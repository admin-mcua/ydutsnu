import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { generateFlashcardsDetailed, generateQuiz, generateTitle, parseQuizFromText, setGeminiDb, testGeminiKey, toGeminiError, MODELS } from './lib/gemini'
import { collectSignupInfo } from './lib/device'
import { randomToken, shareSlug, getToken, getSession } from './lib/auth'
import { pageShell } from './pages'

type Bindings = { DB: D1Database }

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
  const admin = await c.env.DB.prepare(
    'SELECT * FROM admins WHERE username = ? AND password = ?'
  )
    .bind(username, password)
    .first<any>()
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
  if (token)
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
  return c.json({ ok: true })
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
            u.username, u.avatar, u.full_name,
            'flashcard' as content_type
     FROM flashcard_sets f
     JOIN users u ON f.user_id = u.id
     ORDER BY f.created_at DESC
     LIMIT 50`
  ).all()

  const { results: quizzes } = await c.env.DB.prepare(
    `SELECT q.id, q.title, q.types, q.questions, q.share_id, q.created_at, q.user_id, q.difficulty,
            u.username, u.avatar, u.full_name,
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
  let query = `SELECT u.id, u.username, u.full_name, u.avatar, u.bio, u.created_at,
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
    `SELECT id, username, full_name, avatar, bio, created_at FROM users WHERE id = ?`
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

  return c.json({ ok: true })
})

// Accept friend request
app.post('/api/friends/accept', async (c) => {
  const s = await requireUser(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const { user_id } = await c.req.json()

  await c.env.DB.prepare(
    `UPDATE friends SET status = 'accepted' WHERE requester_id = ? AND receiver_id = ? AND status = 'pending'`
  ).bind(user_id, s.user_id).run()

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
    `SELECT u.id, u.username, u.full_name, u.avatar
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
    out.push({ type, question, options, answer, explanation: explanation || undefined })
  }
  return { questions: out }
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
  const all = JSON.parse(row.questions)
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
       u.signup_ip, u.signup_info,
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
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM friends WHERE requester_id = ? OR receiver_id = ?').bind(id, id).run()
  await c.env.DB.prepare('DELETE FROM flashcard_sets WHERE user_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM quiz_attempts WHERE user_id = ? OR quiz_id IN (SELECT id FROM quizzes WHERE user_id = ?)').bind(id, id).run()
  await c.env.DB.prepare('DELETE FROM quizzes WHERE user_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND role = ?').bind(id, 'user').run()
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run()
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

// Download backup of a single user account (JSON file with all their data)
app.get('/api/admin/users/:id/backup', async (c) => {
  const s = await requireAdmin(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)
  const id = c.req.param('id')

  const user = await c.env.DB.prepare(
    'SELECT id, username, email, password, photo, full_name, birthday, avatar, bio, signup_ip, signup_info, created_at FROM users WHERE id = ?'
  ).bind(id).first<any>()
  if (!user) return c.json({ error: 'User not found' }, 404)

  const { results: flashcards } = await c.env.DB.prepare(
    'SELECT id, title, source_text, cards, share_id, created_at FROM flashcard_sets WHERE user_id = ?'
  ).bind(id).all()

  const { results: quizzes } = await c.env.DB.prepare(
    'SELECT id, title, types, questions, share_id, created_at FROM quizzes WHERE user_id = ?'
  ).bind(id).all()

  const backup = {
    _unstudy_backup: true,
    _studymate_backup: true,
    _version: 2,
    _exported_at: new Date().toISOString(),
    user,
    flashcards: flashcards.map((f: any) => ({ ...f, cards: JSON.parse(f.cards) })),
    quizzes: quizzes.map((q: any) => ({ ...q, types: JSON.parse(q.types), questions: JSON.parse(q.questions) }))
  }

  return c.json(backup)
})

// Restore/import a user from a backup file
app.post('/api/admin/users/restore', async (c) => {
  const s = await requireAdmin(c)
  if (!s) return c.json({ error: 'Unauthorized' }, 401)

  const backup = await c.req.json()
  if (!(backup._studymate_backup || backup._unstudy_backup) || !backup.user)
    return c.json({ error: 'Invalid backup file format' }, 400)

  const u = backup.user

  // Check if username or email already exists
  const existingEmail = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(u.email).first()
  if (existingEmail) return c.json({ error: `Email "${u.email}" already exists. Delete the existing account first.` }, 409)

  const existingName = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(u.username).first()
  if (existingName) return c.json({ error: `Username "${u.username}" already exists.` }, 409)

  // Insert user
  const result = await c.env.DB.prepare(
    'INSERT INTO users (username, email, password, photo, full_name, birthday, avatar, bio, signup_ip, signup_info, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    u.username, u.email, u.password, u.photo || null,
    u.full_name || null, u.birthday || null, u.avatar || null, u.bio || '',
    u.signup_ip || null, typeof u.signup_info === 'string' ? u.signup_info : (u.signup_info ? JSON.stringify(u.signup_info) : null),
    u.created_at || new Date().toISOString()
  ).run()
  const newUserId = result.meta.last_row_id as number

  // Restore flashcards
  if (backup.flashcards && Array.isArray(backup.flashcards)) {
    for (const f of backup.flashcards) {
      const share = shareSlug()
      await c.env.DB.prepare(
        'INSERT INTO flashcard_sets (user_id, title, source_text, cards, share_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(
        newUserId, f.title, f.source_text || null,
        JSON.stringify(f.cards), share, f.created_at || new Date().toISOString()
      ).run()
    }
  }

  // Restore quizzes
  if (backup.quizzes && Array.isArray(backup.quizzes)) {
    for (const q of backup.quizzes) {
      const share = shareSlug()
      await c.env.DB.prepare(
        'INSERT INTO quizzes (user_id, title, types, questions, share_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(
        newUserId, q.title, JSON.stringify(q.types),
        JSON.stringify(q.questions), share, q.created_at || new Date().toISOString()
      ).run()
    }
  }

  return c.json({ ok: true, user_id: newUserId, username: u.username })
})

// =================== PAGES ===================
app.get('/', (c) => c.html(pageShell('auth')))
app.get('/app', (c) => c.html(pageShell('app')))
app.get('/admin', (c) => c.html(pageShell('admin')))
app.get('/share/flashcards/:slug', (c) => c.html(pageShell('share-flashcards')))
app.get('/quiz/:slug', (c) => c.html(pageShell('quiz')))
// Old share links keep working — they now open the quiz-only page
app.get('/share/quiz/:slug', (c) => c.redirect('/quiz/' + c.req.param('slug')))

export default app
