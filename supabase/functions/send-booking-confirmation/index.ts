import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = { 'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const { booking_id, tour_name, date, time, guest_name, guest_email, pax, total } = await req.json()

  if (!guest_email) {
    return new Response(JSON.stringify({ error: 'guest_email required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const guestPax = pax ?? 1

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Thousand Miles <rezerwacje@thousandmiles.pl>',
      to: guest_email,
      subject: `Tour booking: ${tour_name}`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
          <h2 style="color:#3A3A3A;margin-bottom:8px">Your tour is booked!</h2>
          <p style="color:#666;margin-bottom:24px">Your reservation has been confirmed. Payment will be collected by the driver on the day of the tour.</p>

          <div style="margin-top:8px">
            <div style="display:inline-block;background:#2563EB;color:#fff;font-size:11px;font-weight:700;letter-spacing:1px;padding:4px 12px;border-radius:6px;margin-bottom:20px">BOOKING CONFIRMED</div>
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr><td style="padding:8px 0;color:#999;width:40%">Booking ref</td><td style="padding:8px 0;color:#3A3A3A;font-weight:600">#TM-${booking_id}</td></tr>
              <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Guest</td><td style="padding:8px 0;color:#3A3A3A">${guest_name || ''}</td></tr>
              <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Tour</td><td style="padding:8px 0;color:#3A3A3A">${tour_name}</td></tr>
              <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Date</td><td style="padding:8px 0;color:#3A3A3A">${date || ''}</td></tr>
              ${time ? `<tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Time</td><td style="padding:8px 0;color:#3A3A3A">${time}</td></tr>` : ''}
              <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Guests</td><td style="padding:8px 0;color:#3A3A3A">${guestPax}</td></tr>
              ${total ? `<tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Total</td><td style="padding:8px 0;color:#3A3A3A;font-weight:600">${total} PLN</td></tr>` : ''}
            </table>
            <div style="margin-top:20px;padding:14px 16px;background:#FEF3C7;border-radius:8px;border-left:4px solid #F59E0B">
              <p style="margin:0;color:#92400E;font-size:13px;font-weight:600">Payment by driver</p>
              <p style="margin:4px 0 0;color:#92400E;font-size:13px">Please have the exact amount ready in cash on the day of the tour. The driver will collect payment at pickup.</p>
            </div>
            <p style="color:#999;font-size:12px;margin-top:16px">Questions? Reply to this email or contact us at rezerwacje@thousandmiles.pl</p>
          </div>
        </div>
      `,
    }),
  })

  console.log('[send-booking-confirmation] email status:', emailRes.status, 'to:', guest_email)

  return new Response(
    JSON.stringify({ sent: emailRes.ok }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  )
})
