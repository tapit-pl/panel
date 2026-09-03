import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const today = new Date().toISOString().slice(0, 10)

  const { data, error } = await db
    .from('custom_packages')
    .update({ status: 'arrived' })
    .in('status', ['paid', 'confirmed'])
    .lt('date', today)
    .not('date', 'is', null)
    .select('id')

  if (error) {
    console.error('[mark-arrived] error:', error.message)
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  console.log('[mark-arrived] updated:', data?.length ?? 0, 'packages to arrived')
  return new Response(JSON.stringify({ updated: data?.length ?? 0 }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
