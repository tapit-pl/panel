import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = { 'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

function escapeHtml(s: string | null | undefined): string {
  if (!s) return ''
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function officeNotificationHtml(p: {
  created_by: string,
  booking_id: string, bokun_booking_id?: number | string | null, tour_name: string, date: string, time?: string | null,
  guest_name?: string | null, extra_guests?: string[] | null, guest_email?: string | null, phone?: string | null,
  pax: number, total?: number | null, pickup?: string | null, language?: string | null,
  payment_method?: string | null, package_lines?: string | null,
}) {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const today = `${pad(now.getDate())}.${pad(now.getMonth()+1)}.${now.getFullYear()}`
  const guestNames = [p.guest_name, ...(p.extra_guests || [])].filter(Boolean).join('<br>')

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

      <h2 style="text-align:center;letter-spacing:2px;font-size:17px;margin:20px 0 6px;text-transform:uppercase">New Reservation</h2>
      <p style="text-align:center;color:#888;font-size:12px;margin-bottom:8px">Nr: TM-${p.bokun_booking_id || p.booking_id}</p>
      <p style="text-align:center;font-weight:bold;font-size:13px;margin-bottom:28px">Created by: ${escapeHtml(p.created_by)}</p>

      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold;width:45%">Offer name:</td><td style="padding:8px 4px">${escapeHtml(p.tour_name)}</td></tr>
        ${p.package_lines ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Package:</td><td style="padding:8px 4px;white-space:pre-line">${escapeHtml(p.package_lines)}</td></tr>` : ''}
        <tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Number of participants:</td><td style="padding:8px 4px">${p.pax}</td></tr>
        ${p.total ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Price:</td><td style="padding:8px 4px">${escapeHtml(String(p.total))} PLN</td></tr>` : ''}
        ${guestNames ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Participants:</td><td style="padding:8px 4px">${guestNames}</td></tr>` : ''}
        ${p.phone ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Contact number:</td><td style="padding:8px 4px">${escapeHtml(p.phone)}</td></tr>` : ''}
        ${p.guest_email ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Email:</td><td style="padding:8px 4px">${escapeHtml(p.guest_email)}</td></tr>` : ''}
        <tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Selected date:</td><td style="padding:8px 4px">${escapeHtml(p.date)}</td></tr>
        ${p.time || p.pickup ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Time and place of meeting:</td><td style="padding:8px 4px">${escapeHtml(p.time || '')}${p.time && p.pickup ? '<br>' : ''}${escapeHtml(p.pickup || '')}</td></tr>` : ''}
        ${p.language ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Language:</td><td style="padding:8px 4px">${escapeHtml(p.language)}</td></tr>` : ''}
        ${p.payment_method ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Payment method:</td><td style="padding:8px 4px">${escapeHtml(p.payment_method)}</td></tr>` : ''}
      </table>
    </div>
  `
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
  const authClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: adminRow } = await db.from('admin_users').select('role, first_name, last_name').eq('email', user.email).maybeSingle()
  const { data: partnerRow } = await db.from('partners').select('name').eq('email', user.email).maybeSingle()
  if (!adminRow && !partnerRow) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })

  // Identity is derived server-side from the authenticated caller — never trust a client-supplied "created by" label.
  const createdBy = adminRow
    ? `${[adminRow.first_name, adminRow.last_name].filter(Boolean).join(' ') || user.email} (role: ${adminRow.role})`
    : `Partner — ${partnerRow!.name}`

  const { data: setting } = await db.from('app_settings').select('value').eq('key', 'office_notification_email').maybeSingle()
  const notifyEmail = setting?.value
  if (!notifyEmail) {
    return new Response(JSON.stringify({ ok: true, skipped: 'no notification email set' }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const {
    booking_id, bokun_booking_id, bokun_confirmation_code, tour_name, date, time,
    guest_name, extra_guests, guest_email, phone, pax, total, pickup, language,
    payment_method, package_lines,
  } = await req.json()

  let resolvedBokunId: number | string | null = bokun_booking_id || null
  if (!resolvedBokunId && bokun_confirmation_code) {
    resolvedBokunId = String(bokun_confirmation_code).replace(/^TM-/i, '')
  }

  const html = officeNotificationHtml({
    created_by: createdBy,
    booking_id, bokun_booking_id: resolvedBokunId as number | null, tour_name, date, time,
    guest_name, extra_guests: extra_guests || null, guest_email, phone,
    pax: pax ?? 1, total, pickup, language, payment_method, package_lines,
  })

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: 'Thousand Miles Panel <rezerwacje@thousandmiles.pl>', to: notifyEmail, subject: `New reservation: ${tour_name} — ${date}`, html }),
  })

  console.log('[send-office-notification] status:', emailRes.status, 'to:', notifyEmail, 'booking:', booking_id)

  return new Response(JSON.stringify({ sent: emailRes.ok }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
