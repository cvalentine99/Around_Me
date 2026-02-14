# Security Considerations

VALENTINE RF is designed as a **local signal intelligence tool** for use on trusted/controlled networks (lab, IR, home). This document outlines security controls and their boundaries.

## Network Binding

By default, VALENTINE RF binds to `0.0.0.0:5050`, making it accessible from any network interface. This is convenient for accessing the web UI from other devices on your local network, but has security implications:

### Recommendations

1. **Firewall Rules**: If you don't need remote access, configure your firewall to block external access to port 5050:
   ```bash
   # Linux (iptables)
   sudo iptables -A INPUT -p tcp --dport 5050 -s 127.0.0.1 -j ACCEPT
   sudo iptables -A INPUT -p tcp --dport 5050 -j DROP

   # macOS (pf)
   echo "block in on en0 proto tcp from any to any port 5050" | sudo pfctl -ef -
   ```

2. **Bind to Localhost**: For local-only access, set the host environment variable:
   ```bash
   export VALENTINE_HOST=127.0.0.1
   python valentine.py
   ```

3. **Trusted Networks Only**: Only run VALENTINE RF on networks you trust.

## TLS

The application is HTTP-only by design. **TLS must be terminated by a reverse proxy** (nginx, Caddy, Traefik). The app must not be exposed directly to the internet. See `docs/DEPLOYMENT.md` for proxy configuration examples.

## Authentication

VALENTINE RF includes session-based authentication:

- Single admin user with password stored as a Werkzeug/bcrypt hash in SQLite
- Random password generated on first run if `VALENTINE_ADMIN_PASSWORD` is not set
- Forced password change on first login (when using generated password)
- Session-backed login with Flask signed cookies
- HMAC-SHA256 API tokens for WebSocket/controller endpoints

### CSRF Protection

State-changing requests (POST/PUT/DELETE) are protected by Origin/Referer header validation. Cross-origin mutation requests are rejected with 403.

### Credentials

| Variable | Purpose | Default |
|---|---|---|
| `VALENTINE_ADMIN_PASSWORD` | Admin password | Random 16-char token (logged to console) |
| `VALENTINE_SECRET_KEY` | Session signing key | Random per-process (sessions lost on restart) |

**Both should be set explicitly for any non-ephemeral deployment.**

## Rate Limiting

Rate limits are enforced per-IP via `flask-limiter`:

| Endpoint | Limit |
|---|---|
| `/login` | 5 per minute |
| `/killall` | 10 per minute |
| `/export/*` | 30 per minute |
| All other endpoints (default) | 60 per minute |
| SSE streaming (`/*/stream`) | Exempt (long-lived connections) |
| `/health` | Exempt (monitoring probes) |

Storage is in-memory. For multi-process deployments, switch to `redis://`.

## Security Headers

VALENTINE RF includes the following security headers on all responses:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevent MIME type sniffing |
| `X-Frame-Options` | `SAMEORIGIN` | Prevent clickjacking |
| `X-XSS-Protection` | `1; mode=block` | Enable browser XSS filter |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Control referrer information |
| `Permissions-Policy` | `geolocation=(self), microphone=()` | Restrict browser features |

## Input Validation

All user inputs are validated before use:

- **Network interface names**: Validated against strict regex pattern
- **Bluetooth interface names**: Must match `hciX` format
- **MAC addresses**: Validated format
- **Frequencies**: Validated range and format
- **File paths**: Protected against directory traversal
- **HTML output**: All user-provided content is escaped

## Subprocess Execution

VALENTINE RF executes external tools (rtl_fm, airodump-ng, etc.) via subprocess. Security measures:

- **No shell execution**: All subprocess calls use list arguments, not shell strings
- **Input validation**: All user-provided arguments are validated before use
- **Process isolation**: Each tool runs in its own process with limited permissions

## Docker Security

- Runs with targeted Linux capabilities (`SYS_RAWIO`, `NET_ADMIN`, `NET_RAW`) instead of `privileged: true`
- `no-new-privileges: true` prevents privilege escalation
- `network_mode: host` is disabled by default (see `docs/DEPLOYMENT.md` for tradeoffs)

## Debug Mode

Debug mode is **disabled by default**. If enabled via `VALENTINE_DEBUG=true`:

- The Werkzeug debugger PIN is disabled (not needed for local tool)
- Additional logging is enabled
- Stack traces are shown on errors

**Never run in debug mode on untrusted networks.**

## Reporting Security Issues

If you discover a security vulnerability, please report it by:

1. Opening a GitHub issue (for non-sensitive issues)
2. Emailing the maintainer directly (for sensitive issues)

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)
