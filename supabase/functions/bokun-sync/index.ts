import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function bokunDate(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`
}


async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

function safeJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/[-￿]/g, c => `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  const authClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: adminRow } = await db.from('admin_users').select('id').eq('email', user.email).maybeSingle()
  const isAdmin = !!adminRow

  // Partners (not in admin_users) may only call read-only Bokun availability endpoints.
  // Admins have unrestricted access to all Bokun endpoints.
  let isPartner = false
  if (!isAdmin) {
    const { data: partnerRow } = await db.from('partners').select('id').eq('email', user.email).eq('active', true).maybeSingle()
    if (!partnerRow) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    isPartner = true
  }

  try {
    const body = await req.json()

    // Partners may call availability, product info, and checkout endpoints.
    // Blocked: /booking.json/booking-search and other admin-level booking management paths.
    if (isPartner) {
      const path: string = body.path || ''
      const allowed = path.startsWith('/activity.json/') ||
                      path.startsWith('/product.json/') ||
                      path.startsWith('/checkout.json/')
      if (!allowed) return new Response(JSON.stringify({ error: 'Forbidden — partners may not access this endpoint' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    const accessKey = Deno.env.get('BOKUN_ACCESS_KEY')!
    const secretKey = Deno.env.get('BOKUN_SECRET_KEY')!

    const { path, method = 'GET', payload } = body
    const date = bokunDate()
    const message = date + accessKey + method.toUpperCase() + path
    const signature = await hmac(secretKey, message)

    const options: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        'X-Bokun-Date': date,
        'X-Bokun-AccessKey': accessKey,
        'X-Bokun-Signature': signature,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    }
    if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && payload !== undefined) {
      options.body = safeJson(payload)
    }

    const res = await fetch(`https://api.bokun.io${path}`, options)
    const text = await res.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = text }

    return new Response(
      JSON.stringify({ status: res.status, body: parsed }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
