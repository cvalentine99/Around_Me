# Security Architecture Review — VALENTINE RF v2.15.0

**Date:** 2026-02-12
**Reviewer:** Principal Security & Systems Engineer (Automated Review)
**Scope:** Full codebase analysis — backend, frontend, Docker, dependencies, data flow
**Commit Basis:** Current HEAD of main branch

---

## Executive Summary

VALENTINE RF is a single-operator Signal Intelligence (SIGINT) platform built on Flask, designed to control software-defined radios and external decoder tools from a browser interface. It runs with elevated system privileges (root or equivalent capabilities) by necessity — WiFi monitor mode, Bluetooth HCI access, and USB SDR dongles require it.

The application demonstrates **above-average security discipline** for a tool of this nature. Input validation is centralized and consistently applied. All subprocess invocations use list-based argument passing (no `shell=True`). Password hashing uses bcrypt/werkzeug. Rate limiting is applied to login. Security headers are present.

However, several gaps exist that are material for any deployment beyond a fully trusted, single-user LAN:

1. **No CSRF protection** on any state-changing endpoint.
2. **Session cookies lack security flags** (`HttpOnly`, `Secure`, `SameSite`).
3. **Weak path validation** on the WiFi handshake crack endpoint allows arbitrary file existence probing and unbounded wordlist paths.
4. **Global shared state** means all authenticated users see the same scan data — acceptable for single-operator use but a data isolation failure in multi-user deployments.
5. **No Content-Security-Policy header**, reducing defense-in-depth against XSS.

**Verdict: Conditionally safe for internal/single-operator use**, provided the deployment is on a trusted network with a single authenticated operator. The issues identified are fixable without architectural changes.

---

## Confirmed Strengths

### S1. Subprocess Execution — No Shell Injection Vectors

Every subprocess call across 150+ invocations uses Python list-based arguments. Zero instances of `shell=True`, `os.system()`, or string-interpolated commands were found. This is the single most important security property for an application that shells out to 15+ external tools.

- `routes/pager.py`, `routes/sensor.py`, `routes/adsb.py`, `routes/ais.py`, `routes/acars.py`, `routes/aprs.py`, `routes/dsc.py`, `routes/dmr.py`, `routes/wifi.py`, `routes/listening_post.py`, `routes/waterfall_websocket.py`, `utils/weather_sat.py`, `utils/sstv/sstv_decoder.py`, `valentine_agent.py`

### S2. Centralized Input Validation

`utils/validation.py` (259 lines) provides 19 validation functions covering all user-controllable parameters: frequencies, gain, PPM, device indices, network interfaces, Bluetooth interfaces, MAC addresses, hostnames, ports, coordinates, and display strings. All route blueprints import and use these validators before constructing subprocess commands.

Key defensive validators:
- `validate_network_interface()` — regex `^[a-zA-Z][a-zA-Z0-9_-]*$`, max 15 chars
- `validate_bluetooth_interface()` — regex `^hci([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$`
- `validate_rtl_tcp_host()` — regex `^[a-zA-Z0-9][a-zA-Z0-9.\-]*$`, max 253 chars
- `escape_html()` — HTML entity escaping for display strings

### S3. Path Traversal Protection Library

`utils/safe_path.py` provides `resolve_safe()` (resolves and constrains to an allowed root) and `is_safe_filename()` (blocks separators, `..`, non-alphanumeric). Used in recording file operations.

### S4. Process Lifecycle Management

`utils/process.py` implements `safe_terminate()` with graceful SIGTERM → timeout → SIGKILL. All spawned processes are tracked in a registry with `atexit` cleanup. Global locks per decoder mode prevent race conditions during start/stop.

### S5. Authentication System

- Bcrypt password hashing via `werkzeug.security`
- Forced password change on first login when using auto-generated credentials
- Rate limiting: 5 login attempts per minute per IP
- API token generation via HMAC-SHA256 with constant-time comparison (`hmac.compare_digest`)
- Global `before_request` hook enforces authentication on all routes except a small allowlist

### S6. Security Headers

`app.py` applies via `after_request`:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: geolocation=(self), microphone=()`

### S7. Docker Hardening

- Non-root runtime user (`valentine:valentine` with `/sbin/nologin`)
- Targeted Linux capabilities (`SYS_RAWIO`, `NET_ADMIN`, `NET_RAW`) instead of `privileged: true`
- `security_opt: no-new-privileges:true`
- Build tools removed after compilation
- `.dockerignore` excludes tests, venvs, `.env`, captured data
- HEALTHCHECK configured
- All compiled SDR tools pinned to exact git commits

### S8. Frontend HTML Escaping

JavaScript `escapeHtml()` function implemented in `static/js/core/utils.js` and duplicated in component modules. Consistently applied to user-facing data (callsigns, SSIDs, device names, message content) before `innerHTML` insertion.

### S9. Python Dependency Pinning

All 16 production dependencies in `requirements.txt` use exact version pins (`==`). No wildcard or minimum-only constraints in the production dependency file.

### S10. No Unsafe Deserialization

Zero instances of `pickle.load()`, `marshal.load()`, `yaml.load()` (without SafeLoader), or `eval()` on external data. All serialization uses `json.loads()` / `json.dumps()`.

---

## Confirmed Gaps

### G1. No CSRF Protection — HIGH

No CSRF tokens, no Flask-WTF integration, no `SameSite` cookie attribute. Every authenticated POST endpoint is vulnerable to cross-site request forgery if the operator visits a malicious page while logged in.

**Affected endpoints include:**
- `POST /killall` — kills all running decoders
- `POST /updater/update` — triggers git pull
- `POST /updater/restart` — restarts the application
- `POST /settings` — modifies application settings
- All decoder start/stop endpoints

**Evidence:** `app.py` — no CSRF middleware registered. `SESSION_COOKIE_SAMESITE` not configured (confirmed via grep — zero matches for `SESSION_COOKIE` in entire codebase).

### G2. Session Cookie Security Flags Not Set — HIGH

Flask session cookies are issued without:
- `HttpOnly` — JavaScript can read session cookies (XSS → session theft)
- `Secure` — Cookies sent over plaintext HTTP
- `SameSite` — No CSRF mitigation from browser

**Evidence:** No `app.config` entries for `SESSION_COOKIE_HTTPONLY`, `SESSION_COOKIE_SECURE`, or `SESSION_COOKIE_SAMESITE` anywhere in the codebase.

### G3. Weak Path Validation on Handshake Crack Endpoint — HIGH

`routes/wifi.py:1047-1121` — The `/handshake/crack` endpoint accepts `capture_file` and `wordlist` paths from user JSON input:

```python
capture_file = data.get('capture_file', '')
wordlist = data.get('wordlist', '')

if not capture_file.startswith('/tmp/valentine_handshake_') or '..' in capture_file:
    return jsonify(...)

if '..' in wordlist:
    return jsonify(...)
```

**Issues:**
- `wordlist` accepts any absolute path on the filesystem (e.g., `/etc/shadow`). The `..` check is insufficient — an attacker can specify any file as a "wordlist" for aircrack-ng to read.
- `os.path.exists(wordlist)` on line 1065 confirms arbitrary file existence (oracle).
- `capture_file` check uses string prefix matching but does not call `Path.resolve()` — symlinks within `/tmp/valentine_handshake_*` are not detected.
- The `utils/safe_path.py` module exists but is not used here.

### G4. No Content-Security-Policy Header — MEDIUM

No CSP header is set anywhere. The application uses inline `onclick` handlers (26+ instances in `templates/index.html`) and `document.write()` (2 instances), which would require `'unsafe-inline'` in a CSP. However, even a permissive CSP with `default-src 'self'` and `script-src 'self' 'unsafe-inline'` would limit damage from injection.

### G5. Health Endpoint Leaks System State Without Authentication — MEDIUM

`GET /health` is in the `allowed_routes` list (no authentication required). It returns uptime, active process count, and decoder status — useful for reconnaissance.

**Evidence:** `app.py:307` — `'health'` in `allowed_routes` list.

### G6. Global Shared State — No Per-User Data Isolation — MEDIUM

All scan data (aircraft, WiFi networks, Bluetooth devices, AIS vessels, DSC messages) is stored in process-wide `DataStore` dictionaries. Every authenticated user sees the same data. One user stopping a decoder affects all users.

**Context:** This is acceptable and by-design for single-operator use. It becomes a data isolation issue only in multi-user deployments.

### G7. API Tokens Are Deterministic and Non-Expiring — MEDIUM

API tokens are derived via `HMAC-SHA256(secret_key, 'valentine-api-token:{username}')`. This means:
- Same username always produces same token (no per-session rotation)
- Tokens never expire
- Token theft provides permanent access until `SECRET_KEY` changes
- Token verification iterates all users with `hmac.compare_digest` per user (O(n) but timing-safe per comparison)

**Evidence:** `app.py:343-359`

### G8. Dependency File Inconsistency — MEDIUM

`pyproject.toml` and `requirements.txt` define the same dependencies with different constraints. Notably, `pyproject.toml` requires `Werkzeug>=3.1.5` while `requirements.txt` pins `Werkzeug==3.1.3` (older). `flask-sock` is unpinned in `pyproject.toml`. This creates ambiguity depending on which file is used for installation.

### G9. System Packages Unpinned in Dockerfile — MEDIUM

All `apt-get install` packages in the Dockerfile (rtl-sdr, aircrack-ng, bluez, multimon-ng, etc.) are installed without version pins. Rebuilding at different times produces different system library versions, reducing reproducibility and potentially introducing regressions.

### G10. Jinja2 `|safe` Filter and Inline onclick — LOW

`templates/components/empty_state.html:17` uses `{{ icon|safe }}` to render SVG icons. The `action_onclick` parameter is embedded directly in an `onclick` attribute. These are currently used only with developer-controlled values, but the pattern is inherently risky if ever connected to user input.

### G11. Default Database Credentials in Docker Compose — LOW

`docker-compose.yml` includes `POSTGRES_PASSWORD=valentine` as the default. While documented that production should override this, the default is weak and in a version-controlled file.

### G12. Auto-Generated Admin Password Logged to Console — LOW

When `VALENTINE_ADMIN_PASSWORD` is not set, a random 22-character password is generated and printed to stdout. In containerized deployments, this password persists in Docker logs.

**Evidence:** `config.py` — password generation and logging at startup.

---

## Risk Ranking

### HIGH — Must Fix Before Non-Trivial Deployment

| # | Issue | Impact |
|---|-------|--------|
| G1 | No CSRF protection | Any site can trigger decoder stop/start, app update/restart, settings changes on behalf of an authenticated operator |
| G2 | Session cookies lack HttpOnly/Secure/SameSite | XSS → session theft; CSRF not mitigated by browser; cookies sent over HTTP |
| G3 | Weak path validation on handshake crack endpoint | Arbitrary file existence oracle; unbounded wordlist path reads arbitrary files via aircrack-ng |

### MEDIUM — Fix Soon

| # | Issue | Impact |
|---|-------|--------|
| G4 | No Content-Security-Policy | Reduced XSS defense-in-depth |
| G5 | Unauthenticated health endpoint | Reconnaissance — reveals uptime, active decoders, process counts |
| G6 | Global shared state | All users see all data; acceptable for single-operator only |
| G7 | Deterministic, non-expiring API tokens | Token theft provides permanent access |
| G8 | Dependency file inconsistency | Installation ambiguity; potential version conflicts |
| G9 | System packages unpinned in Dockerfile | Non-reproducible builds |

### LOW — Document and Monitor

| # | Issue | Impact |
|---|-------|--------|
| G10 | `\|safe` Jinja2 filter on icon rendering | XSS risk if ever connected to user input |
| G11 | Default Postgres password in compose file | Weak default; documented override exists |
| G12 | Admin password in container logs | Credential exposure in log aggregation |

---

## Unknowns / Requires Clarification

| # | Item | Reason |
|---|------|--------|
| U1 | `gp.php` in project root | File contains satellite TLE data, not PHP. Misleading extension — confirm if intentional or artifact |
| U2 | `valentine_agent.py` (169KB) | Large standalone agent binary. Full security review of agent-to-controller trust model not performed — would require dedicated review |
| U3 | HTTPS/TLS termination | No TLS configuration in Flask. Unknown whether a reverse proxy (nginx, Caddy) is expected. If not, all traffic including credentials is plaintext |
| U4 | Multi-user intent | Architecture assumes single operator. If multi-user access is planned, data isolation (G6) and RBAC need design work |
| U5 | Network exposure in production | Docker binds to `0.0.0.0:5050`. Unknown whether firewall rules or VPN restrict access |
| U6 | `modprobe` operations in settings | `routes/settings.py` writes to `/etc/modprobe.d/` and runs `modprobe -r` when blacklisting DVB drivers. Requires root. Risk depends on whether container runs with sufficient privilege |
| U7 | Agent API key storage | `routes/controller.py` stores agent API keys — unclear if encrypted at rest in SQLite |
| U8 | SSRF in agent registration | `routes/controller.py` accepts arbitrary `base_url` for agent registration. Only scheme/netloc validated. No private IP range blocking |

---

## Deployment Verdict

### **Conditionally safe with fixes**

**Conditions for safe internal deployment:**

1. Deploy on a trusted network segment (LAN/VPN) with a single authenticated operator
2. Apply HIGH-priority fixes (G1–G3) before any exposure to untrusted networks
3. Set `VALENTINE_SECRET_KEY` and `VALENTINE_ADMIN_PASSWORD` explicitly via environment variables
4. If HTTPS is required, terminate TLS at a reverse proxy (nginx, Caddy) in front of Flask
5. Restrict Docker port binding to localhost (`127.0.0.1:5050:5050`) if the reverse proxy runs on the same host

The application is **not safe** for deployment on the public internet or any network where the operator's browser may visit untrusted sites (due to G1/G2 CSRF exposure).

---

*Review generated from static analysis of the full codebase. No dynamic testing or penetration testing was performed.*
