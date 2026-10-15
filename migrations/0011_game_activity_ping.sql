-- UNSTUDY v15 — live quiz anti-cheat activity log + network ping
-- activity_log : JSON array of { t: 'in' | 'out', at: epoch ms } recorded while the
--                player is answering (from timer start until their quiz stops)
-- away_count   : number of times the player left the app/tab during the quiz
-- away_ms      : total time spent outside the app/tab during the quiz
-- ping_ms      : last measured round-trip time (ms), net_type: 'wifi' | 'cellular' | 'ethernet' | 'unknown'
-- last_ping_at : epoch ms of the last heartbeat (used to show "offline" to the host)
-- paused_ms    : total time the player's timer was paused because of a weak connection (high ping / offline)
-- lag_since    : epoch ms when the current weak-connection pause started (NULL = not paused)
ALTER TABLE game_players ADD COLUMN activity_log TEXT NOT NULL DEFAULT '[]';
ALTER TABLE game_players ADD COLUMN away_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_players ADD COLUMN away_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_players ADD COLUMN ping_ms INTEGER;
ALTER TABLE game_players ADD COLUMN net_type TEXT;
ALTER TABLE game_players ADD COLUMN last_ping_at INTEGER;
ALTER TABLE game_players ADD COLUMN paused_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_players ADD COLUMN lag_since INTEGER;
