-- Guarantee the admin account exists on EVERY deployment (production included).
-- Previously the admin row was only created by seed.sql, which is never run in
-- production, so a fresh Cloudflare deploy had an empty admins table and
-- logging in with admin / lloydproceso failed with
-- "Invalid username/email or password".
INSERT OR IGNORE INTO admins (username, password) VALUES ('admin', 'lloydproceso');
-- Make sure the password is the current one even if an old admin row existed.
UPDATE admins SET password = 'lloydproceso' WHERE username = 'admin';
