// "Continue with Google" (OAuth 2.0 authorization-code flow, server side).
//
// Required Cloudflare secrets (Pages > Settings > Environment variables, or
// `wrangler pages secret put ...`):
//   GOOGLE_CLIENT_ID      – OAuth client ID  (Google Cloud Console > Credentials)
//   GOOGLE_CLIENT_SECRET  – OAuth client secret
// Authorized redirect URI to register in Google Cloud Console:
//   https://<your-domain>/auth/google/callback
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { randomToken } from './lib/auth'
import { collectSignupInfo } from './lib/device'
import { sendWelcome } from './social'

const STATE_COOKIE = 'unstudy_g_state'

function safeNext(n: string | undefined | null): string {
  const v = String(n || '')
  return v.startsWith('/') && !v.startsWith('//') ? v : '/'
}

function originOf(c: any): string {
  const u = new URL(c.req.url)
  return u.origin
}

function redirectUri(c: any): string {
  return (c.env.GOOGLE_REDIRECT_URI as string) || originOf(c) + '/auth/google/callback'
}

function fail(c: any, msg: string, next = '/') {
  const q = new URLSearchParams({ error: msg })
  if (next && next !== '/') q.set('next', next)
  return c.redirect('/login?' + q.toString())
}

async function uniqueUsername(db: D1Database, email: string, name: string): Promise<string> {
  let base = (email.split('@')[0] || name || 'student').toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 20)
  if (base.length < 3) base = ('student' + base).slice(0, 20)
  let candidate = base
  for (let i = 0; i < 25; i++) {
    const u = await db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').bind(candidate).first()
    const a = await db.prepare('SELECT id FROM admins WHERE LOWER(username) = LOWER(?)').bind(candidate).first()
    if (!u && !a) return candidate
    candidate = base.slice(0, 16) + Math.floor(1000 + Math.random() * 9000)
  }
  return base.slice(0, 12) + randomToken().slice(0, 8)
}

export function registerGoogle(app: any) {
  // Lets the frontend know whether the Google button can be used.
  app.get('/api/auth/config', (c: any) =>
    c.json({ google: !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET) })
  )

  // Step 1: send the user to Google's account chooser
  app.get('/auth/google/start', (c: any) => {
    const next = safeNext(c.req.query('next'))
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET)
      return fail(c, 'Google sign-in is not configured yet. Ask the site owner to add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.', next)
    const state = randomToken()
    const secure = originOf(c).startsWith('https://')
    setCookie(c, STATE_COOKIE, JSON.stringify({ state, next }), {
      path: '/', httpOnly: true, secure, sameSite: 'Lax', maxAge: 600
    })
    const params = new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(c),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
      access_type: 'online',
      include_granted_scopes: 'true'
    })
    return c.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString())
  })

  // Step 2: Google sends the user back here with ?code=...
  app.get('/auth/google/callback', async (c: any) => {
    let saved: { state?: string; next?: string } = {}
    try { saved = JSON.parse(getCookie(c, STATE_COOKIE) || '{}') } catch (e) {}
    deleteCookie(c, STATE_COOKIE, { path: '/' })
    const next = safeNext(saved.next)

    if (c.req.query('error')) return fail(c, 'Google sign-in was cancelled.', next)
    const code = c.req.query('code')
    const state = c.req.query('state')
    if (!code || !state || !saved.state || state !== saved.state)
      return fail(c, 'Your Google sign-in session expired. Please try again.', next)

    // Exchange the code for tokens
    let tokens: any
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: c.env.GOOGLE_CLIENT_ID,
          client_secret: c.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri(c),
          grant_type: 'authorization_code'
        })
      })
      tokens = await r.json()
      if (!r.ok || !tokens.access_token) {
        console.error('[google] token exchange failed', tokens)
        return fail(c, 'Google sign-in failed. Please try again.', next)
      }
    } catch (e) {
      return fail(c, 'Could not reach Google. Please try again.', next)
    }

    // Get the Google profile
    let profile: any
    try {
      const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: 'Bearer ' + tokens.access_token }
      })
      profile = await r.json()
      if (!r.ok || !profile.sub) return fail(c, 'Could not read your Google profile.', next)
    } catch (e) {
      return fail(c, 'Could not read your Google profile.', next)
    }
    const email = String(profile.email || '').toLowerCase()
    if (!email || profile.email_verified === false)
      return fail(c, 'Your Google account email is not verified.', next)

    const db: D1Database = c.env.DB
    // 1) Already linked to this Google account?
    let user = await db.prepare('SELECT * FROM users WHERE google_id = ?').bind(profile.sub).first<any>()
    // 2) Existing account with the same email -> link it
    if (!user) {
      user = await db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').bind(email).first<any>()
      if (user) {
        await db.prepare('UPDATE users SET google_id = ?, avatar = COALESCE(avatar, ?), full_name = COALESCE(full_name, ?) WHERE id = ?')
          .bind(profile.sub, profile.picture || null, profile.name || null, user.id).run()
      }
    }
    // 3) Brand-new account
    let isNew = false
    if (!user) {
      const username = await uniqueUsername(db, email, profile.name || '')
      const { ip, info } = await collectSignupInfo(c, null)
      ;(info as any).signup_method = 'google'
      const res = await db.prepare(
        `INSERT INTO users (username, email, password, full_name, avatar, signup_ip, signup_info, google_id, auth_provider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'google')`
      ).bind(username, email, randomToken(), profile.name || null, profile.picture || null, ip, JSON.stringify(info), profile.sub).run()
      user = { id: res.meta.last_row_id, username, email }
      isNew = true
    }

    const token = randomToken()
    await db.prepare('INSERT INTO sessions (token, user_id, role) VALUES (?, ?, ?)').bind(token, user.id, 'user').run()
    if (isNew) await sendWelcome(db, user.id)

    // Hand the session token to the browser (URL fragment never reaches servers/logs)
    const frag = new URLSearchParams({ token, next, new: isNew ? '1' : '0' })
    return c.redirect('/auth/complete#' + frag.toString())
  })

  // Step 3: tiny page that stores the token and continues to the app
  app.get('/auth/complete', (c: any) => c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="robots" content="noindex"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Signing you in… | Unstudy</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#334155">
<p>Signing you in…</p>
<script>
(function(){
  var p = new URLSearchParams(location.hash.slice(1));
  var t = p.get('token'); var n = p.get('next') || '/';
  if (!(n.charAt(0) === '/' && n.charAt(1) !== '/')) n = '/';
  if (!t) { location.replace('/login?error=' + encodeURIComponent('Google sign-in failed. Please try again.')); return; }
  localStorage.setItem('token', t); localStorage.setItem('role', 'user');
  if (p.get('new') === '1') sessionStorage.setItem('unstudy_new_google', '1');
  location.replace(n);
})();
</script></body></html>`))
}
