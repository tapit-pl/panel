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

function renderEmailBlocks(blocks: Array<{name: string, info: string}>): string {
  if (!blocks || blocks.length === 0) return ''
  const inner = blocks.map(b =>
    '<p style="font-weight:bold;margin:0 0 4px">' + b.name + '</p>' +
    '<p style="color:#E8751A;margin:0 0 14px">' + b.info + '</p>'
  ).join('')
  return '<div style="margin-bottom:28px;font-size:12px">' + inner + '</div>'
}

function renderEmailNotes(notes: string | null): string {
  if (!notes) return ''
  return '<div style="margin-bottom:28px;padding:14px 16px;background:#F8F8F8;border-radius:8px;border-left:3px solid #333;font-size:12px"><p style="margin:0;white-space:pre-line">' + notes + '</p></div>'
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

    let bokunInternalId: number | null = null
    if (bokunReservationCode) {
      const confirmResult = await bokunConfirm(bokunReservationCode)
      bokunInternalId = confirmResult?.booking?.id || confirmResult?.id || null
      console.log('[Webhook] bokun confirm:', JSON.stringify({ code: bokunReservationCode, status: confirmResult?.booking?.status, internalId: bokunInternalId }))
    }

    if (bookingId) {
      const updatePayload: Record<string, unknown> = { status: 'confirmed', stripe_session_id: session.id }
      if (bokunInternalId) updatePayload.bokun_booking_id = bokunInternalId
      const { error } = await db.from('bookings').update(updatePayload).eq('id', bookingId)
      console.log('[Webhook] db update error:', error)

      const { data: booking } = await db
        .from('bookings')
        .select('tour, date, time, guest, email, phone, pax, total, pickup')
        .eq('id', bookingId)
        .single()

      let tourEmailBlocks: Array<{name: string, info: string}> = []
      if (booking?.tour) {
        const { data: tourCfg } = await db.from('tour_config').select('email_blocks').eq('title', booking.tour).maybeSingle()
        tourEmailBlocks = tourCfg?.email_blocks || []
      }

      if (booking?.email) {
        const now = new Date()
        const pad = (n: number) => String(n).padStart(2, '0')
        const today = `${pad(now.getDate())}.${pad(now.getMonth()+1)}.${now.getFullYear()}`
        const pax = booking.pax ?? 1

        const html = `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#333;font-size:13px">
            <table style="width:100%;padding-bottom:16px;border-bottom:2px solid #333;margin-bottom:20px">
              <tr>
                <td style="vertical-align:top;font-size:11px;line-height:1.7">
                  THOUSAND MILES SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ<br>
                  NIP: 6762709355<br>
                  ul. PLAC SZCZEPAŃSKI 8/207<br>
                  31-011 KRAKÓW
                </td>
                <td style="text-align:right;vertical-align:top">
                  <img src="https://panel.thousandmiles.pl/assets/logo.png" style="height:50px;display:block;margin-left:auto;margin-bottom:6px">
                  <span style="font-size:11px">Kraków, ${today}</span>
                </td>
              </tr>
            </table>
            <h2 style="text-align:center;letter-spacing:2px;font-size:17px;margin:20px 0 6px;text-transform:uppercase">Reservation Confirmation</h2>
            <p style="text-align:center;color:#888;font-size:12px;margin-bottom:28px">Nr: TM-${bokunInternalId || bookingId}</p>
            <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
              <tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold;width:45%">Offer name:</td><td style="padding:8px 4px">${booking.tour}</td></tr>
              <tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Number of participants:</td><td style="padding:8px 4px">${pax}</td></tr>
              ${booking.total ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Price:</td><td style="padding:8px 4px">${booking.total} PLN</td></tr>` : ''}
              ${booking.guest ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Participants:</td><td style="padding:8px 4px">${booking.guest}</td></tr>` : ''}
              ${booking.phone ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Contact number:</td><td style="padding:8px 4px">${booking.phone}</td></tr>` : ''}
              <tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Email:</td><td style="padding:8px 4px">${booking.email}</td></tr>
              <tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Selected date:</td><td style="padding:8px 4px">${booking.date || ''}</td></tr>
              ${booking.time || booking.pickup ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Time and place of meeting:</td><td style="padding:8px 4px">${booking.time || ''}${booking.time && booking.pickup ? '<br>' : ''}${booking.pickup || ''}</td></tr>` : ''}
            </table>
            ${tourEmailBlocks.length > 0 ? `<div style="margin-bottom:28px;font-size:12px">${tourEmailBlocks.map((b: {name: string, info: string}) => `<p style="font-weight:bold;margin:0 0 4px">${b.name}</p><p style="color:#E8751A;margin:0 0 14px">${b.info}</p>`).join('')}</div>` : ''}
            <p style="text-align:center;font-weight:bold;font-size:15px;letter-spacing:2px;margin:28px 0;padding:14px 20px;border:2px solid #16A34A;color:#16A34A">PAID BY GUEST</p>
            <div style="border-top:1px solid #eee;padding-top:14px;text-align:center;font-size:11px;color:#888">
              <p style="margin:0">How was your visit? Please review us on <strong>TripAdvisor</strong>: <strong>Thousand Miles Krakow</strong></p>
              <p style="margin:6px 0 0">Instagram: /thousandmiles.pl &nbsp;·&nbsp; Facebook: /ThousandMilesPL</p>
            </div>
          </div>
        `

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Thousand Miles <rezerwacje@thousandmiles.pl>',
            to: booking.email,
            subject: `Booking confirmed: ${booking.tour}`,
            html,
          }),
        })
        console.log('[Webhook] PAID BY GUEST voucher email status:', emailRes.status)
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
