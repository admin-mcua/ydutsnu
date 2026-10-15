// Live quiz "Game" rooms: host creates a room, attaches a quiz, schedules it,
// players join with a letters-only code / link, wait, then answer live.
import type { Hono } from 'hono'
import { getToken, getSession, randomToken } from './lib/auth'

type Env = { Bindings: { DB: D1Database } }

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // letters only (no I / O to avoid confusion)
const CODE_LEN = 6

function makeCode(): string {
  const bytes = new Uint8Array(CODE_LEN)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => LETTERS[b % LETTERS.length]).join('')
}
const cleanCode = (s: any) => String(s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 12)
const norm = (s: any) => String(s ?? '').trim().toLowerCase()

// question title / section: blank -> inherits the previous question's title
function withSections(list: any[]) {
  let cur = ''
  return (list || []).map((q: any) => {
    const t = String(q?.title || '').trim()
    if (t) cur = t
    return { ...q, section: cur || undefined }
  })
}

async function requireUser(c: any) {
  const s = await getSession(c.env.DB, getToken(c))
  return s && s.role === 'user' ? s : null
}
const unauthorized = (c: any) => c.json({ error: 'Log in to host a game.' }, 401)

export function roomStatus(r: any, now = Date.now()) {
  if (!r.questions) return 'setup'               // no quiz yet
  if (!r.start_at || !r.end_at) return 'setup'   // not scheduled yet
  if (now >= r.end_at) return 'closed'
  if (now >= r.start_at) return 'live'
  return 'scheduled'                             // waiting room open
}

// Ranking: highest score first; same score -> players who finished beat players
// still answering, then whoever used LESS TIME on their own timer
// (each student's timer starts when they enter the live quiz), then join time.
const RANK_SQL = `ORDER BY score DESC,
  CASE WHEN finished_at IS NULL THEN 1 ELSE 0 END ASC,
  COALESCE(finished_at, last_answer_at, 9e15) - COALESCE(started_at, joined_at) - COALESCE(paused_ms, 0) ASC,
  joined_at ASC`

export const MAX_TIME_LIMIT = 6 * 3600 // 6 hours (seconds)
const GRACE_MS = 2000                  // network grace for the last answer

// ---------------- NETWORK PING / WEAK-CONNECTION PAUSE ----------------
// Every player sends a heartbeat (with their measured ping + wifi/data type).
// While a player's connection is WEAK (ping >= LAG_PING_MS, or offline) their
// personal timer is PAUSED so a bad network never eats their time.
// Abuse protection: the total pause per player is capped (MAX_PAUSE_MS), it never
// applies while the player is OUT of the app, and the room closing time stays a hard limit.
export const LAG_PING_MS = 500        // ping at / above this = weak connection → timer paused
export const MAX_PAUSE_MS = 5 * 60_000 // a player can be paused for at most 5 minutes in total
const HEARTBEAT_STALE_MS = 10_000     // no heartbeat for 10s → treated as offline
const OFFLINE_GAP_MS = 8_000          // a gap longer than this between heartbeats = was offline

// ---------------- ANTI-CHEAT ACTIVITY LOG ----------------
// "in"  = the player is in the app answering the quiz
// "out" = the player left the app / tab (e.g. to ask an AI model)
// Logged from the moment their timer starts until their quiz stops.
const SUSPICIOUS_OUTS = 10       // left the app 10+ times → suspicious
const SUSPICIOUS_AWAY_MS = 60_000 // or was out for 60s+ in total → suspicious
const MAX_LOG = 400
export const isSuspicious = (p: any) => (Number(p.away_count) || 0) >= SUSPICIOUS_OUTS || (Number(p.away_ms) || 0) >= SUSPICIOUS_AWAY_MS

// Total time this player's timer has been paused (weak connection), up to `now`
export function pausedTotal(p: any, now = Date.now()): number {
  let ms = Number(p.paused_ms) || 0
  if (p.lag_since) {
    const until = Math.min(now, (Number(p.last_ping_at) || Number(p.lag_since)) + HEARTBEAT_STALE_MS)
    ms += Math.max(0, until - Number(p.lag_since))
  }
  return Math.min(MAX_PAUSE_MS, ms)
}

// Personal deadline of a player (epoch ms) — null when the room has no time limit
// or the player's timer has not started yet. Weak-connection pauses push it back.
export function playerDeadline(r: any, p: any, now = Date.now()): number | null {
  const lim = Number(r.time_limit) || 0
  if (!lim || !p.started_at) return null
  return Number(p.started_at) + lim * 1000 + pausedTotal(p, now)
}

// Players whose own timer ran out are marked as finished (at their deadline).
async function finalizeExpired(db: D1Database, r: any, now = Date.now()) {
  const lim = Number(r.time_limit) || 0
  if (!lim) return
  // candidates: the base deadline (without pauses) has passed
  const { results } = await db.prepare(
    `SELECT id, started_at, paused_ms, lag_since, last_ping_at FROM game_players
     WHERE room_id = ? AND finished_at IS NULL AND started_at IS NOT NULL AND started_at + ? <= ?`
  ).bind(r.id, lim * 1000, now).all<any>()
  for (const p of results) {
    const dl = playerDeadline(r, p, now)
    if (dl && dl <= now) {
      await db.prepare('UPDATE game_players SET finished_at = ?, paused_ms = ?, lag_since = NULL WHERE id = ? AND finished_at IS NULL')
        .bind(dl, pausedTotal(p, dl), p.id).run()
    }
  }
}

// Close a running weak-connection pause (when the player finishes)
async function closeLag(db: D1Database, p: any, now = Date.now()) {
  if (!p.lag_since) return
  await db.prepare('UPDATE game_players SET paused_ms = ?, lag_since = NULL WHERE id = ?').bind(pausedTotal(p, now), p.id).run()
}

const parseLog = (s: any): any[] => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : [] } catch (e) { return [] } }
// Is this player's activity log still recording? (timer started, quiz not stopped)
const logOpen = (r: any, p: any, now = Date.now()) => !!p.started_at && !p.finished_at && roomStatus(r, now) === 'live'

// Append an "in" / "out" event (duplicates of the last state are ignored)
async function logActivity(db: D1Database, r: any, p: any, type: 'in' | 'out', now = Date.now()) {
  if (!logOpen(r, p, now)) return false
  const log = parseLog(p.activity_log)
  const last = log[log.length - 1]
  if (last && last.t === type) return false
  if (!last && type === 'in') { /* first entry */ }
  log.push({ t: type, at: now })
  while (log.length > MAX_LOG) log.shift()
  let awayCount = Number(p.away_count) || 0, awayMs = Number(p.away_ms) || 0
  if (type === 'out') awayCount++
  if (type === 'in' && last && last.t === 'out') awayMs += Math.max(0, now - Number(last.at))
  // leaving the app ends any weak-connection pause (no pausing while out)
  let paused = Number(p.paused_ms) || 0, lag = p.lag_since || null
  if (type === 'out' && lag) { paused = pausedTotal(p, now); lag = null }
  await db.prepare('UPDATE game_players SET activity_log = ?, away_count = ?, away_ms = ?, paused_ms = ?, lag_since = ? WHERE id = ?')
    .bind(JSON.stringify(log), awayCount, awayMs, paused, lag, p.id).run()
  p.activity_log = JSON.stringify(log); p.away_count = awayCount; p.away_ms = awayMs; p.paused_ms = paused; p.lag_since = lag
  return true
}

// Summary of a player's log (+ time currently out when the last event is "out")
function activitySummary(r: any, p: any, now = Date.now()) {
  const log = parseLog(p.activity_log)
  const last = log[log.length - 1]
  const recording = logOpen(r, p, now)
  let awayMs = Number(p.away_ms) || 0
  if (last && last.t === 'out') {
    const end = recording ? now : (p.finished_at || Math.min(now, r.end_at || now))
    awayMs += Math.max(0, end - Number(last.at))
  }
  const sum = { away_count: Number(p.away_count) || 0, away_ms: awayMs }
  return { ...sum, suspicious: isSuspicious(sum), recording, is_out: !!(recording && last && last.t === 'out'), log }
}

function netInfo(p: any, now = Date.now()) {
  const fresh = !!p.last_ping_at && now - Number(p.last_ping_at) < HEARTBEAT_STALE_MS
  return {
    ping_ms: p.ping_ms == null ? null : Number(p.ping_ms),
    net_type: p.net_type || 'unknown',
    online: fresh,
    last_ping_at: p.last_ping_at || null,
    lagging: !!p.lag_since && fresh,
    paused_ms: pausedTotal(p, now)
  }
}

async function leaderboard(db: D1Database, r: any) {
  const now = Date.now()
  const { results } = await db
    .prepare(`SELECT id, name, score, answered, joined_at, last_answer_at, finished_at, started_at,
      activity_log, away_count, away_ms, ping_ms, net_type, last_ping_at, paused_ms, lag_since
      FROM game_players WHERE room_id = ? ${RANK_SQL}`)
    .bind(r.id)
    .all<any>()
  const lim = (Number(r.time_limit) || 0) * 1000
  return results.map((p: any, i: number) => {
    const dl = playerDeadline(r, p, now)
    const end = p.finished_at || (roomStatus(r, now) === 'closed' ? Math.min(r.end_at, dl || 9e15) : now)
    const stop = Math.min(end, dl || 9e15)
    const time_used = p.started_at ? Math.max(0, stop - p.started_at - pausedTotal(p, stop)) : 0
    const timed_out = !!(lim && p.started_at && p.finished_at && p.answered < totalOf(r) && p.finished_at >= p.started_at + lim)
    const act = activitySummary(r, p, now)
    const { activity_log, lag_since, ...rest } = p
    return {
      rank: i + 1, ...rest, time_used, timed_out, deadline: dl,
      away_count: act.away_count, away_ms: act.away_ms, suspicious: act.suspicious, is_out: act.is_out, log_recording: act.recording,
      net: netInfo(p, now)
    }
  })
}
const totalOf = (r: any) => (r.questions ? JSON.parse(r.questions).length : 0)

function publicRoom(r: any, now = Date.now()) {
  const qs = r.questions ? JSON.parse(r.questions) : []
  return {
    code: r.code,
    title: r.title,
    difficulty: r.difficulty,
    total: qs.length,
    start_at: r.start_at,
    end_at: r.end_at,
    time_limit: Number(r.time_limit) || 0, // seconds per student (0 = no limit)
    status: roomStatus(r, now),
    now
  }
}

// questions WITHOUT answers (players must not see them before answering)
function playerQuestions(r: any) {
  const qs = r.questions ? JSON.parse(r.questions) : []
  return withSections(qs).map((q: any, i: number) => ({
    i,
    type: q.type,
    section: q.section,
    question: q.question,
    options: q.type === 'identification' ? undefined : (q.type === 'true_false' ? ['True', 'False'] : q.options)
  }))
}

// Full review of one player's answers (question, options, correct answer, chosen answer)
function reviewOf(r: any, answersJson: any) {
  const full = r.questions ? JSON.parse(r.questions) : []
  const answers = JSON.parse(answersJson || '{}')
  return withSections(full).map((q: any, i: number) => ({
    i, type: q.type, section: q.section, question: q.question,
    options: q.type === 'identification' ? undefined : (q.type === 'true_false' ? ['True', 'False'] : q.options),
    answer: q.answer, explanation: q.explanation || '',
    chosen: answers[i] ? answers[i].a : null,
    correct: answers[i] ? !!answers[i].c : false,
    skipped: !answers[i]
  }))
}

async function getRoom(db: D1Database, code: string) {
  return db.prepare('SELECT * FROM game_rooms WHERE code = ?').bind(code).first<any>()
}
async function ownRoom(c: any, s: any) {
  const r = await getRoom(c.env.DB, cleanCode(c.req.param('code')))
  return r && r.host_id === s.user_id ? r : null
}

export function registerGame(app: Hono<Env>) {
  // ================= HOST =================
  // List my rooms
  app.get('/api/game/rooms', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const { results } = await c.env.DB.prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM game_players p WHERE p.room_id = r.id) AS players
       FROM game_rooms r WHERE r.host_id = ? ORDER BY r.created_at DESC`
    ).bind(s.user_id).all<any>()
    const now = Date.now()
    return c.json({ rooms: results.map((r: any) => ({ ...publicRoom(r, now), players: r.players, quiz_id: r.quiz_id, created_at: r.created_at })) })
  })

  // Create a room with a random letters-only code
  app.post('/api/game/rooms', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    for (let tries = 0; tries < 8; tries++) {
      const code = makeCode()
      const exists = await c.env.DB.prepare('SELECT id FROM game_rooms WHERE code = ?').bind(code).first()
      if (exists) continue
      await c.env.DB.prepare('INSERT INTO game_rooms (code, host_id, title) VALUES (?, ?, ?)')
        .bind(code, s.user_id, 'New room').run()
      const r = await getRoom(c.env.DB, code)
      return c.json({ room: publicRoom(r) })
    }
    return c.json({ error: 'Could not create a room code. Please try again.' }, 500)
  })

  // Room details for the host (includes the leaderboard)
  app.get('/api/game/rooms/:code', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const r = await ownRoom(c, s)
    if (!r) return c.json({ error: 'Room not found' }, 404)
    await finalizeExpired(c.env.DB, r)
    return c.json({
      room: { ...publicRoom(r), quiz_id: r.quiz_id, questions: r.questions ? JSON.parse(r.questions) : [] },
      leaderboard: await leaderboard(c.env.DB, r)
    })
  })

  // Attach a quiz (one of mine, or any quiz shown on the Home feed). The quiz title becomes the room name.
  app.put('/api/game/rooms/:code/quiz', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const r = await ownRoom(c, s)
    if (!r) return c.json({ error: 'Room not found' }, 404)
    const st = roomStatus(r)
    if (st === 'live' || st === 'closed') return c.json({ error: 'The quiz can no longer be changed — this room has already started.' }, 400)
    const { quiz_id } = await c.req.json()
    const q = await c.env.DB.prepare('SELECT id, title, questions, difficulty FROM quizzes WHERE id = ?').bind(quiz_id).first<any>()
    if (!q) return c.json({ error: 'Quiz not found' }, 404)
    if (!JSON.parse(q.questions).length) return c.json({ error: 'That quiz has no questions.' }, 400)
    await c.env.DB.prepare('UPDATE game_rooms SET quiz_id = ?, title = ?, questions = ?, difficulty = ? WHERE id = ?')
      .bind(q.id, q.title, q.questions, q.difficulty || 'medium', r.id).run()
    return c.json({ ok: true, title: q.title })
  })

  // Schedule when the quiz starts and when the room closes (epoch ms)
  app.put('/api/game/rooms/:code/schedule', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const r = await ownRoom(c, s)
    if (!r) return c.json({ error: 'Room not found' }, 404)
    if (!r.questions) return c.json({ error: 'Add a quiz to the room first.' }, 400)
    const st = roomStatus(r)
    if (st === 'live' || st === 'closed') return c.json({ error: 'This room has already started — the schedule can no longer be changed.' }, 400)
    const b = await c.req.json()
    const start = Number(b.start_at), end = Number(b.end_at)
    if (!start || !end) return c.json({ error: 'Choose both a start time and a closing time.' }, 400)
    if (start < Date.now() - 60_000) return c.json({ error: 'The start time must be in the future.' }, 400)
    if (end <= start + 60_000) return c.json({ error: 'The room must close at least 1 minute after the quiz starts.' }, 400)
    const limit = b.time_limit === undefined ? (Number(r.time_limit) || 0) : Math.round(Number(b.time_limit) || 0)
    if (limit < 0 || limit > MAX_TIME_LIMIT) return c.json({ error: 'The timer must be between 0 and 360 minutes.' }, 400)
    await c.env.DB.prepare('UPDATE game_rooms SET start_at = ?, end_at = ?, time_limit = ? WHERE id = ?').bind(start, end, limit, r.id).run()
    return c.json({ ok: true })
  })

  // Change only the per-student timer (allowed until the quiz starts)
  app.put('/api/game/rooms/:code/timer', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const r = await ownRoom(c, s)
    if (!r) return c.json({ error: 'Room not found' }, 404)
    const st = roomStatus(r)
    if (st === 'live' || st === 'closed') return c.json({ error: 'The timer can no longer be changed — this room has already started.' }, 400)
    const b = await c.req.json().catch(() => ({}))
    const limit = Math.round(Number(b.time_limit) || 0)
    if (limit < 0 || limit > MAX_TIME_LIMIT) return c.json({ error: 'The timer must be between 0 and 360 minutes.' }, 400)
    await c.env.DB.prepare('UPDATE game_rooms SET time_limit = ? WHERE id = ?').bind(limit, r.id).run()
    return c.json({ ok: true, time_limit: limit })
  })

  // Close the room right now
  app.post('/api/game/rooms/:code/close', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const r = await ownRoom(c, s)
    if (!r) return c.json({ error: 'Room not found' }, 404)
    const now = Date.now()
    await c.env.DB.prepare('UPDATE game_rooms SET end_at = ?, start_at = COALESCE(MIN(start_at, ?), ?) WHERE id = ?')
      .bind(now, now, now, r.id).run()
    return c.json({ ok: true })
  })

  // Re-open a closed room. Players, answers and the leaderboard are KEPT —
  // players who still have unanswered questions can continue, new players can join.
  // Optional start_at in the future puts the room back into the waiting room.
  app.post('/api/game/rooms/:code/reopen', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const r = await ownRoom(c, s)
    if (!r) return c.json({ error: 'Room not found' }, 404)
    if (!r.questions) return c.json({ error: 'Add a quiz to the room first.' }, 400)
    if (roomStatus(r) !== 'closed') return c.json({ error: 'This room is not closed.' }, 400)
    const b = await c.req.json().catch(() => ({}))
    const now = Date.now()
    const end = Number(b.end_at)
    let start = Number(b.start_at) || 0
    if (!end) return c.json({ error: 'Choose when the room closes again.' }, 400)
    if (start && start < now - 60_000) start = 0
    const effStart = start || Math.min(r.start_at || now, now)
    if (end <= Math.max(now, effStart) + 60_000) return c.json({ error: 'The room must stay open for at least 1 minute.' }, 400)
    await c.env.DB.prepare('UPDATE game_rooms SET start_at = ?, end_at = ? WHERE id = ?').bind(effStart, end, r.id).run()
    return c.json({ ok: true })
  })

  // Host: see one player's answers (correct / wrong for every question)
  app.get('/api/game/rooms/:code/players/:pid/answers', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const r = await ownRoom(c, s)
    if (!r) return c.json({ error: 'Room not found' }, 404)
    await finalizeExpired(c.env.DB, r)
    const p = await c.env.DB.prepare('SELECT * FROM game_players WHERE id = ? AND room_id = ?').bind(c.req.param('pid'), r.id).first<any>()
    if (!p) return c.json({ error: 'Player not found' }, 404)
    const board = await leaderboard(c.env.DB, r)
    const row: any = board.find((x) => x.id === p.id) || {}
    const review = reviewOf(r, p.answers)
    return c.json({
      player: {
        id: p.id, name: p.name, guest: !p.user_id, score: p.score, answered: p.answered, total: review.length,
        wrong: Math.max(0, p.answered - p.score), skipped: review.filter((q: any) => q.skipped).length,
        rank: row.rank || null, finished: !!p.finished_at, time_used: row.time_used || 0, timed_out: !!row.timed_out
      },
      activity: activitySummary(r, p),
      net: netInfo(p),
      review
    })
  })

  // Host: one player's in / out activity log (anti-cheat) + network info
  app.get('/api/game/rooms/:code/players/:pid/log', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const r = await ownRoom(c, s)
    if (!r) return c.json({ error: 'Room not found' }, 404)
    await finalizeExpired(c.env.DB, r)
    const p = await c.env.DB.prepare('SELECT * FROM game_players WHERE id = ? AND room_id = ?').bind(c.req.param('pid'), r.id).first<any>()
    if (!p) return c.json({ error: 'Player not found' }, 404)
    return c.json({
      player: { id: p.id, name: p.name, started_at: p.started_at || null, finished_at: p.finished_at || null },
      activity: activitySummary(r, p),
      net: netInfo(p),
      now: Date.now()
    })
  })

  // Remove a player (host moderation)
  app.delete('/api/game/rooms/:code/players/:pid', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const r = await ownRoom(c, s)
    if (!r) return c.json({ error: 'Room not found' }, 404)
    await c.env.DB.prepare('DELETE FROM game_players WHERE id = ? AND room_id = ?').bind(c.req.param('pid'), r.id).run()
    return c.json({ ok: true })
  })

  app.delete('/api/game/rooms/:code', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const r = await ownRoom(c, s)
    if (!r) return c.json({ error: 'Room not found' }, 404)
    await c.env.DB.prepare('DELETE FROM game_players WHERE room_id = ?').bind(r.id).run()
    await c.env.DB.prepare('DELETE FROM game_rooms WHERE id = ?').bind(r.id).run()
    return c.json({ ok: true })
  })

  // ================= PLAYERS (no account needed) =================
  // Public room info (used by the Join box and the player page)
  app.get('/api/game/join/:code', async (c) => {
    const r = await getRoom(c.env.DB, cleanCode(c.req.param('code')))
    if (!r) return c.json({ error: 'No room found with that code.' }, 404)
    const info = publicRoom(r)
    if (info.status === 'setup') return c.json({ error: 'This room is not ready yet. Ask the host to add a quiz and set the schedule.', room: info }, 409)
    return c.json({ room: info })
  })

  // Who am I? Lets the player page skip the name prompt for logged-in users.
  app.get('/api/game/whoami', async (c) => {
    const s = await requireUser(c)
    if (!s) return c.json({ user: null })
    const u = await c.env.DB.prepare('SELECT id, username FROM users WHERE id = ?').bind(s.user_id).first<any>()
    return c.json({ user: u ? { id: u.id, username: u.username } : null })
  })

  // Join -> returns a player token.
  // Logged-in Unstudy users join with their username (no name needed) and can
  // rejoin later (any device) with the same player. Guests must enter a name.
  app.post('/api/game/join/:code', async (c) => {
    const r = await getRoom(c.env.DB, cleanCode(c.req.param('code')))
    if (!r) return c.json({ error: 'No room found with that code.' }, 404)
    const s = await requireUser(c)
    const user = s ? await c.env.DB.prepare('SELECT id, username FROM users WHERE id = ?').bind(s.user_id).first<any>() : null
    if (user) {
      const mine = await c.env.DB.prepare('SELECT id, token, name FROM game_players WHERE room_id = ? AND user_id = ?').bind(r.id, user.id).first<any>()
      if (mine) return c.json({ id: mine.id, token: mine.token, name: mine.name, account: true, rejoined: true })
    }
    const st = roomStatus(r)
    if (st === 'setup') return c.json({ error: 'This room is not ready yet.' }, 409)
    if (st === 'closed') return c.json({ error: 'This room is already closed.' }, 410)
    const b = await c.req.json().catch(() => ({}))
    const clean = (v: any) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 24)
    let name = user ? clean(user.username) : clean(b.name)
    if (name.length < 2) {
      if (!user) return c.json({ error: 'Enter a name (at least 2 characters).' }, 400)
      name = (name + 'Player').slice(0, 24)
    }
    const isTaken = async (n: string) => !!(await c.env.DB.prepare('SELECT id FROM game_players WHERE room_id = ? AND LOWER(name) = LOWER(?)').bind(r.id, n).first())
    if (await isTaken(name)) {
      if (!user) return c.json({ error: 'That name is already taken in this room. Try another one.' }, 409)
      // a guest already uses this username -> add a number
      const base = name.slice(0, 20)
      let n = 2
      while (await isTaken(`${base} ${n}`) && n < 99) n++
      name = `${base} ${n}`
    }
    const token = randomToken()
    const ins = await c.env.DB.prepare('INSERT INTO game_players (room_id, name, token, joined_at, user_id) VALUES (?, ?, ?, ?, ?)')
      .bind(r.id, name, token, Date.now(), user ? user.id : null).run()
    return c.json({ id: ins.meta.last_row_id, token, name, account: !!user })
  })

  // Player state: room info, waiting room list, questions once live, own answers, leaderboard
  app.get('/api/game/play/:code', async (c) => {
    const r = await getRoom(c.env.DB, cleanCode(c.req.param('code')))
    if (!r) return c.json({ error: 'No room found with that code.' }, 404)
    const token = c.req.header('X-Player-Token') || ''
    const me = token
      ? await c.env.DB.prepare('SELECT * FROM game_players WHERE token = ? AND room_id = ?').bind(token, r.id).first<any>()
      : null
    if (!me) return c.json({ error: 'not_joined', room: publicRoom(r) }, 403)
    const now = Date.now()
    const info = publicRoom(r, now)
    // ⏱ The student's personal timer is NOT started here any more. It starts
    // only after the "3, 2, 1, Answer!" countdown has finished on the player's
    // screen (POST /api/game/play/:code/start). Late joiners get the full time.
    await finalizeExpired(c.env.DB, r, now)
    if (!me.finished_at) {
      const dl = playerDeadline(r, me)
      if (dl && dl <= now) me.finished_at = dl
    }
    const board = await leaderboard(c.env.DB, r)
    const mine = board.find((p) => p.id === me.id)
    const deadline = playerDeadline(r, me)
    // Guests (no Unstudy account) can play, but the leaderboard, their rank and
    // the full answer review are locked until they log in / create an account.
    const guest = !me.user_id
    const out: any = {
      room: info,
      me: {
        id: me.id, name: me.name, score: me.score, answered: me.answered, finished: !!me.finished_at,
        rank: guest ? null : mine?.rank,
        guest,
        started_at: me.started_at || null,
        deadline,                                     // personal end time (epoch ms) or null — includes weak-connection pauses
        paused_ms: pausedTotal(me, now),
        lagging: !!me.lag_since,
        activity: activitySummary(r, me, now),
        net: netInfo(me, now),
        time_used: mine?.time_used || 0,
        timed_out: !!(deadline && me.finished_at && me.answered < totalOf(r) && me.finished_at >= deadline)
      },
      players: board.map((p) => ({ id: p.id, name: p.name }))
    }
    if (guest) out.locked = true
    if (!guest && (info.status === 'live' || info.status === 'closed')) {
      out.leaderboard = board.map(({ id, rank, name, score, answered, finished_at, time_used, timed_out }) => ({ id, rank, name, score, answered, finished: !!finished_at, time_used, timed_out }))
    }
    if (info.status === 'live' || info.status === 'closed') {
      out.questions = playerQuestions(r)
      const full = JSON.parse(r.questions)
      const answers = JSON.parse(me.answers || '{}')
      out.answers = Object.fromEntries(Object.entries(answers).map(([k, v]: any) => [k, {
        chosen: v.a, correct: !!v.c, answer: full[k]?.answer, explanation: full[k]?.explanation || ''
      }]))
      // once the player finished (or the room closed) they can review every question.
      // Guests can review their answers too — only the leaderboard / rank stay locked.
      if (me.finished_at || info.status === 'closed') {
        out.review = reviewOf(r, me.answers)
      }
    }
    return c.json(out)
  })

  // ⏱ Start the player's own timer. Called by the player page right AFTER the
  // "3, 2, 1, Answer!" countdown finishes, so the countdown never eats time.
  app.post('/api/game/play/:code/start', async (c) => {
    const r = await getRoom(c.env.DB, cleanCode(c.req.param('code')))
    if (!r) return c.json({ error: 'Room not found' }, 404)
    const token = c.req.header('X-Player-Token') || ''
    const me = await c.env.DB.prepare('SELECT * FROM game_players WHERE token = ? AND room_id = ?').bind(token, r.id).first<any>()
    if (!me) return c.json({ error: 'Join the room first.' }, 403)
    if (roomStatus(r) !== 'live') return c.json({ error: 'The quiz is not live.' }, 400)
    const now = Date.now()
    if (!me.started_at && !me.finished_at) {
      await c.env.DB.prepare('UPDATE game_players SET started_at = ? WHERE id = ? AND started_at IS NULL').bind(now, me.id).run()
      me.started_at = now
      // 📋 the activity log starts with the timer
      await logActivity(c.env.DB, r, me, 'in', now)
    }
    return c.json({ ok: true, now, started_at: me.started_at || null, deadline: playerDeadline(r, me, now), activity: activitySummary(r, me, now) })
  })

  // 📶 Lightweight ping target (no database) — the player page measures the round trip.
  app.get('/api/game/ping', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json({ now: Date.now() })
  })

  // 📶 Heartbeat: the player's ping (ms) + connection type (wifi / cellular data).
  // Also keeps the in / out state in sync and pauses the timer while the
  // connection is weak (ping >= LAG_PING_MS) or the player was offline.
  app.post('/api/game/play/:code/heartbeat', async (c) => {
    const r = await getRoom(c.env.DB, cleanCode(c.req.param('code')))
    if (!r) return c.json({ error: 'Room not found' }, 404)
    const b = await c.req.json().catch(() => ({} as any))
    const token = c.req.header('X-Player-Token') || String(b.token || '')
    const me = await c.env.DB.prepare('SELECT * FROM game_players WHERE token = ? AND room_id = ?').bind(token, r.id).first<any>()
    if (!me) return c.json({ error: 'Join the room first.' }, 403)
    const now = Date.now()
    await finalizeExpired(c.env.DB, r, now)
    const fresh = await c.env.DB.prepare('SELECT finished_at FROM game_players WHERE id = ?').bind(me.id).first<any>()
    me.finished_at = fresh?.finished_at || null
    const ping = Math.max(0, Math.min(60_000, Math.round(Number(b.ping_ms) || 0)))
    const type = ['wifi', 'cellular', 'ethernet', 'unknown'].includes(b.net_type) ? b.net_type : 'unknown'
    const visible = b.visible !== false
    // keep the in / out log in sync (in case a beacon was lost)
    const log = parseLog(me.activity_log)
    const lastState = log.length ? log[log.length - 1].t : null
    if (logOpen(r, me, now) && lastState && lastState !== (visible ? 'in' : 'out')) await logActivity(c.env.DB, r, me, visible ? 'in' : 'out', now)
    const isIn = !log.length ? visible : parseLog(me.activity_log).slice(-1)[0]?.t === 'in'
    // ⏸ weak-connection pause (only while answering, in the app, with time on the clock)
    let paused = Number(me.paused_ms) || 0
    let lag: number | null = me.lag_since || null
    const counting = logOpen(r, me, now) && isIn
    if (counting) {
      // The page reports how long it was OFFLINE while the player stayed in the app.
      // Only counted when there was no "out" since the last heartbeat (leaving the
      // app never earns extra time) and never more than the real gap.
      const offMs = Math.max(0, Number(b.offline_ms) || 0)
      const gap = me.last_ping_at ? now - Number(me.last_ping_at) : 0
      const leftSince = parseLog(me.activity_log).some((e: any) => e.t === 'out' && Number(e.at) >= Number(me.last_ping_at || 0))
      if (!lag && offMs > 0 && gap > OFFLINE_GAP_MS && !leftSince) paused = Math.min(MAX_PAUSE_MS, paused + Math.min(offMs, gap))
      const weak = ping >= LAG_PING_MS
      if (weak && !lag) lag = now
      if (!weak && lag) { paused = pausedTotal({ ...me, paused_ms: paused, lag_since: lag, last_ping_at: now }, now); lag = null }
    } else if (lag) {
      paused = pausedTotal(me, now); lag = null
    }
    paused = Math.min(MAX_PAUSE_MS, paused)
    await c.env.DB.prepare('UPDATE game_players SET ping_ms = ?, net_type = ?, last_ping_at = ?, paused_ms = ?, lag_since = ? WHERE id = ?')
      .bind(ping, type, now, paused, lag, me.id).run()
    Object.assign(me, { ping_ms: ping, net_type: type, last_ping_at: now, paused_ms: paused, lag_since: lag })
    return c.json({
      ok: true, now,
      lagging: !!lag, paused_ms: pausedTotal(me, now), deadline: playerDeadline(r, me, now),
      max_pause_ms: MAX_PAUSE_MS, lag_ping_ms: LAG_PING_MS,
      finished: !!me.finished_at,
      activity: activitySummary(r, me, now)
    })
  })

  // 📋 In / out activity event. Sent by the player page when it is hidden / shown
  // (also via navigator.sendBeacon when leaving, so the token may come in the body).
  app.post('/api/game/play/:code/activity', async (c) => {
    const r = await getRoom(c.env.DB, cleanCode(c.req.param('code')))
    if (!r) return c.json({ error: 'Room not found' }, 404)
    const raw = await c.req.text().catch(() => '')
    let b: any = {}
    try { b = raw ? JSON.parse(raw) : {} } catch (e) { b = {} }
    const token = c.req.header('X-Player-Token') || String(b.token || '')
    const me = await c.env.DB.prepare('SELECT * FROM game_players WHERE token = ? AND room_id = ?').bind(token, r.id).first<any>()
    if (!me) return c.json({ error: 'Join the room first.' }, 403)
    const type = b.type === 'out' ? 'out' : 'in'
    const now = Date.now()
    await finalizeExpired(c.env.DB, r, now)
    const fresh = await c.env.DB.prepare('SELECT finished_at FROM game_players WHERE id = ?').bind(me.id).first<any>()
    me.finished_at = fresh?.finished_at || null
    // Events queued while the player was offline carry their original time (server clock).
    // It is clamped between the previous event and now, so it can never rewrite history.
    const log = parseLog(me.activity_log)
    const floor = Math.max(Number(me.started_at) || 0, log.length ? Number(log[log.length - 1].at) : 0)
    const at = b.at ? Math.min(now, Math.max(floor, Math.round(Number(b.at)) || now)) : now
    await logActivity(c.env.DB, r, me, type, at)
    return c.json({ ok: true, activity: activitySummary(r, me, now), deadline: playerDeadline(r, me, now), paused_ms: pausedTotal(me, now) })
  })

  // A guest who just logged in / created an account links the game they played
  // to their account → saved in their history, leaderboard + review unlocked.
  app.post('/api/game/play/:code/claim', async (c) => {
    const s = await requireUser(c)
    if (!s) return c.json({ error: 'Log in first.' }, 401)
    const r = await getRoom(c.env.DB, cleanCode(c.req.param('code')))
    if (!r) return c.json({ error: 'Room not found' }, 404)
    const token = c.req.header('X-Player-Token') || ''
    const me = await c.env.DB.prepare('SELECT * FROM game_players WHERE token = ? AND room_id = ?').bind(token, r.id).first<any>()
    if (!me) return c.json({ error: 'Join the room first.' }, 403)
    if (me.user_id === s.user_id) return c.json({ ok: true, token: me.token })
    if (me.user_id) return c.json({ error: 'This game result belongs to another account.' }, 403)
    // the account already has its own entry in this room → keep that one
    const existing = await c.env.DB.prepare('SELECT token FROM game_players WHERE room_id = ? AND user_id = ?').bind(r.id, s.user_id).first<any>()
    if (existing) return c.json({ ok: true, token: existing.token, switched: true })
    await c.env.DB.prepare('UPDATE game_players SET user_id = ? WHERE id = ?').bind(s.user_id, me.id).run()
    return c.json({ ok: true, token: me.token, claimed: true })
  })

  // Game history: every live quiz this account played (newest first)
  app.get('/api/game/history', async (c) => {
    const s = await requireUser(c)
    if (!s) return c.json({ error: 'Log in first.' }, 401)
    const { results } = await c.env.DB.prepare(
      `SELECT p.id AS pid, r.* , hu.username AS host_username
       FROM game_players p JOIN game_rooms r ON r.id = p.room_id LEFT JOIN users hu ON hu.id = r.host_id
       WHERE p.user_id = ? ORDER BY p.joined_at DESC LIMIT 100`
    ).bind(s.user_id).all<any>()
    const now = Date.now()
    const games = []
    for (const r of results) {
      await finalizeExpired(c.env.DB, r, now)
      const board = await leaderboard(c.env.DB, r)
      const mine: any = board.find((p) => p.id === r.pid) || {}
      games.push({
        code: r.code, title: r.title, host_username: r.host_username, status: roomStatus(r, now),
        start_at: r.start_at, end_at: r.end_at, time_limit: Number(r.time_limit) || 0,
        total: totalOf(r), players: board.length,
        name: mine.name, rank: mine.rank || null, score: mine.score || 0, answered: mine.answered || 0,
        finished: !!mine.finished_at, time_used: mine.time_used || 0, timed_out: !!mine.timed_out,
        joined_at: mine.joined_at
      })
    }
    return c.json({ games })
  })

  // Submit one answer (checked on the server)
  app.post('/api/game/play/:code/answer', async (c) => {
    const r = await getRoom(c.env.DB, cleanCode(c.req.param('code')))
    if (!r) return c.json({ error: 'Room not found' }, 404)
    const token = c.req.header('X-Player-Token') || ''
    const me = await c.env.DB.prepare('SELECT * FROM game_players WHERE token = ? AND room_id = ?').bind(token, r.id).first<any>()
    if (!me) return c.json({ error: 'Join the room first.' }, 403)
    const st = roomStatus(r)
    if (st === 'scheduled') return c.json({ error: 'The quiz has not started yet.' }, 400)
    if (st === 'closed') return c.json({ error: 'This room is closed. Answers are no longer accepted.', code: 'closed' }, 410)
    if (me.finished_at && me.answered < totalOf(r)) return c.json({ error: 'Your time is up — answers are no longer accepted.', code: 'time_up' }, 409)
    const nowA = Date.now()
    if (!me.started_at) {
      await c.env.DB.prepare('UPDATE game_players SET started_at = ? WHERE id = ? AND started_at IS NULL').bind(nowA, me.id).run()
      me.started_at = nowA
    }
    const dlA = playerDeadline(r, me, nowA)
    if (dlA && nowA > dlA + GRACE_MS) {
      await c.env.DB.prepare('UPDATE game_players SET finished_at = COALESCE(finished_at, ?), paused_ms = ?, lag_since = NULL WHERE id = ?').bind(dlA, pausedTotal(me, dlA), me.id).run()
      return c.json({ error: 'Your time is up — answers are no longer accepted.', code: 'time_up' }, 409)
    }
    const b = await c.req.json()
    const qs = JSON.parse(r.questions)
    const i = Number(b.index)
    if (!Number.isInteger(i) || i < 0 || i >= qs.length) return c.json({ error: 'Invalid question.' }, 400)
    const answers = JSON.parse(me.answers || '{}')
    const q = qs[i]
    if (answers[i]) return c.json({ correct: !!answers[i].c, answer: q.answer, explanation: q.explanation || '', already: true })
    const chosen = String(b.answer ?? '').slice(0, 300)
    const correct = norm(chosen) === norm(q.answer)
    answers[i] = { a: chosen, c: correct ? 1 : 0 }
    const now = Date.now()
    const answered = Object.keys(answers).length
    const score = Object.values(answers).filter((v: any) => v.c).length
    const finished = answered >= qs.length ? now : null
    await c.env.DB.prepare('UPDATE game_players SET answers = ?, answered = ?, score = ?, last_answer_at = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?')
      .bind(JSON.stringify(answers), answered, score, now, finished, me.id).run()
    if (finished) await closeLag(c.env.DB, me, now) // the log + pause stop when the quiz stops
    return c.json({ correct, answer: q.answer, explanation: q.explanation || '', score, answered, finished: !!finished })
  })
}
