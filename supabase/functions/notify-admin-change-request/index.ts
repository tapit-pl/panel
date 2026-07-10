const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const FIELD_LABELS: Record<string, string> = {
  guest:             'Guest name',
  additional_guests: 'Additional guests',
  email:             'Email',
  phone:             'Phone',
  notes:             'Notes',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const { booking_id, partner_name, changes } = await req.json()
  if (!booking_id || !changes) {
    return new Response(JSON.stringify({ error: 'booking_id and changes required' }), { status: 400, headers: CORS })
  }

  const rows = Object.entries(changes as Record<string, { old: string; new: string }>)
    .map(([field, diff]) => `
      <tr>
        <td style="padding:8px 12px;font-weight:bold;width:35%;border-bottom:1px solid #eee">${FIELD_LABELS[field] || field}</td>
        <td style="padding:8px 12px;color:#888;border-bottom:1px solid #eee;text-decoration:line-through">${diff.old || '(empty)'}</td>
        <td style="padding:8px 12px;color:#16A34A;font-weight:bold;border-bottom:1px solid #eee">${diff.new || '(empty)'}</td>
      </tr>`)
    .join('')

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#333;font-size:13px">
      <h2 style="margin:0 0 6px;font-size:18px">Change Request</h2>
      <p style="margin:0 0 20px;color:#666">Partner <strong>${partner_name}</strong> requested changes to booking <strong>#${booking_id}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:12px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #ddd">Field</th>
            <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #ddd">Current value</th>
            <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #ddd">Requested value</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:0;font-size:12px;color:#888">Please log in to the admin panel to approve or reject this request.</p>
      <a href="https://panel.thousandmiles.pl/admin.html" style="display:inline-block;margin-top:12px;background:#E8751A;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:13px">Open Admin Panel</a>
    </div>
  `

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Thousand Miles Panel <rezerwacje@thousandmiles.pl>',
      to: 'kontakt@tapit.com.pl',
      subject: `Change request — ${partner_name} — Booking #${booking_id}`,
      html,
    }),
  })

  const status = emailRes.status
  console.log('[notify-admin-change-request] email status:', status, 'booking:', booking_id)

  return new Response(JSON.stringify({ ok: status < 300 }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})
