import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
  const authClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })

  const url = new URL(req.url)
  const activityId = url.searchParams.get('activityId')

  if (!activityId) {
    return new Response(JSON.stringify({ error: 'activityId param required' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const accessKey = Deno.env.get('BOKUN_ACCESS_KEY')!
  const secretKey = Deno.env.get('BOKUN_SECRET_KEY')!
  const path = `/activity.json/${activityId}/pickup-places`
  const date = bokunDate()
  const message = date + accessKey + 'GET' + path
  const signature = await hmac(secretKey, message)

  const res = await fetch(`https://api.bokun.io${path}`, {
    method: 'GET',
    headers: {
      'X-Bokun-Date': date,
      'X-Bokun-AccessKey': accessKey,
      'X-Bokun-Signature': signature,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  })

  const data = await res.json()
  console.log('[bokun-pickup-places] activityId:', activityId, 'count:', Array.isArray(data) ? data.length : 'N/A')

  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})
