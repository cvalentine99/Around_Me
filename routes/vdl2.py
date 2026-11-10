"""VDL2 aircraft datalink routes."""

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
from typing import Any, Generator

from quart import Blueprint, jsonify, request, Response

import app as app_module
from utils.logging import sensor_logger as logger
from utils.validation import validate_device_index, validate_frequency, validate_gain, validate_ppm
from utils.async_lock import async_thread_lock
from utils.async_process import finish_in_thread
from utils.sdr import SDRFactory, SDRType
from utils.sse import async_sse_stream_fanout, format_sse
from utils.event_pipeline import process_event
from utils.constants import (
    PROCESS_TERMINATE_TIMEOUT,
    SSE_KEEPALIVE_INTERVAL,
    SSE_QUEUE_TIMEOUT,
    PROCESS_START_WAIT,
)
from utils.process import register_process, unregister_process

vdl2_bp = Blueprint('vdl2', __name__, url_prefix='/vdl2')

# Default VDL2 frequencies (MHz) - common worldwide
DEFAULT_VDL2_FREQUENCIES = [
    '136975000',  # Primary worldwide
    '136725000',  # Europe
    '136775000',  # Europe
    '136800000',  # Multi-region
    '136875000',  # Multi-region
]

# Message counter for statistics
vdl2_message_count = 0
vdl2_last_message_time = None

# Track which device is being used
vdl2_active_device: int | None = None


def find_dumpvdl2():
    """Find dumpvdl2 binary."""
    return shutil.which('dumpvdl2')


def stream_vdl2_output(process: subprocess.Popen, is_text_mode: bool = False) -> None:
    """Stream dumpvdl2 JSON output to queue."""
    global vdl2_message_count, vdl2_last_message_time

    try:
        app_module.vdl2_queue.put({'type': 'status', 'status': 'started'})

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
                data = json.loads(line)

                # Add our metadata
                data['type'] = 'vdl2'
                data['timestamp'] = datetime.utcnow().isoformat() + 'Z'

                # Update stats
                vdl2_message_count += 1
                vdl2_last_message_time = time.time()

                app_module.vdl2_queue.put(data)

                # Feed flight correlator
                try:
                    from utils.flight_correlator import get_flight_correlator
                    get_flight_correlator().add_vdl2_message(data)
                except Exception:
                    pass

                # Log if enabled
                if app_module.logging_enabled:
                    try:
                        with open(app_module.log_file_path, 'a') as f:
                            ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                            f.write(f"{ts} | VDL2 | {json.dumps(data)}\n")
                    except Exception:
                        pass

            except json.JSONDecodeError:
                # Not JSON - could be status message
                if line:
                    logger.debug(f"dumpvdl2 non-JSON: {line[:100]}")

    except Exception as e:
        logger.error(f"VDL2 stream error: {e}")
        app_module.vdl2_queue.put({'type': 'error', 'message': str(e)})
    finally:
        global vdl2_active_device
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
        # Only this reader's own session may be reset. After a stop and a
        # quick restart the current process and claim belong to a newer
        # session (start holds vdl2_lock until that session is set up).
        with app_module.vdl2_lock:
            own_session = app_module.vdl2_process is process
            if own_session:
                app_module.vdl2_process = None
                # Release SDR device
                if vdl2_active_device is not None:
                    app_module.release_sdr_device(vdl2_active_device, mode_name='vdl2')
                    vdl2_active_device = None
            announce = own_session or app_module.vdl2_process is None
        if announce:
            app_module.vdl2_queue.put({'type': 'status', 'status': 'stopped'})

@vdl2_bp.route('/tools')
async def check_vdl2_tools() -> Response:
    """Check for VDL2 decoding tools."""
    has_dumpvdl2 = find_dumpvdl2() is not None

    return jsonify({
        'dumpvdl2': has_dumpvdl2,
        'ready': has_dumpvdl2
    })


@vdl2_bp.route('/status')
async def vdl2_status() -> Response:
    """Get VDL2 decoder status."""
    running = False
    if app_module.vdl2_process:
        running = app_module.vdl2_process.poll() is None

    return jsonify({
        'running': running,
        'message_count': vdl2_message_count,
        'last_message_time': vdl2_last_message_time,
        'queue_size': app_module.vdl2_queue.qsize()
    })


@vdl2_bp.route('/start', methods=['POST'])
async def start_vdl2() -> Response:
    """Start VDL2 decoder."""
    data = await request.get_json(silent=True) or {}

    # The lock is shared with the reader thread. Wait for it without blocking
    # the event loop and keep it for the whole start (USB claim, spawn,
    # startup wait), which runs in a worker so other clients keep streaming.
    async with async_thread_lock(app_module.vdl2_lock):
        payload, status = await finish_in_thread(_start_vdl2_locked, data)
    return jsonify(payload), status


def _parse_vdl2_frequencies(value) -> list[str]:
    """Return dumpvdl2 frequency arguments (Hz), or raise ValueError.

    The values end up in dumpvdl2's argv: each must be a plain frequency in
    Hz, never an option, and never a type that breaks the spawn after the
    receiver has been claimed.
    """
    if value is None:
        return list(DEFAULT_VDL2_FREQUENCIES)
    if isinstance(value, str):
        value = [f.strip() for f in value.split(',') if f.strip()]
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        value = [value]
    if not isinstance(value, (list, tuple)) or not value:
        raise ValueError('VDL2 frequencies must be a non-empty list of frequencies in Hz')
    frequencies = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (str, int, float)):
            raise ValueError(f'Invalid VDL2 frequency: {item}')
        try:
            hz = int(float(str(item).strip()))
            validate_frequency(hz / 1e6)
        except ValueError:
            raise ValueError(f'Invalid VDL2 frequency (Hz): {item}') from None
        frequencies.append(str(hz))
    return frequencies


def _start_vdl2_locked(data: dict) -> tuple[dict, int]:
    """Start dumpvdl2. Blocking: runs in a worker while vdl2_lock is held."""
    global vdl2_message_count, vdl2_last_message_time, vdl2_active_device

    previous = app_module.vdl2_process
    if previous is not None:
        if previous.poll() is None:
            return {
                'status': 'error',
                'message': 'VDL2 decoder already running'
            }, 409
        # The decoder exited and its reader is still waiting for this lock to
        # clean up. Do that here so the receiver can be claimed again.
        app_module.vdl2_process = None
        if vdl2_active_device is not None:
            app_module.release_sdr_device(vdl2_active_device, mode_name='vdl2')
            vdl2_active_device = None

    # Check for dumpvdl2
    dumpvdl2_path = find_dumpvdl2()
    if not dumpvdl2_path:
        return {
            'status': 'error',
            'message': 'dumpvdl2 not found. Install from: https://github.com/szpajder/dumpvdl2'
        }, 400

    # Validate inputs before the receiver is claimed
    try:
        device = validate_device_index(data.get('device', '0'))
        gain = validate_gain(data.get('gain', '40'))
        ppm = validate_ppm(data.get('ppm', '0'))
        # dumpvdl2 expects frequencies in Hz (integers)
        frequencies = _parse_vdl2_frequencies(data.get('frequencies'))
    except ValueError as e:
        return {'status': 'error', 'message': str(e)}, 400

    # Check if device is available
    device_int = int(device)
    error = app_module.claim_sdr_device(device_int, 'vdl2')
    if error:
        return {
            'status': 'error',
            'error_type': 'DEVICE_BUSY',
            'message': error
        }, 409

    vdl2_active_device = device_int

    # Clear queue
    while not app_module.vdl2_queue.empty():
        try:
            app_module.vdl2_queue.get_nowait()
        except queue.Empty:
            break

    # Reset stats
    vdl2_message_count = 0
    vdl2_last_message_time = None

    # Resolve SDR type for device selection
    sdr_type_str = data.get('sdr_type', 'rtlsdr')
    try:
        sdr_type = SDRType(sdr_type_str)
    except ValueError:
        sdr_type = SDRType.RTL_SDR

    is_soapy = sdr_type not in (SDRType.RTL_SDR,)

    process = None
    try:
        # Build dumpvdl2 command
        # dumpvdl2 --output decoded:json --rtlsdr <device> --gain <gain> --correction <ppm> <freq1> <freq2> ...
        cmd = [dumpvdl2_path]
        cmd.extend(['--output', 'decoded:json:file:path=-'])

        if is_soapy:
            # SoapySDR device
            sdr_device = SDRFactory.create_default_device(sdr_type, index=device_int)
            builder = SDRFactory.get_builder(sdr_type)
            device_str = builder._build_device_string(sdr_device)
            cmd.extend(['--soapysdr', device_str])
        else:
            cmd.extend(['--rtlsdr', str(device)])

        # Add gain
        if gain and str(gain) != '0':
            cmd.extend(['--gain', str(gain)])

        # Add PPM correction if specified
        if ppm and str(ppm) != '0':
            cmd.extend(['--correction', str(ppm)])

        # Add frequencies (dumpvdl2 takes them as positional args in Hz)
        cmd.extend(frequencies)

        logger.info(f"Starting VDL2 decoder: {' '.join(cmd)}")

        is_text_mode = False

        # On macOS, use pty to avoid stdout buffering issues
        if platform.system() == 'Darwin':
            master_fd, slave_fd = pty.openpty()
            try:
                process = subprocess.Popen(
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
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True
            )

        # Wait briefly to check if process started
        time.sleep(PROCESS_START_WAIT)

        if process.poll() is not None:
            # Process died - release device
            if vdl2_active_device is not None:
                app_module.release_sdr_device(vdl2_active_device, mode_name='vdl2')
                vdl2_active_device = None
            stderr = ''
            if process.stderr:
                stderr = process.stderr.read().decode('utf-8', errors='replace')
            error_msg = 'dumpvdl2 failed to start'
            if stderr:
                error_msg += f': {stderr[:200]}'
            logger.error(error_msg)
            return {'status': 'error', 'message': error_msg}, 500

        app_module.vdl2_process = process
        register_process(process)

        # Start output streaming thread
        thread = threading.Thread(
            target=stream_vdl2_output,
            args=(process, is_text_mode),
            daemon=True
        )
        thread.start()

        return {
            'status': 'started',
            'frequencies': frequencies,
            'device': device,
            'gain': gain
        }, 200

    except Exception as e:
        # Do not leave a half-started decoder holding the receiver
        if process is not None and app_module.vdl2_process is not process:
            try:
                process.kill()
            except Exception:
                pass
        # Release device on failure
        if vdl2_active_device is not None:
            app_module.release_sdr_device(vdl2_active_device, mode_name='vdl2')
            vdl2_active_device = None
        logger.error(f"Failed to start VDL2 decoder: {e}")
        return {'status': 'error', 'message': str(e)}, 500


@vdl2_bp.route('/stop', methods=['POST'])
async def stop_vdl2() -> Response:
    """Stop VDL2 decoder."""
    # Waiting for dumpvdl2 to exit can take seconds: do it in a worker, and
    # wait for the reader-shared lock without blocking the event loop.
    async with async_thread_lock(app_module.vdl2_lock):
        stopped = await finish_in_thread(_stop_vdl2_locked)

    if not stopped:
        return jsonify({
            'status': 'error',
            'message': 'VDL2 decoder not running'
        }), 400

    return jsonify({'status': 'stopped'})


def _stop_vdl2_locked() -> bool:
    """Stop dumpvdl2 and release the receiver. Caller holds vdl2_lock."""
    global vdl2_active_device

    process = app_module.vdl2_process
    if not process:
        return False

    try:
        process.terminate()
        process.wait(timeout=PROCESS_TERMINATE_TIMEOUT)
    except subprocess.TimeoutExpired:
        process.kill()
    except Exception as e:
        logger.error(f"Error stopping VDL2: {e}")

    app_module.vdl2_process = None

    # Release device from registry
    if vdl2_active_device is not None:
        app_module.release_sdr_device(vdl2_active_device, mode_name='vdl2')
        vdl2_active_device = None

    return True


@vdl2_bp.route('/stream')
async def stream_vdl2() -> Response:
    """SSE stream for VDL2 messages."""
    def _on_msg(msg: dict[str, Any]) -> None:
        process_event('vdl2', msg, msg.get('type'))

    response = Response(
        async_sse_stream_fanout(
            source_queue=app_module.vdl2_queue,
            channel_key='vdl2',
            timeout=SSE_QUEUE_TIMEOUT,
            keepalive_interval=SSE_KEEPALIVE_INTERVAL,
            on_message=_on_msg,
        ),
        mimetype='text/event-stream',
    )
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['X-Accel-Buffering'] = 'no'
    return response


@vdl2_bp.route('/frequencies')
async def get_frequencies() -> Response:
    """Get default VDL2 frequencies."""
    return jsonify({
        'default': DEFAULT_VDL2_FREQUENCIES,
        'regions': {
            'north_america': ['136975000', '136100000', '136650000', '136700000', '136800000'],
            'europe': ['136975000', '136675000', '136725000', '136775000', '136825000'],
            'asia_pacific': ['136975000', '136900000'],
        }
    })
