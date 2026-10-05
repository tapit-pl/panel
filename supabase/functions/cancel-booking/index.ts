import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = { 'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

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

async function bokunRequest(method: string, path: string, payload?: unknown) {
  const accessKey = Deno.env.get('BOKUN_ACCESS_KEY')!
  const secretKey = Deno.env.get('BOKUN_SECRET_KEY')!
  const date = bokunDate()
  const message = date + accessKey + method + path
  const signature = await hmac(secretKey, message)
  const res = await fetch(`https://api.bokun.io${path}`, {
    method,
    headers: {
      'X-Bokun-Date': date,
      'X-Bokun-AccessKey': accessKey,
      'X-Bokun-Signature': signature,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  })
  return { ok: res.ok, status: res.status, body: await res.json() }
}

async function bokunCancel(confirmationCode: string) {
  const path = `/booking.json/cancel-booking/${confirmationCode}`
  const res = await bokunRequest('POST', path, { notify: true })
  console.log('[Cancel] cancel response status:', res.status, 'body:', JSON.stringify(res.body).slice(0, 300))
  const msg = res.body?.message || res.body?.errorMessage || ''
  // "Booking is not confirmed" = reservation was never paid, nothing to cancel in Bokun
  const ignorable = !res.ok && (msg.toLowerCase().includes('not confirmed') || msg.toLowerCase().includes('not found'))
  return {
    ok: res.ok || ignorable,
    status: res.status,
    error: (res.ok || ignorable) ? null : (msg || `HTTP ${res.status}`),
    body: res.body,
  }
}

function escapeHtml(s: string | null | undefined): string {
  if (!s) return ''
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function sendCancellationEmail(p: { ref: string, tour_name: string, date?: string | null, guest_email?: string | null }) {
  if (!p.guest_email) return
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#333;font-size:13px">
      <h2 style="text-align:center;letter-spacing:2px;font-size:17px;margin:20px 0 6px;text-transform:uppercase">Reservation Update</h2>
      <p style="text-align:center;color:#888;font-size:12px;margin-bottom:28px">Nr: TM-${escapeHtml(p.ref)}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold;width:45%">Offer name:</td><td style="padding:8px 4px">${escapeHtml(p.tour_name)}</td></tr>
        ${p.date ? `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:8px 4px;font-weight:bold">Selected date:</td><td style="padding:8px 4px">${escapeHtml(p.date)}</td></tr>` : ''}
      </table>
      <p style="text-align:center;font-weight:bold;font-size:15px;letter-spacing:2px;margin:28px 0;padding:14px 20px;border:2px solid #DC2626;color:#DC2626">RESERVATION CANCELLED</p>
    </div>
  `
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Thousand Miles <rezerwacje@thousandmiles.pl>', to: p.guest_email, subject: `Booking cancelled: ${p.tour_name}`, html }),
  })
  console.log('[Cancel] cancellation email status:', res.status, 'to:', p.guest_email)
}

async function findStripeSessionByBookingId(bookingId: string, stripeKey: string): Promise<string | null> {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions?limit=10&metadata[booking_id]=${encodeURIComponent(bookingId)}`, {
    headers: { 'Authorization': `Bearer ${stripeKey}` }
  })
  const data = await res.json()
  const session = data?.data?.[0]
  console.log('[Cancel] Stripe session lookup by booking_id:', bookingId, '→', session?.id || 'not found')
  return session?.id || null
}

async function stripeRefund(stripeSessionId: string | null, bookingId: string): Promise<{ ok: boolean, refundId?: string, error?: string }> {
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')!

  // If session ID not in DB, search Stripe by booking_id metadata
  const sessionId = stripeSessionId || await findStripeSessionByBookingId(bookingId, stripeKey)
  if (!sessionId) return { ok: true }

  const sessionRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${stripeKey}` }
  })
  const session = await sessionRes.json()
  const paymentIntent = session.payment_intent
  console.log('[Cancel] Stripe session status:', session.payment_status, 'pi:', paymentIntent)

  if (!paymentIntent || session.payment_status !== 'paid') {
    // Expire the checkout session so the guest can't pay after cancellation
    if (session.status === 'open') {
      await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}/expire`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${stripeKey}` },
      })
      console.log('[Cancel] Stripe session expired')
    }
    return { ok: true }
  }

  const refundRes = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ payment_intent: paymentIntent }).toString(),
  })
  const refund = await refundRes.json()
  console.log('[Cancel] Stripe refund:', JSON.stringify({ id: refund.id, status: refund.status, error: refund.error }))

  if (refund.error) return { ok: false, error: refund.error.message }
  return { ok: true, refundId: refund.id }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
  const authClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const { booking_id, custom_package_id } = await req.json()
  if (!booking_id && !custom_package_id) return new Response(JSON.stringify({ error: 'Missing booking_id or custom_package_id' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // Check if caller is admin/manager/staff (any admin_users role can cancel bookings);
  // custom_package_id (Seller Panel) cancellation stays manager+ only — see check below.
  const { data: adminUser } = await db.from('admin_users').select('role').eq('email', user.email).maybeSingle()
  const isAdmin = !!adminUser

  // --- Custom package (Seller Panel) path ---
  if (custom_package_id) {
    if (!isAdmin || adminUser.role === 'staff') return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })

    const { data: pkg } = await db.from('custom_packages').select('*').eq('id', custom_package_id).maybeSingle()
    if (!pkg) return new Response(JSON.stringify({ error: 'Custom package not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })

    if (pkg.status === 'cancelled') {
      return new Response(JSON.stringify({ error: 'Already cancelled' }), { status: 409, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const results: Record<string, unknown> = {}

    if (pkg.stripe_session_id) {
      const refund = await stripeRefund(pkg.stripe_session_id, custom_package_id)
      results.stripe = refund
      const refundFailed = !refund.ok
      await db.from('custom_packages').update({
        status: refundFailed ? 'refund_failed' : 'cancelled',
        status_before_cancel: pkg.status,
        stripe_refunded: !refundFailed,
      }).eq('id', custom_package_id)
      await sendCancellationEmail({ ref: custom_package_id, tour_name: pkg.package_name, date: pkg.date, guest_email: pkg.guest_email })
      return new Response(JSON.stringify({ success: true, ...results }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // No Stripe payment — just cancel
    await db.from('custom_packages').update({ status: 'cancelled', status_before_cancel: pkg.status }).eq('id', custom_package_id)
    await sendCancellationEmail({ ref: custom_package_id, tour_name: pkg.package_name, date: pkg.date, guest_email: pkg.guest_email })
    return new Response(JSON.stringify({ success: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // --- Regular booking path ---
  const { data: booking, error: fetchErr } = await db.from('bookings').select('*').eq('id', booking_id).single()
  if (fetchErr || !booking) {
    return new Response(JSON.stringify({ error: 'Booking not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  if (!isAdmin) {
    // Partner: verify this booking belongs to their partner account
    const { data: partnerRow } = await db.from('partners').select('id').eq('email', user.email).maybeSingle()
    if (!partnerRow || booking.partner_id !== partnerRow.id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
  }

  // Atomic lock: only proceed if current status is not already cancelled/refund_failed
  // This prevents double-refund from concurrent cancel requests
  const { data: locked } = await db
    .from('bookings')
    .update({ status: 'cancelling' })
    .eq('id', booking_id)
    .in('status', ['paid', 'to_be_paid', 'pending', 'payment_pending', 'pending_payment', 'confirmed', 'link_expired'])
    .select('id')
    .maybeSingle()

  if (!locked) {
    return new Response(JSON.stringify({ error: 'Booking already cancelled or in progress' }), { status: 409, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const results: Record<string, unknown> = {}

  // Refund Stripe if payment was made
  if (booking.stripe_session_id || booking.payment_method === 'link') {
    const refund = await stripeRefund(booking.stripe_session_id, booking_id)
    results.stripe = refund
  }

  // Cancel in Bokun — look up internal booking ID via search, then cancel
  if (booking.bokun_confirmation_code) {
    console.log('[Cancel] cancelling Bokun confirmation code:', booking.bokun_confirmation_code)
    const cancel = await bokunCancel(booking.bokun_confirmation_code)
    results.bokun = { ok: cancel.ok, error: cancel.error }
  }

  // Update DB status — if refund failed, use refund_failed so admin can investigate
  const refundFailed = results.stripe && !(results.stripe as { ok: boolean }).ok
  await db.from('bookings').update({ status: refundFailed ? 'refund_failed' : 'cancelled' }).eq('id', booking_id)

  await sendCancellationEmail({
    ref: booking.bokun_confirmation_code ? String(booking.bokun_confirmation_code).replace(/^TM-/i, '') : booking_id,
    tour_name: booking.tour, date: booking.date, guest_email: booking.email,
  })

  return new Response(JSON.stringify({ success: true, ...results }), {
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })
})
