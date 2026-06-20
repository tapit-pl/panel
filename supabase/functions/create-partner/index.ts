import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const ADMIN_EMAILS = [
  'kontakt@tapit.com.pl',
  'director@thousandmiles.pl',
  'collaboration@thousandmiles.pl',
  'groups@thousandmiles.pl',
]

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const adminClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const callerClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } }
  })
  const { data: { user: caller } } = await callerClient.auth.getUser()
  if (!caller) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const isAdmin = ADMIN_EMAILS.includes(caller.email ?? '')
  if (!isAdmin) {
    const { data: adminRow } = await adminClient.from('admin_users').select('email').eq('email', caller.email).maybeSingle()
    if (!adminRow) {
      return new Response(JSON.stringify({ error: 'Forbidden: admin access required' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
  }

  const body = await req.json()
  const { action } = body

  // Create new partner
  if (!action || action === 'create') {
    const { email, password, name, phone, address } = body
    if (!email || !password || !name) {
      return new Response(JSON.stringify({ error: 'Missing required fields: email, password, name' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })

    if (authError) {
      return new Response(JSON.stringify({ error: authError.message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const { street, house, apt, postal, city } = address ?? {}
    const addressStr = [street, house, apt, postal, city].filter(Boolean).join(', ')

    const { error: insertError } = await adminClient.from('partners').insert({
      email,
      name,
      phone: phone ?? '',
      address: addressStr,
      active: true,
      role: 'manager',
    })

    if (insertError) {
      await adminClient.auth.admin.deleteUser(authData.user.id)
      return new Response(JSON.stringify({ error: insertError.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // Update partner password
  if (action === 'set_password') {
    const { partner_email, new_password } = body
    if (!partner_email || !new_password) {
      return new Response(JSON.stringify({ error: 'Missing partner_email or new_password' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const { data: { users }, error: listError } = await adminClient.auth.admin.listUsers()
    if (listError) {
      return new Response(JSON.stringify({ error: listError.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const target = users.find(u => u.email === partner_email)
    if (!target) {
      return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const { error: updateError } = await adminClient.auth.admin.updateUserById(target.id, { password: new_password })
    if (updateError) {
      return new Response(JSON.stringify({ error: updateError.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
})
