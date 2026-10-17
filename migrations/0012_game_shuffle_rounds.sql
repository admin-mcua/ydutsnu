-- UNSTUDY v17 — live quiz options: shuffle questions + rounds
-- shuffle_questions : 1 = every player gets the questions in their own random order
--                     (and a new random order on every round)
-- rounds_enabled    : 1 = after answering every question, a player who got some wrong
--                     plays another round with ONLY the wrong ones, again and again,
--                     until every question is correct (perfect quiz)
-- game_players.round: the round the player is on now (= number of rounds played)
ALTER TABLE game_rooms ADD COLUMN shuffle_questions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_rooms ADD COLUMN rounds_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_players ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
