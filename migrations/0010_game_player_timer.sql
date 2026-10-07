-- UNSTUDY v13 — per-student timer in game rooms
-- time_limit: seconds each student gets to answer the quiz (0 = no limit, the timer just counts up)
-- started_at: when THAT student's timer started = the first moment they were in the
--             live quiz (NOT while sitting in the waiting room). Late joiners get the full time.
ALTER TABLE game_rooms ADD COLUMN time_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_players ADD COLUMN started_at INTEGER;
