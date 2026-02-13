# Deployment Guide

## TLS / HTTPS

VALENTINE RF is an HTTP-only application by design. **It does not terminate TLS itself.**

### Requirements

| Requirement | Details |
|---|---|
| TLS termination | Must be handled by a reverse proxy (nginx, Caddy, Traefik, etc.) |
| Direct internet exposure | **Not supported.** The app must not be directly reachable from the public internet. |
| Intended network posture | LAN-only, or behind an authenticated reverse proxy on a controlled network |

### Why no built-in TLS

- The app runs as a local SIGINT tool in lab/IR environments.
- Adding TLS at the application layer would require certificate management that is better handled by dedicated infrastructure.
- Flask's built-in server is not production-grade for TLS regardless.

### Recommended reverse proxy setup

**nginx (minimal):**

```nginx
server {
    listen 443 ssl;
    server_name valentine.local;

    ssl_certificate     /etc/ssl/certs/valentine.pem;
    ssl_certificate_key /etc/ssl/private/valentine.key;

    location / {
        proxy_pass http://127.0.0.1:5050;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support - disable buffering
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
```

**Caddy (minimal):**

```
valentine.local {
    reverse_proxy localhost:5050
}
```

Caddy handles TLS automatically with self-signed or ACME certificates.

### Runtime warning

If the application receives requests without an `X-Forwarded-Proto` header (indicating no reverse proxy is in front), it logs a one-time warning at startup:

```
WARNING - No X-Forwarded-Proto header detected. If this app is exposed beyond
localhost, ensure TLS is terminated by a reverse proxy (nginx/Caddy).
```

This warning is informational only and does not block operation.

---

## Docker Host Networking

### Background

WiFi scanning features (monitor mode via aircrack-ng, deauthentication detection via scapy) require direct access to the host's wireless network interfaces. Docker's default bridge networking isolates container network namespaces, making wireless interfaces invisible to the container.

### When `network_mode: host` is required

- WiFi monitor mode scanning (`airodump-ng`, `iw dev`)
- Deauthentication attack detection (raw 802.11 frame capture)
- Any feature that needs to enumerate or control physical wireless adapters

### When it is NOT required

- All SDR-based features (RTL-SDR accessed via USB passthrough, not networking)
- Bluetooth scanning (accessed via USB/HCI passthrough)
- ADS-B, AIS, ACARS, pager decoding, satellite tracking
- Meshtastic (serial/USB device)
- The web UI itself

### Security tradeoffs of `network_mode: host`

| Concern | Impact |
|---|---|
| Container shares host network namespace | All host network interfaces, ports, and routing visible inside container |
| Port isolation lost | Container binds directly to host ports; no Docker port mapping |
| Other services reachable | Container can reach any service on the host's loopback or LAN |
| Firewall bypass | Host firewall rules for Docker bridge traffic do not apply |

### How to enable (when needed)

Uncomment in `docker-compose.yml`:

```yaml
services:
  valentine-rf:
    network_mode: host
```

When using `network_mode: host`, the `ports:` directive is ignored (all container ports are directly on the host). Remove or comment out the `ports:` section to avoid confusion.

### Recommendation

**Do not enable `network_mode: host` by default.** Only enable it on systems where WiFi scanning is actively needed, and only on trusted/isolated networks. The `docker-compose.yml` ships with this option commented out intentionally.

---

## Environment Variables for Production

| Variable | Purpose | Required for production |
|---|---|---|
| `VALENTINE_SECRET_KEY` | Flask session signing key (64-char hex recommended) | **Yes** |
| `VALENTINE_ADMIN_PASSWORD` | Admin login password | **Yes** |
| `VALENTINE_HOST` | Bind address (default `0.0.0.0`) | No |
| `VALENTINE_PORT` | Bind port (default `5050`) | No |
| `VALENTINE_DEBUG` | Debug mode (default `false`) | Must be `false` |

Generate a secret key:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

---

## Known Test Suite State

The test suite has pre-existing failures unrelated to deployment hardening:

- **51 errors, 166 failures** (as of Feb 2026)
- Root causes: stale `weather_sat` mocks, SQLite path assumptions in test environments, missing system binaries (rtl_fm, airodump-ng, etc.) in CI
- These failures predate any security hardening work
- Tests that exercise the login-protected routes return 302 (redirect to login) rather than 200, which is expected behavior after authentication was added

See `tests/KNOWN_ISSUES.md` for details.
