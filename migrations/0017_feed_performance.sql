-- Speeds up the Home feed (newest public posts) and class feeds.
CREATE INDEX IF NOT EXISTS idx_flashcard_sets_created ON flashcard_sets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quizzes_created ON quizzes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_flashcard_sets_class ON flashcard_sets(class_id);
CREATE INDEX IF NOT EXISTS idx_quizzes_class ON quizzes(class_id);
