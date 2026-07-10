import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = { 'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const { booking_id, bokun_reservation_code, amount_pln, pax, tour_name, date, guest_name, guest_email } = await req.json()

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!
  const params = new URLSearchParams()
  params.set('mode', 'payment')
  if (guest_email) params.set('customer_email', guest_email)
  params.set('line_items[0][price_data][currency]', 'pln')
  params.set('line_items[0][price_data][product_data][name]', tour_name)
  params.set('line_items[0][price_data][product_data][description]', `${date} · ${pax} os.`)
  params.set('line_items[0][price_data][unit_amount]', String(Math.round(amount_pln * 100)))
  params.set('line_items[0][quantity]', '1')
  params.set('expires_at', String(Math.floor(Date.now() / 1000) + 30 * 60))
  params.set('success_url', 'https://panel.thousandmiles.pl/payment-success.html')
  params.set('cancel_url', 'https://panel.thousandmiles.pl/payment-cancel.html')
  params.set('metadata[booking_id]', String(booking_id))
  params.set('metadata[bokun_reservation_code]', bokun_reservation_code)
  params.set('payment_intent_data[metadata][booking_id]', String(booking_id))
  params.set('payment_intent_data[metadata][bokun_reservation_code]', bokun_reservation_code)

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })
  const session = await stripeRes.json()
  console.log('[Stripe] session:', JSON.stringify({ id: session.id, url: session.url, error: session.error }))

  if (guest_email && session.url) {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Thousand Miles <rezerwacje@thousandmiles.pl>',
        to: guest_email,
        subject: `Payment link: ${tour_name}`,
        html: `
          <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
            <h2 style="color:#3A3A3A;margin-bottom:8px">Your tour booking</h2>
            <p style="color:#666;margin-bottom:4px"><strong>${tour_name}</strong></p>
            <p style="color:#666;margin-bottom:24px">Date: ${date} &nbsp;·&nbsp; ${pax} guest${pax > 1 ? 's' : ''}</p>
            <a href="${session.url}"
               style="display:inline-block;background:#E8751A;color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:600;font-size:15px">
              Pay now — ${amount_pln} PLN
            </a>
            <p style="color:#999;font-size:12px;margin-top:24px">Questions? Reply to this email or contact us at rezerwacje@thousandmiles.pl</p>
            <div style="margin-top:16px;padding:12px 16px;background:#FEF3C7;border-radius:8px;border-left:4px solid #F59E0B">
              <p style="margin:0;color:#92400E;font-size:13px;font-weight:600">Please note</p>
              <p style="margin:4px 0 0;color:#92400E;font-size:13px">Your spot is reserved for 30 minutes. Please complete payment promptly to secure your booking.</p>
            </div>

            <div style="margin-top:36px;border-top:2px solid #eee;padding-top:28px">
              <div style="display:inline-block;background:#DC2626;color:#fff;font-size:11px;font-weight:700;letter-spacing:1px;padding:4px 12px;border-radius:6px;margin-bottom:20px">PAYMENT PENDING</div>
              <table style="width:100%;border-collapse:collapse;font-size:14px">
                <tr><td style="padding:8px 0;color:#999;width:40%">Booking ref</td><td style="padding:8px 0;color:#3A3A3A;font-weight:600">#TM-${booking_id}</td></tr>
                <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Guest</td><td style="padding:8px 0;color:#3A3A3A">${guest_name}</td></tr>
                <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Tour</td><td style="padding:8px 0;color:#3A3A3A">${tour_name}</td></tr>
                <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Date</td><td style="padding:8px 0;color:#3A3A3A">${date}</td></tr>
                <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Guests</td><td style="padding:8px 0;color:#3A3A3A">${pax}</td></tr>
                <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Amount</td><td style="padding:8px 0;color:#3A3A3A;font-weight:600">${amount_pln} PLN</td></tr>
              </table>
              <p style="color:#999;font-size:12px;margin-top:16px;font-style:italic">This voucher will be updated once payment is complete.</p>
            </div>
          </div>
        `,
      }),
    })
    console.log('[Resend] status:', emailRes.status)
  }

  return new Response(
    JSON.stringify({ session_url: session.url, session_id: session.id }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  )
})
