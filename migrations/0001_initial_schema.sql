-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  photo TEXT,                         -- base64 data URL captured during human verification
  full_name TEXT,
  birthday TEXT,
  avatar TEXT,                        -- base64 profile picture
  bio TEXT DEFAULT '',
  theme TEXT DEFAULT 'light',         -- 'light' or 'dark'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Admin table
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table (simple token auth)
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  role TEXT NOT NULL,                 -- 'user' or 'admin'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Flashcard sets
CREATE TABLE IF NOT EXISTS flashcard_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  source_text TEXT,
  cards TEXT NOT NULL,                -- JSON array of {front, back}
  share_id TEXT UNIQUE,              -- public share slug
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Quizzes
CREATE TABLE IF NOT EXISTS quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  types TEXT NOT NULL,               -- JSON array of selected types
  questions TEXT NOT NULL,           -- JSON array of question objects
  share_id TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Friends / connections
CREATE TABLE IF NOT EXISTS friends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL,
  receiver_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'accepted', 'declined'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (requester_id) REFERENCES users(id),
  FOREIGN KEY (receiver_id) REFERENCES users(id),
  UNIQUE(requester_id, receiver_id)
);

CREATE INDEX IF NOT EXISTS idx_flashcard_sets_user ON flashcard_sets(user_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_user ON quizzes(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_friends_requester ON friends(requester_id);
CREATE INDEX IF NOT EXISTS idx_friends_receiver ON friends(receiver_id);
