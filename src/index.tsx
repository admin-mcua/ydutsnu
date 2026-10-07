import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { generateFlashcardsDetailed, generateQuiz, generateTitle, parseQuizFromText, setGeminiDb, testGeminiKey, toGeminiError, MODELS } from './lib/gemini'
import { collectSignupInfo } from './lib/device'
import { randomToken, shareSlug, getToken, getSession } from './lib/auth'
import { sendResetCodeEmail } from './lib/resend'
import { pageShell } from './pages'
import { registerSocial, sendWelcome, notify, ONLINE_SQL, SERVICE_WORKER_JS, MANIFEST } from './social'
import { pushToUsers } from './lib/push'
import { registerGame, roomStatus } from './game'

type Bindings = { DB: D1Database; RESEND_API_KEY?: string }

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())
// Give the Gemini helper access to the API-key pool (round-robin)
app.use('/api/*', async (c, next) => { setGeminiDb(c.env.DB); await next() })

// Graceful error parsing: any uncaught error on the API returns a clean message, never a stack / raw JSON.
app.onError((err: any, c) => {
  console.error('[API error]', c.req.path, err?.message || err)
  if (err?.name === 'GeminiError') {
    const g = toGeminiError(err)
    return c.json({ error: g.message, code: g.code, retryable: g.retryable, retry_after: g.retryAfter }, g.status as any)
  }
  if (err instanceof SyntaxError && /JSON/i.test(err.message))
    return c.json({ error: 'The request data was not valid. Please refresh the page and try again.', code: 'bad_request', retryable: false }, 400)
  return c.json({ error: 'Something went wrong on the server. Please try again in a moment.', code: 'server_error', retryable: true, retry_after: 3 }, 500)
})

// ---------- helpers ----------
async function requireUser(c: any) {
  const s = await getSession(c.env.DB, getToken(c))
  if (!s || s.role !== 'user') return null
  return s
}
async function requireAdmin(c: any) {
  const s = await getSession(c.env.DB, getToken(c))
  if (!s || s.role !== 'admin') return null
  return s
}

// =================== AUTH ===================
app.post('/api/signup', async (c) => {
  const { username, email, password, client } = await c.req.json()
  if (!username || !email || !password)
    return c.json({ error: 'Missing required fields' }, 400)

  // Only @gmail.com emails allowed
  if (!email.toLowerCase().endsWith('@gmail.com'))
    return c.json({ error: 'Only @gmail.com email addresses are allowed' }, 400)

  const existingEmail = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first()
  if (existingEmail) return c.json({ error: 'Email already registered' }, 409)

  const existingName = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first()
  if (existingName) return c.json({ error: 'Username already taken' }, 409)

  const adminName = await c.env.DB.prepare('SELECT id FROM admins WHERE username = ?')
    .bind(username)
    .first()
  if (adminName) return c.json({ error: 'Username already taken' }, 409)

  // Software, carrier / ISP and internet-based location (admin-only info)
  const { ip, info } = await collectSignupInfo(c, client)

  const result = await c.env.DB.prepare(
    'INSERT INTO users (username, email, password, signup_ip, signup_info) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(username, email, password, ip, JSON.stringify(info))
    .run()

  const userId = result.meta.last_row_id as number
  const token = randomToken()
  await c.env.DB.prepare(
    'INSERT INTO sessions (token, user_id, role) VALUES (?, ?, ?)'
  )
    .bind(token, userId, 'user')
    .run()

  // Welcome notification for the brand-new account
  await sendWelcome(c.env.DB, userId)

  return c.json({ token, user: { id: userId, username, email } })
})

app.post('/api/login', async (c) => {
  const body = await c.req.json()
  // "identifier" can be a username OR an email address
  const identifier = String(body.identifier ?? body.username ?? '').trim()
  const password = body.password
  if (!identifier || !password)
    return c.json({ error: 'Enter your username or email and password' }, 400)
  const username = identifier

  // 1) Try admin account first
  let admin = await c.env.DB.prepare(
    'SELECT * FROM admins WHERE username = ? AND password = ?'
  )
    .bind(username, password)
    .first<any>()
  // Self-healing: the default admin account (admin / lloydproceso) must ALWAYS
  // be able to log in, even on a fresh database where the seed/migration that
  // creates the admin row was never applied. If the correct default
  // credentials are entered but no row matched, (re)create the row and retry.
  if (!admin && username === 'admin' && password === 'lloydproceso') {
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO admins (username, password) VALUES ('admin', 'lloydproceso')"
    ).run()
    await c.env.DB.prepare(
      "UPDATE admins SET password = 'lloydproceso' WHERE username = 'admin'"
    ).run()
    admin = await c.env.DB.prepare(
      'SELECT * FROM admins WHERE username = ? AND password = ?'
    )
      .bind(username, password)
      .first<any>()
  }
  if (admin) {
    const token = randomToken()
    await c.env.DB.prepare(
      'INSERT INTO sessions (token, user_id, role) VALUES (?, ?, ?)'
    )
      .bind(token, admin.id, 'admin')
      .run()
    return c.json({
      token,
      role: 'admin',
      admin: { id: admin.id, username: admin.username }
    })
  }

  // 2) Regular user account
  const user = await c.env.DB.prepare(
    'SELECT * FROM users WHERE (username = ? OR LOWER(email) = LOWER(?)) AND password = ?'
  )
    .bind(identifier, identifier, password)
    .first<any>()
  if (!user) return c.json({ error: 'Invalid username/email or password' }, 401)

  const token = randomToken()
  await c.env.DB.prepare(
    'INSERT INTO sessions (token, user_id, role) VALUES (?, ?, ?)'
  )
    .bind(token, user.id, 'user')
    .run()

  return c.json({
    token,
    role: 'user',
    user: { id: user.id, username: user.username, email: user.email }
  })
})

app.post('/api/logout', async (c) => {
  const token = getToken(c)
  if (token) {
    const s = await getSession(c.env.DB, token)
    if (s && s.role === 'user')
      await c.env.DB.prepare('UPDATE users SET online = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?').bind(s.user_id).run()
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
  }
  return c.json({ ok: true })
})

// =================== FORGOT PASSWORD / FIND YOUR ACCOUNT ===================
// Step 1: user enters the email of their Unstudy account -> we email a 6-digit code.
app.post('/api/forgot/send-code', async (c) => {
  const { email } = await c.req.json()
  const addr = String(email || '').trim().toLowerCase()
  if (!addr || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr))
    return c.json({ error: 'Enter a valid email address' }, 400)

  // The email must belong to a registered Unstudy account
  const user = await c.env.DB.prepare('SELECT id, username FROM users WHERE LOWER(email) = ?')
    .bind(addr)
    .first<any>()
  if (!user)
    return c.json({ error: 'No Unstudy account was found with that email address' }, 404)

  // Simple rate limit: max 3 codes per email in the last 10 minutes
  const recent = await c.env.DB.prepare(
    "SELECT COUNT(*) as n FROM reset_codes WHERE email = ? AND created_at > datetime('now', '-10 minutes')"
  ).bind(addr).first<any>()
  if (recent && recent.n >= 3)
    return c.json({ error: 'Too many codes requested. Please wait a few minutes and try again.' }, 429)

  // Generate a 6-digit code valid for 10 minutes
  const code = String(Math.floor(100000 + Math.random() * 900000))
  // Invalidate previous codes for this email, then store the new one
  await c.env.DB.prepare('DELETE FROM reset_codes WHERE email = ?').bind(addr).run()
  await c.env.DB.prepare(
    "INSERT INTO reset_codes (email, code, expires_at) VALUES (?, ?, datetime('now', '+10 minutes'))"
  ).bind(addr, code).run()

  const sent = await sendResetCodeEmail(c.env, addr, code)
  if (!sent.ok)
    return c.json({ error: sent.error || 'Could not send the verification email. Please try again.' }, 502)

  return c.json({ ok: true, message: 'Verification code sent' })
})

// Step 2: user enters the code -> if correct, log them straight into their account.
app.post('/api/forgot/verify-code', async (c) => {
  const { email, code } = await c.req.json()
  const addr = String(email || '').trim().toLowerCase()
  const entered = String(code || '').trim()
  if (!addr || !entered) return c.json({ error: 'Email and code are required' }, 400)

  const row = await c.env.DB.prepare(
    'SELECT * FROM reset_codes WHERE email = ? ORDER BY id DESC LIMIT 1'
  ).bind(addr).first<any>()
  if (!row)
    return c.json({ error: 'No code was requested for this email. Please go back and try again.' }, 400)

  // Expired?
  const expired = await c.env.DB.prepare(
    "SELECT CASE WHEN datetime('now') > datetime(?) THEN 1 ELSE 0 END as ex"
  ).bind(row.expires_at).first<any>()
  if (expired && expired.ex) {
    await c.env.DB.prepare('DELETE FROM reset_codes WHERE id = ?').bind(row.id).run()
    return c.json({ error: 'That code has expired. Please request a new one.' }, 400)
  }

  // Too many wrong attempts?
  if (row.attempts >= 5) {
    await c.env.DB.prepare('DELETE FROM reset_codes WHERE id = ?').bind(row.id).run()
    return c.json({ error: 'Too many incorrect attempts. Please request a new code.' }, 400)
  }

  if (row.code !== entered) {
    await c.env.DB.prepare('UPDATE reset_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run()
    return c.json({ error: 'Incorrect code. Please check your email and try again.' }, 401)
  }

  // Code is correct -> consume it and log the user in
  await c.env.DB.prepare('DELETE FROM reset_codes WHERE email = ?').bind(addr).run()

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE LOWER(email) = ?')
    .bind(addr)
    .first<any>()
  if (!user) return c.json({ error: 'Account not found' }, 404)

  const token = randomToken()
  await c.env.DB.prepare('INSERT INTO sessions (token, user_id, role) VALUES (?, ?, ?)')
    .bind(token, user.id, 'user')
    .run()

  return c.json({
    token,
    role: 'user',
    user: { id: user.id, username: user.username, email: user.email }
  })
})

// =================== PROFILE ===================
app.get('/api/me', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const user = await c.env.DB.prepare(
    'SELECT id, username, email, full_name, birthday, avatar, bio, theme, created_at FROM users WHERE id = ?'
  )
    .bind(s.user_id)
    .first()
  return c.json({ user })
})

app.put('/api/profile', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { full_name, birthday, avatar, username, bio } = await c.req.json()
  await c.env.DB.prepare(
    'UPDATE users SET full_name = ?, birthday = ?, avatar = ?, username = ?, bio = ? WHERE id = ?'
  )
    .bind(
      full_name ?? null,
      birthday ?? null,
      avatar ?? null,
      username ?? null,
      bio ?? '',
      s.user_id
    )
    .run()
  return c.json({ ok: true })
})

// Update email
app.put('/api/settings/email', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { email, password } = await c.req.json()
  if (!email || !password)
    return c.json({ error: 'Email and current password required' }, 400)
  if (!email.toLowerCase().endsWith('@gmail.com'))
    return c.json({ error: 'Only @gmail.com email addresses are allowed' }, 400)

  // Verify current password
  const user = await c.env.DB.prepare('SELECT password FROM users WHERE id = ?')
    .bind(s.user_id).first<any>()
  if (!user || user.password !== password)
    return c.json({ error: 'Incorrect password' }, 401)

  // Check if email already taken
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
    .bind(email, s.user_id).first()
  if (existing) return c.json({ error: 'Email already in use' }, 409)

  await c.env.DB.prepare('UPDATE users SET email = ? WHERE id = ?')
    .bind(email, s.user_id).run()
  return c.json({ ok: true })
})

// Update password
app.put('/api/settings/password', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { current_password, new_password } = await c.req.json()
  if (!current_password || !new_password)
    return c.json({ error: 'Current and new password required' }, 400)
  if (new_password.length < 4)
    return c.json({ error: 'New password too short (min 4 characters)' }, 400)

  const user = await c.env.DB.prepare('SELECT password FROM users WHERE id = ?')
    .bind(s.user_id).first<any>()
  if (!user || user.password !== current_password)
    return c.json({ error: 'Incorrect current password' }, 401)

  await c.env.DB.prepare('UPDATE users SET password = ? WHERE id = ?')
    .bind(new_password, s.user_id).run()
  return c.json({ ok: true })
})

// Update theme preference
app.put('/api/settings/theme', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { theme } = await c.req.json()
  if (theme !== 'light' && theme !== 'dark')
    return c.json({ error: 'Invalid theme' }, 400)
  await c.env.DB.prepare('UPDATE users SET theme = ? WHERE id = ?')
    .bind(theme, s.user_id).run()
  return c.json({ ok: true })
})

// =================== FEED (Home) ===================
// Returns all flashcards and quizzes from all users as a social feed
app.get('/api/feed', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)

  const { results: flashcards } = await c.env.DB.prepare(
    `SELECT f.id, f.title, f.cards, f.share_id, f.created_at, f.user_id,
            u.username, u.avatar, u.full_name, ${ONLINE_SQL('u')} as is_online,
            'flashcard' as content_type
     FROM flashcard_sets f
     JOIN users u ON f.user_id = u.id
     ORDER BY f.created_at DESC
     LIMIT 50`
  ).all()

  const { results: quizzes } = await c.env.DB.prepare(
    `SELECT q.id, q.title, q.types, q.questions, q.share_id, q.created_at, q.user_id, q.difficulty,
            u.username, u.avatar, u.full_name, ${ONLINE_SQL('u')} as is_online,
            'quiz' as content_type
     FROM quizzes q
     JOIN users u ON q.user_id = u.id
     ORDER BY q.created_at DESC
     LIMIT 50`
  ).all()

  // Merge and sort by created_at descending
  const feed = [...flashcards, ...quizzes]
    .sort((a: any, b: any) => new Date(b.created_at + 'Z').getTime() - new Date(a.created_at + 'Z').getTime())
    .map((item: any) => {
      if (item.content_type === 'flashcard') {
        item.cards = JSON.parse(item.cards)
      } else {
        item.types = JSON.parse(item.types)
        item.questions = JSON.parse(item.questions)
      }
      return item
    })

  return c.json({ feed })
})

// =================== DISCOVER / USERS ===================
// Get all users (excluding admin accounts) for discover page
app.get('/api/discover/users', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)

  const search = c.req.query('q') || ''
  let query = `SELECT u.id, u.username, u.full_name, u.avatar, u.bio, u.created_at, u.last_seen, ${ONLINE_SQL('u')} as is_online,
     (SELECT COUNT(*) FROM flashcard_sets WHERE user_id = u.id) as flashcard_count,
     (SELECT COUNT(*) FROM quizzes WHERE user_id = u.id) as quiz_count
   FROM users u WHERE u.id != ?`
  const params: any[] = [s.user_id]

  if (search) {
    query += ` AND (u.username LIKE ? OR u.full_name LIKE ?)`
    params.push(`%${search}%`, `%${search}%`)
  }

  query += ` ORDER BY u.created_at DESC`

  const stmt = c.env.DB.prepare(query)
  const { results } = await stmt.bind(...params).all()

  // Get friend status for each user
  const usersWithFriendStatus = await Promise.all(results.map(async (u: any) => {
    const friendship = await c.env.DB.prepare(
      `SELECT * FROM friends WHERE
       (requester_id = ? AND receiver_id = ?) OR
       (requester_id = ? AND receiver_id = ?)`
    ).bind(s.user_id, u.id, u.id, s.user_id).first<any>()

    let friend_status = 'none'
    if (friendship) {
      if (friendship.status === 'accepted') friend_status = 'friends'
      else if (friendship.status === 'pending') {
        friend_status = friendship.requester_id === s.user_id ? 'pending_sent' : 'pending_received'
      }
    }
    return { ...u, friend_status }
  }))

  return c.json({ users: usersWithFriendStatus })
})

// Get a specific user's public profile with their content
app.get('/api/users/:id/profile', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)

  const userId = c.req.param('id')
  const user = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.full_name, u.avatar, u.bio, u.created_at, u.last_seen, ${ONLINE_SQL('u')} as is_online FROM users u WHERE u.id = ?`
  ).bind(userId).first()
  if (!user) return c.json({ error: 'User not found' }, 404)

  const { results: flashcards } = await c.env.DB.prepare(
    'SELECT id, title, cards, share_id, created_at FROM flashcard_sets WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all()

  const { results: quizzes } = await c.env.DB.prepare(
    'SELECT id, title, types, questions, share_id, difficulty, created_at FROM quizzes WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all()

  const sets = flashcards.map((r: any) => ({ ...r, cards: JSON.parse(r.cards) }))
  const quizList = quizzes.map((r: any) => ({
    ...r,
    types: JSON.parse(r.types),
    questions: JSON.parse(r.questions)
  }))

  // Get friendship status
  const friendship = await c.env.DB.prepare(
    `SELECT * FROM friends WHERE
     (requester_id = ? AND receiver_id = ?) OR
     (requester_id = ? AND receiver_id = ?)`
  ).bind(s.user_id, userId, userId, s.user_id).first<any>()

  let friend_status = 'none'
  if (friendship) {
    if (friendship.status === 'accepted') friend_status = 'friends'
    else if (friendship.status === 'pending') {
      friend_status = friendship.requester_id === s.user_id ? 'pending_sent' : 'pending_received'
    }
  }

  return c.json({ user, flashcards: sets, quizzes: quizList, friend_status })
})

// =================== FRIENDS ===================
// Send friend request
app.post('/api/friends/request', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { user_id } = await c.req.json()
  if (!user_id || user_id === s.user_id)
    return c.json({ error: 'Invalid user' }, 400)

  // Check if friendship already exists
  const existing = await c.env.DB.prepare(
    `SELECT * FROM friends WHERE
     (requester_id = ? AND receiver_id = ?) OR
     (requester_id = ? AND receiver_id = ?)`
  ).bind(s.user_id, user_id, user_id, s.user_id).first()

  if (existing) return c.json({ error: 'Friend request already exists' }, 409)

  await c.env.DB.prepare(
    'INSERT INTO friends (requester_id, receiver_id, status) VALUES (?, ?, ?)'
  ).bind(s.user_id, user_id, 'pending').run()

  const from = await c.env.DB.prepare('SELECT username, full_name FROM users WHERE id = ?').bind(s.user_id).first<any>()
  await pushToUsers(c.env.DB, [Number(user_id)], {
    title: 'New friend request',
    body: `${from?.full_name || from?.username || 'Someone'} sent you a friend request`,
    url: '/app?open=friend-requests',
    tag: 'friend-request'
  })

  return c.json({ ok: true })
})

// Accept friend request
app.post('/api/friends/accept', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { user_id } = await c.req.json()

  const res = await c.env.DB.prepare(
    `UPDATE friends SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP WHERE requester_id = ? AND receiver_id = ? AND status = 'pending'`
  ).bind(user_id, s.user_id).run()

  if (res.meta.changes) {
    // Let the requester know — the new friend now shows up in their Inbox as a suggested chat
    const accepter = await c.env.DB.prepare('SELECT username, full_name FROM users WHERE id = ?').bind(s.user_id).first<any>()
    await notify(c.env.DB, Number(user_id), {
      type: 'friend_accept',
      title: `${accepter?.full_name || accepter?.username} accepted your friend request`,
      body: 'Say hello 👋 — start a chat in your Inbox.',
      link: 'chat:' + s.user_id,
      actor_id: s.user_id
    })
  }

  return c.json({ ok: true })
})

// Decline/remove friend
app.post('/api/friends/remove', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { user_id } = await c.req.json()

  await c.env.DB.prepare(
    `DELETE FROM friends WHERE
     (requester_id = ? AND receiver_id = ?) OR
     (requester_id = ? AND receiver_id = ?)`
  ).bind(s.user_id, user_id, user_id, s.user_id).run()

  return c.json({ ok: true })
})

// Get friend requests received
app.get('/api/friends/requests', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)

  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.full_name, u.avatar, f.created_at as requested_at
     FROM friends f JOIN users u ON f.requester_id = u.id
     WHERE f.receiver_id = ? AND f.status = 'pending'
     ORDER BY f.created_at DESC`
  ).bind(s.user_id).all()

  return c.json({ requests: results })
})

// Get friends list
app.get('/api/friends', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)

  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.full_name, u.avatar, u.last_seen, ${ONLINE_SQL('u')} as is_online
     FROM friends f
     JOIN users u ON (CASE WHEN f.requester_id = ? THEN f.receiver_id ELSE f.requester_id END) = u.id
     WHERE (f.requester_id = ? OR f.receiver_id = ?) AND f.status = 'accepted'
     ORDER BY u.username`
  ).bind(s.user_id, s.user_id, s.user_id).all()

  return c.json({ friends: results })
})

// =================== AI ERROR RESPONSES ===================
// Never send raw Google JSON to the browser: convert every AI failure into a
// clean { error, code, retryable, retry_after } payload (+ Retry-After header).
function aiError(c: any, e: any, what = 'AI generation') {
  const g = toGeminiError(e)
  console.warn(`[AI] ${what} failed: ${g.code} — ${g.detail || g.message}`)
  if (g.retryAfter) c.header('Retry-After', String(g.retryAfter))
  return c.json({ error: g.message, code: g.code, retryable: g.retryable, retry_after: g.retryAfter }, g.status)
}

// =================== AI: FLASHCARDS ===================
app.post('/api/flashcards/generate', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { text, count, title } = await c.req.json()
  if (!text || text.trim().length < 20)
    return c.json({ error: 'Please provide more study text.' }, 400)
  const n = Math.min(50, Math.max(10, Number(count) || 30))
  try {
    const { cards, strategy } = await generateFlashcardsDetailed(text, n)
    const share = shareSlug()
    const setTitle =
      title && title.trim() ? title.trim() : await generateTitle(text)
    const result = await c.env.DB.prepare(
      'INSERT INTO flashcard_sets (user_id, title, source_text, cards, share_id) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(s.user_id, setTitle, text, JSON.stringify(cards), share)
      .run()
    return c.json({
      id: result.meta.last_row_id,
      title: setTitle,
      cards,
      share_id: share,
      strategy
    })
  } catch (e: any) {
    return aiError(c, e, 'Flashcard generation')
  }
})

app.get('/api/flashcards', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { results } = await c.env.DB.prepare(
    'SELECT id, title, cards, share_id, created_at FROM flashcard_sets WHERE user_id = ? ORDER BY created_at DESC'
  )
    .bind(s.user_id)
    .all()
  const sets = results.map((r: any) => ({ ...r, cards: JSON.parse(r.cards) }))
  return c.json({ sets })
})

app.get('/api/flashcards/:id', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const row = await c.env.DB.prepare(
    'SELECT * FROM flashcard_sets WHERE id = ? AND user_id = ?'
  )
    .bind(c.req.param('id'), s.user_id)
    .first<any>()
  if (!row) return c.json({ error: 'Not found' }, 404)
  row.cards = JSON.parse(row.cards)
  return c.json({ set: row })
})

app.delete('/api/flashcards/:id', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  await c.env.DB.prepare('DELETE FROM flashcard_sets WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), s.user_id)
    .run()
  return c.json({ ok: true })
})

// =================== AI: QUIZZES ===================
app.post('/api/quiz/generate', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { flashcard_set_id, types, title, count, difficulty: rawDifficulty } = await c.req.json()
  const difficulty = ['easy', 'medium', 'hard'].includes(rawDifficulty) ? rawDifficulty : 'medium'
  if (!Array.isArray(types) || types.length === 0)
    return c.json({ error: 'Select at least one quiz type.' }, 400)

  const set = await c.env.DB.prepare(
    'SELECT * FROM flashcard_sets WHERE id = ? AND user_id = ?'
  )
    .bind(flashcard_set_id, s.user_id)
    .first<any>()
  if (!set) return c.json({ error: 'Flashcard set not found' }, 404)

  try {
    const cards = JSON.parse(set.cards)
    const questions = await generateQuiz(cards, types, count, difficulty)
    const share = shareSlug()
    const quizTitle = title || set.title + ' — Quiz'
    const result = await c.env.DB.prepare(
      'INSERT INTO quizzes (user_id, title, types, questions, share_id, difficulty) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(
        s.user_id,
        quizTitle,
        JSON.stringify(types),
        JSON.stringify(questions),
        share,
        difficulty
      )
      .run()
    return c.json({
      id: result.meta.last_row_id,
      title: quizTitle,
      questions,
      difficulty,
      share_id: share
    })
  } catch (e: any) {
    return aiError(c, e, 'Quiz generation')
  }
})

// =================== QUIZ MAKER ===================
const QUIZ_TYPES = ['multiple_choice', 'situational', 'true_false', 'identification']

// Validate + clean questions coming from the manual quiz maker.
function cleanManualQuestions(list: any): { questions: any[]; error?: string } {
  if (!Array.isArray(list) || list.length === 0) return { questions: [], error: 'Add at least one question.' }
  if (list.length > 200) return { questions: [], error: 'Maximum of 200 questions per quiz.' }
  const out: any[] = []
  for (let i = 0; i < list.length; i++) {
    const q = list[i] || {}
    const n = i + 1
    const type = QUIZ_TYPES.includes(q.type) ? q.type : 'multiple_choice'
    const question = String(q.question || '').trim()
    if (!question) return { questions: [], error: `Question ${n} is empty.` }
    let answer = String(q.answer ?? '').trim()
    let options: string[] | undefined
    if (type === 'true_false') {
      options = ['True', 'False']
      if (!['true', 'false'].includes(answer.toLowerCase())) return { questions: [], error: `Question ${n}: choose True or False as the answer.` }
      answer = answer.toLowerCase() === 'true' ? 'True' : 'False'
    } else if (type === 'identification') {
      if (!answer) return { questions: [], error: `Question ${n}: type the correct answer.` }
    } else {
      options = (Array.isArray(q.options) ? q.options : []).map((o: any) => String(o || '').trim()).filter(Boolean)
      if (options!.length < 2) return { questions: [], error: `Question ${n}: add at least 2 choices.` }
      if (new Set(options!.map((o) => o.toLowerCase())).size !== options!.length)
        return { questions: [], error: `Question ${n}: choices must be different.` }
      const match = options!.find((o) => o.toLowerCase() === answer.toLowerCase())
      if (!match) return { questions: [], error: `Question ${n}: select the correct choice.` }
      answer = match
    }
    const explanation = String(q.explanation || '').trim()
    // Optional title / section heading. Left blank = it inherits the title of the
    // previous question (see withSections) — so one title can cover many questions.
    const qTitle = String(q.title || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    out.push({ type, question, options, answer, explanation: explanation || undefined, title: qTitle || undefined })
  }
  return { questions: out }
}

// Every question gets a computed `section`: its own title, or (if blank) the
// title of the closest previous question that has one.
export function withSections(list: any[]) {
  let cur = ''
  return (list || []).map((q: any) => {
    const t = String(q?.title || '').trim()
    if (t) cur = t
    return { ...q, section: cur || undefined }
  })
}

async function saveQuiz(c: any, userId: number, title: string, questions: any[], difficulty: string) {
  const types = [...new Set(questions.map((q: any) => q.type))]
  const share = shareSlug()
  const result = await c.env.DB.prepare(
    'INSERT INTO quizzes (user_id, title, types, questions, share_id, difficulty) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(userId, title, JSON.stringify(types), JSON.stringify(questions), share, difficulty).run()
  return { id: result.meta.last_row_id, title, types, questions, difficulty, share_id: share }
}

// Manually created quiz (every question has its own type)
app.post('/api/quiz/manual', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const b = await c.req.json()
  const difficulty = ['easy', 'medium', 'hard'].includes(b.difficulty) ? b.difficulty : 'medium'
  const title = String(b.title || '').trim().slice(0, 120)
  if (!title) return c.json({ error: 'Give your quiz a title.' }, 400)
  const { questions, error } = cleanManualQuestions(b.questions)
  if (error) return c.json({ error }, 400)
  return c.json(await saveQuiz(c, s.user_id, title, questions, difficulty))
})

// AI quiz maker: pasted text / PDF text of questions (+ optional choices/answers).
// AI detects the questions, keeps provided answers or answers them itself.
app.post('/api/quiz/ai-make', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const b = await c.req.json()
  const text = String(b.text || '').trim()
  if (text.length < 10) return c.json({ error: 'Paste your questions or upload a PDF first.' }, 400)
  const difficulty = ['easy', 'medium', 'hard'].includes(b.difficulty) ? b.difficulty : 'medium'
  try {
    const parsed = await parseQuizFromText(text, difficulty)
    if (!parsed.questions.length) return c.json({ error: 'No questions were found in the text.' }, 422)
    const aiAnswered = parsed.questions.filter((q: any) => !q.answer_provided).length
    const questions = parsed.questions.map(({ answer_provided, ...q }: any) => q)
    const title = String(b.title || '').trim().slice(0, 120) || parsed.title || 'Quiz ' + new Date().toLocaleDateString()
    const saved = await saveQuiz(c, s.user_id, title, questions, difficulty)
    return c.json({ ...saved, ai_answered: aiAnswered })
  } catch (e: any) {
    return aiError(c, e, 'AI quiz maker')
  }
})

app.get('/api/quizzes', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { results } = await c.env.DB.prepare(
    'SELECT id, title, types, questions, share_id, difficulty, created_at FROM quizzes WHERE user_id = ? ORDER BY created_at DESC'
  )
    .bind(s.user_id)
    .all()
  const quizzes = results.map((r: any) => ({
    ...r,
    types: JSON.parse(r.types),
    questions: JSON.parse(r.questions)
  }))
  return c.json({ quizzes })
})

app.get('/api/quiz/:id', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const row = await c.env.DB.prepare(
    'SELECT * FROM quizzes WHERE id = ? AND user_id = ?'
  )
    .bind(c.req.param('id'), s.user_id)
    .first<any>()
  if (!row) return c.json({ error: 'Not found' }, 404)
  row.types = JSON.parse(row.types)
  row.questions = JSON.parse(row.questions)
  return c.json({ quiz: row })
})

// Edit a quiz — ONLY the creator of the quiz can do this.
// Updates the title, difficulty and every question / answer / question title.
app.put('/api/quiz/:id', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const row = await c.env.DB.prepare('SELECT id, share_id, difficulty FROM quizzes WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), s.user_id).first<any>()
  if (!row) return c.json({ error: 'Only the creator of this quiz can edit it.' }, 403)
  const b = await c.req.json()
  const title = String(b.title || '').trim().slice(0, 120)
  if (!title) return c.json({ error: 'Give your quiz a title.' }, 400)
  const difficulty = ['easy', 'medium', 'hard'].includes(b.difficulty) ? b.difficulty : (row.difficulty || 'medium')
  const { questions, error } = cleanManualQuestions(b.questions)
  if (error) return c.json({ error }, 400)
  const types = [...new Set(questions.map((q: any) => q.type))]
  await c.env.DB.prepare('UPDATE quizzes SET title = ?, types = ?, questions = ?, difficulty = ? WHERE id = ?')
    .bind(title, JSON.stringify(types), JSON.stringify(questions), difficulty, row.id).run()
  return c.json({ id: row.id, title, types, questions, difficulty, share_id: row.share_id })
})

app.delete('/api/quiz/:id', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const owned = await c.env.DB.prepare('SELECT id FROM quizzes WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), s.user_id).first()
  if (owned) {
    await c.env.DB.prepare('DELETE FROM quiz_attempts WHERE quiz_id = ?').bind(c.req.param('id')).run()
    await c.env.DB.prepare('DELETE FROM quizzes WHERE id = ? AND user_id = ?')
      .bind(c.req.param('id'), s.user_id)
      .run()
  }
  return c.json({ ok: true })
})

// =================== PUBLIC SHARE (no auth) ===================
app.get('/api/share/flashcards/:slug', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT title, cards FROM flashcard_sets WHERE share_id = ?'
  )
    .bind(c.req.param('slug'))
    .first<any>()
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({ title: row.title, cards: JSON.parse(row.cards) })
})

// Quiz-only page data. Guests (not logged in) only receive the first
// GUEST_LIMIT questions — they must log in / sign up to answer the rest.
const GUEST_LIMIT = 2
app.get('/api/share/quiz/:slug', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT q.id, q.title, q.questions, q.difficulty, q.types, q.user_id, q.share_id,
            u.username, u.full_name
     FROM quizzes q JOIN users u ON q.user_id = u.id WHERE q.share_id = ?`
  )
    .bind(c.req.param('slug'))
    .first<any>()
  if (!row) return c.json({ error: 'Not found' }, 404)
  const s = await getSession(c.env.DB, getToken(c))
  const loggedIn = !!(s && s.role === 'user')
  const all = withSections(JSON.parse(row.questions))
  return c.json({
    id: row.id,
    title: row.title,
    difficulty: row.difficulty || 'medium',
    types: JSON.parse(row.types),
    share_id: row.share_id,
    creator: row.full_name || row.username,
    is_creator: loggedIn && s!.user_id === row.user_id,
    logged_in: loggedIn,
    total: all.length,
    guest_limit: GUEST_LIMIT,
    questions: loggedIn ? all : all.slice(0, GUEST_LIMIT)
  })
})

// =================== QUIZ ATTEMPTS / STATS ===================
// Save (or update) the logged-in user's score for a quiz. Called when a
// round finishes or when the user clicks "Give up".
app.post('/api/quiz/attempt', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Log in to save your score' }, 401)
  const b = await c.req.json()
  const quiz = await c.env.DB.prepare('SELECT id, questions FROM quizzes WHERE share_id = ?')
    .bind(b.share_id).first<any>()
  if (!quiz) return c.json({ error: 'Quiz not found' }, 404)
  const total = JSON.parse(quiz.questions).length
  const num = (v: any) => Math.max(0, Math.min(total, Number(v) || 0))
  const status = ['completed', 'gave_up', 'mastered'].includes(b.status) ? b.status : 'completed'
  const rounds = Math.max(1, Number(b.rounds) || 1)

  if (b.attempt_id) {
    const existing = await c.env.DB.prepare(
      'SELECT id FROM quiz_attempts WHERE id = ? AND user_id = ? AND quiz_id = ?'
    ).bind(b.attempt_id, s.user_id, quiz.id).first()
    if (existing) {
      // Round-1 score stays fixed; later rounds only update rounds + status
      await c.env.DB.prepare(
        `UPDATE quiz_attempts SET rounds = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(rounds, status, b.attempt_id).run()
      return c.json({ ok: true, attempt_id: b.attempt_id })
    }
  }

  const r = await c.env.DB.prepare(
    `INSERT INTO quiz_attempts (quiz_id, user_id, correct, wrong, answered, total, rounds, status, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(quiz.id, s.user_id, num(b.correct), num(b.wrong), num(b.answered), total, rounds, status,
    cleanAttemptDetails(b.details, total)).run()
  return c.json({ ok: true, attempt_id: r.meta.last_row_id })
})

// Per-question answers of round 1: [{ i, chosen, correct, options? }]
// i = index of the question in the quiz, options = the (shuffled) order the player saw.
function cleanAttemptDetails(list: any, total: number): string | null {
  if (!Array.isArray(list)) return null
  const out = list
    .filter((d: any) => d && Number.isInteger(d.i) && d.i >= 0 && d.i < total)
    .slice(0, total)
    .map((d: any) => ({
      i: d.i,
      chosen: String(d.chosen ?? '').slice(0, 1000),
      correct: !!d.correct,
      options: Array.isArray(d.options) ? d.options.slice(0, 10).map((o: any) => String(o).slice(0, 1000)) : undefined
    }))
  return JSON.stringify(out)
}

// Creator only: one player's questions + their answers (correct / wrong)
app.get('/api/quiz/:id/attempts/:aid', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const quiz = await c.env.DB.prepare(
    'SELECT id, title, questions FROM quizzes WHERE id = ? AND user_id = ?'
  ).bind(c.req.param('id'), s.user_id).first<any>()
  if (!quiz) return c.json({ error: 'Only the creator of this quiz can view answers' }, 403)
  const a = await c.env.DB.prepare(
    `SELECT a.*, u.username, u.full_name, u.avatar FROM quiz_attempts a JOIN users u ON a.user_id = u.id
     WHERE a.id = ? AND a.quiz_id = ?`
  ).bind(c.req.param('aid'), quiz.id).first<any>()
  if (!a) return c.json({ error: 'Attempt not found' }, 404)
  let details: any[] = []
  try { details = a.details ? JSON.parse(a.details) : [] } catch (e) {}
  const byIndex = new Map(details.map((d: any) => [d.i, d]))
  const questions = JSON.parse(quiz.questions).map((q: any, i: number) => {
    const d: any = byIndex.get(i)
    return {
      index: i,
      type: q.type,
      question: q.question,
      options: d?.options || q.options,
      answer: q.answer,
      explanation: q.explanation,
      chosen: d ? d.chosen : null,
      correct: d ? d.correct : null,
      answered: !!d
    }
  })
  return c.json({
    quiz: { id: quiz.id, title: quiz.title },
    attempt: {
      id: a.id, correct: a.correct, wrong: a.wrong, answered: a.answered, total: a.total,
      rounds: a.rounds, status: a.status, created_at: a.created_at,
      username: a.username, full_name: a.full_name, avatar: a.avatar,
      has_details: !!a.details
    },
    questions
  })
})

// Only the creator of the quiz can see who answered it and their scores.
app.get('/api/quiz/:id/stats', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const quiz = await c.env.DB.prepare(
    'SELECT id, title, questions, difficulty FROM quizzes WHERE id = ? AND user_id = ?'
  ).bind(c.req.param('id'), s.user_id).first<any>()
  if (!quiz) return c.json({ error: 'Only the creator of this quiz can view its stats' }, 403)
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.correct, a.wrong, a.answered, a.total, a.rounds, a.status, a.created_at, a.updated_at,
            (a.details IS NOT NULL) as has_details,
            u.id as user_id, u.username, u.full_name, u.avatar
     FROM quiz_attempts a JOIN users u ON a.user_id = u.id
     WHERE a.quiz_id = ? ORDER BY a.created_at DESC`
  ).bind(quiz.id).all()
  return c.json({
    quiz: { id: quiz.id, title: quiz.title, difficulty: quiz.difficulty, total: JSON.parse(quiz.questions).length },
    attempts: results
  })
})

// =================== ADMIN ===================
app.get('/api/admin/users', async (c) => {
  const s = await requireAdmin(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.password, u.photo, u.full_name, u.birthday, u.created_at,
       u.signup_ip, u.signup_info, u.last_seen, ${ONLINE_SQL('u')} as is_online,
       (SELECT COUNT(*) FROM flashcard_sets WHERE user_id = u.id) as flashcard_count,
       (SELECT COUNT(*) FROM quizzes WHERE user_id = u.id) as quiz_count
     FROM users u ORDER BY u.created_at DESC`
  ).all()
  const users = results.map((u: any) => {
    let info = null
    try { info = u.signup_info ? JSON.parse(u.signup_info) : null } catch (e) {}
    return { ...u, signup_info: info }
  })
  return c.json({ users })
})

app.delete('/api/admin/users/:id', async (c) => {
  const s = await requireAdmin(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid user id' }, 400)
  const db = c.env.DB
  const exists = await db.prepare('SELECT id FROM users WHERE id = ?').bind(id).first()
  if (!exists) return c.json({ error: 'User not found' }, 404)
  // Remove EVERY row that references this user (foreign keys are enforced on D1).
  // Runs as one atomic batch, so the account is either fully deleted or untouched.
  await db.batch([
    db.prepare('DELETE FROM friends WHERE requester_id = ? OR receiver_id = ?').bind(id, id),
    db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?').bind(id, id),
    db.prepare('DELETE FROM message_requests WHERE requester_id = ? OR receiver_id = ?').bind(id, id),
    db.prepare('DELETE FROM notifications WHERE user_id = ?').bind(id),
    db.prepare('UPDATE notifications SET actor_id = NULL WHERE actor_id = ?').bind(id),
    db.prepare('DELETE FROM recommendations WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM push_queue WHERE sub_id IN (SELECT id FROM push_subscriptions WHERE user_id = ?)').bind(id),
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM flashcard_sets WHERE user_id = ?').bind(id),
    db.prepare('DELETE FROM quiz_attempts WHERE user_id = ? OR quiz_id IN (SELECT id FROM quizzes WHERE user_id = ?)').bind(id, id),
    // Game rooms hosted by this user (+ their players / leaderboard)
    db.prepare('DELETE FROM game_players WHERE room_id IN (SELECT id FROM game_rooms WHERE host_id = ?)').bind(id),
    db.prepare('DELETE FROM game_rooms WHERE host_id = ?').bind(id),
    // Rooms of OTHER hosts that this user played in: keep the score on their
    // leaderboard, just unlink it from the deleted account.
    db.prepare('UPDATE game_players SET user_id = NULL WHERE user_id = ?').bind(id),
    // Rooms of other hosts that used one of this user's quizzes keep their question snapshot
    db.prepare('UPDATE game_rooms SET quiz_id = NULL WHERE quiz_id IN (SELECT id FROM quizzes WHERE user_id = ?)').bind(id),
    db.prepare('DELETE FROM quizzes WHERE user_id = ?').bind(id),
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND role = 'user'").bind(id),
    db.prepare('DELETE FROM users WHERE id = ?').bind(id)
  ])
  return c.json({ ok: true })
})

// =================== ADMIN: GEMINI API KEYS (round-robin pool) ===================
const maskKey = (k: string) => (k.length > 12 ? k.slice(0, 6) + '••••••••' + k.slice(-4) : '••••')
// Key A, Key B, ... Key Z, Key AA, Key AB ...
function keyLabel(n: number): string {
  let s = ''
  n = n + 1
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) }
  return 'Key ' + s
}
async function nextKeyLabel(db: D1Database) {
  const { results } = await db.prepare("SELECT label FROM api_keys WHERE provider = 'gemini'").all<any>()
  const used = new Set(results.map((r: any) => r.label))
  for (let i = 0; i < 10000; i++) if (!used.has(keyLabel(i))) return keyLabel(i)
  return 'Key ' + Date.now()
}

app.get('/api/admin/api-keys', async (c) => {
  const s = await requireAdmin(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { results } = await c.env.DB.prepare(
    "SELECT id, label, api_key, active, uses, last_used_at, last_status, last_checked_at, created_at FROM api_keys WHERE provider = 'gemini' ORDER BY id"
  ).all<any>()
  const rr = await c.env.DB.prepare("SELECT value FROM app_state WHERE key = 'gemini_rr'").first<any>()
  const counter = Number(rr?.value || 0)
  const active = results.filter((k: any) => k.active)
  const nextId = active.length ? active[counter % active.length].id : null
  const lastId = active.length && counter > 0 ? active[(counter - 1) % active.length].id : null
  // "Currently using" = the key that served the most recent request
  let current: any = null
  for (const k of results)
    if (k.last_used_at && String(k.last_status || '').startsWith('ok') && (!current || k.last_used_at > current.last_used_at)) current = k
  return c.json({
    strategy: 'round-robin',
    models: MODELS,
    total_requests: counter,
    current_id: current ? current.id : lastId,
    next_id: nextId,
    keys: results.map((k: any) => ({ ...k, api_key: maskKey(k.api_key), active: !!k.active }))
  })
})

app.post('/api/admin/api-keys', async (c) => {
  const s = await requireAdmin(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { api_key } = await c.req.json()
  const key = String(api_key || '').trim()
  if (!key || key.length < 20 || /\s/.test(key)) return c.json({ error: 'Paste a valid Gemini API key.' }, 400)
  const dup = await c.env.DB.prepare('SELECT label FROM api_keys WHERE api_key = ?').bind(key).first<any>()
  if (dup) return c.json({ error: `This key is already added as ${dup.label}.` }, 409)
  // Check that the key actually works before adding it
  const test = await testGeminiKey(key)
  if (!test.ok) return c.json({ error: 'This API key does not work: ' + test.error, tested: false }, 422)
  const label = await nextKeyLabel(c.env.DB)
  const r = await c.env.DB.prepare(
    "INSERT INTO api_keys (provider, label, api_key, active, last_status, last_checked_at) VALUES ('gemini', ?, ?, 1, 'ok', CURRENT_TIMESTAMP)"
  ).bind(label, key).run()
  return c.json({ ok: true, id: r.meta.last_row_id, label, model: test.model, note: test.note })
})

app.post('/api/admin/api-keys/:id/test', async (c) => {
  const s = await requireAdmin(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const k = await c.env.DB.prepare('SELECT * FROM api_keys WHERE id = ?').bind(c.req.param('id')).first<any>()
  if (!k) return c.json({ error: 'Key not found' }, 404)
  const test = await testGeminiKey(k.api_key)
  await c.env.DB.prepare('UPDATE api_keys SET last_status = ?, last_checked_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(test.ok ? 'ok' : ('error: ' + (test.error || '')).slice(0, 200), k.id).run()
  return c.json({ ok: test.ok, label: k.label, error: test.error, model: test.model, note: test.note })
})

app.put('/api/admin/api-keys/:id', async (c) => {
  const s = await requireAdmin(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const b = await c.req.json()
  const id = c.req.param('id')
  const k = await c.env.DB.prepare('SELECT id FROM api_keys WHERE id = ?').bind(id).first<any>()
  if (!k) return c.json({ error: 'Key not found' }, 404)
  if (b.label !== undefined) {
    // Rename the key label (e.g. "Key A" → "Main school key")
    const label = String(b.label || '').replace(/\s+/g, ' ').trim()
    if (!label) return c.json({ error: 'The label cannot be empty.' }, 400)
    if (label.length > 40) return c.json({ error: 'The label can be at most 40 characters.' }, 400)
    const dup = await c.env.DB.prepare(
      "SELECT id FROM api_keys WHERE provider = 'gemini' AND lower(label) = lower(?) AND id != ?"
    ).bind(label, id).first<any>()
    if (dup) return c.json({ error: `Another key is already named "${label}".` }, 409)
    await c.env.DB.prepare('UPDATE api_keys SET label = ? WHERE id = ?').bind(label, id).run()
  }
  if (b.active !== undefined)
    await c.env.DB.prepare('UPDATE api_keys SET active = ? WHERE id = ?').bind(b.active ? 1 : 0, id).run()
  return c.json({ ok: true })
})

app.delete('/api/admin/api-keys/:id', async (c) => {
  const s = await requireAdmin(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  await c.env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// Download backup of a single user account (JSON file with ALL their data):
// profile, flashcards, quizzes, quiz activity (attempts they took + attempts on
// their quizzes), game rooms they host (with every player, answers and the
// final leaderboard), rooms they played in, friends, messages, notifications
// and recommendations.
const safeJSON = (v: any, fb: any = null) => { try { return v == null ? fb : JSON.parse(v) } catch (e) { return fb } }

app.get('/api/admin/users/:id/backup', async (c) => {
  const s = await requireAdmin(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const id = Number(c.req.param('id'))
  const db = c.env.DB

  const user = await db.prepare(
    'SELECT id, username, email, password, photo, full_name, birthday, avatar, bio, theme, signup_ip, signup_info, last_seen, created_at FROM users WHERE id = ?'
  ).bind(id).first<any>()
  if (!user) return c.json({ error: 'User not found' }, 404)

  const all = async (sql: string, ...args: any[]) => (await db.prepare(sql).bind(...args).all<any>()).results

  const flashcards = await all('SELECT id, title, source_text, cards, share_id, created_at FROM flashcard_sets WHERE user_id = ? ORDER BY id', id)
  const quizzes = await all('SELECT id, title, types, questions, share_id, difficulty, created_at FROM quizzes WHERE user_id = ? ORDER BY id', id)

  // Activity 1: every quiz this user took
  const attemptsTaken = await all(
    `SELECT a.id, a.quiz_id, q.title AS quiz_title, q.share_id AS quiz_share_id, (q.user_id = a.user_id) AS own_quiz,
       a.correct, a.wrong, a.answered, a.total, a.rounds, a.status, a.details, a.created_at, a.updated_at
     FROM quiz_attempts a LEFT JOIN quizzes q ON q.id = a.quiz_id WHERE a.user_id = ? ORDER BY a.id`, id)
  // Activity 2: other people's attempts on this user's quizzes (quiz stats)
  const attemptsOnMyQuizzes = await all(
    `SELECT a.id, a.quiz_id, q.title AS quiz_title, u.username AS player_username,
       a.correct, a.wrong, a.answered, a.total, a.rounds, a.status, a.details, a.created_at, a.updated_at
     FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id LEFT JOIN users u ON u.id = a.user_id
     WHERE q.user_id = ? AND a.user_id != ? ORDER BY a.id`, id, id)

  // Game rooms hosted by this user, with every player + leaderboard
  const rooms = await all('SELECT * FROM game_rooms WHERE host_id = ? ORDER BY id', id)
  const gameRooms = []
  for (const r of rooms) {
    const players = await all(
      `SELECT p.id, p.name, p.score, p.answered, p.answers, p.joined_at, p.last_answer_at, p.finished_at, p.started_at, p.user_id, u.username AS account_username
       FROM game_players p LEFT JOIN users u ON u.id = p.user_id WHERE p.room_id = ?
       ORDER BY p.score DESC, CASE WHEN p.finished_at IS NULL THEN 1 ELSE 0 END ASC, COALESCE(p.finished_at, p.last_answer_at, 9e15) ASC, p.joined_at ASC`, r.id)
    gameRooms.push({
      id: r.id, code: r.code, title: r.title, quiz_id: r.quiz_id, difficulty: r.difficulty,
      start_at: r.start_at, end_at: r.end_at, created_at: r.created_at, time_limit: r.time_limit || 0,
      status: roomStatus(r),
      questions: safeJSON(r.questions, null),
      leaderboard: players.map((p: any, i: number) => ({
        rank: i + 1, name: p.name, score: p.score, answered: p.answered, finished: !!p.finished_at,
        is_host: p.user_id === id, account_username: p.account_username || null,
        joined_at: p.joined_at, last_answer_at: p.last_answer_at, finished_at: p.finished_at, started_at: p.started_at || null,
        answers: safeJSON(p.answers, {})
      }))
    })
  }

  // Games this user played in rooms hosted by other people (+ their rank there)
  const played = await all(
    `SELECT p.id, p.room_id, p.name, p.score, p.answered, p.answers, p.joined_at, p.last_answer_at, p.finished_at,
       r.code, r.title, r.start_at, r.end_at, r.questions, hu.username AS host_username
     FROM game_players p JOIN game_rooms r ON r.id = p.room_id LEFT JOIN users hu ON hu.id = r.host_id
     WHERE p.user_id = ? AND r.host_id != ? ORDER BY p.id`, id, id)
  const gamesPlayed = []
  for (const p of played) {
    const order = await all(
      `SELECT id FROM game_players WHERE room_id = ? ORDER BY score DESC,
         CASE WHEN finished_at IS NULL THEN 1 ELSE 0 END ASC, COALESCE(finished_at, last_answer_at, 9e15) ASC, joined_at ASC`, p.room_id)
    const pos = order.findIndex((x: any) => x.id === p.id)
    const rank = { rank: pos === -1 ? null : pos + 1 }
    const players = { n: order.length }
    gamesPlayed.push({
      room_code: p.code, room_title: p.title, host_username: p.host_username, start_at: p.start_at, end_at: p.end_at,
      total_questions: (safeJSON(p.questions, []) || []).length, players_in_room: players?.n || 0, rank: rank?.rank || null,
      name: p.name, score: p.score, answered: p.answered, answers: safeJSON(p.answers, {}),
      joined_at: p.joined_at, last_answer_at: p.last_answer_at, finished_at: p.finished_at
    })
  }

  const friends = await all(
    `SELECT f.status, f.created_at, f.accepted_at, CASE WHEN f.requester_id = ? THEN 'sent' ELSE 'received' END AS direction, u.username AS other_username
     FROM friends f JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.receiver_id ELSE f.requester_id END
     WHERE f.requester_id = ? OR f.receiver_id = ?`, id, id, id, id)
  const messages = await all(
    `SELECT m.body, m.read_at, m.created_at, CASE WHEN m.sender_id = ? THEN 'sent' ELSE 'received' END AS direction, u.username AS other_username
     FROM messages m JOIN users u ON u.id = CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END
     WHERE m.sender_id = ? OR m.receiver_id = ? ORDER BY m.id`, id, id, id, id)
  const messageRequests = await all(
    `SELECT r.status, r.created_at, CASE WHEN r.requester_id = ? THEN 'sent' ELSE 'received' END AS direction, u.username AS other_username
     FROM message_requests r JOIN users u ON u.id = CASE WHEN r.requester_id = ? THEN r.receiver_id ELSE r.requester_id END
     WHERE r.requester_id = ? OR r.receiver_id = ?`, id, id, id, id)
  const notifications = await all('SELECT type, title, body, link, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id', id)
  const recommendations = await all('SELECT message, status, created_at FROM recommendations WHERE user_id = ? ORDER BY id', id)

  const backup = {
    _unstudy_backup: true,
    _studymate_backup: true,
    _version: 3,
    _exported_at: new Date().toISOString(),
    user: { ...user, signup_info: safeJSON(user.signup_info, user.signup_info) },
    summary: {
      flashcard_sets: flashcards.length, quizzes: quizzes.length,
      quiz_attempts_taken: attemptsTaken.length, attempts_on_my_quizzes: attemptsOnMyQuizzes.length,
      game_rooms_hosted: gameRooms.length, games_played: gamesPlayed.length,
      friends: friends.length, messages: messages.length, notifications: notifications.length
    },
    flashcards: flashcards.map((f: any) => ({ ...f, cards: safeJSON(f.cards, []) })),
    quizzes: quizzes.map((q: any) => ({ ...q, types: safeJSON(q.types, []), questions: safeJSON(q.questions, []) })),
    activity: {
      quiz_attempts: attemptsTaken.map((a: any) => ({ ...a, own_quiz: !!a.own_quiz, details: safeJSON(a.details, null) })),
      attempts_on_my_quizzes: attemptsOnMyQuizzes.map((a: any) => ({ ...a, details: safeJSON(a.details, null) }))
    },
    game_rooms: gameRooms,
    games_played: gamesPlayed,
    friends,
    messages,
    message_requests: messageRequests,
    notifications,
    recommendations
  }

  return c.json(backup)
})

// Restore/import a user from a backup file (v1/v2 = profile, flashcards, quizzes;
// v3 adds activity, game rooms + leaderboards, games played and social data)
app.post('/api/admin/users/restore', async (c) => {
  const s = await requireAdmin(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB

  const backup = await c.req.json()
  if (!(backup._studymate_backup || backup._unstudy_backup) || !backup.user)
    return c.json({ error: 'Invalid backup file format' }, 400)

  const u = backup.user
  const existingEmail = await db.prepare('SELECT id FROM users WHERE email = ?').bind(u.email).first()
  if (existingEmail) return c.json({ error: `Email "${u.email}" already exists. Delete the existing account first.` }, 409)
  const existingName = await db.prepare('SELECT id FROM users WHERE username = ?').bind(u.username).first()
  if (existingName) return c.json({ error: `Username "${u.username}" already exists.` }, 409)

  const nowIso = new Date().toISOString()
  const asStr = (v: any) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v))
  const result = await db.prepare(
    'INSERT INTO users (username, email, password, photo, full_name, birthday, avatar, bio, theme, signup_ip, signup_info, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    u.username, u.email, u.password, u.photo || null,
    u.full_name || null, u.birthday || null, u.avatar || null, u.bio || '', u.theme === 'dark' ? 'dark' : 'light',
    u.signup_ip || null, asStr(u.signup_info), u.created_at || nowIso
  ).run()
  const newUserId = result.meta.last_row_id as number
  const stats: Record<string, number> = { flashcards: 0, quizzes: 0, quiz_attempts: 0, game_rooms: 0, game_players: 0, games_played: 0, friends: 0, messages: 0, notifications: 0, recommendations: 0 }

  // username -> id lookup for other accounts that still exist
  const idCache = new Map<string, number | null>()
  const userIdOf = async (name: any) => {
    if (!name) return null
    const k = String(name)
    if (!idCache.has(k)) {
      const r = await db.prepare('SELECT id FROM users WHERE username = ?').bind(k).first<any>()
      idCache.set(k, r ? r.id : null)
    }
    return idCache.get(k) || null
  }

  // Flashcards
  for (const f of Array.isArray(backup.flashcards) ? backup.flashcards : []) {
    await db.prepare('INSERT INTO flashcard_sets (user_id, title, source_text, cards, share_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(newUserId, f.title, f.source_text || null, JSON.stringify(f.cards || []), shareSlug(), f.created_at || nowIso).run()
    stats.flashcards++
  }

  // Quizzes (keep the old share link when it is still free)
  const quizMap = new Map<number, number>()
  for (const q of Array.isArray(backup.quizzes) ? backup.quizzes : []) {
    let share = q.share_id && !(await db.prepare('SELECT id FROM quizzes WHERE share_id = ?').bind(q.share_id).first()) ? q.share_id : shareSlug()
    const r = await db.prepare('INSERT INTO quizzes (user_id, title, types, questions, share_id, difficulty, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(newUserId, q.title, JSON.stringify(q.types || []), JSON.stringify(q.questions || []), share, q.difficulty || 'medium', q.created_at || nowIso).run()
    if (q.id != null) quizMap.set(Number(q.id), r.meta.last_row_id as number)
    stats.quizzes++
  }

  const insertAttempt = async (quizId: number, userId: number, a: any) => {
    await db.prepare(
      `INSERT INTO quiz_attempts (quiz_id, user_id, correct, wrong, answered, total, rounds, status, details, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(quizId, userId, a.correct || 0, a.wrong || 0, a.answered || 0, a.total || 0, a.rounds || 1, a.status || 'completed',
      asStr(a.details), a.created_at || nowIso, a.updated_at || a.created_at || nowIso).run()
    stats.quiz_attempts++
  }
  const act = backup.activity || {}
  // Quizzes this user took (own quizzes → new ids; other quizzes → found by share link)
  for (const a of Array.isArray(act.quiz_attempts) ? act.quiz_attempts : []) {
    let qid = quizMap.get(Number(a.quiz_id)) || null
    if (!qid && a.quiz_share_id) {
      const q = await db.prepare('SELECT id FROM quizzes WHERE share_id = ?').bind(a.quiz_share_id).first<any>()
      qid = q ? q.id : null
    }
    if (qid) await insertAttempt(qid, newUserId, a)
  }
  // Other people's attempts on this user's quizzes (only if that player still exists)
  for (const a of Array.isArray(act.attempts_on_my_quizzes) ? act.attempts_on_my_quizzes : []) {
    const qid = quizMap.get(Number(a.quiz_id))
    const pid = await userIdOf(a.player_username)
    if (qid && pid) await insertAttempt(qid, pid, a)
  }

  // Game rooms hosted by this user, with players + leaderboard
  for (const r of Array.isArray(backup.game_rooms) ? backup.game_rooms : []) {
    let code = String(r.code || '').toUpperCase().replace(/[^A-Z]/g, '')
    const taken = async (cd: string) => !cd || !!(await db.prepare('SELECT id FROM game_rooms WHERE code = ?').bind(cd).first())
    for (let t = 0; (await taken(code)) && t < 10; t++) {
      const b = new Uint8Array(6); crypto.getRandomValues(b)
      code = Array.from(b, (x) => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[x % 24]).join('')
    }
    const rr = await db.prepare(
      'INSERT INTO game_rooms (code, host_id, title, quiz_id, questions, difficulty, start_at, end_at, created_at, time_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(code, newUserId, r.title || 'Untitled room', quizMap.get(Number(r.quiz_id)) || null,
      r.questions ? JSON.stringify(r.questions) : null, r.difficulty || 'medium', r.start_at || null, r.end_at || null, r.created_at || nowIso, Number(r.time_limit) || 0).run()
    const roomId = rr.meta.last_row_id as number
    stats.game_rooms++
    const usedNames = new Set<string>()
    for (const p of Array.isArray(r.leaderboard) ? r.leaderboard : []) {
      let name = String(p.name || 'Player').slice(0, 24)
      for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${String(p.name).slice(0, 20)} ${n}`
      usedNames.add(name.toLowerCase())
      const uid = p.is_host ? newUserId : await userIdOf(p.account_username)
      await db.prepare(
        'INSERT INTO game_players (room_id, name, token, score, answered, answers, joined_at, last_answer_at, finished_at, user_id, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(roomId, name, randomToken(), p.score || 0, p.answered || 0, JSON.stringify(p.answers || {}),
        p.joined_at || Date.now(), p.last_answer_at || null, p.finished_at || null, uid, p.started_at || null).run()
      stats.game_players++
    }
  }

  // Games played in other hosts' rooms: re-link the player entry (kept, unlinked, on delete)
  for (const g of Array.isArray(backup.games_played) ? backup.games_played : []) {
    const room = await db.prepare('SELECT id FROM game_rooms WHERE code = ?').bind(g.room_code).first<any>()
    if (!room) continue
    const p = await db.prepare('SELECT id FROM game_players WHERE room_id = ? AND LOWER(name) = LOWER(?) AND user_id IS NULL').bind(room.id, g.name).first<any>()
    if (p) {
      await db.prepare('UPDATE game_players SET user_id = ? WHERE id = ?').bind(newUserId, p.id).run()
      stats.games_played++
    }
  }

  // Friends / messages / message requests (only with accounts that still exist)
  for (const f of Array.isArray(backup.friends) ? backup.friends : []) {
    const other = await userIdOf(f.other_username)
    if (!other || other === newUserId) continue
    const [a, b] = f.direction === 'sent' ? [newUserId, other] : [other, newUserId]
    await db.prepare('INSERT OR IGNORE INTO friends (requester_id, receiver_id, status, created_at, accepted_at) VALUES (?, ?, ?, ?, ?)')
      .bind(a, b, f.status || 'pending', f.created_at || nowIso, f.accepted_at || null).run()
    stats.friends++
  }
  for (const m of Array.isArray(backup.messages) ? backup.messages : []) {
    const other = await userIdOf(m.other_username)
    if (!other || other === newUserId) continue
    const [a, b] = m.direction === 'sent' ? [newUserId, other] : [other, newUserId]
    await db.prepare('INSERT INTO messages (sender_id, receiver_id, body, read_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(a, b, String(m.body || ''), m.read_at || null, m.created_at || nowIso).run()
    stats.messages++
  }
  for (const m of Array.isArray(backup.message_requests) ? backup.message_requests : []) {
    const other = await userIdOf(m.other_username)
    if (!other || other === newUserId) continue
    const [a, b] = m.direction === 'sent' ? [newUserId, other] : [other, newUserId]
    await db.prepare('INSERT OR IGNORE INTO message_requests (requester_id, receiver_id, status, created_at) VALUES (?, ?, ?, ?)')
      .bind(a, b, m.status || 'pending', m.created_at || nowIso).run()
  }
  for (const n of Array.isArray(backup.notifications) ? backup.notifications : []) {
    await db.prepare('INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(newUserId, n.type || 'system', n.title || '', n.body || '', n.link || null, n.is_read ? 1 : 0, n.created_at || nowIso).run()
    stats.notifications++
  }
  for (const r of Array.isArray(backup.recommendations) ? backup.recommendations : []) {
    await db.prepare('INSERT INTO recommendations (user_id, message, status, created_at) VALUES (?, ?, ?, ?)')
      .bind(newUserId, String(r.message || ''), r.status || 'new', r.created_at || nowIso).run()
    stats.recommendations++
  }

  return c.json({ ok: true, user_id: newUserId, username: u.username, restored: stats })
})

// =================== SOCIAL: presence / notifications / inbox / push ===================
registerSocial(app)
registerGame(app)

// =================== PAGES ===================
app.get('/sw.js', (c) => c.body(SERVICE_WORKER_JS, 200, {
  'Content-Type': 'application/javascript; charset=utf-8',
  'Cache-Control': 'no-cache',
  'Service-Worker-Allowed': '/'
}))
app.get('/manifest.webmanifest', (c) => c.body(JSON.stringify(MANIFEST), 200, { 'Content-Type': 'application/manifest+json' }))
app.get('/', (c) => c.html(pageShell('auth')))
app.get('/app', (c) => c.html(pageShell('app')))
app.get('/admin', (c) => c.html(pageShell('admin')))
app.get('/share/flashcards/:slug', (c) => c.html(pageShell('share-flashcards')))
app.get('/quiz/:slug', (c) => c.html(pageShell('quiz')))
app.get('/game/:code', (c) => c.html(pageShell('game')))
app.get('/game', (c) => c.html(pageShell('game')))
// Old share links keep working — they now open the quiz-only page
app.get('/share/quiz/:slug', (c) => c.redirect('/quiz/' + c.req.param('slug')))

export default app
