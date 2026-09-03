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

  // Create new admin/staff user — admin or manager role required.
  // Manager may only create staff/manager accounts, never admin (privilege escalation guard).
  if (action === 'create_admin') {
    if (callerRole !== 'admin' && callerRole !== 'manager') {
      return new Response(JSON.stringify({ error: 'Forbidden: admin or manager role required' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const { email, firstName, lastName, password: newPassword, role: newRole } = body
    if (!email || !newRole || !newPassword) {
      return new Response(JSON.stringify({ error: 'Missing required fields: email, password, role' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const validRoles = ['admin', 'manager', 'staff']
    if (!validRoles.includes(newRole)) {
      return new Response(JSON.stringify({ error: 'Invalid role' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    if (callerRole === 'manager' && newRole === 'admin') {
      return new Response(JSON.stringify({ error: 'Forbidden: manager cannot create admin accounts' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // Check if already exists in admin_users or partners
    const { data: existing } = await adminClient.from('admin_users').select('email').eq('email', email).maybeSingle()
    if (existing) {
      return new Response(JSON.stringify({ error: 'User already exists in admin panel' }), { status: 409, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const { data: existingPartner } = await adminClient.from('partners').select('email').eq('email', email).maybeSingle()
    if (existingPartner) {
      return new Response(JSON.stringify({ error: 'This email is already registered as a partner. Remove them from Partners first.' }), { status: 409, headers: { ...CORS, 'Content-Type': 'application/json' } })
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

  // Create new partner — admin, manager, or staff role required
  if (!action || action === 'create') {
    if (callerRole !== 'admin' && callerRole !== 'manager' && callerRole !== 'staff') {
      return new Response(JSON.stringify({ error: 'Forbidden: admin, manager or staff role required' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const { password, name, phone, address } = body
    const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : body.email
    if (!email || !password || !name) {
      return new Response(JSON.stringify({ error: 'Missing required fields: email, password, name' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // Check if email is already in admin_users or partners
    const { data: existingAdmin } = await adminClient.from('admin_users').select('email').eq('email', email).maybeSingle()
    if (existingAdmin) {
      return new Response(JSON.stringify({ error: 'This email is already registered as a staff/admin user. Remove them from Staff first.' }), { status: 409, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const { data: existingPartner } = await adminClient.from('partners').select('email').eq('email', email).maybeSingle()
    if (existingPartner) {
      return new Response(JSON.stringify({ error: 'A partner with this email already exists.' }), { status: 409, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })

    const authUserAlreadyExisted = !!authError
    if (authError) {
      const m = String(authError.message || authError).toLowerCase()
      const isUserExists = m.includes('already') || m.includes('registered') || m.includes('exists') || m.includes('duplicate')
      if (!isUserExists) {
        return new Response(JSON.stringify({ error: authError.message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      // Auth user already exists — proceed to insert into partners table
    }

    const { street, house, apt, postal, city } = address ?? {}
    const addressStr = [street, house, apt, postal, city].filter(Boolean).join(', ')
    const tourGroups = Array.isArray(body.tour_groups) ? body.tour_groups : []

    const { error: insertError } = await adminClient.from('partners').insert({
      email,
      name,
      phone: phone ?? '',
      address: addressStr,
      active: true,
      role: 'manager',
      tour_groups: tourGroups,
    })

    if (insertError) {
      if (!authUserAlreadyExisted && authData?.user?.id) {
        await adminClient.auth.admin.deleteUser(authData.user.id)
      }
      return new Response(JSON.stringify({ error: insertError.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // Update password — self-service always allowed; resetting a partner's or a staff/manager
  // account's password requires admin or manager; resetting an ADMIN account's password stays
  // admin-only (privilege escalation guard — a manager must never touch an admin's credentials).
  // Service role key bypasses MFA/AAL2 requirements entirely
  if (action === 'set_password') {
    const { partner_email, new_password } = body
    if (!new_password) {
      return new Response(JSON.stringify({ error: 'Missing new_password' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const isSelf = !partner_email || partner_email === caller.email
    if (!isSelf) {
      const { data: partnerRow } = await adminClient.from('partners').select('email').eq('email', partner_email).maybeSingle()
      const isPartnerTarget = !!partnerRow
      if (isPartnerTarget) {
        if (callerRole !== 'admin' && callerRole !== 'manager' && callerRole !== 'staff') {
          return new Response(JSON.stringify({ error: 'Forbidden: admin, manager or staff role required' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
      } else {
        const { data: targetAdminRow } = await adminClient.from('admin_users').select('role').eq('email', partner_email).maybeSingle()
        const targetRole = targetAdminRow?.role
        if (targetRole === 'admin') {
          if (callerRole !== 'admin') {
            return new Response(JSON.stringify({ error: 'Forbidden: admin role required' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
          }
        } else if (callerRole !== 'admin' && callerRole !== 'manager') {
          return new Response(JSON.stringify({ error: 'Forbidden: admin or manager role required' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
      }
    }

    // If changing own password, use caller.id directly — no listUsers needed
    let targetId: string
    if (isSelf) {
      targetId = caller.id
    } else {
      // Find by email via GoTrue filter API — avoids fetching all users
      const _url = Deno.env.get('SUPABASE_URL')!
      const _key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      const filterRes = await fetch(
        `${_url}/auth/v1/admin/users?filter=${encodeURIComponent(partner_email)}&per_page=10`,
        { headers: { 'apikey': _key, 'Authorization': `Bearer ${_key}` } }
      )
      if (!filterRes.ok) {
        return new Response(JSON.stringify({ error: 'Failed to find auth user' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      const filterData = await filterRes.json()
      const target = filterData?.users?.find((u: { email?: string }) => u.email?.toLowerCase() === partner_email.toLowerCase())
      if (!target) {
        return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      targetId = target.id
    }

    const { error: updateError } = await adminClient.auth.admin.updateUserById(targetId, { password: new_password })
    if (updateError) {
      return new Response(JSON.stringify({ error: updateError.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // Sync a partner's Supabase Auth login email after it's been edited — admin, manager or staff.
  // Without this, editing a partner's email in the panel only changes the `partners` row and
  // leaves the real Auth login tied to the old address, locking the partner out.
  if (action === 'set_email') {
    if (callerRole !== 'admin' && callerRole !== 'manager' && callerRole !== 'staff') {
      return new Response(JSON.stringify({ error: 'Forbidden: admin, manager or staff role required' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const { old_email, new_email } = body
    if (!old_email || !new_email) {
      return new Response(JSON.stringify({ error: 'Missing old_email or new_email' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const _url = Deno.env.get('SUPABASE_URL')!
    const _key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const filterRes = await fetch(
      `${_url}/auth/v1/admin/users?filter=${encodeURIComponent(old_email)}&per_page=10`,
      { headers: { 'apikey': _key, 'Authorization': `Bearer ${_key}` } }
    )
    if (!filterRes.ok) {
      return new Response(JSON.stringify({ error: 'Failed to find auth user' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    const filterData = await filterRes.json()
    const target = filterData?.users?.find((u: { email?: string }) => u.email?.toLowerCase() === old_email.toLowerCase())
    if (!target) {
      return new Response(JSON.stringify({ error: 'No auth account found for the current email — cannot change it safely' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const { error: updateError } = await adminClient.auth.admin.updateUserById(target.id, { email: new_email, email_confirm: true })
    if (updateError) {
      return new Response(JSON.stringify({ error: updateError.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
})
