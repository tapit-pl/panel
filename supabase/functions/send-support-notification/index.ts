import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { ticket_id, partner_name, partner_email, subject, message, category, priority } = await req.json()

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Pobierz adres do powiadomień
    const { data: setting } = await adminClient
      .from('app_settings')
      .select('value')
      .eq('key', 'support_notification_email')
      .maybeSingle()

    const notifyEmail = setting?.value
    if (!notifyEmail) {
      return new Response(JSON.stringify({ ok: true, skipped: 'no notification email set' }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    const priorityLabel: Record<string, string> = {
      low: '🟢 Niski', normal: '🔵 Normalny', high: '🟠 Wysoki', urgent: '🔴 Pilny'
    }
    const categoryLabel: Record<string, string> = {
      general: 'Ogólne', booking: 'Rezerwacja', payment: 'Płatność', technical: 'Techniczny', other: 'Inne'
    }

    const ticketShortId = (ticket_id || '').substring(0, 8).toUpperCase()
    const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#333;font-size:14px">
  <div style="border-bottom:3px solid #E8751A;padding-bottom:16px;margin-bottom:24px;display:flex;align-items:center;gap:12px">
    <img src="https://panel.thousandmiles.pl/assets/logo.png" style="height:40px">
    <span style="font-size:18px;font-weight:bold;color:#111">Nowe zgłoszenie partnera</span>
  </div>

  <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
    <tr><td style="padding:6px 0;color:#666;width:120px">Ticket</td><td style="padding:6px 0;font-weight:bold">#${ticketShortId}</td></tr>
    <tr><td style="padding:6px 0;color:#666">Partner</td><td style="padding:6px 0">${escHtml(partner_name)} &lt;${escHtml(partner_email)}&gt;</td></tr>
    <tr><td style="padding:6px 0;color:#666">Temat</td><td style="padding:6px 0;font-weight:bold">${escHtml(subject)}</td></tr>
    <tr><td style="padding:6px 0;color:#666">Kategoria</td><td style="padding:6px 0">${categoryLabel[category] || category}</td></tr>
    <tr><td style="padding:6px 0;color:#666">Priorytet</td><td style="padding:6px 0">${priorityLabel[priority] || priority}</td></tr>
  </table>

  <div style="background:#f8f9fa;border-left:4px solid #E8751A;border-radius:4px;padding:16px;margin-bottom:24px">
    <div style="font-size:12px;color:#888;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">Wiadomość</div>
    <div style="white-space:pre-wrap;line-height:1.6">${escHtml(message)}</div>
  </div>

  <a href="https://panel.thousandmiles.pl/admin.html" style="display:inline-block;background:#E8751A;color:#fff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:8px;font-size:14px">
    Odpowiedz w panelu →
  </a>

  <p style="margin-top:24px;font-size:11px;color:#aaa">Thousand Miles · panel.thousandmiles.pl</p>
</div>`

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Thousand Miles Panel <rezerwacje@thousandmiles.pl>',
        to: notifyEmail,
        subject: `[Support #${ticketShortId}] ${subject} — ${partner_name}`,
        html,
      }),
    })

    if (!emailRes.ok) {
      const err = await emailRes.text()
      console.error('Resend error:', err)
      return new Response(JSON.stringify({ ok: false, error: err }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  } catch (e) {
    console.error('send-support-notification error:', e)
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }
})

function escHtml(s: string | null | undefined): string {
  if (!s) return ''
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
