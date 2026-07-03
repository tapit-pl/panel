import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

async function sendEmail(to: string, subject: string, html: string, resendKey: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Thousand Miles <rezerwacje@thousandmiles.pl>',
      to,
      subject,
      html,
    }),
  })
  return res.status
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const resendKey = Deno.env.get('RESEND_API_KEY')!

  const { data: pendingBookings, error } = await db
    .from('bookings')
    .select('id, tour, date, time, guest, email, pax, total, stripe_session_url, partner_id')
    .eq('status', 'pending_payment')
    .lt('created_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    .is('hotel_warned_at', null)

  if (error) {
    console.error('[check-pending-bookings] query error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  console.log('[check-pending-bookings] pending bookings to warn:', pendingBookings?.length ?? 0)

  let warned = 0

  for (const booking of pendingBookings ?? []) {
    const guestPax = booking.pax ?? 1

    // Email do klienta — przypomnienie z linkiem
    if (booking.email && booking.stripe_session_url) {
      const guestHtml = `
        <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
          <h2 style="color:#3A3A3A;margin-bottom:8px">Your payment is still pending</h2>
          <p style="color:#666;margin-bottom:8px">We noticed your booking for <strong>${booking.tour}</strong> on ${booking.date || ''} has not been paid yet.</p>
          <p style="color:#666;margin-bottom:24px">Please complete your payment to secure your spot. Your reservation may be cancelled if payment is not received.</p>
          <a href="${booking.stripe_session_url}"
             style="display:inline-block;background:#E8751A;color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:600;font-size:15px">
            Complete payment — ${booking.total ? booking.total + ' PLN' : ''}
          </a>
          <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:32px;border-top:2px solid #eee;padding-top:20px">
            <tr><td style="padding:8px 0;color:#999;width:40%">Booking ref</td><td style="padding:8px 0;color:#3A3A3A;font-weight:600">#TM-${booking.id}</td></tr>
            <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Tour</td><td style="padding:8px 0;color:#3A3A3A">${booking.tour}</td></tr>
            <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Date</td><td style="padding:8px 0;color:#3A3A3A">${booking.date || ''}</td></tr>
            ${booking.time ? `<tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Time</td><td style="padding:8px 0;color:#3A3A3A">${booking.time}</td></tr>` : ''}
            <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Guests</td><td style="padding:8px 0;color:#3A3A3A">${guestPax}</td></tr>
          </table>
          <p style="color:#999;font-size:12px;margin-top:16px">Questions? Reply to this email or contact us at rezerwacje@thousandmiles.pl</p>
        </div>
      `
      const guestStatus = await sendEmail(booking.email, `Payment reminder: ${booking.tour}`, guestHtml, resendKey)
      console.log('[check-pending-bookings] guest email status:', guestStatus, 'booking:', booking.id)
    }

    // Email do hotelu — ostrzeżenie o nieopłaconej rezerwacji
    if (booking.partner_id) {
      const { data: partner } = await db
        .from('partners')
        .select('email, name')
        .eq('id', booking.partner_id)
        .single()

      if (partner?.email) {
        const hotelHtml = `
          <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
            <h2 style="color:#3A3A3A;margin-bottom:8px">Unpaid reservation alert</h2>
            <p style="color:#666;margin-bottom:24px">The following reservation created by your hotel has not been paid by the guest in over 2 hours.</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr><td style="padding:8px 0;color:#999;width:40%">Booking ref</td><td style="padding:8px 0;color:#3A3A3A;font-weight:600">#TM-${booking.id}</td></tr>
              <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Guest</td><td style="padding:8px 0;color:#3A3A3A">${booking.guest || '—'}</td></tr>
              <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Tour</td><td style="padding:8px 0;color:#3A3A3A">${booking.tour}</td></tr>
              <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Date</td><td style="padding:8px 0;color:#3A3A3A">${booking.date || ''}</td></tr>
              <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Guests</td><td style="padding:8px 0;color:#3A3A3A">${guestPax}</td></tr>
              <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Amount</td><td style="padding:8px 0;color:#3A3A3A;font-weight:600">${booking.total ? booking.total + ' PLN' : '—'}</td></tr>
            </table>
            <div style="margin-top:20px;padding:14px 16px;background:#FEF2F2;border-radius:8px;border-left:4px solid #DC2626">
              <p style="margin:0;color:#991B1B;font-size:13px;font-weight:600">Action may be required</p>
              <p style="margin:4px 0 0;color:#991B1B;font-size:13px">This reservation will be cancelled if payment is not received within 2–3 hours. Please contact the guest if needed.</p>
            </div>
            <p style="color:#999;font-size:12px;margin-top:16px">This is an automated notification from Thousand Miles panel.</p>
          </div>
        `
        const hotelStatus = await sendEmail(partner.email, `[Action required] Unpaid reservation #TM-${booking.id} — ${booking.guest || 'guest'}`, hotelHtml, resendKey)
        console.log('[check-pending-bookings] hotel email status:', hotelStatus, 'booking:', booking.id, 'partner:', partner.email)
      }
    }

    // Oznacz jako ostrzeżony
    await db.from('bookings').update({ hotel_warned_at: new Date().toISOString() }).eq('id', booking.id)
    warned++
  }

  return new Response(
    JSON.stringify({ processed: pendingBookings?.length ?? 0, warned }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  )
})
