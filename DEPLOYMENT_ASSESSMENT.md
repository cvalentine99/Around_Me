# VALENTINE RF - Deployment Assessment Report

**Date:** 2026-02-21
**Codebase Version:** v2.18.0
**Platform:** Quart/Hypercorn ASGI on Python 3.11
**Assessment Type:** Read-Only (no changes made)

---

## Executive Summary

Valentine RF is a mature SIGINT platform with **excellent internal security practices** (no command injection, parameterized SQL, proper input validation, non-root containers). However, it has **critical gaps in secrets management, network-layer security, CI/CD automation, and data persistence** that must be addressed before production deployment.

| Domain | Rating | Summary |
|--------|--------|---------|
| Docker & Containers | **Good** | Non-root, targeted caps, health checks, multi-arch |
| Dependencies & Security | **Excellent** | Pinned versions, no shell=True, shlex.quote() everywhere |
| Config & Secrets | **Critical** | Hardcoded DB creds, ephemeral secret key & admin password |
| CI/CD & Testing | **Critical** | No CI pipeline; 43 test files but no automated enforcement |
| Frontend & Assets | **Moderate** | CSP weakened by unsafe-inline; no SRI on CDN resources |
| Process Mgmt & Reliability | **Good** | Proper cleanup, but health check always returns 200 |

**Overall Verdict:** Suitable for **isolated local networks** (home lab, closed office). **Not production-ready** without the critical fixes below.

---

## 1. Docker & Container Configuration

### Strengths
- **Non-root user** (`valentine:valentine`) with no login shell (`/sbin/nologin`)
- **Targeted Linux capabilities** (`SYS_RAWIO`, `NET_ADMIN`, `NET_RAW`) instead of `--privileged`
- **`no-new-privileges:true`** security option prevents privilege escalation
- **All git clones pinned** to specific commits/tags (readsb `5831f91`, dump1090 `4f47d12`, SatDump `1.2.2`, etc.)
- **Health check** with `/health` endpoint, 30s interval, 3 retries
- **Multi-arch support** via `build-multiarch.sh` (amd64 + arm64/RPi5)
- **`PYTHONUNBUFFERED=1`** ensures real-time Docker log streaming
- **`.dockerignore`** properly excludes `.git`, `tests/`, `.env`, `pgdata/`

### Concerns

| Issue | Severity | Location |
|-------|----------|----------|
| Base image not pinned to digest hash | Medium | `Dockerfile:9` |
| Monolithic 178-line RUN block (hard to debug/cache) | Medium | `Dockerfile:72-249` |
| `/app/instance` (SQLite DB) **not volume-mounted** - settings lost on restart | **Critical** | `docker-compose.yml:37-41` |
| All USB devices exposed (`/dev/bus/usb`) | Medium | `docker-compose.yml:35-36` |
| Port 5050 bound to 0.0.0.0 (all interfaces) | Medium | `docker-compose.yml:22-23` |

### Recommendations
- Add volume mount: `./instance:/app/instance` to persist settings/baselines
- Pin base image: `python:3.11-slim@sha256:<digest>`
- Bind port to localhost for testing: `127.0.0.1:5050:5050`
- Filter USB to specific SDR dongle rather than entire bus

---

## 2. Dependencies & Security

### Strengths
- **All dependencies pinned** to exact versions in `requirements.txt` (e.g., `quart==0.20.0`, `httpx==0.28.1`)
- **Dev dependencies separated** via `[project.optional-dependencies]` in `pyproject.toml`
- **Zero instances of `shell=True`** in subprocess calls across entire codebase
- **`shlex.quote()` used** on all SDR command builders (RTL-SDR, Airspy, HackRF, LimeSDR, SDRPlay)
- **Parameterized SQL queries** throughout `utils/database.py` (no SQL injection)
- **Column name whitelists** for dynamic UPDATE queries (TSCM schedule/baseline/case)
- **Centralized input validation** in `utils/validation.py` - regex-validated interfaces, MAC addresses, frequencies, gains
- **HTML escaping** for user-supplied display strings (callsigns, SSIDs, device names)

### Authentication & Authorization
- **Session-based auth** with `require_login()` on all routes
- **Password hashing** via Werkzeug PBKDF2 (`generate_password_hash`)
- **12-character minimum** password length enforced
- **Rate limiting** on login: 5 attempts/minute/IP
- **API token support** via HMAC-SHA256 with timing-safe comparison (`hmac.compare_digest`)
- **Forced password change** on first login when using generated password

### Concerns

| Issue | Severity | Location |
|-------|----------|----------|
| **No HTTPS/TLS** - sessions/credentials in plaintext | **Critical** | `config.py:214-215` |
| CSP allows `unsafe-inline` and `unsafe-eval` | High | `app.py:93-96` |
| API keys returned in agent detail JSON responses (should be write-only) | Medium | `utils/database.py:2032` |

---

## 3. Configuration & Secrets Handling

### Strengths
- **`VALENTINE_` prefix convention** for all 50+ environment variables
- **Typed helper functions** (`_get_env`, `_get_env_int`, `_get_env_bool`, `_get_env_float`)
- **`.env` files excluded** from git (`.gitignore` lines 62-64)
- **Instance directory excluded** from git (`.gitignore` line 48)
- **Webhook secrets** passed via `X-Alert-Token` header, never logged
- **Database passwords not logged** - only generic exception messages

### Critical Issues

| Issue | Impact | Location |
|-------|--------|----------|
| **Default Postgres credentials `valentine:valentine`** hardcoded and active | DB accessible with known creds | `config.py:247-248`, `docker-compose.yml:115-116,145` |
| **SECRET_KEY regenerated on every restart** when not explicitly set | Sessions invalidated, users logged out | `config.py:295-300` |
| **Admin password regenerated on every restart** when not explicitly set | Users cannot log back in after restart | `config.py:289-291` |
| Generated admin password **logged to stderr** (visible in `docker logs`) | Password exposed in logs | `utils/database.py:223-229` |

### Recommendations
1. **Create `.env.production` template** with all required variables documented
2. **Require** `VALENTINE_SECRET_KEY` and `VALENTINE_ADMIN_PASSWORD` in production mode
3. **Use Docker secrets** or external vault for sensitive credentials
4. Replace hardcoded Postgres defaults with env var references: `${POSTGRES_PASSWORD}`

---

## 4. CI/CD, Testing & Code Quality

### Critical Gap: No CI/CD Pipeline
- No GitHub Actions workflows (`.github/workflows/` contains only `FUNDING.yml`)
- No GitLab CI, Jenkins, or any automated pipeline
- Docker builds are entirely manual via `build-multiarch.sh`
- No pre-commit hooks (`.pre-commit-config.yaml` absent)

### Test Suite Strengths
- **43 test files** totaling 14,507 lines
- **28 files use async patterns** with pytest-asyncio (`asyncio_mode = "auto"`)
- **Comprehensive mocking** of external SDR tools across 28 files
- **Hardware tests properly marked** with `@pytest.mark.live`
- **Smoke test** for Bluetooth API contract validation
- **Coverage configured** for `app`, `routes`, `utils`, `data` modules

### Linting & Type Checking
- **Ruff configured** with E, W, F, I, B, C4, UP, SIM rules (line length 120)
- **mypy configured** targeting Python 3.9 with `warn_return_any`, `warn_unused_configs`
- Neither enforced in any pipeline

### Concerns

| Issue | Severity |
|-------|----------|
| No CI pipeline - breaking changes can be merged uncaught | **Critical** |
| No pre-commit hooks for local enforcement | High |
| 3 bare `except` handlers in `app.py` suppress errors silently | High |
| 5 timing-dependent tests may be flaky in CI | Medium |
| Test coverage gaps: auth flows, rate limiting, process race conditions | Medium |

### Recommended CI Pipeline
```yaml
# .github/workflows/test.yml
on: [push, pull_request]
jobs:
  test:
    steps:
      - pip install -e ".[dev]"
      - pytest -m "not live" --cov=routes --cov=utils
      - ruff check .
      - mypy .
```

---

## 5. Frontend & Static Assets

### Strengths
- **Security headers present**: `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`
- **Jinja2 autoescape enabled** by default
- **`tojson` filter** used for safe JavaScript variable injection
- **No hardcoded credentials** in JavaScript
- **All API calls use relative paths** (no hardcoded endpoints)
- **`escapeHtml()`/`escapeAttr()` helpers** used for innerHTML assignments
- **Offline-first asset loading** with local vendor fallback for Leaflet, Chart.js
- **CSS variables** for theming (`--bg-card`, `--accent-cyan`, etc.)

### Concerns

| Issue | Severity | Location |
|-------|----------|----------|
| **No SRI hashes** on CDN resources (Leaflet, Chart.js) | **Critical** | `templates/index.html:40` |
| **CSP `unsafe-inline` + `unsafe-eval`** defeats XSS protection | **Critical** | `app.py:95` |
| 2,600+ lines of inline JavaScript in index.html | High | `templates/index.html:2586+` |
| No cache busting (no content hashes in filenames) | Medium | All static assets |
| No minification/bundling (35+ separate JS requests) | Medium | `static/js/` |
| No gzip compression configured | Medium | Relies on reverse proxy |
| innerHTML used 35+ times (mitigated by escape helpers) | Low | Various JS files |

### Recommendations
1. Add SRI hashes to all CDN `<script>` and `<link>` tags
2. Extract inline scripts to external files, use nonce-based CSP
3. Deploy behind nginx with gzip, cache headers, and TLS

---

## 6. Process Management & Reliability

### Strengths
- **Registered process tracking** with `register_process()`/`unregister_process()`
- **`atexit.register(cleanup_all_processes)`** for exit cleanup
- **Safe termination**: `terminate()` with 2s timeout, then `kill()`
- **Signal handlers** for SIGTERM/SIGINT
- **DataStore TTL cleanup**: Aircraft 5min, WiFi 10min, Bluetooth 5min, DSC 1hr
- **CleanupManager** runs every 60s with DB cleanup every 24hr
- **Queue size limits**: All capped at `QUEUE_MAX_SIZE=1000`
- **SDR device claim/release** with lock-protected registry prevents conflicts

### Health Monitoring
- `/health` endpoint returns uptime, process status, data counts
- Docker health check properly configured (30s interval, 10s timeout, 3 retries)

### Concerns

| Issue | Severity | Location |
|-------|----------|----------|
| **Health check always returns HTTP 200** even if decoders are dead | **Critical** | `app.py:746-775` |
| **Subprocess PIPE deadlock risk** - pipes spawned but never read | **Critical** | `adsb.py` (readsb startup) |
| `adsb_messages_received` modified without lock, read in endpoints | High | `adsb.py:462-463` |
| Stale process cleanup misses dump1090, readsb, acarsdec, direwolf, AIS-catcher | High | `utils/process.py:120-128` |
| `wifi_handshakes`, `satellite_passes`, `bt_services` never auto-cleaned | Medium | `app.py:219,225,240` |
| No `/ready` endpoint for startup probe | Medium | - |
| 18 separate process globals with individual locks (no unified manager) | Medium | `app.py:131-205` |
| Daemon threads (TLE, SSE fanout) not coordinated on shutdown | Medium | `app.py:1099`, `sse.py:44-86` |
| No request IDs or correlation for log tracing | Low | - |

### Recommendations
1. Return HTTP 503 from `/health` if critical processes unexpectedly stopped
2. Use `subprocess.DEVNULL` or read pipes in background threads
3. Add lock protection for global counters
4. Implement `/ready` endpoint for container orchestration
5. Expand stale process cleanup list to all decoder tools

---

## Critical Deployment Blockers (Must Fix)

| # | Issue | Category | Impact |
|---|-------|----------|--------|
| 1 | **No HTTPS/TLS** | Network | Credentials transmitted in plaintext |
| 2 | **Hardcoded Postgres creds** (`valentine:valentine`) | Secrets | DB accessible with known credentials |
| 3 | **SECRET_KEY + admin password regenerated on restart** | Secrets | Users locked out after container restart |
| 4 | **`/app/instance` not persisted** | Docker | Settings/baselines lost on restart |
| 5 | **No CI/CD pipeline** | Quality | Breaking changes can reach production uncaught |
| 6 | **No SRI on CDN resources** | Frontend | CDN compromise = full client-side takeover |
| 7 | **Health check always returns 200** | Reliability | Orchestrator routes traffic to broken containers |
| 8 | **Subprocess PIPE deadlock risk** | Reliability | Decoder processes can hang indefinitely |

---

## Deployment Readiness by Environment

### Home Lab / Local Network
**Status: Ready with minor configuration**
- Set `VALENTINE_SECRET_KEY` and `VALENTINE_ADMIN_PASSWORD` in environment
- Add `./instance:/app/instance` volume mount
- Run: `docker compose --profile basic up -d`

### Single-Host Production
**Status: Requires configuration (~2-3 hours)**
1. Create `.env` with strong credentials for all secrets
2. Add instance volume mount
3. Deploy behind nginx/Caddy with TLS termination
4. Bind port to localhost: `127.0.0.1:5050:5050`
5. Add SRI hashes to CDN resources

### Production with History (Postgres)
**Status: Requires configuration (~3-4 hours)**
- All single-host requirements plus:
- Strong, unique Postgres credentials via `.env`
- Persistent Postgres volume on reliable storage
- Database backup strategy

### Full Production (CI/CD + Monitoring)
**Status: Requires significant work (~9-13 hours)**
- All above plus:
- GitHub Actions pipeline (test, lint, type check, Docker build)
- Pre-commit hooks for local enforcement
- Fix health check to return 503 on failure
- Add `/ready` endpoint
- Structured JSON logging with request correlation
- Extract inline JS, implement nonce-based CSP

---

## Summary Scorecard

| Category | Status |
|----------|--------|
| Input Validation | Excellent |
| Subprocess Security | Excellent |
| Database Security (SQL) | Excellent |
| Docker Hardening | Good |
| Process Lifecycle | Good |
| Authentication | Good |
| Dependency Management | Good |
| Test Coverage | Good (not enforced) |
| Logging | Fair |
| Concurrency Safety | Fair |
| Frontend Security | Fair |
| Secrets Management | Critical |
| Network Security | Critical |
| CI/CD Automation | Critical |

---

*Assessment performed read-only. No files were modified.*
