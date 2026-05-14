import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
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

  // Verify caller is an authenticated partner (manager)
  const callerClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } }
  })
  const { data: { user: caller } } = await callerClient.auth.getUser()
  if (!caller) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const { partner_id, first_name, last_name, email } = await req.json()
  if (!partner_id || !first_name || !email) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // Verify caller owns this partner_id (or is the admin)
  const isAdmin = caller.email === 'kontakt@tapit.com.pl'
  if (!isAdmin) {
    const { data: partnerRow } = await adminClient.from('partners').select('email').eq('id', partner_id).maybeSingle()
    if (!partnerRow || partnerRow.email !== caller.email) {
      return new Response(JSON.stringify({ error: 'Forbidden: not your partner account' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
  }

  // Check if email already exists in staff table
  const { data: existing } = await adminClient.from('staff').select('id').eq('email', email).maybeSingle()
  if (existing) {
    return new Response(JSON.stringify({ error: 'A staff member with this email already exists.' }), { status: 409, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // Insert into staff table first (before invite, so redirectByRole can find it)
  const { data: staffRow, error: insertError } = await adminClient.from('staff').insert({
    partner_id,
    first_name,
    last_name: last_name || '',
    email,
    active: true
  }).select().single()

  if (insertError) {
    return new Response(JSON.stringify({ error: insertError.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // Send invite email
  const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
    redirectTo: 'https://panel.thousandmiles.pl',
    data: { role: 'staff', partner_id }
  })

  if (inviteError) {
    // Rollback staff insert
    await adminClient.from('staff').delete().eq('id', staffRow.id)
    return new Response(JSON.stringify({ error: inviteError.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // Store auth_user_id
  if (inviteData?.user?.id) {
    await adminClient.from('staff').update({ auth_user_id: inviteData.user.id }).eq('id', staffRow.id)
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
