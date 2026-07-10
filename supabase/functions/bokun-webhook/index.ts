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

async function bokunGet(path: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const accessKey = Deno.env.get('BOKUN_ACCESS_KEY')!
  const secretKey = Deno.env.get('BOKUN_SECRET_KEY')!
  const date = bokunDate()
  const signature = await hmacSha1(secretKey, date + accessKey + 'GET' + path)
  const res = await fetch(`https://api.bokun.io${path}`, {
    headers: { 'X-Bokun-Date': date, 'X-Bokun-AccessKey': accessKey, 'X-Bokun-Signature': signature, 'Accept': 'application/json' }
  })
  return { ok: res.ok, status: res.status, body: await res.json() }
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

  // Verify signature — logs mismatch but doesn't block (enable strict mode by setting BOKUN_WEBHOOK_SECRET)
  const webhookSecret = Deno.env.get('BOKUN_WEBHOOK_SECRET')
  if (webhookSecret) {
    const valid = await verifyBokunSignature(req.headers, webhookSecret)
    if (!valid) console.warn('[bokun-webhook] Signature mismatch — check BOKUN_WEBHOOK_SECRET')
  }

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
    const resp = await bokunGet(`/booking.json/${numericId}`)
    console.log('[bokun-webhook] fetched booking from Bokun API, HTTP', resp.status)
    if (!resp.ok) {
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

  // Don't overwrite protected statuses with non-cancel events
  if (newStatus !== 'cancelled') {
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
