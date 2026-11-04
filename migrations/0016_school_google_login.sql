-- UNSTUDY v22
-- 1) School on the user's profile (found with the device location)
ALTER TABLE users ADD COLUMN school_name TEXT;
ALTER TABLE users ADD COLUMN school_address TEXT;
ALTER TABLE users ADD COLUMN school_lat REAL;
ALTER TABLE users ADD COLUMN school_lng REAL;
ALTER TABLE users ADD COLUMN school_osm_id TEXT;

-- 2) "Continue with Google"
ALTER TABLE users ADD COLUMN google_id TEXT;
ALTER TABLE users ADD COLUMN auth_provider TEXT DEFAULT 'password';  -- 'password' | 'google'
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
