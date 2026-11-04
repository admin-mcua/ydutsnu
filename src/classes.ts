// Classes: a user can be in ONE class only. Create a class (name + members),
// browse the list of classes and join one, manage members, leave / delete.
import type { Hono } from 'hono'
import { getToken, getSession } from './lib/auth'
import { ONLINE_SQL, AVATAR_SQL, notify } from './social'
import { SLIM_FLASHCARD_COLS, SLIM_QUIZ_COLS, slimItem } from './slim'

type Env = { Bindings: { DB: D1Database } }

async function requireUser(c: any) {
  const s = await getSession(c.env.DB, getToken(c))
  return s && s.role === 'user' ? s : null
}
const unauthorized = (c: any) => c.json({ error: 'Unauthorized' }, 401)
const MAX_NAME = 60
const MAX_DESC = 200

async function membershipOf(db: D1Database, userId: number) {
  return db.prepare('SELECT * FROM class_members WHERE user_id = ?').bind(userId).first<any>()
}

async function classDetails(db: D1Database, classId: number) {
  const cls = await db
    .prepare(
      `SELECT c.*, u.username AS owner_username, u.full_name AS owner_name,
              (SELECT COUNT(*) FROM class_members m WHERE m.class_id = c.id) AS member_count
       FROM classes c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?`
    )
    .bind(classId)
    .first<any>()
  if (!cls) return null
  const { results: members } = await db
    .prepare(
      `SELECT u.id, u.username, u.full_name, ${AVATAR_SQL('u')} AS avatar, u.last_seen, ${ONLINE_SQL('u')} AS is_online,
              m.role, m.joined_at
       FROM class_members m JOIN users u ON u.id = m.user_id
       WHERE m.class_id = ?
       ORDER BY (m.role = 'owner') DESC, m.joined_at ASC`
    )
    .bind(classId)
    .all()
  return { ...cls, members }
}

// ---- Class log (joined / left history) ----
async function userRow(db: D1Database, id: number) {
  return db.prepare('SELECT id, username, full_name FROM users WHERE id = ?').bind(id).first<any>()
}
export async function logClass(db: D1Database, classId: number, userId: number, action: string, actorId: number | null = null) {
  try {
    const u = await userRow(db, userId)
    const a = actorId && actorId !== userId ? await userRow(db, actorId) : null
    await db.prepare('INSERT INTO class_logs (class_id, user_id, username, full_name, action, actor_id, actor_name) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(classId, userId, u?.username || 'deleted user', u?.full_name || null, action, a ? a.id : null, a ? (a.full_name || a.username) : null).run()
  } catch (e) { /* the log must never break the main action */ }
}
// When a user leaves / is removed, their class-only posts go back to "Only me"
async function unpostFromClass(db: D1Database, classId: number, userId: number) {
  for (const t of ['flashcard_sets', 'quizzes']) {
    await db.prepare(`UPDATE ${t} SET visibility = CASE WHEN visibility = 'class' THEN 'private' ELSE visibility END, class_id = NULL WHERE user_id = ? AND class_id = ?`)
      .bind(userId, classId).run()
  }
}
async function isMember(db: D1Database, classId: number, userId: number) {
  return !!(await db.prepare('SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?').bind(classId, userId).first())
}

// Add users (that are not in any class yet) to a class. Returns ids added.
async function addMembers(db: D1Database, classId: number, ids: number[], me: number) {
  const added: number[] = []
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0 || id === me) continue
    const u = await db.prepare('SELECT id FROM users WHERE id = ?').bind(id).first()
    if (!u) continue
    const r = await db
      .prepare(`INSERT OR IGNORE INTO class_members (class_id, user_id, role) VALUES (?, ?, 'member')`)
      .bind(classId, id)
      .run()
    if (r.meta.changes) added.push(id)
  }
  return added
}

export function registerClasses(app: Hono<Env>) {
  // My class (or null) with its members
  app.get('/api/classes/mine', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const m = await membershipOf(c.env.DB, s.user_id)
    if (!m) return c.json({ class: null })
    const cls = await classDetails(c.env.DB, m.class_id)
    return c.json({ class: cls, my_role: m.role })
  })

  // List every class (to pick one to join)
  app.get('/api/classes', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const q = (c.req.query('q') || '').trim()
    let sql = `SELECT c.id, c.name, c.description, c.created_at, c.owner_id,
                      u.username AS owner_username, u.full_name AS owner_name, ${AVATAR_SQL('u')} AS owner_avatar,
                      (SELECT COUNT(*) FROM class_members m WHERE m.class_id = c.id) AS member_count
               FROM classes c LEFT JOIN users u ON u.id = c.owner_id`
    const params: any[] = []
    if (q) { sql += ' WHERE c.name LIKE ? OR u.username LIKE ? OR u.full_name LIKE ?'; params.push(`%${q}%`, `%${q}%`, `%${q}%`) }
    sql += ' ORDER BY member_count DESC, c.created_at DESC LIMIT 200'
    const { results } = await c.env.DB.prepare(sql).bind(...params).all()
    return c.json({ classes: results })
  })

  // Users that can be added to a class (not in any class yet)
  app.get('/api/classes/candidates', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const q = (c.req.query('q') || '').trim()
    let sql = `SELECT u.id, u.username, u.full_name, ${AVATAR_SQL('u')} AS avatar, u.last_seen, ${ONLINE_SQL('u')} AS is_online,
                      EXISTS(SELECT 1 FROM friends f WHERE f.status = 'accepted' AND
                        ((f.requester_id = ?1 AND f.receiver_id = u.id) OR (f.requester_id = u.id AND f.receiver_id = ?1))) AS is_friend
               FROM users u
               WHERE u.id != ?1 AND NOT EXISTS (SELECT 1 FROM class_members m WHERE m.user_id = u.id)`
    const params: any[] = [s.user_id]
    if (q) { sql += ' AND (u.username LIKE ?2 OR u.full_name LIKE ?2)'; params.push(`%${q}%`) }
    sql += ' ORDER BY is_friend DESC, u.username COLLATE NOCASE ASC LIMIT 100'
    const { results } = await c.env.DB.prepare(sql).bind(...params).all()
    return c.json({ users: results })
  })

  // Create a class: { name, description?, member_ids?: number[] }
  app.post('/api/classes', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    const body = await c.req.json().catch(() => ({} as any))
    const name = String(body.name || '').trim().slice(0, MAX_NAME)
    const description = String(body.description || '').trim().slice(0, MAX_DESC)
    if (name.length < 2) return c.json({ error: 'Please give your class a name (at least 2 characters).' }, 400)
    if (await membershipOf(db, s.user_id)) return c.json({ error: 'You are already in a class. Leave it first to create a new one.' }, 409)
    const r = await db.prepare('INSERT INTO classes (name, description, owner_id) VALUES (?, ?, ?)').bind(name, description, s.user_id).run()
    const classId = Number(r.meta.last_row_id)
    try {
      await db.prepare(`INSERT INTO class_members (class_id, user_id, role) VALUES (?, ?, 'owner')`).bind(classId, s.user_id).run()
    } catch (e) {
      await db.prepare('DELETE FROM classes WHERE id = ?').bind(classId).run()
      return c.json({ error: 'You are already in a class.' }, 409)
    }
    await logClass(db, classId, s.user_id, 'created')
    const ids = Array.isArray(body.member_ids) ? body.member_ids.map(Number).slice(0, 200) : []
    const added = await addMembers(db, classId, ids, s.user_id)
    for (const id of added) await logClass(db, classId, id, 'added', s.user_id)
    const meRow = await db.prepare('SELECT username, full_name FROM users WHERE id = ?').bind(s.user_id).first<any>()
    for (const id of added) {
      await notify(db, id, { type: 'class', title: `You were added to the class "${name}"`, body: `${meRow?.full_name || meRow?.username || 'Someone'} added you. Open the Class tab to see your classmates.`, link: 'class', actor_id: s.user_id }).catch(() => {})
    }
    return c.json({ class: await classDetails(db, classId), added: added.length, skipped: ids.length - added.length })
  })

  // Join a class (only if you're not in a class yet)
  app.post('/api/classes/:id/join', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    const id = Number(c.req.param('id'))
    const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').bind(id).first<any>()
    if (!cls) return c.json({ error: 'Class not found' }, 404)
    if (await membershipOf(db, s.user_id)) return c.json({ error: 'You can only join one class. Leave your current class first.' }, 409)
    const jr = await db.prepare(`INSERT OR IGNORE INTO class_members (class_id, user_id, role) VALUES (?, ?, 'member')`).bind(id, s.user_id).run()
    if (jr.meta.changes) await logClass(db, id, s.user_id, 'joined')
    const meRow = await db.prepare('SELECT username, full_name FROM users WHERE id = ?').bind(s.user_id).first<any>()
    await notify(db, cls.owner_id, { type: 'class', title: `${meRow?.full_name || meRow?.username} joined "${cls.name}"`, body: 'A new classmate joined your class.', link: 'class', actor_id: s.user_id }, false).catch(() => {})
    return c.json({ class: await classDetails(db, id) })
  })

  // Leave my class. If the owner leaves, the oldest member becomes owner; an empty class is deleted.
  app.post('/api/classes/leave', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    const m = await membershipOf(db, s.user_id)
    if (!m) return c.json({ error: 'You are not in a class.' }, 400)
    await db.prepare('DELETE FROM class_members WHERE user_id = ?').bind(s.user_id).run()
    await unpostFromClass(db, m.class_id, s.user_id)
    const next = await db.prepare('SELECT user_id FROM class_members WHERE class_id = ? ORDER BY joined_at ASC, id ASC LIMIT 1').bind(m.class_id).first<any>()
    if (!next) {
      await db.batch([
        db.prepare('DELETE FROM classes WHERE id = ?').bind(m.class_id),
        db.prepare('DELETE FROM class_logs WHERE class_id = ?').bind(m.class_id)
      ])
    } else {
      await logClass(db, m.class_id, s.user_id, 'left')
      if (m.role === 'owner') {
        await db.batch([
          db.prepare(`UPDATE class_members SET role = 'owner' WHERE user_id = ?`).bind(next.user_id),
          db.prepare('UPDATE classes SET owner_id = ? WHERE id = ?').bind(next.user_id, m.class_id)
        ])
        await logClass(db, m.class_id, next.user_id, 'new_owner')
      }
    }
    return c.json({ ok: true })
  })

  // Owner: rename / edit description
  app.put('/api/classes/:id', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    const id = Number(c.req.param('id'))
    const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').bind(id).first<any>()
    if (!cls) return c.json({ error: 'Class not found' }, 404)
    if (cls.owner_id !== s.user_id) return c.json({ error: 'Only the class owner can edit the class.' }, 403)
    const body = await c.req.json().catch(() => ({} as any))
    const name = body.name !== undefined ? String(body.name).trim().slice(0, MAX_NAME) : cls.name
    const description = body.description !== undefined ? String(body.description).trim().slice(0, MAX_DESC) : cls.description
    if (name.length < 2) return c.json({ error: 'Class name must have at least 2 characters.' }, 400)
    await db.prepare('UPDATE classes SET name = ?, description = ? WHERE id = ?').bind(name, description, id).run()
    return c.json({ class: await classDetails(db, id) })
  })

  // Any member: invite / add members { user_ids: number[] }
  app.post('/api/classes/:id/members', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    const id = Number(c.req.param('id'))
    const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').bind(id).first<any>()
    if (!cls) return c.json({ error: 'Class not found' }, 404)
    if (!(await isMember(db, id, s.user_id))) return c.json({ error: 'Only members of this class can invite people.' }, 403)
    const body = await c.req.json().catch(() => ({} as any))
    const ids = Array.isArray(body.user_ids) ? body.user_ids.map(Number).slice(0, 200) : []
    const added = await addMembers(db, id, ids, s.user_id)
    for (const uid of added) await logClass(db, id, uid, 'added', s.user_id)
    const meRow = await db.prepare('SELECT username, full_name FROM users WHERE id = ?').bind(s.user_id).first<any>()
    for (const uid of added) {
      await notify(db, uid, { type: 'class', title: `You were added to the class "${cls.name}"`, body: `${meRow?.full_name || meRow?.username || 'Someone'} added you. Open the Class tab to see your classmates.`, link: 'class', actor_id: s.user_id }).catch(() => {})
    }
    return c.json({ class: await classDetails(db, id), added: added.length, skipped: ids.length - added.length })
  })

  // Owner: remove a member
  app.delete('/api/classes/:id/members/:uid', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    const id = Number(c.req.param('id'))
    const uid = Number(c.req.param('uid'))
    const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').bind(id).first<any>()
    if (!cls) return c.json({ error: 'Class not found' }, 404)
    if (cls.owner_id !== s.user_id) return c.json({ error: 'Only the class owner can remove members.' }, 403)
    if (uid === s.user_id) return c.json({ error: 'Use "Leave class" to leave your own class.' }, 400)
    const rr = await db.prepare('DELETE FROM class_members WHERE class_id = ? AND user_id = ?').bind(id, uid).run()
    if (rr.meta.changes) {
      await unpostFromClass(db, id, uid)
      await logClass(db, id, uid, 'removed', s.user_id)
    }
    return c.json({ class: await classDetails(db, id) })
  })

  // Owner: delete the class (everyone is removed)
  app.delete('/api/classes/:id', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    const id = Number(c.req.param('id'))
    const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').bind(id).first<any>()
    if (!cls) return c.json({ error: 'Class not found' }, 404)
    if (cls.owner_id !== s.user_id) return c.json({ error: 'Only the class owner can delete the class.' }, 403)
    await db.batch([
      db.prepare(`UPDATE flashcard_sets SET visibility = CASE WHEN visibility = 'class' THEN 'private' ELSE visibility END, class_id = NULL WHERE class_id = ?`).bind(id),
      db.prepare(`UPDATE quizzes SET visibility = CASE WHEN visibility = 'class' THEN 'private' ELSE visibility END, class_id = NULL WHERE class_id = ?`).bind(id),
      db.prepare('DELETE FROM class_logs WHERE class_id = ?').bind(id),
      db.prepare('DELETE FROM class_members WHERE class_id = ?').bind(id),
      db.prepare('DELETE FROM classes WHERE id = ?').bind(id)
    ])
    return c.json({ ok: true })
  })

  // Class log: everyone who joined / left (members only)
  app.get('/api/classes/:id/log', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    const id = Number(c.req.param('id'))
    if (!(await isMember(db, id, s.user_id))) return c.json({ error: 'Only members can see the class log.' }, 403)
    const { results } = await db.prepare(
      `SELECT l.id, l.user_id, l.action, l.actor_id, l.actor_name, l.created_at,
              COALESCE(u.username, l.username) AS username, COALESCE(u.full_name, l.full_name) AS full_name, ${AVATAR_SQL('u')} AS avatar
       FROM class_logs l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.class_id = ? ORDER BY l.id DESC LIMIT 300`
    ).bind(id).all()
    return c.json({ log: results })
  })

  // Class main: flashcards & quizzes posted to the class (members only)
  app.get('/api/classes/:id/posts', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    const id = Number(c.req.param('id'))
    if (!(await isMember(db, id, s.user_id))) return c.json({ error: 'Only members can see class posts.' }, 403)
    const { results: flashcards } = await db.prepare(
      `SELECT f.id, f.title, f.share_id, f.created_at, f.user_id, f.visibility, f.class_id, ${SLIM_FLASHCARD_COLS('f')},
              u.username, ${AVATAR_SQL('u')} AS avatar, u.full_name, ${ONLINE_SQL('u')} AS is_online, 'flashcard' AS content_type
       FROM flashcard_sets f JOIN users u ON u.id = f.user_id
       WHERE f.class_id = ? AND f.visibility != 'private'
         AND EXISTS (SELECT 1 FROM class_members m WHERE m.class_id = f.class_id AND m.user_id = f.user_id)
       ORDER BY f.created_at DESC LIMIT 100`
    ).bind(id).all()
    const { results: quizzes } = await db.prepare(
      `SELECT q.id, q.title, q.types, q.share_id, q.created_at, q.user_id, q.difficulty, q.visibility, q.class_id, ${SLIM_QUIZ_COLS('q')},
              u.username, ${AVATAR_SQL('u')} AS avatar, u.full_name, ${ONLINE_SQL('u')} AS is_online, 'quiz' AS content_type
       FROM quizzes q JOIN users u ON u.id = q.user_id
       WHERE q.class_id = ? AND q.visibility != 'private'
         AND EXISTS (SELECT 1 FROM class_members m WHERE m.class_id = q.class_id AND m.user_id = q.user_id)
       ORDER BY q.created_at DESC LIMIT 100`
    ).bind(id).all()
    const posts = [...flashcards, ...quizzes]
      .sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
      .map(slimItem)
    return c.json({ posts })
  })

  // Upload one of my flashcard sets / quizzes to my class: { type: 'flashcard'|'quiz', id, visibility?: 'class'|'public' }
  app.post('/api/classes/:id/posts', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    const id = Number(c.req.param('id'))
    if (!(await isMember(db, id, s.user_id))) return c.json({ error: 'Only members can upload to this class.' }, 403)
    const body = await c.req.json().catch(() => ({} as any))
    const table = body.type === 'quiz' ? 'quizzes' : body.type === 'flashcard' ? 'flashcard_sets' : null
    if (!table) return c.json({ error: 'Unknown item type.' }, 400)
    const row = await db.prepare(`SELECT id, title, visibility FROM ${table} WHERE id = ? AND user_id = ?`).bind(Number(body.id), s.user_id).first<any>()
    if (!row) return c.json({ error: 'You can only upload your own flashcards and quizzes.' }, 404)
    const visibility = body.visibility === 'public' ? 'public' : body.visibility === 'class' ? 'class' : (row.visibility === 'public' ? 'public' : 'class')
    await db.prepare(`UPDATE ${table} SET class_id = ?, visibility = ? WHERE id = ?`).bind(id, visibility, row.id).run()
    return c.json({ ok: true, visibility, class_id: id })
  })

  // Remove a post from the class (the creator, or the class owner)
  app.delete('/api/classes/:id/posts/:type/:itemId', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    const id = Number(c.req.param('id'))
    const table = c.req.param('type') === 'quiz' ? 'quizzes' : 'flashcard_sets'
    const cls = await db.prepare('SELECT owner_id FROM classes WHERE id = ?').bind(id).first<any>()
    if (!cls) return c.json({ error: 'Class not found' }, 404)
    const row = await db.prepare(`SELECT id, user_id FROM ${table} WHERE id = ? AND class_id = ?`).bind(Number(c.req.param('itemId')), id).first<any>()
    if (!row) return c.json({ error: 'Post not found' }, 404)
    if (row.user_id !== s.user_id && cls.owner_id !== s.user_id) return c.json({ error: 'Only the creator or the class owner can remove this post.' }, 403)
    await db.prepare(`UPDATE ${table} SET visibility = CASE WHEN visibility = 'class' THEN 'private' ELSE visibility END, class_id = NULL WHERE id = ?`).bind(row.id).run()
    return c.json({ ok: true })
  })
}
