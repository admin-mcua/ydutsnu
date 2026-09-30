-- UNSTUDY v8: presence, notifications, recommendations, inbox / messaging, push

-- 1) Presence: last time the user was active in the app (UTC)
ALTER TABLE users ADD COLUMN last_seen DATETIME;
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen);

-- 2) In-app notifications (bell icon)
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'system',   -- welcome | broadcast | friend_accept | message_request | system
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,                             -- optional in-app target, e.g. "chat:12", "suggest", "inbox"
  actor_id INTEGER,                      -- user that triggered it (optional)
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- 3) Feature recommendations sent by users (visible in the admin dashboard)
CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',    -- new | seen
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_recommendations_user ON recommendations(user_id);

-- 4) Announcements the admin sent to every user
CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  recipients INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5) Direct messages
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL,
  receiver_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  read_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sender_id) REFERENCES users(id),
  FOREIGN KEY (receiver_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, receiver_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, read_at);

-- 6) Message requests (when users are not friends yet)
CREATE TABLE IF NOT EXISTS message_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL,
  receiver_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(requester_id, receiver_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_req_receiver ON message_requests(receiver_id, status);

-- 7) Web Push (phone / desktop notifications)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- Items waiting to be shown by the service worker when a push arrives
CREATE TABLE IF NOT EXISTS push_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_id INTEGER NOT NULL,               -- push_subscriptions.id (one row per device)
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '/app',
  tag TEXT NOT NULL DEFAULT 'unstudy',
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_push_queue_sub ON push_queue(sub_id, delivered);

-- Text key/value config (VAPID keys are generated automatically on first use)
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 1b) Online flag (1 while the app is open; last_seen decides if it is stale)
ALTER TABLE users ADD COLUMN online INTEGER NOT NULL DEFAULT 0;
-- When a friendship was accepted (used to sort new friends in the inbox)
ALTER TABLE friends ADD COLUMN accepted_at DATETIME;
