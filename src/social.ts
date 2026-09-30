// Presence, notifications, recommendations, inbox / messaging and push routes.
import type { Hono } from 'hono'
import { getToken, getSession } from './lib/auth'
import { getVapid, pushToUsers } from './lib/push'

type Env = { Bindings: { DB: D1Database } }

// A user counts as online while the app is open (heartbeat every ~20s).
export const ONLINE_SQL = (a = 'u') => `(${a}.online = 1 AND ${a}.last_seen >= datetime('now', '-70 seconds'))`

export const WELCOME_TITLE = 'Welcome to Unstudy! 🎉'
export const WELCOME_BODY =
  "We're so happy you're here! Unstudy is still a work in progress, and we're building it together with you. " +
  'Tell us what features you would love to see — tap here to send your suggestions and recommendations.'

async function requireUser(c: any) {
  const s = await getSession(c.env.DB, getToken(c))
  return s && s.role === 'user' ? s : null
}
async function requireAdmin(c: any) {
  const s = await getSession(c.env.DB, getToken(c))
  return s && s.role === 'admin' ? s : null
}
const unauthorized = (c: any) => c.json({ error: 'Unauthorized' }, 401)

// Create an in-app notification (+ optional phone/desktop push)
export async function notify(
  db: D1Database,
  userId: number,
  n: { type: string; title: string; body?: string; link?: string | null; actor_id?: number | null },
  push = true
) {
  await db
    .prepare('INSERT INTO notifications (user_id, type, title, body, link, actor_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(userId, n.type, n.title, n.body || '', n.link || null, n.actor_id ?? null)
    .run()
  if (push) await pushToUsers(db, [userId], { title: n.title, body: n.body || '', url: '/app?open=notifications', tag: 'notif-' + n.type })
}

export async function sendWelcome(db: D1Database, userId: number) {
  await notify(db, userId, { type: 'welcome', title: WELCOME_TITLE, body: WELCOME_BODY, link: 'suggest' }, false)
}

const displayName = (u: any) => (u ? u.full_name || u.username : 'Someone')

async function areFriends(db: D1Database, a: number, b: number) {
  const r = await db
    .prepare(`SELECT id FROM friends WHERE status = 'accepted' AND ((requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?))`)
    .bind(a, b, b, a)
    .first()
  return !!r
}
async function messageRequest(db: D1Database, a: number, b: number) {
  return db
    .prepare(`SELECT * FROM message_requests WHERE (requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?)`)
    .bind(a, b, b, a)
    .first<any>()
}

export function registerSocial(app: Hono<Env>) {
  // ================= PRESENCE =================
  // Heartbeat + all badge counters in one cheap request (polled by the app).
  app.get('/api/badges', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    // ?bg=1 → background check while the app is hidden (does not count as online)
    if (c.req.query('bg') !== '1')
      await db.prepare('UPDATE users SET online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?').bind(s.user_id).run()
    const r = await db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM notifications WHERE user_id = ?1 AND is_read = 0) AS notifications,
          (SELECT COUNT(*) FROM friends WHERE receiver_id = ?1 AND status = 'pending') AS friend_requests,
          (SELECT COUNT(DISTINCT m.sender_id) FROM messages m
             WHERE m.receiver_id = ?1 AND m.read_at IS NULL) AS unread_chats,
          (SELECT MAX(id) FROM notifications WHERE user_id = ?1) AS last_notification_id,
          (SELECT MAX(id) FROM messages WHERE receiver_id = ?1) AS last_message_id`
      )
      .bind(s.user_id)
      .first<any>()
    // Latest items (used for local notifications when push isn't available)
    const latestNotif = await db
      .prepare('SELECT id, title, body FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .bind(s.user_id)
      .first<any>()
    const latestMsg = await db
      .prepare(
        `SELECT m.id, m.body, m.sender_id, u.username, u.full_name FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.receiver_id = ? ORDER BY m.id DESC LIMIT 1`
      )
      .bind(s.user_id)
      .first<any>()
    return c.json({ ...r, latest_notification: latestNotif || null, latest_message: latestMsg ? { ...latestMsg, name: displayName(latestMsg) } : null })
  })

  // Called with navigator.sendBeacon when the app is closed / hidden.
  // (sendBeacon cannot set headers, so the token may come in the body.)
  app.post('/api/presence/offline', async (c) => {
    let token = getToken(c)
    if (!token) {
      try { token = (JSON.parse(await c.req.text()) || {}).token || null } catch (e) {}
    }
    const s = await getSession(c.env.DB, token)
    if (s && s.role === 'user')
      await c.env.DB.prepare('UPDATE users SET online = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?').bind(s.user_id).run()
    return c.json({ ok: true })
  })

  // ================= NOTIFICATIONS =================
  app.get('/api/notifications', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const { results } = await c.env.DB.prepare(
      `SELECT n.id, n.type, n.title, n.body, n.link, n.is_read, n.created_at, n.actor_id, u.avatar AS actor_avatar
       FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 60`
    ).bind(s.user_id).all()
    return c.json({ notifications: results })
  })

  app.post('/api/notifications/read-all', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    await c.env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').bind(s.user_id).run()
    return c.json({ ok: true })
  })

  app.post('/api/notifications/:id/read', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    await c.env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').bind(c.req.param('id'), s.user_id).run()
    return c.json({ ok: true })
  })

  app.delete('/api/notifications/:id', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    await c.env.DB.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').bind(c.req.param('id'), s.user_id).run()
    return c.json({ ok: true })
  })

  // ================= RECOMMENDATIONS (user → admin) =================
  app.post('/api/recommendations', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const { message } = await c.req.json()
    const text = String(message || '').trim()
    if (text.length < 3) return c.json({ error: 'Please write your suggestion first.' }, 400)
    if (text.length > 2000) return c.json({ error: 'Please keep it under 2000 characters.' }, 400)
    // Simple anti-spam: max 10 per day
    const cnt = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM recommendations WHERE user_id = ? AND created_at >= datetime('now', '-1 day')"
    ).bind(s.user_id).first<any>()
    if (Number(cnt?.n || 0) >= 10) return c.json({ error: 'You already sent a lot of suggestions today. Thank you! Try again tomorrow.' }, 429)
    await c.env.DB.prepare('INSERT INTO recommendations (user_id, message) VALUES (?, ?)').bind(s.user_id, text).run()
    await notify(c.env.DB, s.user_id, {
      type: 'system',
      title: 'Thanks for your suggestion! 💜',
      body: "We received it. We're working on Unstudy together with you — keep the ideas coming!",
      link: 'suggest'
    }, false)
    return c.json({ ok: true })
  })

  app.get('/api/recommendations/mine', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const { results } = await c.env.DB.prepare(
      'SELECT id, message, created_at FROM recommendations WHERE user_id = ? ORDER BY id DESC LIMIT 20'
    ).bind(s.user_id).all()
    return c.json({ recommendations: results })
  })

  // ================= ADMIN: recommendations + broadcast =================
  app.get('/api/admin/recommendations', async (c) => {
    if (!(await requireAdmin(c))) return unauthorized(c)
    const { results } = await c.env.DB.prepare(
      `SELECT r.id, r.message, r.status, r.created_at, u.id AS user_id, u.username, u.full_name, u.email, u.avatar
       FROM recommendations r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 500`
    ).all()
    return c.json({ recommendations: results })
  })

  app.get('/api/admin/summary', async (c) => {
    if (!(await requireAdmin(c))) return unauthorized(c)
    const r = await c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM recommendations WHERE status = 'new') AS new_recommendations,
              (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM users u WHERE ${ONLINE_SQL('u')}) AS online`
    ).first()
    return c.json(r)
  })

  app.put('/api/admin/recommendations/:id', async (c) => {
    if (!(await requireAdmin(c))) return unauthorized(c)
    const { status } = await c.req.json()
    await c.env.DB.prepare('UPDATE recommendations SET status = ? WHERE id = ?')
      .bind(status === 'new' ? 'new' : 'seen', c.req.param('id')).run()
    return c.json({ ok: true })
  })

  app.post('/api/admin/recommendations/mark-all-seen', async (c) => {
    if (!(await requireAdmin(c))) return unauthorized(c)
    await c.env.DB.prepare("UPDATE recommendations SET status = 'seen' WHERE status = 'new'").run()
    return c.json({ ok: true })
  })

  app.delete('/api/admin/recommendations/:id', async (c) => {
    if (!(await requireAdmin(c))) return unauthorized(c)
    await c.env.DB.prepare('DELETE FROM recommendations WHERE id = ?').bind(c.req.param('id')).run()
    return c.json({ ok: true })
  })

  // Send a notification to ALL users
  app.post('/api/admin/broadcast', async (c) => {
    if (!(await requireAdmin(c))) return unauthorized(c)
    const b = await c.req.json()
    const title = String(b.title || '').trim().slice(0, 120) || 'Unstudy'
    const body = String(b.message || b.body || '').trim().slice(0, 2000)
    if (!body) return c.json({ error: 'Type a message to send.' }, 400)
    const db = c.env.DB
    const ins = await db.prepare(
      "INSERT INTO notifications (user_id, type, title, body, link) SELECT id, 'broadcast', ?, ?, NULL FROM users"
    ).bind(title, body).run()
    const recipients = Number(ins.meta.changes || 0)
    await db.prepare('INSERT INTO broadcasts (title, body, recipients) VALUES (?, ?, ?)').bind(title, body, recipients).run()
    const { results } = await db.prepare('SELECT DISTINCT user_id FROM push_subscriptions').all<any>()
    await pushToUsers(db, results.map((r: any) => r.user_id), { title, body, url: '/app?open=notifications', tag: 'broadcast' })
    return c.json({ ok: true, recipients })
  })

  app.get('/api/admin/broadcasts', async (c) => {
    if (!(await requireAdmin(c))) return unauthorized(c)
    const { results } = await c.env.DB.prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 50').all()
    return c.json({ broadcasts: results })
  })

  // ================= INBOX / MESSAGES =================
  app.get('/api/inbox', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    const me = s.user_id

    // Friends (top row) — online first
    const { results: friends } = await db.prepare(
      `SELECT u.id, u.username, u.full_name, u.avatar, u.last_seen, ${ONLINE_SQL('u')} AS is_online, f.accepted_at, f.created_at AS friend_since
       FROM friends f
       JOIN users u ON u.id = (CASE WHEN f.requester_id = ?1 THEN f.receiver_id ELSE f.requester_id END)
       WHERE (f.requester_id = ?1 OR f.receiver_id = ?1) AND f.status = 'accepted'
       ORDER BY is_online DESC, u.last_seen DESC`
    ).bind(me).all<any>()

    // Conversations: last message per partner
    const { results: convos } = await db.prepare(
      `WITH mine AS (
         SELECT id, sender_id, receiver_id, body, read_at, created_at,
                CASE WHEN sender_id = ?1 THEN receiver_id ELSE sender_id END AS partner
         FROM messages WHERE sender_id = ?1 OR receiver_id = ?1
       ),
       last AS (SELECT partner, MAX(id) AS last_id FROM mine GROUP BY partner)
       SELECT m.id, m.body, m.sender_id, m.created_at, l.partner,
              (SELECT COUNT(*) FROM messages x WHERE x.sender_id = l.partner AND x.receiver_id = ?1 AND x.read_at IS NULL) AS unread,
              u.username, u.full_name, u.avatar, u.last_seen, ${ONLINE_SQL('u')} AS is_online
       FROM last l JOIN messages m ON m.id = l.last_id JOIN users u ON u.id = l.partner
       ORDER BY m.id DESC LIMIT 100`
    ).bind(me).all<any>()

    const friendIds = new Set(friends.map((f: any) => f.id))
    const { results: reqs } = await db.prepare(
      `SELECT requester_id, receiver_id, status FROM message_requests WHERE requester_id = ?1 OR receiver_id = ?1`
    ).bind(me).all<any>()
    const pendingIncoming = new Set(reqs.filter((r: any) => r.status === 'pending' && r.receiver_id === me).map((r: any) => r.requester_id))
    const pendingOutgoing = new Set(reqs.filter((r: any) => r.status === 'pending' && r.requester_id === me).map((r: any) => r.receiver_id))

    const conversations: any[] = []
    const requests: any[] = []
    for (const cv of convos) {
      const item = {
        user: { id: cv.partner, username: cv.username, full_name: cv.full_name, avatar: cv.avatar, last_seen: cv.last_seen, is_online: !!cv.is_online },
        last_message: { id: cv.id, body: cv.body, from_me: cv.sender_id === me, created_at: cv.created_at },
        unread: cv.unread,
        pending_outgoing: !friendIds.has(cv.partner) && pendingOutgoing.has(cv.partner)
      }
      if (!friendIds.has(cv.partner) && pendingIncoming.has(cv.partner)) requests.push(item)
      else conversations.push(item)
    }

    // Suggested chats: friends you have never messaged (newest friendships first)
    const talked = new Set(convos.map((cv: any) => cv.partner))
    const suggested = friends
      .filter((f: any) => !talked.has(f.id))
      .sort((a: any, b: any) => String(b.accepted_at || b.friend_since || '').localeCompare(String(a.accepted_at || a.friend_since || '')))
      .map((f: any) => ({ id: f.id, username: f.username, full_name: f.full_name, avatar: f.avatar, last_seen: f.last_seen, is_online: !!f.is_online }))

    return c.json({
      friends: friends.map((f: any) => ({ id: f.id, username: f.username, full_name: f.full_name, avatar: f.avatar, last_seen: f.last_seen, is_online: !!f.is_online })),
      conversations,
      suggested,
      requests
    })
  })

  // Messages with one user (?after=<id> returns only newer ones)
  app.get('/api/messages/:uid', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    const me = s.user_id
    const other = Number(c.req.param('uid'))
    const after = Number(c.req.query('after') || 0)
    const user = await db.prepare(
      `SELECT u.id, u.username, u.full_name, u.avatar, u.last_seen, ${ONLINE_SQL('u')} AS is_online FROM users u WHERE u.id = ?`
    ).bind(other).first<any>()
    if (!user) return c.json({ error: 'User not found' }, 404)

    const { results } = await db.prepare(
      `SELECT id, sender_id, receiver_id, body, read_at, created_at FROM messages
       WHERE ((sender_id = ?1 AND receiver_id = ?2) OR (sender_id = ?2 AND receiver_id = ?1)) AND id > ?3
       ORDER BY id DESC LIMIT 200`
    ).bind(me, other, after).all<any>()
    results.reverse()

    await db.prepare('UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL')
      .bind(other, me).run()

    const friends = await areFriends(db, me, other)
    const req = await messageRequest(db, me, other)
    let relation = friends ? 'friends' : 'none'
    if (!friends && req) {
      if (req.status === 'accepted') relation = 'accepted'
      else relation = req.requester_id === me ? 'request_sent' : 'request_received'
    }
    // Last message I sent that the other person has read ("Seen")
    const seen = await db.prepare(
      'SELECT MAX(id) AS id FROM messages WHERE sender_id = ? AND receiver_id = ? AND read_at IS NOT NULL'
    ).bind(me, other).first<any>()

    return c.json({ user: { ...user, is_online: !!user.is_online }, messages: results, relation, seen_id: seen?.id || 0 })
  })

  app.post('/api/messages/:uid', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const db = c.env.DB
    const me = s.user_id
    const other = Number(c.req.param('uid'))
    if (!other || other === me) return c.json({ error: 'Invalid user' }, 400)
    const { body } = await c.req.json()
    const text = String(body || '').trim()
    if (!text) return c.json({ error: 'Type a message first.' }, 400)
    if (text.length > 2000) return c.json({ error: 'Message is too long (max 2000 characters).' }, 400)
    const target = await db.prepare('SELECT id FROM users WHERE id = ?').bind(other).first()
    if (!target) return c.json({ error: 'User not found' }, 404)

    const sender = await db.prepare('SELECT username, full_name FROM users WHERE id = ?').bind(me).first<any>()
    const friends = await areFriends(db, me, other)
    let isRequest = false
    if (!friends) {
      const req = await messageRequest(db, me, other)
      if (!req) {
        await db.prepare("INSERT INTO message_requests (requester_id, receiver_id, status) VALUES (?, ?, 'pending')").bind(me, other).run()
        isRequest = true
        await notify(db, other, {
          type: 'message_request',
          title: `${displayName(sender)} wants to send you a message`,
          body: text.slice(0, 120),
          link: 'chat:' + me,
          actor_id: me
        }, false)
      } else if (req.status === 'pending' && req.receiver_id === me) {
        // Replying to a message request = accepting it
        await db.prepare("UPDATE message_requests SET status = 'accepted' WHERE id = ?").bind(req.id).run()
      } else if (req.status === 'pending') {
        isRequest = true
        // Limit spam while the request is not accepted yet
        const cnt = await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND receiver_id = ?').bind(me, other).first<any>()
        if (Number(cnt?.n || 0) >= 5)
          return c.json({ error: 'Wait for them to accept your message request before sending more messages.' }, 429)
      }
    }

    const r = await db.prepare('INSERT INTO messages (sender_id, receiver_id, body) VALUES (?, ?, ?)').bind(me, other, text).run()
    await db.prepare('UPDATE users SET online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?').bind(me).run()
    await pushToUsers(db, [other], {
      title: isRequest ? `Message request from ${displayName(sender)}` : displayName(sender),
      body: text.slice(0, 200),
      url: '/app?chat=' + me,
      tag: 'chat-' + me
    })
    const msg = await db.prepare('SELECT id, sender_id, receiver_id, body, read_at, created_at FROM messages WHERE id = ?')
      .bind(r.meta.last_row_id).first()
    return c.json({ ok: true, message: msg, request: isRequest })
  })

  app.post('/api/message-requests/:uid/accept', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    await c.env.DB.prepare("UPDATE message_requests SET status = 'accepted' WHERE requester_id = ? AND receiver_id = ?")
      .bind(c.req.param('uid'), s.user_id).run()
    return c.json({ ok: true })
  })

  app.post('/api/message-requests/:uid/decline', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const other = c.req.param('uid')
    await c.env.DB.prepare("DELETE FROM message_requests WHERE requester_id = ? AND receiver_id = ? AND status = 'pending'").bind(other, s.user_id).run()
    await c.env.DB.prepare('DELETE FROM messages WHERE sender_id = ? AND receiver_id = ?').bind(other, s.user_id).run()
    return c.json({ ok: true })
  })

  // ================= WEB PUSH =================
  app.get('/api/push/key', async (c) => {
    const v = await getVapid(c.env.DB)
    return c.json({ publicKey: v.publicKey })
  })

  app.post('/api/push/subscribe', async (c) => {
    const s = await requireUser(c)
    if (!s) return unauthorized(c)
    const { endpoint } = await c.req.json()
    if (!endpoint || !/^https:\/\//.test(endpoint)) return c.json({ error: 'Invalid subscription' }, 400)
    await c.env.DB.prepare(
      'INSERT INTO push_subscriptions (user_id, endpoint) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id'
    ).bind(s.user_id, endpoint).run()
    return c.json({ ok: true })
  })

  app.post('/api/push/unsubscribe', async (c) => {
    const { endpoint } = await c.req.json()
    if (endpoint) {
      const sub = await c.env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).first<any>()
      if (sub) {
        await c.env.DB.prepare('DELETE FROM push_queue WHERE sub_id = ?').bind(sub.id).run()
        await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run()
      }
    }
    return c.json({ ok: true })
  })

  // The service worker asks what to show after it receives a push
  app.post('/api/push/pending', async (c) => {
    const { endpoint } = await c.req.json().catch(() => ({}))
    if (!endpoint) return c.json({ items: [] })
    const sub = await c.env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).first<any>()
    if (!sub) return c.json({ items: [] })
    const { results } = await c.env.DB.prepare(
      "SELECT id, title, body, url, tag FROM push_queue WHERE sub_id = ? AND delivered = 0 AND created_at >= datetime('now', '-1 day') ORDER BY id LIMIT 5"
    ).bind(sub.id).all<any>()
    await c.env.DB.prepare('UPDATE push_queue SET delivered = 1 WHERE sub_id = ? AND delivered = 0').bind(sub.id).run()
    // housekeeping
    await c.env.DB.prepare("DELETE FROM push_queue WHERE created_at < datetime('now', '-3 days')").run()
    return c.json({ items: results })
  })
}

// Service worker served from the site root so it can control /app
export const SERVICE_WORKER_JS = `/* Unstudy service worker: notifications */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let items = []
    try {
      if (event.data) {
        try { items = [event.data.json()] } catch (e) { items = [{ title: 'Unstudy', body: event.data.text() }] }
      } else {
        const sub = await self.registration.pushManager.getSubscription()
        const res = await fetch('/api/push/pending', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub && sub.endpoint })
        })
        items = (await res.json()).items || []
      }
    } catch (e) {}
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    clientsList.forEach((c) => c.postMessage({ type: 'refresh-badges' }))
    const focused = clientsList.some((c) => c.focused && c.visibilityState === 'visible')
    if (!items.length) {
      if (!focused) await self.registration.showNotification('Unstudy', { body: 'You have a new update.', icon: '/static/logo-192.png', badge: '/static/logo-64.png', tag: 'unstudy' })
      return
    }
    for (const it of items) {
      // Don't pop up a system notification for the chat you are looking at
      if (focused && String(it.tag || '').startsWith('chat-')) continue
      await self.registration.showNotification(it.title || 'Unstudy', {
        body: it.body || '', icon: '/static/logo-192.png', badge: '/static/logo-64.png',
        tag: it.tag || 'unstudy', renotify: true, data: { url: it.url || '/app' }
      })
    }
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/app'
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of all) {
      if (new URL(c.url).pathname === '/app') {
        await c.focus()
        c.postMessage({ type: 'open', url })
        return
      }
    }
    await self.clients.openWindow(url)
  })())
})
`

export const MANIFEST = {
  name: 'Unstudy',
  short_name: 'Unstudy',
  start_url: '/app',
  scope: '/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#4F46E5',
  icons: [
    { src: '/static/logo-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/static/logo-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
  ]
}
