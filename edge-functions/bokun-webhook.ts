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
  if (typeof val === 'number' && val > 946684800000) {
    // Unix ms timestamp — add UTC+2 (Warsaw) to get correct local date
    return new Date(val + 7200000).toISOString().substring(0, 10)
  }
  if (Array.isArray(val) && val.length >= 3) {
    const [y, m, d] = val as number[]
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`
  }
  if (typeof val === 'string' && val.length >= 10) return val.substring(0, 10)
  return null
}

function parseBokunTime(val: unknown): string | null {
  if (!val) return null
  if (typeof val === 'number' && val > 946684800000) {
    // Unix ms timestamp — extract UTC+2 (Warsaw) local time
    const d = new Date(val + 7200000)
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`
  }
  if (Array.isArray(val) && val.length >= 2) {
    const [h, m] = val as number[]
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`
  }
  if (typeof val === 'string' && val.length >= 5) return val.substring(0, 5)
  return null
}

function extractBookingRow(body: Record<string, unknown>, confirmationCode: string, status: string): Record<string, unknown> {
  // activityBookings = HTTP webhook format; productBookings = REST API format
  const ab = (body.activityBookings as Record<string, unknown>[])?.[0] ?? {}
  const pb = (body.productBookings as Record<string, unknown>[])?.[0] ?? {}
  // Use whichever has more data
  const booking = Object.keys(ab).length > Object.keys(pb).length ? ab : pb

  const customer = (body.customer ?? body.contactPerson ?? {}) as Record<string, unknown>
  const firstName = String(customer.firstName ?? customer.first_name ?? '')
  const lastName  = String(customer.lastName  ?? customer.last_name  ?? '')
  const guest     = [firstName, lastName].filter(Boolean).join(' ') || null

  // Tour name — try all known paths
  const abActivity = (ab.activity ?? {}) as Record<string, unknown>
  const pbProduct  = (pb.product ?? {}) as Record<string, unknown>
  const tourName   = String(
    ab.title ?? abActivity.title ??
    pb.title ?? pbProduct.title ??
    booking.title ?? body.title ?? ''
  )

  // Date: try plain date field first, then startDate, then parse from startDateTime array
  const sdt = (booking.startDateTime ?? ab.startDateTime ?? pb.startDateTime) as number[] | null
  let startDate: string | null =
    parseBokunDate(booking.date ?? booking.startDate) ??
    parseBokunDate(ab.date ?? ab.startDate) ??
    parseBokunDate(pb.date ?? pb.startDate)

  if (!startDate && Array.isArray(sdt) && sdt.length >= 3) {
    startDate = parseBokunDate([sdt[0], sdt[1], sdt[2]])
  }

  // Time: try startTime/time field, then extract from startDateTime array
  let startTime: string | null =
    parseBokunTime(booking.startTime ?? booking.time) ??
    parseBokunTime(ab.startTime ?? ab.time) ??
    parseBokunTime(pb.startTime ?? pb.time)

  if (!startTime && Array.isArray(sdt) && sdt.length >= 5) {
    startTime = parseBokunTime([sdt[3], sdt[4]])
  }

  // Pax: totalParticipants (activityBooking), then sum passengers, then paxCount
  const abPax = Number(ab.totalParticipants ?? 0)
  const passengers = (booking.passengers ?? body.passengers ?? []) as Record<string, unknown>[]
  const passengerPax = passengers.reduce((sum, p) => sum + (Number(p.count ?? p.quantity ?? 1)), 0)
  const pax = abPax || passengerPax || Number(booking.paxCount ?? body.paxCount ?? 0) || null

  const guestEmail = String(customer.email ?? '')
  const phone      = String(customer.phoneNumber ?? customer.phone ?? '')

  const codePrefix = confirmationCode.replace(/^#/, '').split('-')[0].toUpperCase()
  const isOtaPln = ['VIA', 'GET', 'GYG', 'KLO', 'EXP'].includes(codePrefix)

  // Price: for OTA-PLN channels use customerInvoice (PLN); for others use resellerInvoice (TM net) if available
  const ri = (pb.resellerInvoice ?? ab.resellerInvoice) as Record<string, unknown> | undefined
  const ci = (pb.customerInvoice ?? ab.customerInvoice) as Record<string, unknown> | undefined
  let rawTotal: unknown
  let currency: string
  if (isOtaPln) {
    rawTotal = ci?.total ?? body.totalPriceConverted ?? body.totalPrice ?? booking.totalPrice
    currency = 'PLN'
  } else {
    const riTotal = ri?.total
    if (typeof riTotal === 'number' && riTotal > 0) {
      rawTotal = riTotal
      currency = String(ri?.currency ?? 'EUR')
    } else {
      rawTotal = ci?.total ?? body.totalPriceConverted ?? body.totalPrice ?? booking.totalPrice
      currency = String(ci?.currency ?? body.currency ?? 'EUR')
    }
  }
  const total = typeof rawTotal === 'number' && rawTotal > 0
    ? rawTotal
    : (Number(rawTotal) > 0 ? Number(rawTotal) : null)
  const sourceMap: Record<string, string> = {
    VIA: 'Viator', GET: 'GYG', GYG: 'GYG', HEA: 'Headout',
    MUS: 'Musement', KLO: 'Klook', EXP: 'Expedia',
  }
  const source = sourceMap[codePrefix] ?? 'bokun_ota'

  return {
    bokun_confirmation_code: confirmationCode,
    tour:        tourName || 'Bokun OTA',
    tour_name:   tourName || null,
    guest:       guest,
    guest_email: guestEmail || null,
    phone:       phone || null,
    date:        startDate,
    time:        startTime,
    pax:         pax,
    total:       total,
    currency:    currency,
    source:      source,
    status:      status,
    partner_id:  null,
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

  let confirmationCode: string | null = null
  let rawBokunStatus: string | null = null
  let fullBooking: Record<string, unknown> | null = null

  if (payload.confirmationCode) {
    confirmationCode = String(payload.confirmationCode)
    const pb = (payload.productBookings as Record<string, unknown>[])?.[0]
    const ab = (payload.activityBookings as Record<string, unknown>[])?.[0]
    rawBokunStatus = String(pb?.status ?? ab?.status ?? payload.status ?? '')
    fullBooking = payload
  } else if (payload.bookingId) {
    let numericId: string
    try {
      const decoded = atob(String(payload.bookingId))
      numericId = decoded.startsWith('Booking:') ? (decoded.split(':')[1] ?? String(payload.bookingId)) : String(payload.bookingId)
    } catch {
      numericId = String(payload.bookingId)
    }
    const resp = await bokunGet(`/booking.json/${numericId}`)
    console.log('[bokun-webhook] Bokun API HTTP', resp.status)
    if (resp.ok) {
      confirmationCode = String(resp.body.confirmationCode ?? '')
      const pb = (resp.body.productBookings as Record<string, unknown>[])?.[0]
      rawBokunStatus = String(pb?.status ?? resp.body.status ?? '')
      fullBooking = resp.body
    } else if (resp.status === 404) {
      // Race condition — webhook fires before booking is in API, use payload as fallback
      console.log('[bokun-webhook] 404 from Bokun API, falling back to payload')
      const code = String(payload.confirmationCode ?? payload.bookingConfirmationCode ?? '')
      if (code) {
        confirmationCode = code
        const pb = (payload.productBookings as Record<string, unknown>[])?.[0]
        const ab = (payload.activityBookings as Record<string, unknown>[])?.[0]
        rawBokunStatus = String(pb?.status ?? ab?.status ?? payload.status ?? '')
        fullBooking = payload
      }
    } else {
      return new Response(JSON.stringify({ error: 'Bokun API fetch failed', bokun: resp.status }), { status: 502, headers: CORS })
    }
  }

  if (!confirmationCode) {
    console.error('[bokun-webhook] no confirmationCode — raw payload:', rawBody.slice(0, 600))
    return new Response(JSON.stringify({ error: 'no_confirmation_code', raw: rawBody.slice(0, 400) }), { status: 400, headers: CORS })
  }

  // Determine new status
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

  const { data: existingRows } = await db
    .from('bookings')
    .select('id, status')
    .eq('bokun_confirmation_code', confirmationCode)

  const existing = existingRows && existingRows.length > 0 ? existingRows[0] : null

  if (existing) {
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

  if (!fullBooking) {
    console.log('[bokun-webhook] no full booking data for insert, skipping')
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'no_full_booking_for_insert' }), { headers: CORS })
  }

  const row = extractBookingRow(fullBooking, confirmationCode, newStatus)

  // Debug logs to diagnose date/price fields
  const pb0 = (fullBooking.productBookings as Record<string,unknown>[])?.[0] ?? {}
  const ab0 = (fullBooking.activityBookings as Record<string,unknown>[])?.[0] ?? {}
  console.log('[bokun-webhook] row:', JSON.stringify({ tour: row.tour, date: row.date, time: row.time, pax: row.pax, total: row.total, guest: row.guest }))
  console.log('[bokun-webhook] date fields:', JSON.stringify({
    pbDate: pb0.date, pbStartDate: pb0.startDate, pbStartDateTime: pb0.startDateTime,
    abDate: ab0.date, abStartDate: ab0.startDate, abStartDateTime: ab0.startDateTime,
  }))
  console.log('[bokun-webhook] price fields:', JSON.stringify({
    currency: fullBooking.currency,
    totalPriceConverted: fullBooking.totalPriceConverted,
    totalPrice: fullBooking.totalPrice,
    pbTotalPrice: pb0.totalPrice,
  }))
  console.log('[bokun-webhook] invoice:', JSON.stringify(fullBooking.invoice))
  console.log('[bokun-webhook] pb0 invoices:', JSON.stringify({ customerInvoice: pb0.customerInvoice, resellerInvoice: pb0.resellerInvoice }))

  const { data: inserted, error: insertError } = await db
    .from('bookings')
    .insert(row)
    .select('id')

  if (insertError) {
    console.error('[bokun-webhook] DB insert error:', insertError.message)
    return new Response(JSON.stringify({ error: insertError.message }), { status: 500, headers: CORS })
  }

  console.log(`[bokun-webhook] INSERTED | ${confirmationCode} | ${row.tour_name} | ${row.date} | pax:${row.pax} | total:${row.total} | ${newStatus}`)
  return new Response(
    JSON.stringify({ ok: true, action: 'inserted', confirmationCode, newStatus, id: inserted?.[0]?.id }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  )
})
