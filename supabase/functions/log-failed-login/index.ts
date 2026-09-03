import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = { 'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

// No auth required by design — a failed login attempt has no session to authenticate with.
// Called from the shared login screen (index.html) whenever signInWithPassword() returns an error.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const body = await req.json().catch(() => ({}))
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : ''
  const errorMessage = typeof body.error_message === 'string' ? body.error_message.slice(0, 300) : 'Unknown error'
  if (!email) return new Response(JSON.stringify({ error: 'Missing email' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown'
  const userAgent = typeof body.user_agent === 'string' ? body.user_agent.slice(0, 200) : ''

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { error: insertErr } = await db.from('audit_log').insert({
    action: 'login_failed',
    details: `Failed login for ${email} — ${errorMessage} (IP: ${ip}${userAgent ? `, ${userAgent}` : ''})`,
    ref: email,
    user_email: email,
  })
  if (insertErr) {
    console.error('log-failed-login insert error:', insertErr.message)
    return new Response(JSON.stringify({ ok: false, error: insertErr.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
