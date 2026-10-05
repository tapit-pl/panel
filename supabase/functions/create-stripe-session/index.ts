import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = { 'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

const DEFAULT_EXPIRY_SETTINGS = { longWindowHours: 24, shortWindowHours: 1 }

// Regular tour bookings: if the tour is at least longWindowHours away, give longWindowHours to pay.
// If the tour is closer than that, give only shortWindowHours so the hold doesn't linger past the tour.
// longWindowHours is clamped to Stripe's hard cap (24h from session creation); both values floored at
// Stripe's 30-min minimum.
function computeExpiresAt(tourDate: string | null, tourTime: string | null, settings: typeof DEFAULT_EXPIRY_SETTINGS): number {
  const nowSec = Math.floor(Date.now() / 1000)
  const longHours = Math.min(24, Math.max(0.5, settings.longWindowHours || DEFAULT_EXPIRY_SETTINGS.longWindowHours))
  const shortHours = Math.min(longHours, Math.max(0.5, settings.shortWindowHours || DEFAULT_EXPIRY_SETTINGS.shortWindowHours))
  const longExpiry = nowSec + Math.round(longHours * 60 * 60)
  const shortExpiry = nowSec + Math.round(shortHours * 60 * 60)
  if (!tourDate) return longExpiry
  const timePart = tourTime && /^\d{2}:\d{2}/.test(tourTime) ? tourTime.slice(0, 5) : '00:00'
  const tourMs = new Date(`${tourDate}T${timePart}:00Z`).getTime()
  if (isNaN(tourMs)) return longExpiry
  const hoursUntilTour = (tourMs - Date.now()) / (1000 * 60 * 60)
  return hoursUntilTour >= longHours ? longExpiry : shortExpiry
}

function formatExpiryLabel(expiresAtSec: number): string {
  const d = new Date(expiresAtSec * 1000)
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (type: string) => parts.find(p => p.type === type)?.value || ''
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
  const authClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const { booking_id, custom_package_id, bokun_reservation_code, pax, tour_name, date, guest_name, guest_email, rate_selections, pickup_mode, send_email } = await req.json()

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  let amount_pln = 0
  let tourDate: string | null = null
  let tourTime: string | null = null

  // 0. Custom package: read price from custom_packages table (never trust client-provided amount)
  if (custom_package_id) {
    const { data: pkg } = await db.from('custom_packages')
      .select('guest_price').eq('id', custom_package_id).maybeSingle()
    if (pkg?.guest_price && pkg.guest_price > 0) {
      amount_pln = pkg.guest_price
      console.log('[Stripe] Using custom_package.guest_price:', amount_pln)
    } else {
      return new Response(JSON.stringify({ error: 'Custom package not found or price is zero' }), { status: 422, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
  }

  // 1. Resend: booking already in DB — use stored total (most reliable, also verifies ownership)
  if (!amount_pln && booking_id) {
    const { data: bookingRow } = await db.from('bookings')
      .select('total, partner_id, date, time')
      .eq('id', booking_id)
      .maybeSingle()

    tourDate = bookingRow?.date || null
    tourTime = bookingRow?.time || null

    if (bookingRow?.partner_id) {
      const { data: adminRow } = await db.from('admin_users').select('id').eq('email', user.email).maybeSingle()
      if (!adminRow) {
        const { data: partnerRow } = await db.from('partners').select('id').eq('email', user.email).maybeSingle()
        if (!partnerRow || partnerRow.id !== bookingRow.partner_id) {
          console.error('[Stripe] Ownership check failed — user', user.email, 'tried to access booking', booking_id)
          return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
      }
    }

    if (bookingRow?.total && bookingRow.total > 0) {
      amount_pln = bookingRow.total
      console.log('[Stripe] Using booking.total from DB:', amount_pln)
    }
  }

  // 2. New booking: compute price server-side from tour_commissions — never trust client-provided amount
  if (!amount_pln) {
    let serverBase = 0

    if (rate_selections && Array.isArray(rate_selections) && rate_selections.length > 0) {
      // Rate/package pricing: look up each rate title in tour_commissions
      for (const rs of rate_selections) {
        if (!rs?.title || !rs?.count) continue
        const { data: commRow } = await db.from('tour_commissions')
          .select('price_pln')
          .eq('title', rs.title)
          .eq('active', true)
          .maybeSingle()
        if (commRow?.price_pln) serverBase += rs.count * commRow.price_pln
      }
    }

    if (!serverBase) {
      // Pax-based pricing: look up by tour_name
      const { data: commRow } = await db.from('tour_commissions')
        .select('price_pln')
        .eq('title', tour_name)
        .eq('active', true)
        .maybeSingle()
      if (commRow?.price_pln) serverBase = commRow.price_pln * (pax || 1)
    }

    // Transport surcharge (hotel pickup)
    if (pickup_mode === 'hotel' && serverBase > 0) {
      const rateTitleForTransport = (rate_selections && rate_selections[0]?.title) || tour_name
      const { data: transportRow } = await db.from('tour_commissions')
        .select('transport_price_pln')
        .eq('title', rateTitleForTransport)
        .eq('active', true)
        .maybeSingle()
      if (transportRow?.transport_price_pln) serverBase += transportRow.transport_price_pln * (pax || 1)
    }

    if (serverBase > 0) {
      amount_pln = serverBase
      console.log('[Stripe] Server-computed price from tour_commissions:', amount_pln, 'tour:', tour_name)
    } else {
      console.error('[Stripe] Tour not found in tour_commissions:', tour_name, 'rate_selections:', JSON.stringify(rate_selections))
      return new Response(JSON.stringify({ error: 'Cannot determine price for this tour — contact Thousand Miles support' }), { status: 422, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
  }

  if (!amount_pln || amount_pln <= 0) {
    console.error('[Stripe] Cannot determine price for tour:', tour_name, 'pax:', pax)
    return new Response(JSON.stringify({ error: 'Cannot determine tour price — check tour_commissions configuration' }), { status: 422, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!
  const params = new URLSearchParams()
  params.set('mode', 'payment')
  if (guest_email) params.set('customer_email', guest_email)
  params.set('line_items[0][price_data][currency]', 'pln')
  params.set('line_items[0][price_data][product_data][name]', tour_name)
  params.set('line_items[0][price_data][product_data][description]', `${date} · ${pax} os.`)
  params.set('line_items[0][price_data][unit_amount]', String(Math.round(amount_pln * 100)))
  params.set('line_items[0][quantity]', '1')
  let expiresAt: number
  if (custom_package_id) {
    expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60
  } else {
    const { data: settingsRow } = await db.from('app_settings').select('value').eq('key', 'stripe_expiry_settings').maybeSingle()
    let expirySettings = DEFAULT_EXPIRY_SETTINGS
    if (settingsRow?.value) {
      try { expirySettings = { ...DEFAULT_EXPIRY_SETTINGS, ...JSON.parse(settingsRow.value) } } catch (_) { /* keep defaults */ }
    }
    expiresAt = computeExpiresAt(tourDate || date || null, tourTime, expirySettings)
  }
  params.set('expires_at', String(expiresAt))
  params.set('success_url', 'https://panel.thousandmiles.pl/payment-success.html')
  params.set('cancel_url', 'https://panel.thousandmiles.pl/payment-cancel.html')
  params.set('metadata[booking_id]', custom_package_id ? String(custom_package_id) : String(booking_id || ''))
  if (custom_package_id) params.set('metadata[custom_package_id]', String(custom_package_id))
  if (bokun_reservation_code) {
    params.set('metadata[bokun_reservation_code]', bokun_reservation_code)
    params.set('payment_intent_data[metadata][bokun_reservation_code]', bokun_reservation_code)
  }
  if (booking_id) params.set('payment_intent_data[metadata][booking_id]', String(booking_id))

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })
  const session = await stripeRes.json()
  console.log('[Stripe] session:', JSON.stringify({ id: session.id, url: session.url, amount_pln, status: stripeRes.status, error: session.error }))

  if (session.error || !session.url) {
    console.error('[Stripe] API error:', JSON.stringify(session.error || { message: 'no session URL returned' }))
    return new Response(
      JSON.stringify({ error: session.error?.message || 'Stripe session creation failed' }),
      { status: 422, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }

  // Update custom_package with stripe session data
  if (custom_package_id && session.id) {
    await db.from('custom_packages')
      .update({ stripe_session_id: session.id, stripe_session_url: session.url || null })
      .eq('id', custom_package_id)
  }

  if (guest_email && session.url && send_email !== false) {
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
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
            <div style="text-align:center;margin-bottom:28px">
              <img src="https://panel.thousandmiles.pl/assets/logo.png" alt="Thousand Miles" style="height:48px;display:inline-block">
            </div>
            <h2 style="color:#3A3A3A;margin-bottom:8px">Hey! Thank you for your booking!</h2>
            <p style="color:#666;margin-bottom:20px">Here is the payment link:</p>
            <p style="color:#3A3A3A;margin-bottom:4px;font-size:16px;font-weight:600">${tour_name}</p>
            <p style="color:#666;margin-bottom:24px">Date: ${date} &nbsp;·&nbsp; ${pax} guest${pax > 1 ? 's' : ''}</p>
            <a href="${session.url}"
               style="display:inline-block;background:#E8751A;color:#fff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:600;font-size:15px">
              Pay now — ${amount_pln} PLN
            </a>
            <div style="margin-top:20px;padding:12px 16px;background:#FEF3C7;border-radius:8px;border-left:4px solid #F59E0B">
              <p style="margin:0;color:#92400E;font-size:13px;font-weight:600">Please note</p>
              <p style="margin:4px 0 0;color:#92400E;font-size:13px">Your spot is reserved until ${formatExpiryLabel(expiresAt)}. Please complete payment before then to secure your booking.</p>
            </div>

            <div style="margin-top:36px;border-top:2px solid #eee;padding-top:28px">
              <div style="display:inline-block;background:#DC2626;color:#fff;font-size:11px;font-weight:700;letter-spacing:1px;padding:4px 12px;border-radius:6px;margin-bottom:20px">PAYMENT PENDING</div>
              <table style="width:100%;border-collapse:collapse;font-size:14px">
                <tr><td style="padding:8px 0;color:#999;width:40%">Booking ref</td><td style="padding:8px 0;color:#3A3A3A;font-weight:600">${custom_package_id ? 'TM-PKG-' + custom_package_id.split('-')[0].toUpperCase() : booking_id ? '#TM-' + booking_id : '—'}</td></tr>
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
