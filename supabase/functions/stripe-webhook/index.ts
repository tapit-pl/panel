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
        .select('tour, date, time, guest, email, pax, total')
        .eq('id', bookingId)
        .single()

      if (booking?.email) {
        const guestPax = booking.pax ?? 1
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
            html: `
              <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
                <h2 style="color:#3A3A3A;margin-bottom:8px">Your tour is confirmed!</h2>
                <p style="color:#666;margin-bottom:24px">Payment received. We look forward to seeing you!</p>

                <div style="margin-top:8px">
                  <div style="display:inline-block;background:#16A34A;color:#fff;font-size:11px;font-weight:700;letter-spacing:1px;padding:4px 12px;border-radius:6px;margin-bottom:20px">CONFIRMED &amp; PAID</div>
                  <table style="width:100%;border-collapse:collapse;font-size:14px">
                    <tr><td style="padding:8px 0;color:#999;width:40%">Booking ref</td><td style="padding:8px 0;color:#3A3A3A;font-weight:600">#TM-${bookingId}</td></tr>
                    <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Guest</td><td style="padding:8px 0;color:#3A3A3A">${booking.guest || ''}</td></tr>
                    <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Tour</td><td style="padding:8px 0;color:#3A3A3A">${booking.tour}</td></tr>
                    <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Date</td><td style="padding:8px 0;color:#3A3A3A">${booking.date || ''}</td></tr>
                    ${booking.time ? `<tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Time</td><td style="padding:8px 0;color:#3A3A3A">${booking.time}</td></tr>` : ''}
                    <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Guests</td><td style="padding:8px 0;color:#3A3A3A">${guestPax}</td></tr>
                    <tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#999">Total paid</td><td style="padding:8px 0;color:#3A3A3A;font-weight:600">${booking.total ? booking.total + ' PLN' : ''}</td></tr>
                  </table>
                  <p style="color:#999;font-size:12px;margin-top:16px">Questions? Reply to this email or contact us at rezerwacje@thousandmiles.pl</p>
                </div>
              </div>
            `,
          }),
        })
        console.log('[Webhook] PAID voucher email status:', emailRes.status)
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
