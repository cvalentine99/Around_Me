"""UAT (978 MHz) ADS-B tracking routes.

Decodes UAT (Universal Access Transceiver) signals on 978 MHz using dump978-fa.
UAT is the US-only ADS-B link used by general aviation below FL180 (18,000 ft).
Aircraft are merged into the existing adsb_aircraft DataStore so they appear
on the same map and SSE stream as 1090 ES targets.

Pipeline: dump978-fa --sdr | uat2json → JSON lines on stdout → parser thread
"""

from __future__ import annotations

import asyncio
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
from utils.sdr.registry import normalize_sdr_type
from utils.async_lock import async_thread_lock
from utils.async_process import async_popen, finish_in_thread

logger = get_logger('valentine.uat')

uat_bp = Blueprint('uat', __name__, url_prefix='/uat')

# Serializes start, stop and the reader thread's own cleanup.
uat_lock = threading.Lock()

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
            if not uat_running or _uat_json_process is not process:
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
        if _uat_json_process is process:
            app_module.adsb_queue.put({'type': 'status', 'text': 'uat_stopped'})


# ─── Routes ────────────────────────────────────────────────────────

@uat_bp.route('/tools')
async def check_uat_tools():
    """Check if dump978 tools are installed."""
    return jsonify({
        'enabled': UAT_ENABLED,
        'dump978': find_dump978() is not None,
        'uat2json': find_uat2json() is not None,
        'supported_sdr_types': ['rtlsdr'],
    })


@uat_bp.route('/status')
async def uat_status():
    """Get UAT decoder status."""
    return jsonify({
        'enabled': UAT_ENABLED,
        'running': uat_running,
        'active_device': uat_active_device,
        'active_sdr_type': 'rtlsdr' if uat_active_device is not None else None,
        'sdr_type': 'rtlsdr' if uat_active_device is not None else None,
        'receiver': ({'device': uat_active_device, 'sdr_type': 'rtlsdr'}
                     if uat_active_device is not None else None),
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
    data = await request.get_json(silent=True) or {}
    try:
        sdr_type = normalize_sdr_type(data.get('sdr_type', 'rtlsdr'))
    except ValueError as exc:
        return jsonify({'status': 'error', 'message': str(exc)}), 400
    if sdr_type != 'rtlsdr':
        return jsonify({'status': 'error', 'message': 'UAT requires an RTL-SDR receiver.',
                        'supported_sdr_types': ['rtlsdr']}), 400

    if not UAT_ENABLED:
        return jsonify({
            'status': 'error',
            'message': 'UAT support is disabled. Set VALENTINE_UAT_ENABLED=true.'
        }), 400

    # Starting takes seconds (USB claim, two spawns, startup wait). The slow
    # steps run off the event loop, so the lock keeps a second request from
    # starting a second pipeline in the meantime.
    async with async_thread_lock(uat_lock):
        return await _start_uat_locked(data)


async def _start_uat_locked(data: dict):
    """Start the dump978 | uat2json pipeline while holding uat_lock."""
    global uat_running, uat_active_device
    global _uat_dump978_process, _uat_json_process, _uat_messages_received

    if uat_running:
        return jsonify({
            'status': 'already_running',
            'message': 'UAT decoder is already active.'
        }), 409

    # ── Validate inputs ──
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
    # The claim probes USB, so it runs in a worker; wait for its result even
    # when cancelled so a late successful claim is not orphaned.
    claim = asyncio.create_task(asyncio.to_thread(app_module.claim_sdr_device, device, 'uat'))
    try:
        error = await asyncio.shield(claim)
    except asyncio.CancelledError:
        error = await claim
        if not error:
            app_module.release_sdr_device(device, mode_name='uat')
        raise
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
        _uat_dump978_process = await async_popen(
            dump978_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        register_process(_uat_dump978_process)

        # Pipe dump978 stdout into uat2json stdin
        _uat_json_process = await async_popen(
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
        await asyncio.sleep(UAT_START_WAIT)

        if _uat_dump978_process.poll() is not None:
            stderr_text = await asyncio.to_thread(_read_exit_stderr, _uat_dump978_process)
            await asyncio.to_thread(_cleanup_uat_processes)
            app_module.release_sdr_device(device, mode_name='uat')
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
            'sdr_type': 'rtlsdr',
            'receiver': {'device': device, 'sdr_type': 'rtlsdr'},
        })

    except asyncio.CancelledError:
        # The client went away mid-start (there is no await after the reader
        # thread takes over): stop the half-started pipeline and free the SDR.
        await asyncio.to_thread(_cleanup_uat_processes)
        app_module.release_sdr_device(device, mode_name='uat')
        raise
    except Exception as e:
        await asyncio.to_thread(_cleanup_uat_processes)
        app_module.release_sdr_device(device, mode_name='uat')
        logger.error("Failed to start UAT: %s", e)
        return jsonify({'status': 'error', 'message': str(e)}), 500


@uat_bp.route('/stop', methods=['POST'])
async def stop_uat():
    """Stop UAT decoding and release the SDR device."""
    # Terminating the pipeline can wait seconds per process. Run it in a
    # worker, serialized with start: a start awaits its startup check, and a
    # stop must not tear the pipeline down underneath it.
    async with async_thread_lock(uat_lock):
        await finish_in_thread(_stop_uat)

    return jsonify({'status': 'stopped', 'message': 'UAT decoder stopped.'})


def _stop_uat() -> None:
    """Stop the pipeline and release the receiver. Caller holds uat_lock."""
    global uat_running, uat_active_device

    uat_running = False
    _cleanup_uat_processes()

    if uat_active_device is not None:
        app_module.release_sdr_device(uat_active_device, mode_name='uat')
        uat_active_device = None


# ─── Internal helpers ──────────────────────────────────────────────

def _read_exit_stderr(process: subprocess.Popen) -> str:
    """Return what an exited pipeline member wrote to stderr (blocking read)."""
    if not process.stderr:
        return ''
    try:
        return process.stderr.read().decode('utf-8', errors='ignore').strip()[:500]
    except Exception:
        return ''


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
