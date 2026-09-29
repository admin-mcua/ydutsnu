-- Change the default admin password from "admin123" to "lloydproceso"
UPDATE admins SET password = 'lloydproceso' WHERE username = 'admin';
-- Log out any existing admin sessions so the new password is required
DELETE FROM sessions WHERE role = 'admin';
