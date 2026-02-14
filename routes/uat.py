"""UAT (978 MHz) ADS-B tracking routes.

Decodes UAT (Universal Access Transceiver) signals on 978 MHz using dump978-fa.
UAT is the US-only ADS-B link used by general aviation below FL180 (18,000 ft).
Aircraft are merged into the existing adsb_aircraft DataStore so they appear
on the same map and SSE stream as 1090 ES targets.

Pipeline: dump978-fa --sdr | uat2json → JSON lines on stdout → parser thread
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time

from quart import Blueprint, jsonify, request

import app as app_module
from config import UAT_ENABLED, UAT_DEFAULT_DEVICE, UAT_DEFAULT_GAIN
from utils.logging import get_logger
from utils.validation import validate_device_index, validate_gain
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

def _parse_uat_aircraft(data: dict) -> dict | None:
    """Parse a single dump978/uat2json JSON object into an aircraft dict.

    Returns an aircraft dict matching the 1090 ES schema, or None if
    the ICAO address is missing.
    """
    icao = (data.get('address') or '').upper()
    if not icao:
        return None

    # Start with existing aircraft data or create new
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

    return aircraft


def _stream_uat_output(process: subprocess.Popen) -> None:
    """Read JSON lines from uat2json stdout and merge into adsb_aircraft.

    Each line from uat2json is a JSON object with fields like:
        address, callsign, altitude, position, velocity, squawk, etc.
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

            aircraft = _parse_uat_aircraft(data)
            if aircraft is None:
                continue

            # Store and enqueue for SSE — same DataStore as 1090 ES
            icao = aircraft['icao']
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
async def check_uat_tools():
    """Check if dump978 tools are installed."""
    return jsonify({
        'enabled': UAT_ENABLED,
        'dump978': find_dump978() is not None,
        'uat2json': find_uat2json() is not None,
    })


@uat_bp.route('/status')
async def uat_status():
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
async def start_uat():
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
    data = await request.get_json(silent=True) or {}
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

    # ── Claim SDR device ──
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
async def stop_uat():
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
            # Close leaked stderr pipes
            if proc.stderr:
                try:
                    proc.stderr.close()
                except Exception:
                    pass
            unregister_process(proc)

    _uat_dump978_process = None
    _uat_json_process = None
