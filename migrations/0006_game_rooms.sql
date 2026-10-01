-- UNSTUDY v9 — Live quiz "Game" rooms
-- A host creates a room (short letters-only code), attaches a quiz (snapshot of
-- its questions), schedules when it starts and closes, then players join with
-- the code / link, wait in a waiting room and answer when it starts.
CREATE TABLE IF NOT EXISTS game_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,          -- letters only, e.g. "QWERTY"
  host_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT 'Untitled room', -- = title of the selected quiz
  quiz_id INTEGER,                    -- source quiz (informational)
  questions TEXT,                     -- JSON snapshot of the quiz questions
  difficulty TEXT DEFAULT 'medium',
  start_at INTEGER,                   -- epoch ms
  end_at INTEGER,                     -- epoch ms (room closes)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (host_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_game_rooms_host ON game_rooms(host_id);

CREATE TABLE IF NOT EXISTS game_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,         -- secret used by the player's browser
  score INTEGER NOT NULL DEFAULT 0,   -- number of correct answers
  answered INTEGER NOT NULL DEFAULT 0,
  answers TEXT NOT NULL DEFAULT '{}', -- JSON { index: { a: answer, c: 0|1 } }
  joined_at INTEGER NOT NULL,         -- epoch ms
  last_answer_at INTEGER,             -- epoch ms
  finished_at INTEGER,                -- epoch ms (answered every question)
  FOREIGN KEY (room_id) REFERENCES game_rooms(id),
  UNIQUE(room_id, name)
);
CREATE INDEX IF NOT EXISTS idx_game_players_room ON game_players(room_id);
