"""ACARS aircraft messaging routes."""

from __future__ import annotations

import io
import json
import os
import platform
import pty
import queue
import shutil
import subprocess
import threading
import time
from datetime import datetime
import asyncio
from typing import Generator

from quart import Blueprint, jsonify, request, Response

import app as app_module
from utils.logging import sensor_logger as logger
from utils.validation import validate_device_index, validate_frequency, validate_gain, validate_ppm
from utils.sse import format_sse
from utils.sse import event_stream_response
from utils.constants import (
    PROCESS_TERMINATE_TIMEOUT,
    SSE_KEEPALIVE_INTERVAL,
    SSE_QUEUE_TIMEOUT,
    PROCESS_START_WAIT,
)
from utils.process import register_process, unregister_process, safe_terminate
from utils.sdr.registry import normalize_sdr_type
from utils.async_lock import async_thread_lock
from utils.async_process import async_popen, finish_in_thread

acars_bp = Blueprint('acars', __name__, url_prefix='/acars')

# Default VHF ACARS frequencies (MHz) - common worldwide
DEFAULT_ACARS_FREQUENCIES = [
    '131.550',  # Primary worldwide
    '130.025',  # Secondary USA/Canada
    '129.125',  # USA
    '131.525',  # Europe
    '131.725',  # Europe secondary
]

# Message counter for statistics
acars_message_count = 0
acars_last_message_time = None

# Track which device is being used
acars_active_device: int | None = None


def find_acarsdec():
    """Find acarsdec binary."""
    return shutil.which('acarsdec')


def _parse_acars_frequencies(value) -> list[str]:
    """Return acarsdec frequency arguments, or raise ValueError.

    The values end up in acarsdec's argv, so each one must be a plain
    frequency: never an option, and never a non-string that breaks the spawn
    after the receiver has been claimed.
    """
    if value is None:
        return list(DEFAULT_ACARS_FREQUENCIES)
    if isinstance(value, str):
        value = [f.strip() for f in value.split(',')]
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        value = [value]
    if not isinstance(value, (list, tuple)) or not value:
        raise ValueError('ACARS frequencies must be a non-empty list of MHz values')
    frequencies = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (str, int, float)):
            raise ValueError(f'Invalid ACARS frequency: {item}')
        text = str(item).strip()
        try:
            validate_frequency(text)
        except ValueError:
            raise ValueError(f'Invalid ACARS frequency: {item}') from None
        frequencies.append(text)
    return frequencies


def get_acarsdec_json_flag(acarsdec_path: str) -> str:
    """Detect which JSON output flag acarsdec supports.

    Different forks use different flags:
    - TLeconte v4.0+: uses -j for JSON stdout
    - TLeconte v3.x: uses -o 4 for JSON stdout
    - f00b4r0 fork (DragonOS): uses --output json:file:- for JSON stdout
    """
    try:
        # Get help/version by running acarsdec with no args (shows usage)
        result = subprocess.run(
            [acarsdec_path],
            capture_output=True,
            text=True,
            timeout=5
        )
        output = result.stdout + result.stderr

        import re

        # Check for f00b4r0 fork signature: uses --output instead of -j/-o
        # f00b4r0's help shows "--output" for output configuration
        if '--output' in output or 'json:file:' in output.lower():
            logger.debug("Detected f00b4r0 acarsdec fork (--output syntax)")
            return '--output'

        # Parse version from output like "Acarsdec v4.3.1" or "Acarsdec/acarsserv 3.7"
        version_match = re.search(r'acarsdec[^\d]*v?(\d+)\.(\d+)', output, re.IGNORECASE)
        if version_match:
            major = int(version_match.group(1))
            # Version 4.0+ uses -j for JSON stdout
            if major >= 4:
                return '-j'
            # Version 3.x uses -o for output mode
            else:
                return '-o'
    except Exception as e:
        logger.debug(f"Could not detect acarsdec version: {e}")

    # Default to -j (TLeconte modern standard)
    return '-j'


def stream_acars_output(process: subprocess.Popen, is_text_mode: bool = False) -> None:
    """Stream acarsdec JSON output to queue."""
    global acars_message_count, acars_last_message_time

    try:
        app_module.acars_queue.put({'type': 'status', 'status': 'started'})

        # Use appropriate sentinel based on mode (text mode for pty on macOS)
        sentinel = '' if is_text_mode else b''
        for line in iter(process.stdout.readline, sentinel):
            if is_text_mode:
                line = line.strip()
            else:
                line = line.decode('utf-8', errors='replace').strip()
            if not line:
                continue

            try:
                # acarsdec -o 4 outputs JSON, one message per line
                data = json.loads(line)

                # Add our metadata
                data['type'] = 'acars'
                data['timestamp'] = datetime.utcnow().isoformat() + 'Z'

                # Update stats
                acars_message_count += 1
                acars_last_message_time = time.time()

                app_module.acars_queue.put(data)

                # Log if enabled
                if app_module.logging_enabled:
                    try:
                        with open(app_module.log_file_path, 'a') as f:
                            ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                            f.write(f"{ts} | ACARS | {json.dumps(data)}\n")
                    except Exception:
                        pass

            except json.JSONDecodeError:
                # Not JSON - could be status message
                if line:
                    logger.debug(f"acarsdec non-JSON: {line[:100]}")

    except Exception as e:
        logger.error(f"ACARS stream error: {e}")
        app_module.acars_queue.put({'type': 'error', 'message': str(e)})
    finally:
        global acars_active_device
        # Ensure process is terminated
        try:
            process.terminate()
            process.wait(timeout=2)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass
        unregister_process(process)
        with app_module.acars_lock:
            # A previous decoder can finish after Stop All and a new start.
            if app_module.acars_process is process:
                app_module.acars_queue.put({'type': 'status', 'status': 'stopped'})
                app_module.acars_process = None
                if acars_active_device is not None:
                    app_module.release_sdr_device(acars_active_device, mode_name='acars')
                    acars_active_device = None


@acars_bp.route('/tools')
async def check_acars_tools() -> Response:
    """Check for ACARS decoding tools."""
    has_acarsdec = find_acarsdec() is not None

    return jsonify({
        'acarsdec': has_acarsdec,
        'ready': has_acarsdec,
        'supported_sdr_types': ['rtlsdr'],
    })


@acars_bp.route('/status')
async def acars_status() -> Response:
    """Get ACARS decoder status."""
    running = False
    if app_module.acars_process:
        running = app_module.acars_process.poll() is None

    return jsonify({
        'running': running,
        'active_device': acars_active_device,
        'active_sdr_type': 'rtlsdr' if acars_active_device is not None else None,
        'sdr_type': 'rtlsdr' if acars_active_device is not None else None,
        'receiver': ({'device': acars_active_device, 'sdr_type': 'rtlsdr'}
                     if acars_active_device is not None else None),
        'message_count': acars_message_count,
        'last_message_time': acars_last_message_time,
        'queue_size': app_module.acars_queue.qsize()
    })


@acars_bp.route('/start', methods=['POST'])
async def start_acars() -> Response:
    """Start ACARS decoder."""
    data = await request.get_json(silent=True) or {}
    try:
        sdr_type = normalize_sdr_type(data.get('sdr_type', 'rtlsdr'))
    except ValueError as exc:
        return jsonify({'status': 'error', 'message': str(exc)}), 400
    if sdr_type != 'rtlsdr':
        return jsonify({'status': 'error', 'message': 'ACARS requires an RTL-SDR receiver.',
                        'supported_sdr_types': ['rtlsdr']}), 400

    # The lock is shared with the reader thread. Wait for it without blocking
    # the event loop and keep it for the whole start, so two requests cannot
    # both pass the "already running" check.
    async with async_thread_lock(app_module.acars_lock):
        return await _start_acars_locked(data)


async def _start_acars_locked(data: dict) -> Response:
    """Start acarsdec while holding acars_lock; slow steps run off the event loop."""
    global acars_message_count, acars_last_message_time, acars_active_device

    previous = app_module.acars_process
    if previous is not None:
        if previous.poll() is None:
            return jsonify({
                'status': 'error',
                'message': 'ACARS decoder already running'
            }), 409
        # The decoder exited and its reader is still waiting for this lock to
        # clean up. Do that here so the receiver can be claimed again.
        app_module.acars_process = None
        if acars_active_device is not None:
            app_module.release_sdr_device(acars_active_device, mode_name='acars')
            acars_active_device = None

    # Check for acarsdec
    acarsdec_path = find_acarsdec()
    if not acarsdec_path:
        return jsonify({
            'status': 'error',
            'message': 'acarsdec not found. Install with: sudo apt install acarsdec'
        }), 400

    # Validate inputs
    try:
        device = validate_device_index(data.get('device', '0'))
        gain = validate_gain(data.get('gain', '40'))
        ppm = validate_ppm(data.get('ppm', '0'))
        # Get frequencies - use provided or defaults. Validated before the
        # receiver is claimed: a bad value must not strand the claim.
        frequencies = _parse_acars_frequencies(data.get('frequencies'))
    except ValueError as e:
        return jsonify({'status': 'error', 'message': str(e)}), 400

    # Probing the installed fork runs acarsdec once; do it before the receiver
    # is claimed so nothing has to be undone if the request goes away.
    json_flag = await asyncio.to_thread(get_acarsdec_json_flag, acarsdec_path)

    # Check if device is available. The claim probes USB, so it runs in a
    # worker; wait for its result even when cancelled so a late successful
    # claim is not orphaned.
    device_int = int(device)
    claim = asyncio.create_task(asyncio.to_thread(app_module.claim_sdr_device, device_int, 'acars'))
    try:
        error = await asyncio.shield(claim)
    except asyncio.CancelledError:
        error = await claim
        if not error:
            app_module.release_sdr_device(device_int, mode_name='acars')
        raise
    if error:
        return jsonify({
            'status': 'error',
            'error_type': 'DEVICE_BUSY',
            'message': error
        }), 409

    acars_active_device = device_int

    # Clear queue
    while not app_module.acars_queue.empty():
        try:
            app_module.acars_queue.get_nowait()
        except queue.Empty:
            break

    # Reset stats
    acars_message_count = 0
    acars_last_message_time = None

    # Build acarsdec command
    # Different forks have different syntax:
    # - TLeconte v4+: acarsdec -j -g <gain> -p <ppm> -r <device> <freq1> <freq2> ...
    # - TLeconte v3: acarsdec -o 4 -g <gain> -p <ppm> -r <device> <freq1> <freq2> ...
    # - f00b4r0 (DragonOS): acarsdec --output json:file:- -g <gain> -p <ppm> -r <device> <freq1> ...
    # Note: gain/ppm must come BEFORE -r
    cmd = [acarsdec_path]
    if json_flag == '--output':
        # f00b4r0 fork: --output json:file (no path = stdout)
        cmd.extend(['--output', 'json:file'])
    elif json_flag == '-j':
        cmd.append('-j')         # JSON output (TLeconte v4+)
    else:
        cmd.extend(['-o', '4'])  # JSON output (TLeconte v3.x)

    # Add gain if not auto (must be before -r)
    if gain and str(gain) != '0':
        cmd.extend(['-g', str(gain)])

    # Add PPM correction if specified (must be before -r)
    if ppm and str(ppm) != '0':
        cmd.extend(['-p', str(ppm)])

    # Add device and frequencies
    # f00b4r0 uses --rtlsdr <device>, TLeconte uses -r <device>
    if json_flag == '--output':
        # Use 3.2 MS/s sample rate for wider bandwidth (handles NA frequency span)
        cmd.extend(['-m', '256'])
        cmd.extend(['--rtlsdr', str(device)])
    else:
        cmd.extend(['-r', str(device)])
    cmd.extend(frequencies)

    logger.info(f"Starting ACARS decoder: {' '.join(cmd)}")

    process = None
    try:
        is_text_mode = False

        # On macOS, use pty to avoid stdout buffering issues
        if platform.system() == 'Darwin':
            master_fd, slave_fd = pty.openpty()
            try:
                process = await async_popen(
                    cmd,
                    stdout=slave_fd,
                    stderr=subprocess.PIPE,
                    start_new_session=True
                )
            except BaseException:
                os.close(master_fd)
                raise
            finally:
                os.close(slave_fd)
            # Wrap master_fd as a text file for line-buffered reading
            process.stdout = io.open(master_fd, 'r', buffering=1)
            is_text_mode = True
        else:
            process = await async_popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True
            )

        # Wait briefly to check if process started
        await asyncio.sleep(PROCESS_START_WAIT)

        if process.poll() is not None:
            # Process died - release device
            if acars_active_device is not None:
                app_module.release_sdr_device(acars_active_device, mode_name='acars')
                acars_active_device = None
            stderr = ''
            if process.stderr:
                stderr = (await asyncio.to_thread(process.stderr.read)).decode('utf-8', errors='replace')
            error_msg = f'acarsdec failed to start'
            if stderr:
                error_msg += f': {stderr[:200]}'
            logger.error(error_msg)
            return jsonify({'status': 'error', 'message': error_msg}), 500

        app_module.acars_process = process
        register_process(process)

        # Start output streaming thread
        thread = threading.Thread(
            target=stream_acars_output,
            args=(process, is_text_mode),
            daemon=True
        )
        thread.start()

        return jsonify({
            'status': 'started',
            'frequencies': frequencies,
            'device': device,
            'sdr_type': 'rtlsdr',
            'receiver': {'device': device_int, 'sdr_type': 'rtlsdr'},
            'gain': gain
        })

    except asyncio.CancelledError:
        # The client went away mid-start (there is no await after the decoder
        # is handed to its reader): do not leave an unowned decoder holding
        # the receiver.
        if process is not None:
            await asyncio.to_thread(safe_terminate, process)
        if acars_active_device is not None:
            app_module.release_sdr_device(acars_active_device, mode_name='acars')
            acars_active_device = None
        raise
    except Exception as e:
        # Release device on failure
        if acars_active_device is not None:
            app_module.release_sdr_device(acars_active_device, mode_name='acars')
            acars_active_device = None
        logger.error(f"Failed to start ACARS decoder: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@acars_bp.route('/stop', methods=['POST'])
async def stop_acars() -> Response:
    """Stop ACARS decoder."""
    # Waiting for acarsdec to exit can take seconds: do it in a worker, and
    # wait for the reader-shared lock without blocking the event loop.
    async with async_thread_lock(app_module.acars_lock):
        was_running = await finish_in_thread(_stop_acars)

    if not was_running:
        return jsonify({
            'status': 'error',
            'message': 'ACARS decoder not running'
        }), 400

    return jsonify({'status': 'stopped'})


def _stop_acars() -> bool:
    """Stop acarsdec and release its receiver. Caller holds acars_lock."""
    global acars_active_device

    process = app_module.acars_process
    if not process:
        return False

    try:
        process.terminate()
        process.wait(timeout=PROCESS_TERMINATE_TIMEOUT)
    except subprocess.TimeoutExpired:
        process.kill()
    except Exception as e:
        logger.error(f"Error stopping ACARS: {e}")

    app_module.acars_process = None

    # Keep release and process reset inside the same synchronization scope.
    if acars_active_device is not None:
        app_module.release_sdr_device(acars_active_device, mode_name='acars')
        acars_active_device = None

    return True


@acars_bp.route('/stream')
async def stream_acars() -> Response:
    """SSE stream for ACARS messages."""
    return event_stream_response(app_module.acars_queue)


@acars_bp.route('/frequencies')
async def get_frequencies() -> Response:
    """Get default ACARS frequencies."""
    return jsonify({
        'default': DEFAULT_ACARS_FREQUENCIES,
        'regions': {
            'north_america': ['129.125', '130.025', '130.450', '131.550'],
            'europe': ['131.525', '131.725', '131.550'],
            'asia_pacific': ['131.550', '131.450'],
        }
    })
