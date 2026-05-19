import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function bokunDate(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`
}

function rfcDate(): string {
  return new Date().toUTCString()
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

// Escape all non-ASCII characters as \uXXXX so Bokun's parser always gets pure ASCII JSON
function safeJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/[-￿]/g, c => `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`)
}

async function tryVariant(label: string, date: string, message: string, secret: string, path: string, accessKey: string) {
  const signature = await hmac(secret, message)
  try {
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
    const body = await res.text()
    let parsed
    try { parsed = JSON.parse(body) } catch { parsed = body }
    const ok = !body.includes('Invalid signature')
    return { label, status: res.status, ok, preview: typeof parsed === 'object' ? JSON.stringify(parsed).slice(0, 120) : String(parsed).slice(0, 120) }
  } catch (e) {
    return { label, status: 0, ok: false, preview: String(e) }
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const body = await req.json()
    const accessKey = Deno.env.get('BOKUN_ACCESS_KEY')!
    const secretKey = Deno.env.get('BOKUN_SECRET_KEY')!

    // SIGNATURE TEST MODE
    if (body.signatureTest) {
      const activityId = body.activityId || '225214'
      const today = new Date()
      const fmt = (d: Date) => d.toISOString().slice(0, 10)
      const start = fmt(today)
      const end = fmt(new Date(today.getTime() + 30 * 86400000))
      const fullPath = `/activity.json/${activityId}/availabilities?start=${start}&end=${end}`
      const basePath = `/activity.json/${activityId}/availabilities`
      const fullPathEncoded = `/activity.json/${activityId}/availabilities?start=${start}%26end=${end}`
      const fullPathSorted = `/activity.json/${activityId}/availabilities?end=${end}&start=${start}`

      const d1 = bokunDate()
      const d2 = rfcDate()

      const variants = [
        { label: 'V1: custom-date + full-path', date: d1, msg: d1 + accessKey + 'GET' + fullPath },
        { label: 'V2: custom-date + base-path (no query)', date: d1, msg: d1 + accessKey + 'GET' + basePath },
        { label: 'V3: rfc-date + full-path', date: d2, msg: d2 + accessKey + 'GET' + fullPath },
        { label: 'V4: rfc-date + base-path', date: d2, msg: d2 + accessKey + 'GET' + basePath },
        { label: 'V5: custom-date + full-path + newlines', date: d1, msg: d1 + '\n' + accessKey + '\n' + 'GET' + '\n' + fullPath },
        { label: 'V6: custom-date + base-path + newlines', date: d1, msg: d1 + '\n' + accessKey + '\n' + 'GET' + '\n' + basePath },
        { label: 'V7: rfc-date + full-path + newlines', date: d2, msg: d2 + '\n' + accessKey + '\n' + 'GET' + '\n' + fullPath },
        { label: 'V8: rfc-date + base-path + newlines', date: d2, msg: d2 + '\n' + accessKey + '\n' + 'GET' + '\n' + basePath },
        { label: 'V9: custom-date + & encoded as %26', date: d1, msg: d1 + accessKey + 'GET' + fullPathEncoded },
        { label: 'V10: custom-date + sorted params', date: d1, msg: d1 + accessKey + 'GET' + fullPathSorted },
        { label: 'V11: lowercase method + full-path', date: d1, msg: d1 + accessKey + 'get' + fullPath },
        { label: 'V12: path without leading slash', date: d1, msg: d1 + accessKey + 'GET' + fullPath.slice(1) },
        { label: 'V13: accessKey first', date: d1, msg: accessKey + d1 + 'GET' + fullPath },
        { label: 'V14: rfc-date + sorted params', date: d2, msg: d2 + accessKey + 'GET' + fullPathSorted },
        { label: 'V15: rfc-date + & encoded', date: d2, msg: d2 + accessKey + 'GET' + fullPathEncoded },
      ]

      const results = []
      for (const v of variants) {
        const r = await tryVariant(v.label, v.date, v.msg, secretKey, fullPath, accessKey)
        results.push(r)
        if (r.ok) results.push({ label: '*** WINNER ***', winner: v.label, message: v.msg })
      }

      return new Response(JSON.stringify({ results, fullPath }, null, 2), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // NORMAL MODE
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
    if (method.toUpperCase() === 'POST' && payload !== undefined) {
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
