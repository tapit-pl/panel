import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

// HMAC-SHA256 — Bokun webhook signature verification
async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

// HMAC-SHA1 — Bokun REST API auth (same as other edge functions)
async function hmacSha1(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

async function verifyBokunSignature(headers: Headers, secret: string): Promise<boolean> {
  const received = headers.get('x-bokun-hmac')
  if (!received) return false
  const parts: string[] = []
  headers.forEach((val, key) => {
    const lk = key.toLowerCase()
    if (lk.startsWith('x-bokun-') && lk !== 'x-bokun-hmac') parts.push(`${lk}:${val}`)
  })
  parts.sort()
  const computed = await hmacSha256(secret, parts.join('\n'))
  return computed === received
}

function bokunDate(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`
}

// /booking.json/{id} GET 404s even for valid bookings on this account — booking-search by
// confirmationCode (the plain numeric id, no "TM-" prefix) is the endpoint that actually works.
async function bokunFindBookingById(numericId: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
  const accessKey = Deno.env.get('BOKUN_ACCESS_KEY')!
  const secretKey = Deno.env.get('BOKUN_SECRET_KEY')!
  const path = '/booking.json/booking-search'
  const date = bokunDate()
  const payload = { confirmationCode: numericId, pageSize: 1, page: 0 }
  const signature = await hmacSha1(secretKey, date + accessKey + 'POST' + path)
  const res = await fetch(`https://api.bokun.io${path}`, {
    method: 'POST',
    headers: { 'X-Bokun-Date': date, 'X-Bokun-AccessKey': accessKey, 'X-Bokun-Signature': signature, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  const item = (data?.items as Record<string, unknown>[] | undefined)?.[0] ?? null
  return { ok: res.ok, status: res.status, body: item }
}

// Returns true if refund was issued successfully, false if booking was not in paid state,
// throws if refund was attempted but failed (caller should NOT mark as cancelled).
async function stripeRefundIfPaid(db: ReturnType<typeof createClient>, confirmationCode: string): Promise<boolean> {
  // Atomically claim the cancellation by switching status from 'paid' → 'cancelling'.
  // If two webhooks arrive simultaneously only one UPDATE will match — prevents double refund.
  const { data: claimed } = await db.from('bookings')
    .update({ status: 'cancelling' })
    .eq('bokun_confirmation_code', confirmationCode)
    .in('status', ['paid'])
    .select('id, stripe_session_id, payment_method')
    .maybeSingle()

  if (!claimed) return false  // Not paid, already cancelling/cancelled, or no record — skip refund
  if (!claimed.stripe_session_id && claimed.payment_method !== 'link') return false

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!
  let sessionId = claimed.stripe_session_id

  if (!sessionId) {
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions?limit=10&metadata[booking_id]=${encodeURIComponent(claimed.id)}`, {
      headers: { 'Authorization': `Bearer ${stripeKey}` }
    })
    const data = await res.json()
    sessionId = data?.data?.[0]?.id || null
  }
  if (!sessionId) return false

  const sessionRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${stripeKey}` }
  })
  const session = await sessionRes.json()
  if (!session.payment_intent || session.payment_status !== 'paid') return false

  const refundRes = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ payment_intent: session.payment_intent }).toString(),
  })
  const refund = await refundRes.json()
  console.log('[bokun-webhook] Stripe refund:', JSON.stringify({ id: refund.id, status: refund.status, error: refund.error }))

  if (refund.error) {
    // Refund failed — revert status to 'paid' so admin can retry manually
    await db.from('bookings').update({ status: 'refund_failed' })
      .eq('bokun_confirmation_code', confirmationCode).eq('status', 'cancelling')
    throw new Error(`Stripe refund failed: ${refund.error.message}`)
  }
  return true
}

const BOKUN_STATUS_MAP: Record<string, string> = {
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  PENDING:   'payment_pending',
  DECLINED:  'cancelled',
  ON_HOLD:   'payment_pending',
}

// Statuses that Bokun CONFIRM/PENDING events should never overwrite
const PROTECTED_STATUSES = ['paid', 'to_be_paid', 'cancelled']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const rawBody = await req.text()
  let payload: Record<string, unknown>
  try { payload = JSON.parse(rawBody) } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: CORS })
  }

  const topic = req.headers.get('x-bokun-topic') || ''
  console.log('[bokun-webhook] topic:', topic || '(none)', '| keys:', Object.keys(payload).join(','))

  // Verify signature — always required; reject if env var is missing
  const webhookSecret = Deno.env.get('BOKUN_WEBHOOK_SECRET')
  if (!webhookSecret) {
    console.error('[bokun-webhook] BOKUN_WEBHOOK_SECRET not set — rejecting request')
    return new Response(JSON.stringify({ error: 'Webhook not configured' }), { status: 500, headers: CORS })
  }
  const valid = await verifyBokunSignature(req.headers, webhookSecret)
  if (!valid) return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401, headers: CORS })

  // Skip non-booking events
  if (topic && !topic.startsWith('booking')) {
    return new Response(JSON.stringify({ ok: true, skipped: true, topic }), { headers: CORS })
  }

  // --- Extract confirmation code + raw Bokun status ---
  let confirmationCode: string | null = null
  let rawBokunStatus: string | null = null

  if (payload.confirmationCode) {
    // Old-style notification: full booking payload sent directly
    confirmationCode = String(payload.confirmationCode)
    const pb = (payload.productBookings as Record<string, unknown>[])?.[0]
    rawBokunStatus = String(pb?.status ?? payload.status ?? '')
  } else if (payload.bookingId) {
    // New-style (GraphQL webhook): bookingId is base64("Booking:12345") — fetch full details
    let numericId: string
    try {
      const decoded = atob(String(payload.bookingId)) // e.g. "Booking:37648"
      numericId = decoded.split(':')[1] ?? String(payload.bookingId)
    } catch {
      numericId = String(payload.bookingId)
    }
    const resp = await bokunFindBookingById(numericId)
    console.log('[bokun-webhook] fetched booking from Bokun API, HTTP', resp.status, 'found:', !!resp.body)
    if (!resp.ok || !resp.body) {
      return new Response(JSON.stringify({ error: 'Bokun API fetch failed', bokun: resp.status }), { status: 502, headers: CORS })
    }
    confirmationCode = String(resp.body.confirmationCode ?? '')
    const pb = (resp.body.productBookings as Record<string, unknown>[])?.[0]
    rawBokunStatus = String(pb?.status ?? resp.body.status ?? '')
  }

  if (!confirmationCode) {
    // Log full payload so we can diagnose the format on first real invocation
    console.error('[bokun-webhook] no confirmationCode — raw payload:', rawBody.slice(0, 600))
    return new Response(JSON.stringify({ error: 'no_confirmation_code', raw: rawBody.slice(0, 400) }), { status: 400, headers: CORS })
  }

  // --- Determine new panel status ---
  let newStatus: string | null = null

  // Topic takes priority (cancel event is authoritative even if status field says otherwise)
  if (topic === 'bookings/cancel' || topic === 'booking/cancel') {
    newStatus = 'cancelled'
  } else if (topic === 'bookings/create' || topic === 'booking/create') {
    newStatus = 'confirmed'
  } else if (rawBokunStatus) {
    newStatus = BOKUN_STATUS_MAP[rawBokunStatus.toUpperCase()] ?? null
  }

  if (!newStatus) {
    console.log('[bokun-webhook] no status mapping — topic:', topic, 'bokunStatus:', rawBokunStatus)
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'no_status_mapping' }), { headers: CORS })
  }

  // --- Update Supabase ---
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  if (newStatus === 'cancelled') {
    // Atomically claim + refund. If refund fails, status is set to 'refund_failed' and we abort.
    try {
      const refunded = await stripeRefundIfPaid(db, confirmationCode)
      // If booking was in 'cancelling' state (set by stripeRefundIfPaid), the final UPDATE below
      // handles it. If refunded=false the booking was not paid — proceed to normal cancel UPDATE.
      if (refunded) {
        // Refund succeeded — the status was already set to 'cancelling'; now set to 'cancelled'
        const { data: updated } = await db.from('bookings')
          .update({ status: 'cancelled' })
          .eq('bokun_confirmation_code', confirmationCode)
          .select('id, status')
        console.log(`[bokun-webhook] cancel+refund | ${confirmationCode} → cancelled | rows: ${updated?.length ?? 0}`)
        return new Response(JSON.stringify({ ok: true, confirmationCode, newStatus: 'cancelled', refunded: true, rowsUpdated: updated?.length ?? 0 }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    } catch(e) {
      const msg = (e as Error).message
      console.error('[bokun-webhook] Stripe refund error — booking left as refund_failed:', msg)
      return new Response(JSON.stringify({ ok: false, error: 'stripe_refund_failed', detail: msg }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
  } else {
    // Don't overwrite protected statuses with non-cancel events
    const { data: existing } = await db.from('bookings')
      .select('status').eq('bokun_confirmation_code', confirmationCode).maybeSingle()
    if (existing && PROTECTED_STATUSES.includes(existing.status)) {
      console.log(`[bokun-webhook] skipping — status '${existing.status}' is protected`)
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'protected_status', current: existing.status }), { headers: CORS })
    }
  }

  const { data: updated, error } = await db
    .from('bookings')
    .update({ status: newStatus })
    .eq('bokun_confirmation_code', confirmationCode)
    .select('id, status')

  if (error) {
    console.error('[bokun-webhook] DB error:', error.message)
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS })
  }

  console.log(`[bokun-webhook] ${topic || rawBokunStatus} | ${confirmationCode} → ${newStatus} | rows: ${updated?.length ?? 0}`)
  return new Response(
    JSON.stringify({ ok: true, confirmationCode, newStatus, rowsUpdated: updated?.length ?? 0 }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  )
})
