import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = { 'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

function voucherHtml(p: {
  booking_id: string, bokun_booking_id?: number | string | null, tour_name: string, date: string, time?: string | null,
  guest_name?: string | null, guest_email?: string | null, phone?: string | null,
  pax: number, total?: number | null, pickup?: string | null,
  email_blocks?: Array<{name: string, info: string}> | null,
  badge: string, badge_color: string,
}) {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const today = `${pad(now.getDate())}.${pad(now.getMonth()+1)}.${now.getFullYear()}`

  return `
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
      <p style="text-align:center;color:#888;font-size:12px;margin-bottom:28px">Nr: TM-${p.bokun_booking_id || p.booking_id}</p>

      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold;width:45%">Offer name:</td><td style="padding:8px 4px">${p.tour_name}</td></tr>
        <tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Number of participants:</td><td style="padding:8px 4px">${p.pax}</td></tr>
        ${p.total ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Price:</td><td style="padding:8px 4px">${p.total} PLN</td></tr>` : ''}
        ${p.guest_name ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Participants:</td><td style="padding:8px 4px">${p.guest_name}</td></tr>` : ''}
        ${p.phone ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Contact number:</td><td style="padding:8px 4px">${p.phone}</td></tr>` : ''}
        ${p.guest_email ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Email:</td><td style="padding:8px 4px">${p.guest_email}</td></tr>` : ''}
        <tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Selected date:</td><td style="padding:8px 4px">${p.date}</td></tr>
        ${p.time || p.pickup ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Time and place of meeting:</td><td style="padding:8px 4px">${p.time || ''}${p.time && p.pickup ? '<br>' : ''}${p.pickup || ''}</td></tr>` : ''}
      </table>

      ${(p.email_blocks && p.email_blocks.length > 0) ? `<div style="margin-bottom:28px;font-size:12px">${p.email_blocks.map(b => `<p style="font-weight:bold;margin:0 0 4px">${b.name}</p><p style="color:#E8751A;margin:0 0 14px">${b.info}</p>`).join('')}</div>` : ''}

      <p style="text-align:center;font-weight:bold;font-size:15px;letter-spacing:2px;margin:28px 0;padding:14px 20px;border:2px solid ${p.badge_color};color:${p.badge_color}">${p.badge}</p>

      <div style="border-top:1px solid #eee;padding-top:14px;text-align:center;font-size:11px;color:#888">
        <p style="margin:0">How was your visit? Please review us on <strong>TripAdvisor</strong>: <strong>Thousand Miles Krakow</strong></p>
        <p style="margin:6px 0 0">Instagram: /thousandmiles.pl &nbsp;·&nbsp; Facebook: /ThousandMilesPL</p>
      </div>
    </div>
  `
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const { booking_id, bokun_booking_id, bokun_confirmation_code, tour_name, date, time, guest_name, guest_email, phone, pax, total, pickup, payment_type, email_blocks } = await req.json()

  if (!guest_email) {
    return new Response(JSON.stringify({ error: 'guest_email required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // Prefer numeric bokun_booking_id; fallback to stripping "TM-" prefix from confirmation code
  let resolvedBokunId: number | string | null = bokun_booking_id || null
  if (!resolvedBokunId && bokun_confirmation_code) {
    resolvedBokunId = String(bokun_confirmation_code).replace(/^TM-/i, '')
  }

  const isHotel = payment_type === 'hotel'
  const badge = isHotel ? 'PAID AT HOTEL' : 'PAY TO DRIVER'
  const badge_color = isHotel ? '#16A34A' : '#E8751A'
  const subject = isHotel ? `Booking confirmed: ${tour_name}` : `Tour booking: ${tour_name}`

  const html = voucherHtml({
    booking_id, bokun_booking_id: resolvedBokunId as number | null, tour_name, date, time, guest_name, guest_email, phone,
    pax: pax ?? 1, total, pickup, email_blocks: email_blocks || null, badge, badge_color,
  })

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: 'Thousand Miles <rezerwacje@thousandmiles.pl>', to: guest_email, subject, html }),
  })

  console.log('[send-booking-confirmation] status:', emailRes.status, 'to:', guest_email, 'type:', payment_type)

  return new Response(JSON.stringify({ sent: emailRes.ok }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
