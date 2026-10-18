-- UNSTUDY v18 — live quiz "Retake" option
-- retake_enabled      : 1 = after finishing, a player may retake the quiz (practice only —
--                       the leaderboard ALWAYS keeps their first attempt)
-- game_players.retake_* : the player's current retake (kept apart from the scored attempt)
--   retake_count      : how many retakes the player started
--   retake_active     : 1 = the player is in (or just finished) a retake
--   retake_answers    : JSON answers of the current retake (same format as answers)
--   retake_round      : round of the current retake (rounds mode)
--   retake_started_at : when the current retake's timer started
--   retake_finished_at: when the current retake ended (finished / time up)
--   retake_history    : JSON array of finished retakes { n, score, answered, total, rounds, started_at, finished_at, time_up, perfected }
ALTER TABLE game_rooms ADD COLUMN retake_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_players ADD COLUMN retake_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_players ADD COLUMN retake_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_players ADD COLUMN retake_answers TEXT NOT NULL DEFAULT '{}';
ALTER TABLE game_players ADD COLUMN retake_round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE game_players ADD COLUMN retake_started_at INTEGER;
ALTER TABLE game_players ADD COLUMN retake_finished_at INTEGER;
ALTER TABLE game_players ADD COLUMN retake_history TEXT NOT NULL DEFAULT '[]';
