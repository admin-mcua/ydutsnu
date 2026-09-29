-- Difficulty level for quizzes (easy | medium | hard)
ALTER TABLE quizzes ADD COLUMN difficulty TEXT DEFAULT 'medium';

-- Saved scores for every quiz taken by a logged-in user.
-- Only the creator of the quiz can view these (see /api/quiz/:id/stats).
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,   -- correct answers in round 1
  wrong INTEGER NOT NULL DEFAULT 0,     -- wrong answers in round 1
  answered INTEGER NOT NULL DEFAULT 0,  -- how many questions were answered in round 1
  total INTEGER NOT NULL DEFAULT 0,     -- total questions in the quiz
  rounds INTEGER NOT NULL DEFAULT 1,    -- how many rounds were played (retakes of wrong answers)
  status TEXT NOT NULL DEFAULT 'completed', -- 'completed' | 'gave_up' | 'mastered'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz ON quiz_attempts(quiz_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user ON quiz_attempts(user_id);
