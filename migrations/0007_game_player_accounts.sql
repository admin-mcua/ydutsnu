-- UNSTUDY v10 — logged-in players join game rooms with their Unstudy username
-- (no name prompt). Links a game player to the account so they can rejoin
-- from any device and keep their progress.
ALTER TABLE game_players ADD COLUMN user_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_game_players_user ON game_players(room_id, user_id);
