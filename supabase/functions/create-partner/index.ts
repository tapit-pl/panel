import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

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

  const { data: callerRow } = await adminClient.from('admin_users').select('role').eq('email', caller.email).maybeSingle()
  if (!callerRow) {
    return new Response(JSON.stringify({ error: 'Forbidden: admin access required' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
  const callerRole = callerRow.role as string

  const body = await req.json()
  const { action } = body

  // Create new admin/staff user — admin role required
  if (action === 'create_admin') {
    if (callerRole !== 'admin') {
      return new Response(JSON.stringify({ error: 'Forbidden: admin role required' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const { email, firstName, lastName, password: newPassword, role: newRole } = body
    if (!email || !newRole || !newPassword) {
      return new Response(JSON.stringify({ error: 'Missing required fields: email, password, role' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const validRoles = ['admin', 'manager', 'staff']
    if (!validRoles.includes(newRole)) {
      return new Response(JSON.stringify({ error: 'Invalid role' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // Check if already exists in admin_users
    const { data: existing } = await adminClient.from('admin_users').select('email').eq('email', email).maybeSingle()
    if (existing) {
      return new Response(JSON.stringify({ error: 'User already exists in admin panel' }), { status: 409, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // Create Supabase auth account (if already exists, that's fine — just add to admin_users)
    const { error: authError } = await adminClient.auth.admin.createUser({
      email,
      password: newPassword,
      email_confirm: true,
    })
    if (authError) {
      const m = authError.message.toLowerCase()
      const userExists = m.includes('already') || m.includes('registered') || m.includes('exists') || m.includes('duplicate')
      if (!userExists) {
        return new Response(JSON.stringify({ error: authError.message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      // Auth user already exists — proceed to add them to admin_users
    }

    // Insert into admin_users
    const insertData: Record<string, unknown> = { email, role: newRole, first_name: firstName || null, last_name: lastName || null }
    const { error: insertError } = await adminClient.from('admin_users').insert(insertData)
    if (insertError) {
      return new Response(JSON.stringify({ error: insertError.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // Create new partner — admin role required
  if (!action || action === 'create') {
    if (callerRole !== 'admin') {
      return new Response(JSON.stringify({ error: 'Forbidden: admin role required' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
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

  // Update partner password — admin role required
  if (action === 'set_password') {
    if (callerRole !== 'admin') {
      return new Response(JSON.stringify({ error: 'Forbidden: admin role required' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const { partner_email, new_password } = body
    if (!partner_email || !new_password) {
      return new Response(JSON.stringify({ error: 'Missing partner_email or new_password' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // Find user by email via listUsers
    const { data: listData, error: listError } = await adminClient.auth.admin.listUsers({ perPage: 1000 })
    if (listError) {
      return new Response(JSON.stringify({ error: listError.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const target = listData?.users?.find((u: { email?: string }) => u.email === partner_email)
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
