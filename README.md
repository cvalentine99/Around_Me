# VALENTINE RF — Around Me

<p align="center">
  <img src="https://img.shields.io/badge/python-3.9+-blue.svg" alt="Python 3.9+">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg" alt="Platform">
  <img src="https://img.shields.io/badge/theme-Obsidian%20Prism-blueviolet.svg" alt="Obsidian Prism Theme">
</p>

<p align="center">
  <strong>Signal Intelligence Platform</strong><br>
  A web-based interface for software-defined radio reconnaissance and RF analysis.
</p>

<p align="center">
  <img src="static/images/screenshots/valentine-rf-main.png" alt="Valentine RF - Around Me Screenshot">
</p>

---

## Overview

Valentine RF — Around Me is a comprehensive SIGINT platform that provides a unified web interface for software-defined radio tools, wireless reconnaissance, and RF spectrum analysis. The platform integrates 20 scan modes across WiFi, Bluetooth, ADS-B, AIS, Meshtastic, TSCM, and more — all accessible through a glassmorphic dark-mode UI built on the **Obsidian Prism** design system.

The application runs as a Flask server with real-time SSE data streams, Leaflet-based geospatial visualization (5 map instances), Chart.js analytics, and hardware integration for RTL-SDR, HackRF, and Ubertooth devices.

---

## Features

| Category | Capabilities |
|----------|-------------|
| **RF Decoding** | POCSAG/FLEX pager decoding, 433MHz sensor capture (weather, TPMS, IoT), ACARS aircraft datalink |
| **Aircraft** | ADS-B tracking via dump1090, real-time radar map, persistent history (Postgres optional) |
| **Maritime** | AIS ship tracking, VHF DSC distress monitoring |
| **Voice** | DMR/P25/NXDN/D-STAR decoding via dsd-fme with visual synthesizer |
| **Spectrum** | Listening post frequency scanner, WebSDR remote HF listening |
| **Satellite** | NOAA APT / Meteor LRPT weather image decoding, ISS SSTV, pass prediction via TLE |
| **Wireless Recon** | WiFi monitor-mode scanning (aircrack-ng), Bluetooth discovery + tracker detection |
| **TSCM** | Counter-surveillance sweeps, RF baseline comparison, threat-level reporting |
| **Mesh** | Meshtastic LoRa mesh network integration |
| **Geospatial** | 5-layer map view (ADS-B, Meshtastic, Satellites, WebSDR, Trilateration) |
| **Intelligence** | Number stations database, remote distributed agents, offline/air-gapped mode |

---

## Architecture

The platform consists of 35 Flask route blueprints, a 572-line trilateration engine, gpsd integration, and SQLite storage. The frontend uses Jinja2 templates with vanilla JavaScript, Leaflet maps, and Chart.js visualizations — all styled with the Obsidian Prism purple glass theme.

```
valentine.py              ← Main entry point
app.py                    ← Flask app factory
config.py                 ← Configuration and environment variables
routes/                   ← 35 route blueprints (scan, adsb, ais, wifi, bt, tscm, etc.)
templates/                ← 38 Jinja2 HTML templates
static/css/core/          ← Theme variables and glassmorphic styles
static/js/                ← 41 JavaScript modules
utils/                    ← Trilateration engine, safe_path, hardware helpers
data/                     ← OUI database, satellite TLE, TSCM frequency tables
```

A separate **React/TypeScript redesign** is available on the `react-redesign` branch, featuring the same Obsidian Prism theme with shadcn/ui components, resizable panels, and keyboard-first navigation.

---

## Installation

### Local (Debian / Ubuntu / macOS)

```bash
git clone https://github.com/cvalentine99/Around_Me.git
cd Around_Me
./setup.sh
sudo -E venv/bin/python valentine.py
```

### Docker

```bash
git clone https://github.com/cvalentine99/Around_Me.git
cd Around_Me
docker compose --profile basic up -d --build
```

> **Note:** Docker requires privileged mode for USB SDR access. SDR devices are passed through via `/dev/bus/usb`. The container runs as a non-root user with only the necessary Linux capabilities (NET_RAW, NET_ADMIN, SYS_RAWIO).

#### Multi-Architecture Builds (amd64 + arm64)

Cross-compile on an x64 machine and push to a registry. This is much faster than building natively on an RPi.

```bash
# One-time setup on your x64 build machine
docker run --privileged --rm tonistiigi/binfmt --install all
docker buildx create --name valentine-builder --use --bootstrap

# Build and push for both architectures
REGISTRY=ghcr.io/youruser ./build-multiarch.sh --push

# On the RPi5, just pull and run
VALENTINE_IMAGE=ghcr.io/youruser/valentine-rf:latest docker compose --profile basic up -d
```

| Flag | Description |
|------|-------------|
| `--push` | Push to container registry |
| `--load` | Load into local Docker (single platform only) |
| `--arm64-only` | Build arm64 only (for RPi deployment) |
| `--amd64-only` | Build amd64 only |

Environment variables: `REGISTRY`, `IMAGE_NAME`, `IMAGE_TAG`

#### Using a Pre-built Image

```bash
VALENTINE_IMAGE=ghcr.io/youruser/valentine-rf:latest
docker compose --profile basic up -d
```

---

## ADS-B History (Optional)

The ADS-B history feature persists aircraft messages to Postgres for long-term analysis.

```bash
docker compose --profile history up -d
```

| Variable | Default | Description |
|----------|---------|-------------|
| `VALENTINE_ADSB_HISTORY_ENABLED` | `false` | Enable persistent ADS-B history |
| `VALENTINE_ADSB_DB_HOST` | `adsb_db` | Postgres host |
| `VALENTINE_ADSB_DB_PORT` | `5432` | Postgres port |
| `VALENTINE_ADSB_DB_NAME` | `valentine-rf_adsb` | Database name |
| `VALENTINE_ADSB_AUTO_START` | `false` | Auto-start ADS-B tracking on dashboard load |
| `VALENTINE_SHARED_OBSERVER_LOCATION` | `true` | Share observer location across modules |

Then open **/adsb/history** for the reporting dashboard.

---

## Open the Interface

After starting, open **http://localhost:5050** in your browser.

Default credentials: **admin** / **admin**

> On first login, you will be prompted to change your password (enforced by the security hardening layer).

Credentials can be changed via the `ADMIN_USERNAME` and `ADMIN_PASSWORD` variables in `config.py`.

---

## Security Hardening

This release includes 7 priority security fixes:

| Fix | Description |
|-----|-------------|
| **Random Secret Key** | Flask secret key generated via `secrets.token_hex(32)` on first run |
| **Forced Password Change** | Default admin credentials must be changed on first login |
| **Auth Bypass Removal** | All debug/backdoor authentication bypasses removed |
| **Path Traversal Protection** | `utils/safe_path.py` containment for all file operations |
| **RTL-TCP Binding** | Locked to `127.0.0.1` — no external network exposure |
| **Dependency Pinning** | All Python packages pinned to exact versions |
| **Docker Hardening** | Non-root user, dropped capabilities, read-only filesystem where possible |

---

## Hardware Requirements

| Hardware | Purpose | Price |
|----------|---------|-------|
| **RTL-SDR** | Required for all SDR features | ~$25-35 |
| **WiFi adapter** | Must support monitor mode | ~$20-40 |
| **Bluetooth adapter** | Device scanning (usually built-in) | — |
| **GPS** | Any Linux-supported GPS unit | ~$10 |

Most features work with a basic RTL-SDR dongle (RTL2832U + R820T2). Valentine RF supports any device that SoapySDR supports — install the appropriate module for your hardware (e.g., `soapysdr-module-sdrplay` for SDRPlay devices).

> **GPS:** gpsd is required for real-time location. Valentine RF automatically detects gpsd when rendering map views.

---

## Theme: Obsidian Prism

The UI uses the **Obsidian Prism** design system — a glassmorphic dark-mode aesthetic with:

- Deep void background (`#08060e`)
- Frosted purple glass panels with `backdrop-filter: blur`
- Violet accent colors for interactive elements
- Cyan highlights for live/active states
- Space Grotesk + IBM Plex Mono typography
- 200–250ms transition animations

All theme variables are defined in `static/css/core/variables.css`.

---

## React Redesign

A modern React/TypeScript frontend is available on the **`react-redesign`** branch:

```bash
git checkout react-redesign
pnpm install
pnpm dev
```

The React version includes the same Obsidian Prism theme with additional features: resizable panels, keyboard-first command palette (Cmd+K), collapsible detail drawers, and ultrawide monitor optimization. Every screen maps to the same Flask backend routes.

---

## Documentation

- [Usage Guide](docs/USAGE.md) — Detailed instructions for each scan mode
- [Distributed Agents](docs/DISTRIBUTED_AGENTS.md) — Remote sensor node deployment
- [Hardware Guide](docs/HARDWARE.md) — SDR hardware and advanced setup
- [Troubleshooting](docs/TROUBLESHOOTING.md) — Common issues and solutions
- [Security](docs/SECURITY.md) — Network security and best practices

---

## Discord

<p align="center">
  <a href="https://discord.gg/EyeksEJmWE">Join our Discord</a>
</p>

---

## Disclaimer

This project was developed using AI as a coding partner, combining human direction with AI-assisted implementation. The goal: make Software Defined Radio more accessible by providing a clean, unified interface for common SDR tools.

**This software is for educational and authorized testing purposes only.**

- Only use with proper authorization
- Intercepting communications without consent may be illegal
- You are responsible for compliance with applicable laws

---

## License

MIT License — see [LICENSE](LICENSE)

## Author

Created by **smittix** — [GitHub](https://github.com/smittix)

Redesigned by **cvalentine99** — [GitHub](https://github.com/cvalentine99)

## Acknowledgments

[rtl-sdr](https://osmocom.org/projects/rtl-sdr/wiki) |
[multimon-ng](https://github.com/EliasOenal/multimon-ng) |
[rtl_433](https://github.com/merbanan/rtl_433) |
[dump1090](https://github.com/flightaware/dump1090) |
[AIS-catcher](https://github.com/jvde-github/AIS-catcher) |
[acarsdec](https://github.com/TLeconte/acarsdec) |
[aircrack-ng](https://www.aircrack-ng.org/) |
[Leaflet.js](https://leafletjs.com/) |
[SatDump](https://github.com/SatDump/SatDump) |
[Celestrak](https://celestrak.org/) |
[Priyom.org](https://priyom.org/)
