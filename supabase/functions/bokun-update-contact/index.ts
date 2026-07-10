const CORS = {
  'Access-Control-Allow-Origin': '*',
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

async function bokunFetch(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const accessKey = Deno.env.get('BOKUN_ACCESS_KEY')!
  const secretKey = Deno.env.get('BOKUN_SECRET_KEY')!
  const date = bokunDate()
  const sig = await hmac(secretKey, date + accessKey + method + path)
  const opts: RequestInit = {
    method,
    headers: {
      'X-Bokun-Date': date,
      'X-Bokun-AccessKey': accessKey,
      'X-Bokun-Signature': sig,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetch(`https://api.bokun.io${path}`, opts)
  let data: unknown
  try { data = await res.json() } catch { data = await res.text() }
  return { status: res.status, data }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const { confirmationCode, firstName, lastName, email, phoneNumber } = await req.json()
  if (!confirmationCode) {
    return new Response(JSON.stringify({ error: 'confirmationCode required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // Search by confirmation code
  const { status: searchStatus, data: searchData } = await bokunFetch('POST', '/booking.json/booking-search', {
    confirmationCodeList: [confirmationCode],
    pageSize: 1,
    page: 0,
  })
  console.log('[bokun-update-contact] search status:', searchStatus, 'totalHits:', (searchData as Record<string,unknown>)?.totalHits, 'items:', ((searchData as Record<string,unknown>)?.items as unknown[])?.length)

  const items = (searchData as Record<string, unknown>)?.items
  const booking = Array.isArray(items) && items.length > 0 ? items[0] : null

  if (!booking) {
    return new Response(JSON.stringify({ error: 'Booking not found', searchStatus, totalHits: (searchData as Record<string,unknown>)?.totalHits }), {
      status: 404, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  // Patch customer fields
  const bk = booking as Record<string, unknown>
  const internalId = bk.id
  console.log('[bokun-update-contact] found booking id:', internalId, 'confirmationCode:', bk.confirmationCode)

  const customer = (bk.customer && typeof bk.customer === 'object' ? { ...(bk.customer as object) } : {}) as Record<string, unknown>
  if (firstName   !== undefined) customer.firstName   = firstName
  if (lastName    !== undefined) customer.lastName    = lastName
  if (email       !== undefined) customer.email       = email
  if (phoneNumber !== undefined) customer.phoneNumber = phoneNumber
  bk.customer = customer

  // PUT booking back
  const { status: putStatus, data: putData } = await bokunFetch('PUT', `/booking.json/${internalId}`, bk)
  console.log('[bokun-update-contact] PUT status:', putStatus, JSON.stringify(putData).slice(0, 200))

  return new Response(JSON.stringify({ putStatus, putData }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})
