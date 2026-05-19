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

async function verifyStripeSignature(body: string, sigHeader: string, secret: string): Promise<boolean> {
  const parts: Record<string, string[]> = {}
  for (const part of sigHeader.split(',')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq)
    const v = part.slice(eq + 1)
    if (!parts[k]) parts[k] = []
    parts[k].push(v)
  }
  const timestamp = parts['t']?.[0]
  const signatures = parts['v1'] || []
  if (!timestamp || signatures.length === 0) return false

  const payload = `${timestamp}.${body}`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  const expected = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, '0')).join('')
  return signatures.some(s => s === expected)
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
  const sigHeader = req.headers.get('stripe-signature') || ''
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!

  const valid = await verifyStripeSignature(body, sigHeader, webhookSecret)
  if (!valid) {
    console.error('[Webhook] invalid signature')
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 400 })
  }

  const event = JSON.parse(body)
  console.log('[Webhook] event type:', event.type)

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object
    const bookingId = session?.metadata?.booking_id
    const bokunReservationCode = session?.metadata?.bokun_reservation_code

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    if (bokunReservationCode) {
      const confirmResult = await bokunConfirm(bokunReservationCode)
      console.log('[Webhook] bokun confirm:', JSON.stringify({ code: bokunReservationCode, status: confirmResult?.booking?.status }))
    }

    if (bookingId) {
      const { error } = await db.from('bookings').update({
        status: 'confirmed',
        stripe_session_id: session.id,
      }).eq('id', bookingId)
      console.log('[Webhook] db update error:', error)
    }
  }

  return new Response(JSON.stringify({ received: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
