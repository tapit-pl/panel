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

  // Verify caller is the admin
  const callerClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } }
  })
  const { data: { user: caller } } = await callerClient.auth.getUser()
  if (!caller || caller.email !== 'kontakt@tapit.com.pl') {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const { email } = await req.json()
  if (!email) return new Response(JSON.stringify({ error: 'Missing email' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })

  // Find partner id first
  const { data: partner } = await adminClient.from('partners').select('id').eq('email', email).single()
  const partnerId = partner?.id

  if (partnerId) {
    // Nullify staff_id in bookings before deleting staff (FK: bookings.staff_id → staff.id)
    const { data: staffRows } = await adminClient.from('staff').select('id').eq('partner_id', partnerId)
    const staffIds = (staffRows ?? []).map((s: { id: string }) => s.id)
    if (staffIds.length > 0) {
      await adminClient.from('bookings').update({ staff_id: null }).in('staff_id', staffIds)
    }

    // Cascade: nullify partner_id in bookings, print_orders, tickets (keep historical data)
    await adminClient.from('bookings').update({ partner_id: null }).eq('partner_id', partnerId)
    await adminClient.from('print_orders').update({ partner_id: null }).eq('partner_id', partnerId)
    await adminClient.from('tickets').update({ partner_id: null }).eq('partner_id', partnerId)

    // Cascade: delete records owned by this partner
    await adminClient.from('settlements').delete().eq('partner_id', partnerId)
    await adminClient.from('staff').delete().eq('partner_id', partnerId)
    await adminClient.from('user_roles').delete().eq('partner_id', partnerId)
  }

  // Delete from partners table
  const { error: dbError } = await adminClient.from('partners').delete().eq('email', email)
  if (dbError) return new Response(JSON.stringify({ error: dbError.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })

  // Delete Supabase Auth user (skip if already deleted)
  const { data: { users } } = await adminClient.auth.admin.listUsers()
  const user = users.find((u: any) => u.email === email)
  if (user) {
    const { error } = await adminClient.auth.admin.deleteUser(user.id)
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
