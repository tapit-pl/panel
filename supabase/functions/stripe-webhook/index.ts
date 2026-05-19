import Stripe from 'https://esm.sh/stripe@14?target=deno'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

function bokunDate(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

async function bokunConfirm(confirmationCode: string) {
  const accessKey = Deno.env.get('BOKUN_ACCESS_KEY')!
  const secretKey = Deno.env.get('BOKUN_SECRET_KEY')!
  const path = `/checkout.json/confirm-reserved/${confirmationCode}`
  const date = bokunDate()
  const message = date + accessKey + 'POST' + path
  const signature = await hmac(secretKey, message)
  const res = await fetch(`https://api.bokun.io${path}`, {
    method: 'POST',
    headers: {
      'X-Bokun-Date': date,
      'X-Bokun-AccessKey': accessKey,
      'X-Bokun-Signature': signature,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: '{}',
  })
  return res.json()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const body = await req.text()
  const sig  = req.headers.get('stripe-signature') || ''
  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-04-10', httpClient: Stripe.createFetchHttpClient() })

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, Deno.env.get('STRIPE_WEBHOOK_SECRET')!)
  } catch (err) {
    return new Response(JSON.stringify({ error: `Webhook error: ${err.message}` }), { status: 400 })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session
    const bookingId           = session.metadata?.booking_id
    const bokunReservationCode = session.metadata?.bokun_reservation_code

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    if (bokunReservationCode) {
      await bokunConfirm(bokunReservationCode)
    }

    if (bookingId) {
      await db.from('bookings').update({
        status: 'confirmed',
        stripe_session_id: session.id,
      }).eq('id', bookingId)
    }
  }

  return new Response(JSON.stringify({ received: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
