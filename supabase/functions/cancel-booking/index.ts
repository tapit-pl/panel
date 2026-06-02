import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = { 'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

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

async function bokunRequest(method: string, path: string, payload?: unknown) {
  const accessKey = Deno.env.get('BOKUN_ACCESS_KEY')!
  const secretKey = Deno.env.get('BOKUN_SECRET_KEY')!
  const date = bokunDate()
  const message = date + accessKey + method + path
  const signature = await hmac(secretKey, message)
  const res = await fetch(`https://api.bokun.io${path}`, {
    method,
    headers: {
      'X-Bokun-Date': date,
      'X-Bokun-AccessKey': accessKey,
      'X-Bokun-Signature': signature,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  })
  return { ok: res.ok, status: res.status, body: await res.json() }
}

async function bokunCancel(confirmationCode: string) {
  const path = `/booking.json/cancel-booking/${confirmationCode}`
  const res = await bokunRequest('POST', path, { notify: true })
  console.log('[Cancel] cancel response status:', res.status, 'body:', JSON.stringify(res.body).slice(0, 300))
  const msg = res.body?.message || res.body?.errorMessage || ''
  // "Booking is not confirmed" = reservation was never paid, nothing to cancel in Bokun
  const ignorable = !res.ok && (msg.toLowerCase().includes('not confirmed') || msg.toLowerCase().includes('not found'))
  return {
    ok: res.ok || ignorable,
    status: res.status,
    error: (res.ok || ignorable) ? null : (msg || `HTTP ${res.status}`),
    body: res.body,
  }
}

async function findStripeSessionByBookingId(bookingId: string, stripeKey: string): Promise<string | null> {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions?limit=10&metadata[booking_id]=${encodeURIComponent(bookingId)}`, {
    headers: { 'Authorization': `Bearer ${stripeKey}` }
  })
  const data = await res.json()
  const session = data?.data?.[0]
  console.log('[Cancel] Stripe session lookup by booking_id:', bookingId, '→', session?.id || 'not found')
  return session?.id || null
}

async function stripeRefund(stripeSessionId: string | null, bookingId: string): Promise<{ ok: boolean, refundId?: string, error?: string }> {
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!

  // If session ID not in DB, search Stripe by booking_id metadata
  const sessionId = stripeSessionId || await findStripeSessionByBookingId(bookingId, stripeKey)
  if (!sessionId) return { ok: true }

  const sessionRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${stripeKey}` }
  })
  const session = await sessionRes.json()
  const paymentIntent = session.payment_intent
  console.log('[Cancel] Stripe session status:', session.payment_status, 'pi:', paymentIntent)

  if (!paymentIntent || session.payment_status !== 'paid') {
    // Expire the checkout session so the guest can't pay after cancellation
    if (session.status === 'open') {
      await fetch(`https://api.stripe.com/v1/checkout/sessions/${stripeSessionId}/expire`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${stripeKey}` },
      })
      console.log('[Cancel] Stripe session expired')
    }
    return { ok: true }
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
  if (booking.stripe_session_id || booking.payment_method === 'link') {
    const refund = await stripeRefund(booking.stripe_session_id, booking_id)
    results.stripe = refund
  }

  // Cancel in Bokun — look up internal booking ID via search, then cancel
  if (booking.bokun_confirmation_code) {
    console.log('[Cancel] cancelling Bokun confirmation code:', booking.bokun_confirmation_code)
    const cancel = await bokunCancel(booking.bokun_confirmation_code)
    results.bokun = { ok: cancel.ok, error: cancel.error }
  }

  // Update DB status
  await db.from('bookings').update({ status: 'cancelled' }).eq('id', booking_id)

  return new Response(JSON.stringify({ success: true, ...results }), {
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })
})
