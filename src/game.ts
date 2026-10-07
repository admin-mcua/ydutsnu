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
  COALESCE(finished_at, last_answer_at, 9e15) - COALESCE(started_at, joined_at) ASC,
  joined_at ASC`

export const MAX_TIME_LIMIT = 6 * 3600 // 6 hours (seconds)
const GRACE_MS = 2000                  // network grace for the last answer

// Personal deadline of a player (epoch ms) — null when the room has no time limit
// or the player's timer has not started yet.
export function playerDeadline(r: any, p: any): number | null {
  const lim = Number(r.time_limit) || 0
  if (!lim || !p.started_at) return null
  return Number(p.started_at) + lim * 1000
}

// Players whose own timer ran out are marked as finished (at their deadline).
async function finalizeExpired(db: D1Database, r: any, now = Date.now()) {
  const lim = Number(r.time_limit) || 0
  if (!lim) return
  await db.prepare(
    `UPDATE game_players SET finished_at = started_at + ?
     WHERE room_id = ? AND finished_at IS NULL AND started_at IS NOT NULL AND started_at + ? <= ?`
  ).bind(lim * 1000, r.id, lim * 1000, now).run()
}

async function leaderboard(db: D1Database, r: any) {
  const now = Date.now()
  const { results } = await db
    .prepare(`SELECT id, name, score, answered, joined_at, last_answer_at, finished_at, started_at FROM game_players WHERE room_id = ? ${RANK_SQL}`)
    .bind(r.id)
    .all<any>()
  const lim = (Number(r.time_limit) || 0) * 1000
  return results.map((p: any, i: number) => {
    const end = p.finished_at || (roomStatus(r, now) === 'closed' ? Math.min(r.end_at, lim && p.started_at ? p.started_at + lim : 9e15) : now)
    const time_used = p.started_at ? Math.max(0, Math.min(end, lim ? p.started_at + lim : 9e15) - p.started_at) : 0
    const timed_out = !!(lim && p.started_at && p.finished_at && p.answered < totalOf(r) && p.finished_at >= p.started_at + lim)
    return { rank: i + 1, ...p, time_used, timed_out }
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
      const mine = await c.env.DB.prepare('SELECT token, name FROM game_players WHERE room_id = ? AND user_id = ?').bind(r.id, user.id).first<any>()
      if (mine) return c.json({ token: mine.token, name: mine.name, account: true, rejoined: true })
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
    await c.env.DB.prepare('INSERT INTO game_players (room_id, name, token, joined_at, user_id) VALUES (?, ?, ?, ?, ?)')
      .bind(r.id, name, token, Date.now(), user ? user.id : null).run()
    return c.json({ token, name, account: !!user })
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
    // ⏱ The student's personal timer starts the first time they are IN the live
    // quiz (after the waiting room). Late joiners start their own full timer now.
    if (info.status === 'live' && !me.started_at && !me.finished_at) {
      await c.env.DB.prepare('UPDATE game_players SET started_at = ? WHERE id = ? AND started_at IS NULL').bind(now, me.id).run()
      me.started_at = now
    }
    await finalizeExpired(c.env.DB, r, now)
    if (!me.finished_at) {
      const dl = playerDeadline(r, me)
      if (dl && dl <= now) me.finished_at = dl
    }
    const board = await leaderboard(c.env.DB, r)
    const mine = board.find((p) => p.id === me.id)
    const deadline = playerDeadline(r, me)
    const out: any = {
      room: info,
      me: {
        id: me.id, name: me.name, score: me.score, answered: me.answered, finished: !!me.finished_at, rank: mine?.rank,
        started_at: me.started_at || null,
        deadline,                                     // personal end time (epoch ms) or null
        time_used: mine?.time_used || 0,
        timed_out: !!(deadline && me.finished_at && me.answered < totalOf(r) && me.finished_at >= deadline)
      },
      players: board.map((p) => ({ id: p.id, name: p.name }))
    }
    if (info.status === 'live' || info.status === 'closed') {
      out.leaderboard = board.map(({ id, rank, name, score, answered, finished_at, time_used, timed_out }) => ({ id, rank, name, score, answered, finished: !!finished_at, time_used, timed_out }))
    }
    if (info.status === 'live' || info.status === 'closed') {
      out.questions = playerQuestions(r)
      const full = JSON.parse(r.questions)
      const answers = JSON.parse(me.answers || '{}')
      out.answers = Object.fromEntries(Object.entries(answers).map(([k, v]: any) => [k, {
        chosen: v.a, correct: !!v.c, answer: full[k]?.answer, explanation: full[k]?.explanation || ''
      }]))
      // once the player finished (or the room closed) they can review every question
      if (me.finished_at || info.status === 'closed') {
        out.review = withSections(full).map((q: any, i: number) => ({
          i, type: q.type, section: q.section, question: q.question,
          options: q.type === 'identification' ? undefined : (q.type === 'true_false' ? ['True', 'False'] : q.options),
          answer: q.answer, explanation: q.explanation || '',
          chosen: answers[i] ? answers[i].a : null,
          correct: answers[i] ? !!answers[i].c : false,
          skipped: !answers[i]
        }))
      }
    }
    return c.json(out)
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
    const dlA = playerDeadline(r, me)
    if (dlA && nowA > dlA + GRACE_MS) {
      await c.env.DB.prepare('UPDATE game_players SET finished_at = COALESCE(finished_at, ?) WHERE id = ?').bind(dlA, me.id).run()
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
    return c.json({ correct, answer: q.answer, explanation: q.explanation || '', score, answered, finished: !!finished })
  })
}
