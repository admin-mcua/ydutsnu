// School on the user's profile.
// The browser sends the device location (navigator.geolocation) and we look up
// the nearest schools from OpenStreetMap (Overpass API, free, no API key).
import { getToken, getSession } from './lib/auth'

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
]

async function requireUser(c: any) {
  const s = await getSession(c.env.DB, getToken(c))
  if (!s || s.role !== 'user') return null
  return s
}

function distKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function escRegex(s: string) {
  return s.replace(/[\\^$.*+?()[\]{}|"]/g, (m) => (m === '"' ? '' : '\\' + m))
}

function addressOf(t: any): string {
  const parts = [
    [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '),
    t['addr:suburb'] || t['addr:village'] || t['addr:district'],
    t['addr:city'] || t['addr:town'] || t['addr:municipality'],
    t['addr:province'] || t['addr:state']
  ].filter(Boolean)
  return parts.join(', ')
}

const KIND: Record<string, string> = {
  school: 'School', college: 'College', university: 'University', kindergarten: 'Kindergarten'
}

async function overpass(query: string): Promise<any[]> {
  let lastErr: any = null
  for (const url of OVERPASS) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 15000)
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Unstudy/1.0 (school finder)' },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrl.signal
      })
      clearTimeout(t)
      if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue }
      const j: any = await r.json()
      return j.elements || []
    } catch (e) { lastErr = e }
  }
  throw lastErr || new Error('Overpass unavailable')
}

// Photon (komoot) — free OpenStreetMap search with location bias. Primary source.
const PHOTON_TAGS = ['amenity:school', 'amenity:college', 'amenity:university', 'amenity:kindergarten']
async function photon(q: string, lat: number, lng: number): Promise<any[]> {
  const params = new URLSearchParams({ q, lat: String(lat), lon: String(lng), limit: '40', zoom: '15', location_bias_scale: '0.1', lang: 'en' })
  PHOTON_TAGS.forEach((t) => params.append('osm_tag', t))
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 10000)
  try {
    const r = await fetch('https://photon.komoot.io/api/?' + params.toString(), {
      headers: { 'User-Agent': 'Unstudy/1.0 (school finder)', Accept: 'application/json' },
      signal: ctrl.signal
    })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const j: any = await r.json()
    return (j.features || []).map((f: any) => {
      const p = f.properties || {}
      const [lo, la] = f.geometry?.coordinates || []
      if (!p.name || la == null) return null
      return {
        id: (p.osm_type || 'N') + '/' + p.osm_id,
        name: String(p.name),
        kind: KIND[p.osm_value] || 'School',
        address: [[p.housenumber, p.street].filter(Boolean).join(' '), p.district || p.locality, p.city, p.state].filter(Boolean).join(', '),
        lat: la, lng: lo
      }
    }).filter(Boolean)
  } finally { clearTimeout(t) }
}

async function overpassSchools(q: string, lat: number, lng: number): Promise<any[]> {
  const nameFilter = q ? `["name"~"${escRegex(q)}",i]` : '["name"]'
  const radii = q ? [15000, 50000] : [3000, 10000, 25000]
  let elements: any[] = []
  for (const r of radii) {
    const query = `[out:json][timeout:20];nwr["amenity"~"^(school|college|university|kindergarten)$"]${nameFilter}(around:${r},${lat},${lng});out center tags 80;`
    elements = await overpass(query)
    if (elements.length >= 8) break
  }
  return elements.map((e: any) => {
    const t = e.tags || {}
    const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon
    if (!t.name || la == null || lo == null) return null
    return { id: e.type + '/' + e.id, name: String(t.name), kind: KIND[t.amenity] || 'School', address: addressOf(t), lat: la, lng: lo }
  }).filter(Boolean)
}

export function registerSchools(app: any) {
  // Nearest schools to the device location. Optional ?q= filters by name.
  app.get('/api/schools/nearby', async (c: any) => {
    const s = await requireUser(c)
    if (!s) return c.json({ error: 'Please log in to add your school.' }, 401)
    const lat = Number(c.req.query('lat')), lng = Number(c.req.query('lng'))
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      return c.json({ error: 'Turn on your location so we can find schools near you.' }, 400)
    const q = String(c.req.query('q') || '').trim().slice(0, 60)
    let found: any[] = []
    try {
      // Nearest schools: several generic searches biased to the user's location
      const queries = q ? [q] : ['school', 'high school', 'elementary school', 'university', 'college']
      const res = await Promise.allSettled(queries.map((qq) => photon(qq, lat, lng)))
      res.forEach((r) => { if (r.status === 'fulfilled') found.push(...r.value) })
      if (!res.some((r) => r.status === 'fulfilled')) throw new Error('photon failed')
    } catch (e) {
      found = []
    }
    if (!found.length) {
      try { found = await overpassSchools(q, lat, lng) } catch (e) {
        return c.json({ error: 'The school finder is busy right now. Please try again in a moment.', retryable: true }, 503)
      }
    }

    const maxKm = q ? 150 : 60
    const seen = new Set<string>()
    const schools = found
      .map((x: any) => ({ ...x, distance_km: Math.round(distKm(lat, lng, x.lat, x.lng) * 100) / 100 }))
      .filter((x: any) => {
        if (x.distance_km > maxKm) return false
        const key = x.name.toLowerCase() + '|' + Math.round(x.lat * 500) + '|' + Math.round(x.lng * 500)
        if (seen.has(key)) return false
        seen.add(key); return true
      })
      .sort((a: any, b: any) => a.distance_km - b.distance_km)
      .slice(0, 40)

    return c.json({ schools })
  })

  // Save (or remove) the school on my profile
  app.put('/api/profile/school', async (c: any) => {
    const s = await requireUser(c)
    if (!s) return c.json({ error: 'Unauthorized' }, 401)
    const b = await c.req.json().catch(() => ({}))
    if (!b || !b.name) {
      await c.env.DB.prepare('UPDATE users SET school_name = NULL, school_address = NULL, school_lat = NULL, school_lng = NULL, school_osm_id = NULL WHERE id = ?')
        .bind(s.user_id).run()
      return c.json({ ok: true, school: null })
    }
    const name = String(b.name).trim().slice(0, 120)
    const lat = Number(b.lat), lng = Number(b.lng)
    if (!name) return c.json({ error: 'Pick a school' }, 400)
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
      return c.json({ error: 'Turn on your location to add your school.' }, 400)
    const address = String(b.address || '').trim().slice(0, 200)
    const osm = b.id ? String(b.id).slice(0, 40) : null
    await c.env.DB.prepare('UPDATE users SET school_name = ?, school_address = ?, school_lat = ?, school_lng = ?, school_osm_id = ? WHERE id = ?')
      .bind(name, address, lat, lng, osm, s.user_id).run()
    return c.json({ ok: true, school: { name, address, lat, lng } })
  })
}
