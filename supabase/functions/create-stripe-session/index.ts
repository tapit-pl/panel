import Stripe from 'https://esm.sh/stripe@14?target=deno'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const { booking_id, bokun_reservation_code, amount_pln, pax, tour_name, date, guest_name, guest_email } = await req.json()

  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-04-10', httpClient: Stripe.createFetchHttpClient() })

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: guest_email || undefined,
    line_items: [{
      price_data: {
        currency: 'pln',
        product_data: {
          name: tour_name,
          description: `${date} · ${pax} os.`,
        },
        unit_amount: Math.round(amount_pln * 100),
      },
      quantity: 1,
    }],
    success_url: 'https://panel.thousandmiles.pl/payment-success.html',
    cancel_url:  'https://panel.thousandmiles.pl/payment-cancel.html',
    metadata: { booking_id: String(booking_id), bokun_reservation_code },
    payment_intent_data: {
      metadata: { booking_id: String(booking_id), bokun_reservation_code },
    },
  })

  // Send email via Resend
  if (guest_email) {
    await fetch('https://api.resend.com/emails', {
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
            <p style="color:#999;font-size:12px;margin-top:24px">This link expires in 24 hours. Questions? Reply to this email.</p>
          </div>
        `,
      }),
    })
  }

  return new Response(
    JSON.stringify({ session_url: session.url, session_id: session.id }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  )
})
