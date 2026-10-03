-- Email verification codes for the "Forgot password" / Find your account flow.
-- A 6-digit code is emailed (via Resend) to the account's address; entering it
-- correctly logs the user in.
CREATE TABLE IF NOT EXISTS reset_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,          -- wrong tries (max 5)
  expires_at DATETIME NOT NULL,        -- code valid for 10 minutes
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reset_codes_email ON reset_codes(email);
