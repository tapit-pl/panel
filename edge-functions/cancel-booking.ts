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

async function bokunCancel(confirmationCode: string) {
  const accessKey = Deno.env.get('BOKUN_ACCESS_KEY')!
  const secretKey = Deno.env.get('BOKUN_SECRET_KEY')!
  // Extract numeric booking ID from "TM-XXXXXXXX"
  const bookingId = confirmationCode.replace(/^TM-/i, '')
  const path = `/booking.json/${bookingId}/cancel`
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
  const body = await res.json()
  console.log('[Cancel] Bokun cancel response:', JSON.stringify({ status: res.status, bookingStatus: body?.booking?.status || body?.status, message: body?.message || body?.errorMessage }))
  return { ok: res.ok, status: res.status, error: res.ok ? null : (body?.message || body?.errorMessage || `HTTP ${res.status}`), body }
}

async function stripeRefund(stripeSessionId: string): Promise<{ ok: boolean, refundId?: string, error?: string }> {
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!

  // Get payment_intent from checkout session
  const sessionRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${stripeSessionId}`, {
    headers: { 'Authorization': `Bearer ${stripeKey}` }
  })
  const session = await sessionRes.json()
  const paymentIntent = session.payment_intent
  console.log('[Cancel] Stripe session status:', session.payment_status, 'pi:', paymentIntent)

  if (!paymentIntent || session.payment_status !== 'paid') {
    return { ok: true } // Nothing to refund
  }

  const refundRes = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ payment_intent: paymentIntent }).toString(),
  })
  const refund = await refundRes.json()
  console.log('[Cancel] Stripe refund:', JSON.stringify({ id: refund.id, status: refund.status, error: refund.error }))

  if (refund.error) return { ok: false, error: refund.error.message }
  return { ok: true, refundId: refund.id }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const { booking_id } = await req.json()
  if (!booking_id) return new Response(JSON.stringify({ error: 'Missing booking_id' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: booking, error: fetchErr } = await db.from('bookings').select('*').eq('id', booking_id).single()
  if (fetchErr || !booking) {
    return new Response(JSON.stringify({ error: 'Booking not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const results: Record<string, unknown> = {}

  // Refund Stripe if payment was made
  if (booking.stripe_session_id) {
    const refund = await stripeRefund(booking.stripe_session_id)
    results.stripe = refund
  }

  // Cancel in Bokun
  if (booking.bokun_confirmation_code) {
    const cancel = await bokunCancel(booking.bokun_confirmation_code)
    results.bokun = { ok: cancel.ok, error: cancel.error }
  }

  // Update DB status
  await db.from('bookings').update({ status: 'cancelled' }).eq('id', booking_id)

  return new Response(JSON.stringify({ success: true, ...results }), {
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })
})
