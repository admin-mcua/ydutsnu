// Collects "additional information" about a newly created account.
// Shown ONLY in the admin dashboard.
//  - Software: OS, browser, device (from User-Agent + client hints sent by the browser)
//  - Carrier / ISP: from Cloudflare's request.cf (asOrganization / ASN) → fallback IP lookup
//  - Location (internet / IP based): city, region, country, postal, lat/lon, timezone

type AnyObj = Record<string, any>

export function parseUserAgent(ua: string = '') {
  let os = 'Unknown', osVersion = ''
  let m: RegExpMatchArray | null
  if ((m = ua.match(/Windows NT ([\d.]+)/))) {
    os = 'Windows'
    osVersion = ({ '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' } as AnyObj)[m[1]] || m[1]
  } else if ((m = ua.match(/Android ([\d.]+)/))) { os = 'Android'; osVersion = m[1] }
  else if ((m = ua.match(/(?:iPhone|CPU) OS ([\d_]+)/))) { os = /iPad/.test(ua) ? 'iPadOS' : 'iOS'; osVersion = m[1].replace(/_/g, '.') }
  else if ((m = ua.match(/Mac OS X ([\d_.]+)/))) { os = 'macOS'; osVersion = m[1].replace(/_/g, '.') }
  else if (/CrOS/.test(ua)) os = 'ChromeOS'
  else if (/Linux/.test(ua)) os = 'Linux'

  let browser = 'Unknown', browserVersion = ''
  const tests: [string, RegExp][] = [
    ['Facebook App', /FBAV\/([\d.]+)/],
    ['Instagram App', /Instagram ([\d.]+)/],
    ['Messenger', /MessengerForiOS|Orca-Android/],
    ['Edge', /Edg(?:A|iOS)?\/([\d.]+)/],
    ['Opera', /(?:OPR|Opera)\/([\d.]+)/],
    ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
    ['UC Browser', /UCBrowser\/([\d.]+)/],
    ['Brave', /Brave\/([\d.]+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
    ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+).*Safari/]
  ]
  for (const [name, re] of tests) {
    const r = ua.match(re)
    if (r) { browser = name; browserVersion = r[1] || ''; break }
  }

  let deviceType = 'Desktop'
  if (/iPad|Tablet/i.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) deviceType = 'Tablet'
  else if (/Mobi|iPhone|Android/i.test(ua)) deviceType = 'Mobile'

  let device = ''
  if (/iPhone/.test(ua)) device = 'iPhone'
  else if (/iPad/.test(ua)) device = 'iPad'
  else if ((m = ua.match(/Android [\d.]+; (?:[a-z]{2}[-_][a-z]{2}; )?([^;)]+?)(?: Build|\))/i))) device = m[1].trim()
  else if (/Macintosh/.test(ua)) device = 'Mac'
  if (device === 'K') device = '' // Chrome's reduced UA hides the model

  return { os, os_version: osVersion, browser, browser_version: browserVersion, device_type: deviceType, device }
}

const str = (v: any, max = 300) => (v === undefined || v === null ? '' : String(v).slice(0, max))

function cleanClient(client: any) {
  if (!client || typeof client !== 'object') return {}
  const allowed = ['user_agent', 'platform', 'language', 'languages', 'timezone', 'screen', 'touch', 'cores',
    'memory_gb', 'connection_type', 'connection_effective', 'ch_platform', 'ch_platform_version', 'ch_model',
    'ch_mobile', 'ch_browsers']
  const out: AnyObj = {}
  for (const k of allowed) if (client[k] !== undefined && client[k] !== null && client[k] !== '') out[k] = typeof client[k] === 'boolean' || typeof client[k] === 'number' ? client[k] : str(client[k], 500)
  return out
}

// Fallback lookup when Cloudflare's request.cf isn't available (e.g. local dev).
async function ipLookup(ip: string): Promise<AnyObj | null> {
  if (!ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd)/i.test(ip)) return null
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 3000)
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: ctrl.signal })
    clearTimeout(t)
    const d: any = await r.json()
    if (!d || d.success === false) return null
    return {
      isp: d.connection?.isp || d.connection?.org || '',
      org: d.connection?.org || '',
      asn: d.connection?.asn ? String(d.connection.asn) : '',
      city: d.city || '', region: d.region || '', country: d.country || '', country_code: d.country_code || '',
      postal: d.postal || '', latitude: d.latitude, longitude: d.longitude,
      timezone: d.timezone?.id || '', continent: d.continent || '', source: 'ipwho.is'
    }
  } catch (e) {
    return null
  }
}

export async function collectSignupInfo(c: any, client: any) {
  const req = c.req.raw as Request & { cf?: AnyObj }
  const cf: AnyObj = (req as any).cf || {}
  const ip = c.req.header('CF-Connecting-IP') || (c.req.header('X-Forwarded-For') || '').split(',')[0].trim() || c.req.header('X-Real-IP') || ''
  const ua = c.req.header('User-Agent') || ''
  const cl = cleanClient(client)
  const sw = parseUserAgent(cl.user_agent || ua)

  // Client hints are more precise than the (frozen) UA string on Chrome/Android
  if (cl.ch_platform) sw.os = String(cl.ch_platform).replace('Chrome OS', 'ChromeOS')
  if (cl.ch_platform_version) {
    if (sw.os === 'Windows') sw.os_version = parseInt(cl.ch_platform_version) >= 13 ? '11' : '10'
    else sw.os_version = cl.ch_platform_version
  }
  if (cl.ch_model) sw.device = cl.ch_model

  let network: AnyObj = {
    isp: str(cf.asOrganization), asn: cf.asn ? 'AS' + cf.asn : '',
    city: str(cf.city), region: str(cf.region), country: str(cf.country), country_code: str(cf.country),
    postal: str(cf.postalCode), latitude: cf.latitude ? Number(cf.latitude) : undefined,
    longitude: cf.longitude ? Number(cf.longitude) : undefined, timezone: str(cf.timezone),
    continent: str(cf.continent), colo: str(cf.colo), source: 'cloudflare'
  }
  if (!network.isp && !network.city) {
    const look = await ipLookup(ip)
    if (look) network = { ...network, ...look, asn: look.asn ? (look.asn.startsWith('AS') ? look.asn : 'AS' + look.asn) : network.asn }
  }
  if (!network.isp) network.source = network.city ? network.source : 'unavailable'

  // Guess connection kind from the ISP name / browser's Network Information API
  const ispName = String(network.isp || '').toLowerCase()
  const mobileHint = /mobile|wireless|cellular|telecom|smart|globe|dito|vodafone|t-mobile|verizon|at&t|airtel|jio|telkomsel|orange|o2|ee\b|three|lte|4g|5g/.test(ispName)
  const connection = cl.connection_type
    ? cl.connection_type
    : sw.device_type === 'Mobile' && mobileHint ? 'Likely mobile data (carrier)' : ''

  const info = {
    software: { ...sw, user_agent: str(cl.user_agent || ua, 500), browsers_full: cl.ch_browsers || '' },
    network: {
      ...network,
      connection,
      effective_type: cl.connection_effective || '',
      maps_url: network.latitude && network.longitude ? `https://www.google.com/maps?q=${network.latitude},${network.longitude}` : ''
    },
    device: {
      screen: cl.screen || '', touch: cl.touch ?? null, cores: cl.cores ?? null, memory_gb: cl.memory_gb ?? null,
      language: cl.language || c.req.header('Accept-Language')?.split(',')[0] || '', languages: cl.languages || '',
      browser_timezone: cl.timezone || '', platform: cl.platform || ''
    },
    captured_at: new Date().toISOString()
  }
  return { ip, info }
}
