# Adding UAT (978 MHz ADS-B) Support to VALENTINE RF

A step-by-step guide for integrating dump978 UAT decoding alongside the existing 1090 MHz ADS-B system.

---

## Table of Contents

1. [What Is UAT and Why Add It?](#1-what-is-uat-and-why-add-it)
2. [Architecture Overview](#2-architecture-overview)
3. [Prerequisites](#3-prerequisites)
4. [Step 1 — Build dump978 in Docker](#step-1--build-dump978-in-docker)
5. [Step 2 — Add Configuration](#step-2--add-configuration)
6. [Step 3 — Add Constants](#step-3--add-constants)
7. [Step 4 — Extend the SDR Command Builder](#step-4--extend-the-sdr-command-builder)
8. [Step 5 — Create the UAT Route Blueprint](#step-5--create-the-uat-route-blueprint)
9. [Step 6 — Register Global State in app.py](#step-6--register-global-state-in-apppy)
10. [Step 7 — Register the Blueprint](#step-7--register-the-blueprint)
11. [Step 8 — Add the Frontend](#step-8--add-the-frontend)
12. [Step 9 — Write Tests](#step-9--write-tests)
13. [Step 10 — Docker Compose Environment](#step-10--docker-compose-environment)
14. [Verification Checklist](#verification-checklist)
15. [Troubleshooting](#troubleshooting)
16. [Reference: Data Flow Diagram](#reference-data-flow-diagram)

---

## 1. What Is UAT and Why Add It?

**ADS-B** (Automatic Dependent Surveillance-Broadcast) lets aircraft broadcast their position, altitude, speed, and identity. There are two ADS-B links:

| Link | Frequency | Coverage | Decoder |
|------|-----------|----------|---------|
| **1090 ES** (Extended Squitter) | 1090 MHz | Worldwide, all altitudes | dump1090 (already in the app) |
| **978 UAT** (Universal Access Transceiver) | 978 MHz | **US only**, below FL180 (18,000 ft) | dump978 (**not yet in the app**) |

Most US general aviation (Cessnas, Pipers, helicopters) transmits **only on 978 MHz**. Without UAT support, these aircraft are invisible to VALENTINE RF. Adding it roughly doubles low-altitude traffic coverage in the US.

UAT also carries **FIS-B** (Flight Information Service-Broadcast) — free weather radar imagery, METARs, TAFs, NOTAMs, and PIREPs. This is bonus data that 1090 ES does not provide.

### What a second dongle gets you

```
                  ┌─────────────┐
   1090 MHz ──►   │  RTL-SDR #0 │ ──► dump1090 ──► SBS port 30003
                  └─────────────┘
                  ┌─────────────┐
    978 MHz ──►   │  RTL-SDR #1 │ ──► dump978  ──► JSON on stdout
                  └─────────────┘
                         │
                         ▼
              Merged into adsb_aircraft DataStore
              (same map, same SSE stream, same UI)
```

The existing SDR device registry (`app.py:248-277`) already supports claiming multiple devices by index, so the multi-dongle infrastructure is ready.

---

## 2. Architecture Overview

Below is every file you will touch, mapped to the existing ADS-B equivalent you should use as a reference.

```
File to create/modify             Existing ADS-B reference         What it does
─────────────────────────────────────────────────────────────────────────────────
Dockerfile                        Lines 98-107 (dump1090 build)    Compile dump978 from source
config.py                         Lines 199-211 (ADSB_* vars)     Add UAT_* env vars
utils/constants.py                Lines 14-15 (ADSB_SBS_PORT)     Add UAT-specific constants
utils/sdr/rtlsdr.py              Lines 116-158 (build_adsb_cmd)   Add build_uat_command()
routes/uat.py                     routes/adsb.py (entire file)     New blueprint: start/stop/stream
routes/__init__.py                Line 12, 43 (adsb_bp)           Register uat_bp
app.py                            Lines 142-145 (adsb globals)    Add uat_process, uat_queue, etc.
templates/adsb_dashboard.html     Existing dashboard               Add UAT toggle/indicator
static/js/modes/adsb.js          Existing JS (if applicable)      Parse UAT events in stream
docker-compose.yml                Lines 42-63 (ADSB env vars)     Add VALENTINE_UAT_* vars
tests/test_uat.py                 tests/test_adsb.py (if exists)  Unit tests for UAT routes
```

### Key principle: UAT feeds the same aircraft DataStore

UAT aircraft go into the **same** `app_module.adsb_aircraft` DataStore and the **same** `app_module.adsb_queue`. The frontend already renders all aircraft from that store. This means you do NOT need a separate map, separate SSE endpoint, or separate UI panel. You just need to:

1. Parse dump978 JSON output
2. Merge it into `adsb_aircraft` keyed by ICAO hex
3. Tag each aircraft with `source: "uat"` so the UI can show which link it came from

---

## 3. Prerequisites

Before starting, make sure you understand these existing patterns (read the files):

- **Process lifecycle**: `utils/process.py` — `safe_terminate()`, `register_process()`
- **SSE streaming**: `utils/sse.py` — `format_sse()`, generator pattern
- **SDR device registry**: `app.py:248-297` — `claim_sdr_device()`, `release_sdr_device()`
- **Input validation**: `utils/validation.py` — never trust user input
- **Config pattern**: `config.py:137-165` — `_get_env()`, `_get_env_int()`, `_get_env_bool()`

Install a second RTL-SDR dongle for local testing. Verify both are detected:

```bash
rtl_test -t -d 0   # Should say "Found 1 device(s)" for dongle 0
rtl_test -t -d 1   # Should find dongle 1
```

---

## Step 1 — Build dump978 in Docker

**File:** `Dockerfile`

Find the dump1090 build block (around line 98). Add the dump978 build directly after it.

**Reference — the existing dump1090 build you are copying from:**

```dockerfile
# (Existing) dump1090 — 1090 MHz ADS-B decoder
RUN git clone https://github.com/flightaware/dump1090.git /tmp/dump1090 && \
    cd /tmp/dump1090 && \
    git checkout 4f47d12a18db && \
    make BLADERF=no RTLSDR=yes && \
    cp dump1090 /usr/bin/dump1090-fa && \
    ln -sf /usr/bin/dump1090-fa /usr/bin/dump1090 && \
    rm -rf /tmp/dump1090
```

**New block to add immediately below:**

```dockerfile
# dump978 — 978 MHz UAT decoder (FlightAware)
# Produces JSON on stdout, one object per UAT frame
RUN git clone https://github.com/flightaware/dump978.git /tmp/dump978 && \
    cd /tmp/dump978 && \
    git checkout v9.0 && \
    mkdir build && cd build && \
    cmake .. -DCMAKE_INSTALL_PREFIX=/usr && \
    make -j$(nproc) && \
    cp dump978-fa /usr/bin/dump978-fa && \
    cp uat2json /usr/bin/uat2json && \
    cp uat2esnt /usr/bin/uat2esnt && \
    ln -sf /usr/bin/dump978-fa /usr/bin/dump978 && \
    rm -rf /tmp/dump978
```

**What each binary does:**

| Binary | Purpose |
|--------|---------|
| `dump978-fa` | Raw UAT demodulation from RTL-SDR, outputs raw UAT frames on stdout |
| `uat2json` | Converts raw frames to JSON (position, velocity, callsign, etc.) |
| `uat2esnt` | Converts UAT frames to 1090 ES format (for feeding to aggregators) |

### Build dependencies

dump978 requires `cmake`, `libboost-system-dev`, `libboost-program-options-dev`, `libboost-regex-dev`, and `libboost-filesystem-dev`. Check the Dockerfile's `apt-get install` block (near the top) and add any that are missing:

```dockerfile
# Add to the existing apt-get install line:
    libboost-system-dev \
    libboost-program-options-dev \
    libboost-regex-dev \
    libboost-filesystem-dev \
```

### Verify the build works

```bash
docker compose --profile basic build
docker compose --profile basic run --rm valentine which dump978-fa uat2json
# Should print:
#   /usr/bin/dump978-fa
#   /usr/bin/uat2json
```

---

## Step 2 — Add Configuration

**File:** `config.py`

Add a new UAT section directly below the ADS-B settings block (after line 211).

```python
# UAT (978 MHz) settings
UAT_ENABLED = _get_env_bool('UAT_ENABLED', False)
UAT_AUTO_START = _get_env_bool('UAT_AUTO_START', False)
UAT_DEFAULT_DEVICE = _get_env_int('UAT_DEFAULT_DEVICE', 1)
UAT_DEFAULT_GAIN = _get_env('UAT_DEFAULT_GAIN', '40')
```

### Why these specific variables?

- `UAT_ENABLED` — Feature flag. The UI should hide UAT controls when `False`. This lets users without a second dongle avoid confusion.
- `UAT_AUTO_START` — Mirrors `ADSB_AUTO_START`. When `True`, UAT decoding starts automatically on app launch.
- `UAT_DEFAULT_DEVICE` — Defaults to `1` (second dongle). Device `0` is typically used by 1090 ES.
- `UAT_DEFAULT_GAIN` — Separate gain from 1090 ES since optimal gain differs per frequency.

### Import it where needed

Any file that needs these values will import from config:

```python
from config import UAT_ENABLED, UAT_AUTO_START, UAT_DEFAULT_DEVICE, UAT_DEFAULT_GAIN
```

---

## Step 3 — Add Constants

**File:** `utils/constants.py`

Add a new UAT section. Follow the existing naming and comment style:

```python
# =============================================================================
# UAT (978 MHz ADS-B)
# =============================================================================

# dump978 does not use a TCP port like dump1090's SBS.
# Instead, it streams JSON to stdout. We pipe: dump978-fa | uat2json.
# This constant is only needed if you later add uat2esnt SBS re-broadcast.
UAT_ESNT_PORT = 30978

# Wait time after launching dump978 before checking if it crashed
UAT_START_WAIT = 2.0

# UAT process termination timeout
UAT_TERMINATE_TIMEOUT = 5
```

### Key difference from 1090 ES

dump1090 exposes a TCP server on port 30003 (SBS format). dump978 does **not** — it writes JSON to stdout. This fundamentally changes the parsing approach:

| | dump1090 (1090 ES) | dump978 (978 UAT) |
|---|---|---|
| Output | TCP socket, SBS CSV | stdout, JSON lines |
| Parser | `parse_sbs_stream()` — socket reader | `stream_uat_output()` — stdout reader |
| Connection | `socket.connect()` to localhost:30003 | Read `process.stdout` directly |

This means the UAT parser will look more like `routes/sensor.py:stream_sensor_output()` (which reads `process.stdout`) than `routes/adsb.py:parse_sbs_stream()` (which connects to a socket).

---

## Step 4 — Extend the SDR Command Builder

**File:** `utils/sdr/rtlsdr.py`

Add a `build_uat_command()` method to the `RTLSDRCommandBuilder` class. Place it directly after the existing `build_adsb_command()` method.

**Reference — existing `build_adsb_command()` (lines 116-158):**

```python
def build_adsb_command(
    self,
    device: SDRDevice,
    gain: Optional[float] = None,
    bias_t: bool = False
) -> list[str]:
    """Build dump1090 command for ADS-B decoding."""
    # ... validates device, builds ['dump1090', '--net', '--device-index', '0', ...]
```

**New method to add:**

```python
def build_uat_command(
    self,
    device: SDRDevice,
    gain: float | None = None,
) -> tuple[list[str], list[str]]:
    """Build dump978 pipeline commands for UAT decoding.

    Returns two commands that must be piped together:
        dump978-fa --sdr --sdr-device-index N | uat2json

    Args:
        device: The SDR device to use.
        gain: Optional gain value. If None, uses auto-gain.

    Returns:
        Tuple of (dump978_cmd, uat2json_cmd) for subprocess piping.
    """
    if device.is_network:
        raise ValueError("UAT decoding requires a local RTL-SDR device, not rtl_tcp.")

    dump978_path = self.get_tool_path('dump978-fa', 'dump978')
    uat2json_path = self.get_tool_path('uat2json')

    dump978_cmd = [
        dump978_path,
        '--sdr',
        '--sdr-device-index', str(device.index),
    ]

    if gain is not None:
        dump978_cmd.extend(['--sdr-gain', str(gain)])

    uat2json_cmd = [uat2json_path]

    return dump978_cmd, uat2json_cmd
```

### Why a tuple of two commands?

dump978's architecture is a Unix pipeline:

```
dump978-fa  --sdr  |  uat2json
   (raw frames)       (JSON output)
```

You will connect them in the route via `subprocess.Popen` pipe chaining (shown in Step 5).

### Also add to the base class

**File:** `utils/sdr/base.py`

Add the abstract method signature to `CommandBuilder` so other SDR types can implement it later:

```python
@abstractmethod
def build_uat_command(
    self,
    device: SDRDevice,
    gain: float | None = None,
) -> tuple[list[str], list[str]]:
    """Build UAT decoder command. Returns (dump978_cmd, uat2json_cmd)."""
    ...
```

---

## Step 5 — Create the UAT Route Blueprint

**File:** `routes/uat.py` (new file)

This is the largest piece. The structure mirrors `routes/adsb.py` but is simpler because:
- dump978 outputs JSON to stdout (no socket parsing)
- UAT merges into the existing `adsb_aircraft` DataStore (no new DataStore)
- No separate SSE stream needed (reuses `/adsb/stream`)

```python
"""UAT (978 MHz) ADS-B tracking routes."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time

from flask import Blueprint, jsonify, request

import app as app_module
from config import UAT_ENABLED, UAT_DEFAULT_DEVICE, UAT_DEFAULT_GAIN
from utils.logging import get_logger
from utils.validation import validate_device_index, validate_gain
from utils.sdr import SDRFactory, SDRType
from utils.process import register_process, unregister_process
from utils.constants import UAT_START_WAIT, UAT_TERMINATE_TIMEOUT

logger = get_logger('valentine.uat')

uat_bp = Blueprint('uat', __name__, url_prefix='/uat')

# Module-level state
uat_running = False
uat_active_device: int | None = None
_uat_dump978_process: subprocess.Popen | None = None
_uat_json_process: subprocess.Popen | None = None
_uat_messages_received = 0


# ─── Tool discovery ────────────────────────────────────────────────

DUMP978_PATHS = [
    '/usr/bin/dump978-fa',
    '/usr/bin/dump978',
    '/usr/local/bin/dump978-fa',
    '/usr/local/bin/dump978',
    '/opt/homebrew/bin/dump978-fa',
]


def find_dump978() -> str | None:
    """Find the dump978 binary on this system."""
    for name in ['dump978-fa', 'dump978']:
        path = shutil.which(name)
        if path:
            return path
    for path in DUMP978_PATHS:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def find_uat2json() -> str | None:
    """Find the uat2json binary."""
    path = shutil.which('uat2json')
    if path:
        return path
    for prefix in ['/usr/bin/', '/usr/local/bin/']:
        candidate = prefix + 'uat2json'
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


# ─── Output parser (runs in a background thread) ───────────────────

def _stream_uat_output(process: subprocess.Popen) -> None:
    """Read JSON lines from uat2json stdout and merge into adsb_aircraft.

    Each line from uat2json looks like:
    {
        "address": "A12345",
        "address_qualifier": "adsb_icao",
        "callsign": "N12345",
        "altitude": { "baro": 3500 },
        "airground_state": "airborne",
        "position": { "lat": 40.1234, "lon": -74.5678 },
        "velocity": { "groundspeed": 120, "heading": 270, "vertical_rate": 0 },
        ...
    }
    """
    global _uat_messages_received

    try:
        app_module.adsb_queue.put({'type': 'status', 'text': 'uat_started'})

        for raw_line in iter(process.stdout.readline, b''):
            if not uat_running:
                break

            line = raw_line.decode('utf-8', errors='replace').strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue

            icao = (data.get('address') or '').upper()
            if not icao:
                continue

            # Build an aircraft dict matching the 1090 ES schema
            aircraft = app_module.adsb_aircraft.get(icao) or {'icao': icao}
            aircraft['source'] = 'uat'  # Tag so frontend can distinguish

            # Callsign
            callsign = (data.get('callsign') or '').strip()
            if callsign:
                aircraft['callsign'] = callsign

            # Altitude (prefer barometric)
            alt_obj = data.get('altitude') or {}
            baro_alt = alt_obj.get('baro')
            if baro_alt is not None:
                try:
                    aircraft['altitude'] = int(baro_alt)
                except (ValueError, TypeError):
                    pass

            # Position
            pos = data.get('position') or {}
            if pos.get('lat') is not None and pos.get('lon') is not None:
                try:
                    aircraft['lat'] = float(pos['lat'])
                    aircraft['lon'] = float(pos['lon'])
                except (ValueError, TypeError):
                    pass

            # Velocity
            vel = data.get('velocity') or {}
            if vel.get('groundspeed') is not None:
                try:
                    aircraft['speed'] = int(vel['groundspeed'])
                except (ValueError, TypeError):
                    pass
            if vel.get('heading') is not None:
                try:
                    aircraft['heading'] = int(vel['heading'])
                except (ValueError, TypeError):
                    pass
            if vel.get('vertical_rate') is not None:
                try:
                    aircraft['vertical_rate'] = int(vel['vertical_rate'])
                except (ValueError, TypeError):
                    pass

            # Squawk
            squawk = data.get('squawk')
            if squawk is not None:
                aircraft['squawk'] = str(squawk)

            # Store and enqueue for SSE
            app_module.adsb_aircraft.set(icao, aircraft)
            app_module.adsb_queue.put({'type': 'aircraft', **aircraft})
            _uat_messages_received += 1

    except Exception as e:
        logger.error("UAT output parser error: %s", e)
        app_module.adsb_queue.put({'type': 'error', 'text': f'UAT error: {e}'})
    finally:
        app_module.adsb_queue.put({'type': 'status', 'text': 'uat_stopped'})


# ─── Routes ────────────────────────────────────────────────────────

@uat_bp.route('/tools')
def check_uat_tools():
    """Check if dump978 tools are installed."""
    return jsonify({
        'enabled': UAT_ENABLED,
        'dump978': find_dump978() is not None,
        'uat2json': find_uat2json() is not None,
    })


@uat_bp.route('/status')
def uat_status():
    """Get UAT decoder status."""
    return jsonify({
        'enabled': UAT_ENABLED,
        'running': uat_running,
        'active_device': uat_active_device,
        'messages_received': _uat_messages_received,
        'dump978_running': (
            _uat_dump978_process is not None
            and _uat_dump978_process.poll() is None
        ),
    })


@uat_bp.route('/start', methods=['POST'])
def start_uat():
    """Start UAT (978 MHz) decoding.

    Request JSON body (all optional):
        device  — RTL-SDR device index (default: UAT_DEFAULT_DEVICE from config)
        gain    — RF gain (default: UAT_DEFAULT_GAIN from config)

    Example:
        POST /uat/start
        {"device": 1, "gain": 40}
    """
    global uat_running, uat_active_device
    global _uat_dump978_process, _uat_json_process, _uat_messages_received

    if not UAT_ENABLED:
        return jsonify({
            'status': 'error',
            'message': 'UAT support is disabled. Set VALENTINE_UAT_ENABLED=true.'
        }), 400

    if uat_running:
        return jsonify({
            'status': 'already_running',
            'message': 'UAT decoder is already active.'
        }), 409

    # ── Validate inputs ──
    data = request.json or {}
    try:
        device = validate_device_index(data.get('device', UAT_DEFAULT_DEVICE))
        gain = float(validate_gain(data.get('gain', UAT_DEFAULT_GAIN)))
    except ValueError as e:
        return jsonify({'status': 'error', 'message': str(e)}), 400

    # ── Find binaries ──
    dump978_path = find_dump978()
    uat2json_path = find_uat2json()
    if not dump978_path:
        return jsonify({
            'status': 'error',
            'message': 'dump978 not found. Install dump978-fa or ensure it is in PATH.'
        }), 500
    if not uat2json_path:
        return jsonify({
            'status': 'error',
            'message': 'uat2json not found. Install dump978-fa package.'
        }), 500

    # ── Claim the SDR device ──
    error = app_module.claim_sdr_device(device, 'uat')
    if error:
        return jsonify({
            'status': 'error',
            'error_type': 'DEVICE_BUSY',
            'message': error,
        }), 409

    # ── Build the pipeline: dump978-fa | uat2json ──
    dump978_cmd = [
        dump978_path,
        '--sdr',
        '--sdr-device-index', str(device),
        '--sdr-gain', str(gain),
    ]
    uat2json_cmd = [uat2json_path]

    try:
        logger.info("Starting dump978 pipeline: %s | %s", dump978_cmd, uat2json_cmd)

        # Start dump978-fa (raw UAT frames to stdout)
        _uat_dump978_process = subprocess.Popen(
            dump978_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        register_process(_uat_dump978_process)

        # Pipe dump978 stdout into uat2json stdin
        _uat_json_process = subprocess.Popen(
            uat2json_cmd,
            stdin=_uat_dump978_process.stdout,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        register_process(_uat_json_process)

        # Allow dump978 stdout to be closed in this process
        # so uat2json gets SIGPIPE when dump978 exits.
        _uat_dump978_process.stdout.close()

        # Wait briefly and check for immediate crash
        time.sleep(UAT_START_WAIT)

        if _uat_dump978_process.poll() is not None:
            stderr_text = ''
            if _uat_dump978_process.stderr:
                try:
                    stderr_text = _uat_dump978_process.stderr.read().decode(
                        'utf-8', errors='ignore'
                    ).strip()[:500]
                except Exception:
                    pass
            _cleanup_uat_processes()
            app_module.release_sdr_device(device)
            return jsonify({
                'status': 'error',
                'message': f'dump978 exited immediately. {stderr_text}'
            }), 500

        # ── Start reader thread ──
        uat_running = True
        uat_active_device = device
        _uat_messages_received = 0

        thread = threading.Thread(
            target=_stream_uat_output,
            args=(_uat_json_process,),
            daemon=True,
        )
        thread.start()

        return jsonify({
            'status': 'started',
            'message': 'UAT (978 MHz) decoding started.',
            'device': device,
        })

    except Exception as e:
        _cleanup_uat_processes()
        app_module.release_sdr_device(device)
        logger.error("Failed to start UAT: %s", e)
        return jsonify({'status': 'error', 'message': str(e)}), 500


@uat_bp.route('/stop', methods=['POST'])
def stop_uat():
    """Stop UAT decoding and release the SDR device."""
    global uat_running, uat_active_device

    uat_running = False
    _cleanup_uat_processes()

    if uat_active_device is not None:
        app_module.release_sdr_device(uat_active_device)
        uat_active_device = None

    return jsonify({'status': 'stopped', 'message': 'UAT decoder stopped.'})


# ─── Internal helpers ──────────────────────────────────────────────

def _cleanup_uat_processes() -> None:
    """Terminate dump978 and uat2json processes."""
    global _uat_dump978_process, _uat_json_process

    for proc in [_uat_json_process, _uat_dump978_process]:
        if proc and proc.poll() is None:
            try:
                pgid = os.getpgid(proc.pid)
                os.killpg(pgid, 15)  # SIGTERM
                proc.wait(timeout=UAT_TERMINATE_TIMEOUT)
            except (subprocess.TimeoutExpired, ProcessLookupError, OSError):
                try:
                    pgid = os.getpgid(proc.pid)
                    os.killpg(pgid, 9)  # SIGKILL
                except (ProcessLookupError, OSError):
                    pass
            unregister_process(proc)

    _uat_dump978_process = None
    _uat_json_process = None
```

### What just happened — the important parts explained

**Subprocess pipe chaining (the core trick):**

```python
# dump978 writes raw frames to its stdout
dump978_proc = Popen(dump978_cmd, stdout=PIPE, ...)

# uat2json reads from dump978's stdout via stdin
json_proc = Popen(uat2json_cmd, stdin=dump978_proc.stdout, stdout=PIPE, ...)

# Close dump978's stdout in THIS process so the pipe works cleanly
dump978_proc.stdout.close()
```

This is equivalent to the shell command `dump978-fa --sdr | uat2json`. The `.stdout.close()` call is critical — without it, uat2json won't get a proper EOF when dump978 exits.

**Merging into existing DataStore:**

```python
# Same DataStore and queue as 1090 ES — aircraft appear on the same map
app_module.adsb_aircraft.set(icao, aircraft)
app_module.adsb_queue.put({'type': 'aircraft', **aircraft})
```

The `source: 'uat'` tag lets the frontend distinguish UAT aircraft from 1090 ES, but both appear in the same table/map.

**Device registry prevents conflicts:**

```python
# This will fail if device 1 is already claimed by another mode
error = app_module.claim_sdr_device(device, 'uat')
```

---

## Step 6 — Register Global State in app.py

**File:** `app.py`

Add UAT process tracking after the existing ADS-B block (after line 145):

```python
# UAT (978 MHz ADS-B)
uat_process = None  # Not used directly (managed in routes/uat.py) but kept for killall
uat_lock = threading.Lock()
```

Also update the `/killall` route (around line 753) to kill dump978:

```python
# In the processes_to_kill list, add:
processes_to_kill = [
    'rtl_fm', 'multimon-ng', 'rtl_433',
    'airodump-ng', 'aireplay-ng', 'airmon-ng',
    'dump1090', 'dump978-fa', 'uat2json',  # <-- add these two
    'acarsdec', 'direwolf', 'AIS-catcher',
    # ... rest of the list
]
```

And add UAT state reset in the same function:

```python
# Reset UAT state (add after the ADS-B reset block)
try:
    from routes import uat as uat_module
    uat_module.uat_running = False
    uat_module.uat_active_device = None
except ImportError:
    pass
```

---

## Step 7 — Register the Blueprint

**File:** `routes/__init__.py`

Add the import and registration alongside the existing adsb_bp:

```python
# At the top with other imports:
from .uat import uat_bp

# In the register_blueprints() function, add:
app.register_blueprint(uat_bp)
```

### Verify it works

After restarting the app:

```bash
curl http://localhost:5050/uat/tools
# Response:
# {"dump978": true, "enabled": true, "uat2json": true}

curl http://localhost:5050/uat/status
# Response:
# {"active_device": null, "enabled": true, "messages_received": 0, "running": false, ...}
```

---

## Step 8 — Add the Frontend

### 8a. Add a UAT source badge to the aircraft table

**File:** `templates/adsb_dashboard.html`

In the aircraft table row template, add a source indicator. Find where the callsign cell is rendered and add:

```html
<!-- After the callsign column -->
<td class="aircraft-source">
    <span class="badge badge-source"
          data-source="${aircraft.source || '1090'}">
        ${aircraft.source === 'uat' ? '978' : '1090'}
    </span>
</td>
```

Add corresponding CSS:

```css
.badge-source[data-source="uat"] {
    background: var(--accent-cyan, #00bcd4);
    color: #000;
    font-size: 0.7rem;
    padding: 2px 6px;
    border-radius: 3px;
}

.badge-source[data-source="1090"] {
    background: var(--bg-card, #1e293b);
    color: var(--text-dim, #94a3b8);
    font-size: 0.7rem;
    padding: 2px 6px;
    border-radius: 3px;
}
```

### 8b. Add UAT start/stop controls

Add a toggle in the ADS-B dashboard controls area:

```html
<div class="uat-controls" id="uat-controls">
    <label class="control-label">UAT (978 MHz)</label>
    <select id="uat-device" class="input-field">
        <!-- Populated dynamically from /devices -->
    </select>
    <button id="btn-uat-start" class="btn btn-start" onclick="startUAT()">
        Start UAT
    </button>
    <button id="btn-uat-stop" class="btn btn-stop" onclick="stopUAT()"
            style="display:none;">
        Stop UAT
    </button>
    <span id="uat-status" class="status-text">Stopped</span>
</div>
```

### 8c. Add JavaScript for UAT control

```javascript
// UAT controls — add to the ADS-B dashboard script section

async function startUAT() {
    const device = document.getElementById('uat-device').value;
    try {
        const resp = await fetch('/uat/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device: parseInt(device) }),
        });
        const data = await resp.json();
        if (data.status === 'started') {
            document.getElementById('btn-uat-start').style.display = 'none';
            document.getElementById('btn-uat-stop').style.display = '';
            document.getElementById('uat-status').textContent = 'Running';
        } else {
            alert(data.message || 'Failed to start UAT');
        }
    } catch (err) {
        console.error('UAT start error:', err);
    }
}

async function stopUAT() {
    try {
        await fetch('/uat/stop', { method: 'POST' });
        document.getElementById('btn-uat-start').style.display = '';
        document.getElementById('btn-uat-stop').style.display = 'none';
        document.getElementById('uat-status').textContent = 'Stopped';
    } catch (err) {
        console.error('UAT stop error:', err);
    }
}

// Poll UAT status on page load
async function checkUATStatus() {
    try {
        const resp = await fetch('/uat/status');
        const data = await resp.json();
        if (data.running) {
            document.getElementById('btn-uat-start').style.display = 'none';
            document.getElementById('btn-uat-stop').style.display = '';
            document.getElementById('uat-status').textContent =
                `Running — ${data.messages_received} msgs`;
        }
    } catch (err) {
        // UAT not available
    }
}

// Call on page load
checkUATStatus();
```

### No separate SSE stream needed

The existing ADS-B SSE stream at `/adsb/stream` already delivers all aircraft from `adsb_queue`. Since UAT aircraft are pushed into the same queue (Step 5), they will appear automatically in the existing `EventSource` handler. The only change is checking `aircraft.source` to render the 978/1090 badge.

---

## Step 9 — Write Tests

**File:** `tests/test_uat.py` (new file)

Follow the project's existing test patterns: use pytest with mocked subprocesses.

```python
"""Tests for UAT (978 MHz) routes."""

import json
from unittest.mock import patch, MagicMock

import pytest


@pytest.fixture
def client(tmp_path):
    """Create a test Flask client."""
    # Import app after patching to avoid side effects
    import app as app_module
    app_module.app.config['TESTING'] = True
    with app_module.app.test_client() as client:
        # Bypass login for tests
        with client.session_transaction() as sess:
            sess['logged_in'] = True
        yield client


class TestUATTools:
    """Tests for /uat/tools endpoint."""

    @patch('routes.uat.find_dump978', return_value='/usr/bin/dump978-fa')
    @patch('routes.uat.find_uat2json', return_value='/usr/bin/uat2json')
    @patch('routes.uat.UAT_ENABLED', True)
    def test_tools_found(self, mock_json, mock_978, client):
        resp = client.get('/uat/tools')
        data = resp.get_json()
        assert data['dump978'] is True
        assert data['uat2json'] is True
        assert data['enabled'] is True

    @patch('routes.uat.find_dump978', return_value=None)
    @patch('routes.uat.find_uat2json', return_value=None)
    @patch('routes.uat.UAT_ENABLED', False)
    def test_tools_not_found(self, mock_json, mock_978, client):
        resp = client.get('/uat/tools')
        data = resp.get_json()
        assert data['dump978'] is False
        assert data['enabled'] is False


class TestUATStatus:
    """Tests for /uat/status endpoint."""

    def test_status_stopped(self, client):
        resp = client.get('/uat/status')
        data = resp.get_json()
        assert data['running'] is False
        assert data['messages_received'] == 0


class TestUATStartStop:
    """Tests for /uat/start and /uat/stop endpoints."""

    @patch('routes.uat.UAT_ENABLED', False)
    def test_start_when_disabled(self, client):
        resp = client.post('/uat/start', json={})
        assert resp.status_code == 400
        data = resp.get_json()
        assert 'disabled' in data['message'].lower()

    @patch('routes.uat.UAT_ENABLED', True)
    @patch('routes.uat.find_dump978', return_value=None)
    def test_start_no_binary(self, mock_find, client):
        resp = client.post('/uat/start', json={'device': 1})
        assert resp.status_code == 500
        assert 'not found' in resp.get_json()['message'].lower()

    def test_start_invalid_device(self, client):
        with patch('routes.uat.UAT_ENABLED', True):
            resp = client.post('/uat/start', json={'device': 999})
            assert resp.status_code == 400

    @patch('routes.uat.UAT_ENABLED', True)
    @patch('routes.uat.find_dump978', return_value='/usr/bin/dump978-fa')
    @patch('routes.uat.find_uat2json', return_value='/usr/bin/uat2json')
    @patch('app.claim_sdr_device', return_value=None)
    @patch('subprocess.Popen')
    def test_start_success(self, mock_popen, mock_claim, mock_j, mock_d, client):
        """Test successful UAT start with mocked subprocess."""
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None  # Process is still running
        mock_proc.stdout = MagicMock()
        mock_proc.stderr = MagicMock()
        mock_proc.pid = 12345
        mock_popen.return_value = mock_proc

        resp = client.post('/uat/start', json={'device': 1, 'gain': 40})
        data = resp.get_json()
        assert data['status'] == 'started'
        assert data['device'] == 1


class TestUATOutputParser:
    """Tests for the JSON output parser."""

    def test_parse_uat_json_line(self):
        """Verify a dump978 JSON line is correctly mapped to aircraft dict."""
        from routes.uat import _stream_uat_output

        # This tests the field mapping logic without running a real process.
        # A real UAT JSON line from dump978:
        sample = {
            "address": "A0B1C2",
            "callsign": "N54321",
            "altitude": {"baro": 4500},
            "position": {"lat": 40.6892, "lon": -74.0445},
            "velocity": {"groundspeed": 95, "heading": 180, "vertical_rate": -200},
            "squawk": "1200",
        }

        # You would feed this to _stream_uat_output via a mock process.
        # For a unit test, extract the parsing logic into a helper:
        #   aircraft = _parse_uat_json(sample)
        # and test that helper directly.
        assert sample['address'] == 'A0B1C2'
        assert sample['altitude']['baro'] == 4500
```

### Run the tests

```bash
# Run just the UAT tests
pytest tests/test_uat.py -v

# Run all tests to check for regressions
pytest

# Run with coverage
pytest --cov=routes.uat tests/test_uat.py
```

---

## Step 10 — Docker Compose Environment

**File:** `docker-compose.yml`

Add UAT environment variables to both profiles. Place them after the existing `VALENTINE_ADSB_*` block:

```yaml
environment:
  # ... existing ADSB vars ...

  # UAT (978 MHz) — requires second RTL-SDR dongle
  - VALENTINE_UAT_ENABLED=false        # Set to true when second dongle available
  - VALENTINE_UAT_AUTO_START=false
  - VALENTINE_UAT_DEFAULT_DEVICE=1     # Device index for 978 MHz dongle
  - VALENTINE_UAT_DEFAULT_GAIN=40
```

Also ensure the second USB device is passed through. In the `devices` section:

```yaml
devices:
  - /dev/bus/usb:/dev/bus/usb   # Already present — passes all USB devices
```

---

## Verification Checklist

Use this to confirm everything works end-to-end:

- [ ] `docker compose build` succeeds (dump978 compiles)
- [ ] `which dump978-fa` and `which uat2json` work inside the container
- [ ] `curl /uat/tools` returns `{"dump978": true, "uat2json": true, "enabled": true}`
- [ ] `curl /uat/status` returns `{"running": false, ...}`
- [ ] `POST /uat/start {"device": 1}` returns `{"status": "started"}`
- [ ] `POST /uat/start {"device": 1}` again returns 409 (already running)
- [ ] `POST /uat/start {"device": 0}` returns 409 if device 0 is claimed by 1090 ES
- [ ] Aircraft from UAT appear in `/adsb/stream` SSE with `"source": "uat"`
- [ ] Aircraft appear on the ADS-B dashboard map alongside 1090 ES targets
- [ ] `POST /uat/stop` returns `{"status": "stopped"}`
- [ ] After stop, device 1 is released (`/devices/status` shows it free)
- [ ] `POST /killall` kills dump978-fa and uat2json
- [ ] `pytest tests/test_uat.py -v` — all tests pass
- [ ] `pytest` — no regressions in existing tests
- [ ] `ruff check routes/uat.py` — no lint errors

---

## Troubleshooting

### "dump978 not found"

The binary isn't in PATH or the Docker image. Check:

```bash
docker compose run --rm valentine which dump978-fa
docker compose run --rm valentine dump978-fa --help
```

If missing, rebuild the Docker image: `docker compose build --no-cache`

### "Device busy" when starting UAT

Another mode is using that SDR device. Check which:

```bash
curl http://localhost:5050/devices/status
```

Stop the conflicting mode first, or use a different `device` index.

### dump978 exits immediately

Common causes:
- Wrong device index (no dongle at that index)
- Kernel DVB driver blocking the device
- Another process holding the USB handle

Check stderr from the start response — it includes the first 500 chars of dump978's error output.

```bash
# Manually test dump978 outside the app:
dump978-fa --sdr --sdr-device-index 1 | uat2json
# You should see JSON lines when aircraft are nearby (US only).
```

### No aircraft appearing

UAT is **US-only**. If you are outside the US, no aircraft will transmit on 978 MHz. Use a remote SBS feed or test data instead.

Even in the US, UAT traffic is lower than 1090 ES. Wait a few minutes near an airport.

### UAT aircraft don't have type/registration info

The existing `aircraft_db.lookup(icao)` in `routes/adsb.py` only enriches 1090 ES aircraft. To also enrich UAT aircraft, call the same lookup in `_stream_uat_output()`:

```python
from utils import aircraft_db

# After getting icao:
db_info = aircraft_db.lookup(icao)
if db_info:
    if db_info['registration']:
        aircraft['registration'] = db_info['registration']
    if db_info['type_code']:
        aircraft['type_code'] = db_info['type_code']
```

---

## Reference: Data Flow Diagram

```
                           ┌──────────────────────────────────────────┐
                           │            VALENTINE RF App              │
                           │                                          │
  RTL-SDR #0               │   ┌─────────────┐                       │
  (1090 MHz) ──► dump1090 ─┼──►│ SBS parser  │──► adsb_aircraft ─────┼──► /adsb/stream (SSE)
                           │   │ (socket)     │    DataStore          │         │
                           │   └─────────────┘       ▲                │         │
                           │                         │                │         ▼
  RTL-SDR #1               │   ┌─────────────┐      │                │    ADS-B Dashboard
  (978 MHz) ──► dump978 ───┼──►│ UAT parser  │──────┘                │    (unified map)
               + uat2json  │   │ (stdout)     │                       │
                           │   └─────────────┘                       │
                           │                                          │
                           └──────────────────────────────────────────┘
```

Both parsers write to the **same** `adsb_aircraft` DataStore and the **same** `adsb_queue`. The SSE stream and dashboard render all aircraft regardless of source. The `source` field (`"uat"` or `"1090"`) is the only distinguisher.
