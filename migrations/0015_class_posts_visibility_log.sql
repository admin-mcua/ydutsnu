-- UNSTUDY v20 — Class Main/Members, class log, class posts, visibility
-- 1) Visibility for every flashcard set / quiz: public | class | private ("Only me")
--    class_id = the class the item is posted to (NULL = not posted to a class)
ALTER TABLE flashcard_sets ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE flashcard_sets ADD COLUMN class_id INTEGER;
ALTER TABLE quizzes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE quizzes ADD COLUMN class_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_flashcard_sets_class ON flashcard_sets(class_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_class ON quizzes(class_id);
CREATE INDEX IF NOT EXISTS idx_flashcard_sets_vis ON flashcard_sets(visibility);
CREATE INDEX IF NOT EXISTS idx_quizzes_vis ON quizzes(visibility);

-- 2) Class log: every user that joined / left the class
CREATE TABLE IF NOT EXISTS class_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL,
  user_id INTEGER,                 -- the user the event is about
  username TEXT NOT NULL DEFAULT '', -- snapshot (kept even if the account is deleted)
  full_name TEXT,
  action TEXT NOT NULL,            -- created | joined | added | left | removed | new_owner
  actor_id INTEGER,                -- who did it (for added / removed)
  actor_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_class_logs_class ON class_logs(class_id, id);

-- Backfill: current members get a "created" / "joined" entry
INSERT INTO class_logs (class_id, user_id, username, full_name, action, created_at)
SELECT m.class_id, m.user_id, u.username, u.full_name,
       CASE WHEN m.role = 'owner' THEN 'created' ELSE 'joined' END, m.joined_at
FROM class_members m JOIN users u ON u.id = m.user_id;
