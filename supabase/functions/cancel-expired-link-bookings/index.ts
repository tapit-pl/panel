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

function escapeHtml(s: string | null | undefined): string {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function bokunCancel(confirmationCode: string): Promise<boolean> {
  const accessKey = Deno.env.get('BOKUN_ACCESS_KEY')!
  const secretKey = Deno.env.get('BOKUN_SECRET_KEY')!
  const path = `/booking.json/cancel-booking/${confirmationCode}`
  const date = bokunDate()
  const signature = await hmac(secretKey, date + accessKey + 'POST' + path)
  const res = await fetch(`https://api.bokun.io${path}`, {
    method: 'POST',
    headers: { 'X-Bokun-Date': date, 'X-Bokun-AccessKey': accessKey, 'X-Bokun-Signature': signature, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ notify: false }),
  })
  const body = await res.json().catch(() => ({}))
  const msg = (body?.message || body?.errorMessage || '').toLowerCase()
  const ok = res.ok || msg.includes('not confirmed') || msg.includes('not found') || msg.includes('already cancelled')
  console.log('[cancel-expired-link-bookings] bokunCancel', confirmationCode, '→ status:', res.status, 'ok:', ok, 'msg:', msg.slice(0, 100))
  return ok
}

// Bookings whose payment link expired while the tour was still far away get marked 'link_expired'
// (by stripe-webhook's checkout.session.expired handler) instead of being cancelled outright — Bokun
// stays Confirmed the whole time, so nothing is at risk while we wait. This cron is the other half:
// once the tour is finally within 23h and the booking is STILL unpaid, cancel it for real.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: candidates, error } = await db
    .from('bookings')
    .select('id, bokun_confirmation_code, email, guest, tour, date, time, pax')
    .eq('status', 'link_expired')

  if (error) {
    console.error('[cancel-expired-link-bookings] query error:', error.message)
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const nowMs = Date.now()
  const due = (candidates ?? []).filter(b => {
    if (!b.date) return true // no date on file — safest is to resolve it now rather than let it linger forever
    const timePart = b.time && /^\d{2}:\d{2}/.test(b.time) ? b.time.slice(0, 5) : '00:00'
    const tourMs = new Date(`${b.date}T${timePart}:00Z`).getTime()
    if (isNaN(tourMs)) return true
    const hoursUntilTour = (tourMs - nowMs) / (1000 * 60 * 60)
    return hoursUntilTour < 23
  })

  console.log('[cancel-expired-link-bookings] link_expired total:', candidates?.length ?? 0, 'due for cancellation:', due.length)

  let cancelled = 0
  for (const b of due) {
    if (b.bokun_confirmation_code) {
      await bokunCancel(b.bokun_confirmation_code)
    }
    await db.from('bookings').update({ status: 'cancelled' }).eq('id', b.id)
    console.log('[cancel-expired-link-bookings] cancelled:', b.id)
    cancelled++

    if (b.email) {
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const today = `${pad(now.getDate())}.${pad(now.getMonth()+1)}.${now.getFullYear()}`
      const ref = b.bokun_confirmation_code || b.id
      const emailHtml = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#333;font-size:13px">
          <table style="width:100%;padding-bottom:16px;border-bottom:2px solid #333;margin-bottom:20px">
            <tr>
              <td style="vertical-align:top;font-size:11px;line-height:1.7">
                THOUSAND MILES SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ<br>NIP: 6762709355<br>ul. PLAC SZCZEPAŃSKI 8/207<br>31-011 KRAKÓW
              </td>
              <td style="text-align:right;vertical-align:top">
                <img src="https://panel.thousandmiles.pl/assets/logo.png" style="height:50px;display:block;margin-left:auto;margin-bottom:6px">
                <span style="font-size:11px">Kraków, ${today}</span>
              </td>
            </tr>
          </table>
          <h2 style="text-align:center;letter-spacing:2px;font-size:17px;margin:20px 0 6px;text-transform:uppercase">Reservation Confirmation</h2>
          <p style="text-align:center;color:#888;font-size:12px;margin-bottom:28px">Nr: ${escapeHtml(ref)}</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            ${b.tour ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold;width:45%">Tour:</td><td style="padding:8px 4px">${escapeHtml(b.tour)}</td></tr>` : ''}
            ${b.date ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Date:</td><td style="padding:8px 4px">${escapeHtml(b.date)}</td></tr>` : ''}
            ${b.pax ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Number of participants:</td><td style="padding:8px 4px">${b.pax}</td></tr>` : ''}
            ${b.guest ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Guest name:</td><td style="padding:8px 4px">${escapeHtml(b.guest)}</td></tr>` : ''}
          </table>
          <div style="margin:16px 0;padding:14px 16px;background:#FEF3C7;border-radius:8px;border-left:4px solid #F59E0B">
            <p style="margin:0 0 5px;font-weight:bold;font-size:12px;color:#92400E;text-transform:uppercase;letter-spacing:1px">Payment not received</p>
            <p style="margin:0;font-size:12px;color:#92400E;line-height:1.6">We have not received your payment in time, so your reservation has been automatically cancelled. If you would like to book again, please contact us.</p>
          </div>
          <p style="text-align:center;font-weight:bold;font-size:15px;letter-spacing:2px;margin:28px 0;padding:14px 20px;border:2px solid #DC2626;color:#DC2626">RESERVATION CANCELLED</p>
          <div style="border-top:1px solid #eee;padding-top:14px;text-align:center;font-size:11px;color:#888">
            <p style="margin:0">How was your visit? Please review us on <strong>TripAdvisor</strong>: <strong>Thousand Miles Krakow</strong></p>
            <p style="margin:6px 0 0">Instagram: /thousandmiles.pl &nbsp;·&nbsp; Facebook: /ThousandMilesPL</p>
          </div>
        </div>`
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Thousand Miles <rezerwacje@thousandmiles.pl>',
          to: b.email,
          subject: `Reservation cancelled: ${b.tour || 'your booking'}`,
          html: emailHtml,
        }),
      })
      console.log('[cancel-expired-link-bookings] cancellation email status:', emailRes.status, 'to:', b.email)
    }
  }

  return new Response(
    JSON.stringify({ checked: candidates?.length ?? 0, cancelled }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  )
})
