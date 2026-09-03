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

async function bokunCancel(confirmationCode: string): Promise<void> {
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
  console.log('[check-pending-bookings] bokunCancel', confirmationCode, '→ status:', res.status, 'ok:', ok, 'msg:', msg.slice(0, 100))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
  const authClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: adminUser } = await db.from('admin_users').select('role').eq('email', user.email).maybeSingle()
  if (!adminUser) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })

  // Fallback cleanup: cancel payment_pending bookings older than 35 min
  // (safety net in case the Stripe checkout.session.expired webhook failed to arrive)
  const cutoff = new Date(Date.now() - 35 * 60 * 1000).toISOString()
  const { data: stale, error } = await db
    .from('bookings')
    .select('id, bokun_confirmation_code')
    .eq('status', 'payment_pending')
    .lt('created_at', cutoff)

  if (error) {
    console.error('[check-pending-bookings] query error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  console.log('[check-pending-bookings] stale payment_pending bookings:', stale?.length ?? 0)

  let cancelled = 0
  for (const b of stale ?? []) {
    if (b.bokun_confirmation_code) {
      await bokunCancel(b.bokun_confirmation_code)
    }
    await db.from('bookings').update({ status: 'cancelled' }).eq('id', b.id)
    console.log('[check-pending-bookings] cancelled:', b.id)
    cancelled++
  }

  return new Response(
    JSON.stringify({ processed: stale?.length ?? 0, cancelled }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  )
})
