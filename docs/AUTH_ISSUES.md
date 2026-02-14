# Authentication Issues Report

## Summary

The security hardening commit (`5312bfc`) added authentication to Valentine RF
but introduced several usability problems that made it nearly impossible for
existing users to log in. This document details each issue, root cause, and fix.

## Issues

### 1. No migration path from open access to authenticated

**Problem:** Before the security commit, Valentine RF had no login. After the
commit, a login wall appeared with no documentation on what the credentials
are. Users who previously ran the app with `admin / admin` or no auth were
locked out.

**Root cause:** The auth system generates a random 16-character password on
first startup and prints it to the console log. This is easy to miss in the
wall of startup output, and there's no indication on the login page itself
about where to find credentials.

**Fix:** Print credentials clearly at startup with a visible banner. Document
the `VALENTINE_ADMIN_PASSWORD` env var prominently.

---

### 2. `VALENTINE_ADMIN_PASSWORD` env var ignored when DB already exists

**Problem:** Setting `export VALENTINE_ADMIN_PASSWORD="mypass"` before starting
the app had no effect if the database already contained an admin user (created
on a previous run with a random password).

**Root cause:** `utils/database.py` line 216-218 only created the admin user
when the users table was empty (`SELECT COUNT(*) FROM users` == 0). If a user
already existed, the env var password was silently ignored.

**Fix:** Added an `elif ADMIN_PASSWORD_EXPLICIT:` branch that updates the
existing admin user's password hash when the env var is set. Committed in
`6c92f29`.

---

### 3. Database owned by root cannot be deleted by normal user

**Problem:** When the app runs with `sudo`, the SQLite database
(`instance/valentine.db`) is created with root ownership. When told to
`rm instance/valentine.db`, the command fails with "Permission denied" but
the error is easy to miss since the next command (`sudo -E ... valentine.py`)
runs immediately after.

**Root cause:** The instance directory and database are created by the Flask
app running as root. Normal users cannot delete root-owned files.

**Fix:** Users must use `sudo rm instance/valentine.db`. The startup banner
now shows the active credentials so deleting the DB should rarely be needed.

---

### 4. Rate limiter locks out users during troubleshooting

**Problem:** The login endpoint is rate-limited to 5 attempts per minute.
When debugging auth issues, users hit this limit within seconds and get
`429 Too Many Requests`, making troubleshooting harder.

**Root cause:** 5 per minute is too aggressive for a single-user local app.
Users trying different passwords exhaust the limit in under a minute.

**Fix:** Increased login rate limit from 5/minute to 15/minute. This still
prevents brute-force attacks but gives operators room to troubleshoot.

---

### 5. No visible confirmation of successful login

**Problem:** The server logs show `POST /login 302` on success, but users
looking at the terminal see "Failed login attempt" messages from other
attempts and assume everything failed. The 302 redirect (which means success)
is not obvious.

**Root cause:** Successful logins log at INFO level, but failed logins log at
WARNING level. Warnings are more visible. There's no startup-visible
confirmation like "Login successful for admin".

**Fix:** Added a clear `"User 'admin' logged in successfully"` log at WARNING
level so it's visible alongside the failure messages.

---

## Correct Setup Procedure

```bash
# Option A: Set your own password (recommended)
export VALENTINE_ADMIN_PASSWORD="your-password-here"
sudo -E venv/bin/python valentine.py
# Login with: admin / your-password-here

# Option B: Use generated password
sudo -E venv/bin/python valentine.py
# Look for the password in the startup banner (printed in a box)
# Login with: admin / <generated-password>

# If locked out: reset the database
sudo rm instance/valentine.db
sudo -E venv/bin/python valentine.py
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `VALENTINE_ADMIN_USERNAME` | `admin` | Admin login username |
| `VALENTINE_ADMIN_PASSWORD` | (random) | Admin login password. If not set, a random password is generated and printed at startup |
| `VALENTINE_SECRET_KEY` | (random) | Session signing key. Set this for sessions to survive restarts |
