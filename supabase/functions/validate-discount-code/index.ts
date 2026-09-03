import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = { 'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
  const authClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: adminRow } = await db.from('admin_users').select('id').eq('email', user.email).maybeSingle()
  const { data: partnerRow } = await db.from('partners').select('id').eq('email', user.email).maybeSingle()
  if (!adminRow && !partnerRow) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const { code } = await req.json()
  const normalized = (code || '').trim().toUpperCase()
  if (!normalized) return new Response(JSON.stringify({ valid: false }), { headers: { ...CORS, 'Content-Type': 'application/json' } })

  const { data: row } = await db.from('discount_codes').select('code,discount_pct,active').eq('code', normalized).maybeSingle()

  if (!row || !row.active) {
    return new Response(JSON.stringify({ valid: false }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({ valid: true, discount_pct: row.discount_pct, code: row.code }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
