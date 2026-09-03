import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const adminClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  // Verify caller is admin
  const callerClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } }
  })
  const { data: { user: caller } } = await callerClient.auth.getUser()
  if (!caller) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const { data: callerRow } = await adminClient.from('admin_users').select('role').eq('email', caller.email).maybeSingle()
  if (!callerRow || callerRow.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden: admin role required' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const { email, action } = await req.json()
  if (!email) return new Response(JSON.stringify({ error: 'Missing email' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  if (email.toLowerCase() === caller.email?.toLowerCase()) return new Response(JSON.stringify({ error: 'Cannot modify your own account' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })

  // Find Auth user
  const { data: listData } = await adminClient.auth.admin.listUsers({ perPage: 1000 })
  const authUser = listData?.users?.find((u: { email?: string }) => u.email?.toLowerCase() === email.toLowerCase())

  if (action === 'deactivate' || action === 'activate') {
    const ban_duration = action === 'deactivate' ? '87600h' : 'none'
    if (authUser) {
      const { error } = await adminClient.auth.admin.updateUserById(authUser.id, { ban_duration })
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    await adminClient.from('admin_users').update({ active: action === 'activate' }).eq('email', email)
    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // action === 'delete' (default)
  const { error: dbError } = await adminClient.from('admin_users').delete().eq('email', email)
  if (dbError) return new Response(JSON.stringify({ error: dbError.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (authUser) {
    const { error } = await adminClient.auth.admin.deleteUser(authUser.id)
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
