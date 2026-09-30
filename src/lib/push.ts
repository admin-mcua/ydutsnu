// Minimal Web Push for Cloudflare Workers (no npm deps).
// We send "empty" pushes signed with VAPID (ES256 via WebCrypto). When the
// service worker receives the push it calls /api/push/pending to fetch the
// queued notification text for that device. This avoids payload encryption
// while still showing real phone / desktop notifications.

const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64urlStr = (str: string) => b64url(new TextEncoder().encode(str))
const fromB64url = (s: string) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

type Vapid = { publicKey: string; privateJwk: JsonWebKey }
let cached: Vapid | null = null

// VAPID keys are created once and stored in D1 (app_config)
export async function getVapid(db: D1Database): Promise<Vapid> {
  if (cached) return cached
  const row = await db.prepare("SELECT value FROM app_config WHERE key = 'vapid'").first<any>()
  if (row) {
    cached = JSON.parse(row.value)
    return cached!
  }
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  const raw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer
  const v: Vapid = { publicKey: b64url(raw), privateJwk }
  await db.prepare("INSERT OR IGNORE INTO app_config (key, value) VALUES ('vapid', ?)").bind(JSON.stringify(v)).run()
  // Re-read in case another request created it at the same time
  const again = await db.prepare("SELECT value FROM app_config WHERE key = 'vapid'").first<any>()
  cached = again ? JSON.parse(again.value) : v
  return cached!
}

async function vapidHeader(v: Vapid, endpoint: string) {
  const aud = new URL(endpoint).origin
  const header = b64urlStr(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const payload = b64urlStr(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:hello@unstudy.app' }))
  const key = await crypto.subtle.importKey('jwk', v.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(header + '.' + payload))
  return `vapid t=${header}.${payload}.${b64url(sig)}, k=${v.publicKey}`
}

export async function sendEmptyPush(db: D1Database, sub: { id: number; endpoint: string }) {
  try {
    const v = await getVapid(db)
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: await vapidHeader(v, sub.endpoint), TTL: '86400', Urgency: 'high', 'Content-Length': '0' }
    })
    // Subscription expired / unsubscribed → forget it
    if (res.status === 404 || res.status === 410) {
      await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run()
      await db.prepare('DELETE FROM push_queue WHERE sub_id = ?').bind(sub.id).run()
    }
    return res.ok
  } catch (e) {
    return false
  }
}

/**
 * Queue a notification for every device of the given users and wake them up.
 * Max ~40 devices per call (Workers sub-request limit); the rest still get the
 * in-app notification when they open the app.
 */
export async function pushToUsers(db: D1Database, userIds: number[], msg: { title: string; body: string; url?: string; tag?: string }) {
  if (!userIds.length) return
  const ids = [...new Set(userIds)].slice(0, 5000)
  const subs: any[] = []
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    const { results } = await db
      .prepare(`SELECT id, endpoint FROM push_subscriptions WHERE user_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<any>()
    subs.push(...results)
  }
  if (!subs.length) return
  const limited = subs.slice(0, 40)
  const stmts = limited.map((s) =>
    db.prepare('INSERT INTO push_queue (sub_id, title, body, url, tag) VALUES (?, ?, ?, ?, ?)')
      .bind(s.id, msg.title.slice(0, 120), msg.body.slice(0, 300), msg.url || '/app', msg.tag || 'unstudy')
  )
  await db.batch(stmts)
  await Promise.all(limited.map((s) => sendEmptyPush(db, s)))
}

export { fromB64url }
