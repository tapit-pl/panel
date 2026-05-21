import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

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
  CONFIRMED: 'Confirmed',
  CANCELLED: 'Cancelled',
  PENDING:   'Pending',
  DECLINED:  'Cancelled',
  ON_HOLD:   'Pending',
}

function parseBokunDate(val: unknown): string | null {
  if (!val) return null
  // Bokun dates: [year, month, day] array or "YYYY-MM-DD" string
  if (Array.isArray(val) && val.length >= 3) {
    const [y, m, d] = val as number[]
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`
  }
  if (typeof val === 'string') return val.substring(0, 10)
  return null
}

function parseBokunTime(val: unknown): string | null {
  if (!val) return null
  if (Array.isArray(val) && val.length >= 2) {
    const [h, m] = val as number[]
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`
  }
  if (typeof val === 'string') return val.substring(0, 5)
  return null
}

function extractBookingRow(body: Record<string, unknown>, confirmationCode: string, status: string): Record<string, unknown> {
  const pb = (body.productBookings as Record<string, unknown>[])?.[0] ?? {}
  const customer = (body.customer ?? body.contactPerson ?? {}) as Record<string, unknown>
  const firstName = String(customer.firstName ?? customer.first_name ?? '')
  const lastName  = String(customer.lastName  ?? customer.last_name  ?? '')
  const guest     = [firstName, lastName].filter(Boolean).join(' ') || null

  const product   = (pb.product ?? {}) as Record<string, unknown>
  const tourName  = String(product.title ?? pb.title ?? body.title ?? '')

  // Start date/time from productBooking
  const startDate = parseBokunDate(pb.startDate ?? pb.date)
  const startTime = parseBokunTime(pb.startTime ?? pb.time)

  // Pax: sum all participants
  const passengers = (pb.passengers ?? body.passengers ?? []) as Record<string, unknown>[]
  const pax = passengers.reduce((sum, p) => sum + (Number(p.count ?? p.quantity ?? 1)), 0) || Number(pb.paxCount ?? body.paxCount ?? 0) || null

  // Price in local currency (PLN)
  const priceObj  = (pb.totalPrice ?? pb.price ?? body.totalPrice ?? {}) as Record<string, unknown>
  const total     = Number(priceObj.amount ?? priceObj.value ?? priceObj.price ?? 0) || null

  const guestEmail = String(customer.email ?? '')
  const phone      = String(customer.phoneNumber ?? customer.phone ?? '')

  return {
    bokun_confirmation_code: confirmationCode,
    tour_name:  tourName || null,
    guest:      guest,
    guest_email: guestEmail || null,
    phone:      phone || null,
    date:       startDate,
    time:       startTime,
    pax:        pax,
    total:      total,
    source:     'bokun_ota',
    status:     status,
    partner_id: null,
  }
}

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

  const webhookSecret = Deno.env.get('BOKUN_WEBHOOK_SECRET')
  if (webhookSecret) {
    const valid = await verifyBokunSignature(req.headers, webhookSecret)
    if (!valid) console.warn('[bokun-webhook] Signature mismatch — check BOKUN_WEBHOOK_SECRET')
  }

  if (topic && !topic.startsWith('booking')) {
    return new Response(JSON.stringify({ ok: true, skipped: true, topic }), { headers: CORS })
  }

  // --- Fetch full booking details from Bokun ---
  let confirmationCode: string | null = null
  let rawBokunStatus: string | null = null
  let fullBooking: Record<string, unknown> | null = null

  if (payload.confirmationCode) {
    confirmationCode = String(payload.confirmationCode)
    const pb = (payload.productBookings as Record<string, unknown>[])?.[0]
    rawBokunStatus = String(pb?.status ?? payload.status ?? '')
    fullBooking = payload
  } else if (payload.bookingId) {
    let numericId: string
    try {
      const decoded = atob(String(payload.bookingId))
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
    fullBooking = resp.body
  }

  if (!confirmationCode) {
    console.error('[bokun-webhook] no confirmationCode — raw payload:', rawBody.slice(0, 600))
    return new Response(JSON.stringify({ error: 'no_confirmation_code', raw: rawBody.slice(0, 400) }), { status: 400, headers: CORS })
  }

  // --- Determine new status ---
  let newStatus: string | null = null
  if (topic === 'bookings/cancel' || topic === 'booking/cancel') {
    newStatus = 'Cancelled'
  } else if (topic === 'bookings/create' || topic === 'booking/create') {
    newStatus = 'Confirmed'
  } else if (rawBokunStatus) {
    newStatus = BOKUN_STATUS_MAP[rawBokunStatus.toUpperCase()] ?? null
  }

  if (!newStatus) {
    console.log('[bokun-webhook] no status mapping — topic:', topic, 'bokunStatus:', rawBokunStatus)
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'no_status_mapping' }), { headers: CORS })
  }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // --- Check if booking already exists in DB ---
  const { data: existing } = await db
    .from('bookings')
    .select('id, status')
    .eq('bokun_confirmation_code', confirmationCode)
    .maybeSingle()

  if (existing) {
    // UPDATE status only
    const { data: updated, error } = await db
      .from('bookings')
      .update({ status: newStatus })
      .eq('bokun_confirmation_code', confirmationCode)
      .select('id, status')

    if (error) {
      console.error('[bokun-webhook] DB update error:', error.message)
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS })
    }
    console.log(`[bokun-webhook] UPDATED | ${confirmationCode} → ${newStatus} | rows: ${updated?.length ?? 0}`)
    return new Response(
      JSON.stringify({ ok: true, action: 'updated', confirmationCode, newStatus, rowsUpdated: updated?.length ?? 0 }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }

  // --- INSERT new booking ---
  if (!fullBooking) {
    console.log('[bokun-webhook] no full booking data for insert, skipping')
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'no_full_booking_for_insert' }), { headers: CORS })
  }

  const row = extractBookingRow(fullBooking, confirmationCode, newStatus)
  const { data: inserted, error: insertError } = await db
    .from('bookings')
    .insert(row)
    .select('id')

  if (insertError) {
    console.error('[bokun-webhook] DB insert error:', insertError.message)
    return new Response(JSON.stringify({ error: insertError.message }), { status: 500, headers: CORS })
  }

  console.log(`[bokun-webhook] INSERTED | ${confirmationCode} | ${row.tour_name} | ${row.date} | pax:${row.pax} | ${newStatus}`)
  return new Response(
    JSON.stringify({ ok: true, action: 'inserted', confirmationCode, newStatus, id: inserted?.[0]?.id }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  )
})
