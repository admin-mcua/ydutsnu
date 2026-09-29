-- UNSTUDY v6
-- 1) Device / network info captured at sign-up (shown ONLY to admins)
ALTER TABLE users ADD COLUMN signup_ip TEXT;
ALTER TABLE users ADD COLUMN signup_info TEXT;   -- JSON: software, ISP/carrier, location

-- 2) Gemini API keys (managed in the admin dashboard) + round-robin rotation
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'gemini',
  label TEXT NOT NULL,                 -- "Key A", "Key B", ...
  api_key TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at DATETIME,
  last_status TEXT,                    -- 'ok' | 'error: ...'
  last_checked_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO app_state (key, value) VALUES ('gemini_rr', 0);
-- The key that was previously hard-coded becomes "Key A"
INSERT OR IGNORE INTO api_keys (provider, label, api_key, last_status)
VALUES ('gemini', 'Key A', 'AIzaSyDTkLMabFgMQzkvF0vNoaE3D4QyTzmhvzs', 'ok');

-- 3) Per-question answers for every quiz attempt (creator can review them in Stats)
ALTER TABLE quiz_attempts ADD COLUMN details TEXT;  -- JSON [{i, chosen, correct, options}]
