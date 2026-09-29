-- Default admin account: username "admin", password "lloydproceso"
INSERT OR IGNORE INTO admins (username, password) VALUES ('admin', 'lloydproceso');
-- If the admin already exists (old password), update it to the new password
UPDATE admins SET password = 'lloydproceso' WHERE username = 'admin';
