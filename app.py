"""
VALENTINE RF - Signal Intelligence Platform

Quart application and shared state (async-native Flask replacement).
"""

from __future__ import annotations

import sys
import site

from utils.database import get_db

# Ensure user site-packages is available (may be disabled when running as root/sudo)
if not site.ENABLE_USER_SITE:
    user_site = site.getusersitepackages()
    if user_site and user_site not in sys.path:
        sys.path.insert(0, user_site)

import os
import asyncio
import queue
import threading
import platform
import subprocess

from typing import Any

from quart import Quart, render_template, jsonify, send_file, Response, request, redirect, url_for, flash, session, websocket
from quart.wrappers.response import IterableBody
from werkzeug.security import check_password_hash
from config import (
    VERSION, CHANGELOG, SHARED_OBSERVER_LOCATION_ENABLED,
    DEFAULT_LATITUDE, DEFAULT_LONGITUDE, SECRET_KEY,
    ADMIN_PASSWORD, ADMIN_PASSWORD_EXPLICIT, ADMIN_USERNAME,
)
from utils.dependencies import check_tool, check_all_dependencies, TOOL_DEPENDENCIES
from utils.process import cleanup_stale_processes, cleanup_all_processes
from utils.sdr import SDRFactory
from utils.sdr.registry import SDRDeviceRegistry, sdr_device_key
from utils.sse import EventQueue
from utils.cleanup import DataStore, cleanup_manager
from utils.constants import (
    MAX_AIRCRAFT_AGE_SECONDS,
    MAX_WIFI_NETWORK_AGE_SECONDS,
    MAX_BT_DEVICE_AGE_SECONDS,
    MAX_VESSEL_AGE_SECONDS,
    MAX_DSC_MESSAGE_AGE_SECONDS,
    MAX_DEAUTH_ALERTS_AGE_SECONDS,
    QUEUE_MAX_SIZE,
)
import logging
from quart_rate_limiter import RateLimiter, rate_limit
from datetime import timedelta
# Track application start time for uptime calculation
import time as _time
_app_start_time = _time.time()
logger = logging.getLogger('valentine.database')

# Create Quart app (async-native Flask replacement)
app = Quart(__name__)
app.secret_key = SECRET_KEY  # Generated randomly or from VALENTINE_SECRET_KEY env var

# Set up rate limiting (Quart-native rate limiter)
rate_limiter = RateLimiter(app)

# Disable Werkzeug debugger PIN (not needed for local development tool)
os.environ['WERKZEUG_DEBUG_PIN'] = 'off'

# ============================================
# ERROR HANDLERS    
# ============================================
@app.errorhandler(429)
async def ratelimit_handler(e):
    logger.warning(f"Rate limit exceeded for IP: {request.remote_addr}")
    await flash("Too many login attempts. Please wait one minute before trying again.", "error")
    return await render_template('login.html', version=VERSION), 429

# ============================================
# SECURITY HEADERS
# ============================================

@app.after_request
async def add_security_headers(response):
    """Add security headers to all responses."""
    # Prevent MIME type sniffing
    response.headers['X-Content-Type-Options'] = 'nosniff'
    # Prevent clickjacking
    response.headers['X-Frame-Options'] = 'SAMEORIGIN'
    # Enable XSS filter
    response.headers['X-XSS-Protection'] = '1; mode=block'
    # Referrer policy
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    # Permissions policy (disable unnecessary features)
    response.headers['Permissions-Policy'] = 'geolocation=(self), microphone=()'
    # Content Security Policy
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com https://fonts.googleapis.com https://cdn.jsdelivr.net; "
        "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://*.basemaps.cartocdn.com https://api.planespotters.net; "
        "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; "
        "connect-src 'self' ws: wss:; "
        "media-src 'self' blob:; "
        "worker-src 'self' blob:; "
        "frame-src 'self'"
    )
    # Quart's ordinary response deadline is a total lifetime, not an idle
    # timeout. Event and live audio streams intentionally remain open.
    if response.mimetype == 'text/event-stream' or (
        (response.mimetype or '').startswith('audio/')
        and isinstance(response.response, IterableBody)
    ):
        response.timeout = None
    return response


# ============================================
# CONTEXT PROCESSORS
# ============================================

@app.context_processor
async def inject_offline_settings():
    """Inject offline settings into all templates."""
    from utils.database import get_setting
    return {
        'offline_settings': {
            'enabled': get_setting('offline.enabled', False),
            'assets_source': get_setting('offline.assets_source', 'cdn'),
            'fonts_source': get_setting('offline.fonts_source', 'cdn'),
            'tile_provider': get_setting('offline.tile_provider', 'cartodb_dark_cyan'),
            'tile_server_url': get_setting('offline.tile_server_url', '')
        }
    }


# ============================================
# GLOBAL PROCESS MANAGEMENT
# ============================================

# Pager decoder
current_process = None
output_queue = EventQueue(maxsize=QUEUE_MAX_SIZE, mode='pager')
process_lock = threading.Lock()

# RTL_433 sensor
sensor_process = None
sensor_queue = EventQueue(maxsize=QUEUE_MAX_SIZE, mode='sensor')
sensor_lock = threading.Lock()

# WiFi
wifi_process = None
wifi_queue = EventQueue(maxsize=QUEUE_MAX_SIZE, mode='wifi')
wifi_lock = threading.Lock()

# Bluetooth
bt_process = None
bt_queue = EventQueue(maxsize=QUEUE_MAX_SIZE, mode='bluetooth')
bt_lock = threading.Lock()

# ADS-B aircraft
adsb_process = None
adsb_queue = EventQueue(maxsize=QUEUE_MAX_SIZE, mode='adsb')
adsb_lock = threading.Lock()

# Satellite/Iridium
satellite_process = None
satellite_queue = EventQueue(maxsize=QUEUE_MAX_SIZE, mode='satellite')
satellite_lock = threading.Lock()

# ACARS aircraft messaging
acars_process = None
acars_queue = EventQueue(maxsize=QUEUE_MAX_SIZE, mode='acars')
acars_lock = threading.Lock()

# APRS amateur radio tracking
aprs_process = None
aprs_rtl_process = None
aprs_queue = EventQueue(maxsize=QUEUE_MAX_SIZE, mode='aprs')
aprs_lock = threading.Lock()

# RTLAMR utility meter reading
rtlamr_process = None
rtlamr_queue = EventQueue(maxsize=QUEUE_MAX_SIZE, mode='rtlamr')
rtlamr_lock = threading.Lock()

# AIS vessel tracking
ais_process = None
ais_queue = EventQueue(maxsize=QUEUE_MAX_SIZE, mode='ais')
ais_lock = threading.Lock()

# DSC (Digital Selective Calling)
dsc_process = None
dsc_rtl_process = None
dsc_queue = EventQueue(maxsize=QUEUE_MAX_SIZE, mode='dsc')
dsc_lock = threading.Lock()

# DMR / Digital Voice
dmr_process = None
dmr_rtl_process = None
dmr_queue = EventQueue(maxsize=QUEUE_MAX_SIZE, mode='dmr')
dmr_lock = threading.Lock()

# TSCM (Technical Surveillance Countermeasures)
tscm_queue = EventQueue(maxsize=QUEUE_MAX_SIZE, mode='tscm')
tscm_lock = threading.Lock()

# Deauth Attack Detection
deauth_detector = None
deauth_detector_queue = EventQueue(maxsize=QUEUE_MAX_SIZE)
deauth_detector_lock = threading.Lock()

# VDL Mode 2 aviation data link
vdl2_process = None
vdl2_queue = EventQueue(maxsize=QUEUE_MAX_SIZE, mode='vdl2')
vdl2_lock = threading.Lock()

# ============================================
# GLOBAL STATE DICTIONARIES
# ============================================

# Logging settings
logging_enabled = False
log_file_path = 'pager_messages.log'

# WiFi state - using DataStore for automatic cleanup
wifi_monitor_interface = None
wifi_networks = DataStore(max_age_seconds=MAX_WIFI_NETWORK_AGE_SECONDS, name='wifi_networks')
wifi_clients = DataStore(max_age_seconds=MAX_WIFI_NETWORK_AGE_SECONDS, name='wifi_clients')
wifi_handshakes = []  # Captured handshakes (list, not auto-cleaned)

# Bluetooth state - using DataStore for automatic cleanup
bt_interface = None
bt_devices = DataStore(max_age_seconds=MAX_BT_DEVICE_AGE_SECONDS, name='bt_devices')
bt_beacons = DataStore(max_age_seconds=MAX_BT_DEVICE_AGE_SECONDS, name='bt_beacons')
bt_services = {}     # MAC -> list of services (not auto-cleaned, user-requested)

# Aircraft (ADS-B) state - using DataStore for automatic cleanup
adsb_aircraft = DataStore(max_age_seconds=MAX_AIRCRAFT_AGE_SECONDS, name='adsb_aircraft')

# Vessel (AIS) state - using DataStore for automatic cleanup
ais_vessels = DataStore(max_age_seconds=MAX_VESSEL_AGE_SECONDS, name='ais_vessels')

# DSC (Digital Selective Calling) state - using DataStore for automatic cleanup
dsc_messages = DataStore(max_age_seconds=MAX_DSC_MESSAGE_AGE_SECONDS, name='dsc_messages')

# Deauth alerts - using DataStore for automatic cleanup
deauth_alerts = DataStore(max_age_seconds=MAX_DEAUTH_ALERTS_AGE_SECONDS, name='deauth_alerts')

# Satellite state
satellite_passes = []  # Predicted satellite passes (not auto-cleaned, calculated)

# Register data stores with cleanup manager
cleanup_manager.register(wifi_networks)
cleanup_manager.register(wifi_clients)
cleanup_manager.register(bt_devices)
cleanup_manager.register(bt_beacons)
cleanup_manager.register(adsb_aircraft)
cleanup_manager.register(ais_vessels)
cleanup_manager.register(dsc_messages)
cleanup_manager.register(deauth_alerts)

# ============================================
# SDR DEVICE REGISTRY
# ============================================
# Tracks which mode is using which SDR device to prevent conflicts
# RTL-SDR keys retain legacy integer indices; other hardware families use
# namespaced keys such as 'hackrf:0'. Values are the owning mode names.
_sdr_registry = SDRDeviceRegistry()
sdr_device_registry = _sdr_registry.allocations
sdr_device_registry_lock = _sdr_registry.lock


def claim_sdr_device(device_index: int, mode_name: str, sdr_type='rtlsdr') -> str | None:
    """Claim an SDR device for a mode.

    Checks the in-app registry first, then probes an RTL-SDR USB device to
    catch stale handles held by external processes (e.g. a leftover
    rtl_fm from a previous crash).

    Args:
        device_index: The SDR device index to claim
        mode_name: Name of the mode claiming the device (e.g., 'sensor', 'rtlamr')
        sdr_type: Hardware family; indices are independent across families

    Returns:
        Error message if device is in use, None if successfully claimed
    """
    return _sdr_registry.claim(device_index, mode_name, sdr_type)


def claim_sdr_device_with_lease(device_index: int, mode_name: str, sdr_type='rtlsdr'):
    """Claim a receiver and return a generation for connection-owned cleanup."""
    return _sdr_registry.claim_with_lease(device_index, mode_name, sdr_type)


def release_sdr_device(device_index: int, sdr_type='rtlsdr', *, mode_name=None, lease=None) -> None:
    """Release an SDR device from the registry.

    Args:
        device_index: The SDR device index to release
        sdr_type: Hardware family used when claiming the receiver
        mode_name: Optional expected owner for delayed cleanup
        lease: Optional acquisition generation for delayed cleanup
    """
    _sdr_registry.release(device_index, sdr_type, mode_name=mode_name, lease=lease)


async def claim_sdr_device_async(device_index: int, mode_name: str, sdr_type='rtlsdr') -> str | None:
    """claim_sdr_device for request handlers, without blocking the event loop.

    Claiming an RTL-SDR runs ``rtl_test`` (up to 3 s), which would stall every
    stream and WebSocket while it runs. The claim runs in a worker. If the
    request is cancelled meanwhile, its outcome is awaited and a successful
    claim released, so the receiver is not left reserved by nobody.
    """
    claim = asyncio.ensure_future(
        asyncio.to_thread(claim_sdr_device, device_index, mode_name, sdr_type=sdr_type))
    try:
        return await asyncio.shield(claim)
    except asyncio.CancelledError:
        if not await claim:
            release_sdr_device(device_index, sdr_type, mode_name=mode_name)
        raise


async def claim_sdr_device_with_lease_async(device_index: int, mode_name: str, sdr_type='rtlsdr'):
    """claim_sdr_device_with_lease without blocking the event loop (see above)."""
    claim = asyncio.ensure_future(
        asyncio.to_thread(claim_sdr_device_with_lease, device_index, mode_name, sdr_type=sdr_type))
    try:
        return await asyncio.shield(claim)
    except asyncio.CancelledError:
        error, lease = await claim
        if not error:
            release_sdr_device(device_index, sdr_type, mode_name=mode_name, lease=lease)
        raise


def get_sdr_device_status() -> dict[int | str, str]:
    """Get current SDR device allocations.

    Returns:
        Dictionary mapping device indices to mode names
    """
    return _sdr_registry.status()


# ============================================
# SDR DEVICE DETECTION
# ============================================
# Detection runs rtl_test, hackrf_info and SoapySDRUtil (about 3 s). It must
# never run on the event loop: the main page polls /devices/status every few
# seconds, and each blocking run froze every stream and button meanwhile.
DEVICE_CACHE_SECONDS = 10.0
_device_cache: dict = {'devices': None, 'at': 0.0, 'source': None}
_device_cache_lock = threading.Lock()


def _detector():
    # Identity of the detection function: a test that patches it gets fresh data
    import inspect
    return inspect.getattr_static(SDRFactory, 'detect_devices')


def _detect_devices_cached(max_age: float) -> list:
    """Detect devices (blocking), sharing one run between concurrent callers."""
    with _device_cache_lock:
        cache = _device_cache
        if (cache['devices'] is not None and cache['source'] is _detector()
                and _time.monotonic() - cache['at'] < max_age):
            return cache['devices']
        devices = list(SDRFactory.detect_devices())
        # A receiver that a mode is using cannot always be opened by the
        # detection tools (hackrf_info fails on a busy HackRF). Keep the last
        # known entry for claimed receivers instead of letting them vanish.
        if cache['devices'] and cache['source'] is _detector():
            claimed = set(get_sdr_device_status())
            present = {sdr_device_key(d.index, d.sdr_type) for d in devices}
            for old in cache['devices']:
                key = sdr_device_key(old.index, old.sdr_type)
                if key in claimed and key not in present:
                    devices.append(old)
            devices.sort(key=lambda d: (d.sdr_type.value, d.index))
        cache.update(devices=devices, at=_time.monotonic(), source=_detector())
        return devices


async def detect_devices_async(max_age: float = DEVICE_CACHE_SECONDS) -> list:
    """SDR detection for request handlers: off the event loop, briefly cached."""
    cache = _device_cache
    if (cache['devices'] is not None and cache['source'] is _detector()
            and _time.monotonic() - cache['at'] < max_age):
        return cache['devices']
    return await asyncio.to_thread(_detect_devices_cached, max_age)


# ============================================
# MAIN ROUTES
# ============================================

@app.before_request
async def require_login():
    # Routes that don't require login (to avoid infinite redirect loop)
    allowed_routes = ['login', 'static', 'favicon', 'health', 'health_check',
                      'change_password']

    # Agent push ingestion authenticates its own X-API-Key against the
    # registered agent. It does not have a browser session or user token.
    if request.endpoint == 'controller.ingest_push_data':
        return None

    if session.get('logged_in'):
        if (session.get('password_must_change')
                and request.endpoint not in allowed_routes + ['logout']):
            return redirect(url_for('change_password'))
        return None

    # Browser requests use the session; standalone API clients can supply
    # the same explicit bearer/query token supported by earlier versions.
    if (request.path.startswith('/controller/')
            or request.path.startswith('/listening/audio/')):
        token = (request.args.get('token')
                 or request.headers.get('Authorization', '').removeprefix('Bearer ').strip())
        if not token or not _verify_api_token(token):
            return jsonify({'status': 'error', 'message': 'Authentication required'}), 401
        return None  # Token valid, proceed

    # If user is not logged in and the current route is not allowed...
    if request.endpoint not in allowed_routes:
        return redirect(url_for('login'))


@app.before_websocket
async def require_websocket_login():
    """Authenticate WebSocket handshakes before any radio handler runs."""
    if session.get('logged_in'):
        if session.get('password_must_change'):
            return jsonify({'status': 'error', 'message': 'Password change required'}), 403
        return None
    token = (websocket.args.get('token')
             or websocket.headers.get('Authorization', '').removeprefix('Bearer ').strip())
    if not token or not _verify_api_token(token):
        return jsonify({'status': 'error', 'message': 'Authentication required'}), 401
    
@app.route('/logout')
async def logout():
    session.clear()
    return redirect(url_for('login'))

# ============================================
# API TOKEN HELPERS
# ============================================
import hashlib as _hashlib
import hmac as _hmac

def _generate_api_token(username: str) -> str:
    """Derive a per-user API token from the app secret key."""
    return _hmac.new(
        app.secret_key.encode() if isinstance(app.secret_key, str) else app.secret_key,
        f'valentine-api-token:{username}'.encode(),
        _hashlib.sha256
    ).hexdigest()

def _verify_api_token(token: str) -> bool:
    """Verify an API token against all known users."""
    with get_db() as conn:
        users = conn.execute(
            'SELECT username FROM users WHERE password_must_change = 0'
        ).fetchall()
    for user in users:
        expected = _generate_api_token(user['username'])
        if _hmac.compare_digest(token, expected):
            return True
    return False


async def _not_a_login_attempt() -> bool:
    """Only POSTs are login attempts; viewing the login page must not count."""
    return request.method != 'POST'


@app.route('/login', methods=['GET', 'POST'])
@rate_limit(5, timedelta(minutes=1), skip_function=_not_a_login_attempt)  # 5 login attempts per minute per IP
async def login():
    if request.method == 'POST':
        form = await request.form
        username = form.get('username')
        password = form.get('password')

        # Connect to DB and find user
        with get_db() as conn:
            cursor = conn.execute(
                'SELECT password_hash, role, password_must_change FROM users WHERE username = ?',
                (username,)
            )
            user = cursor.fetchone()

        # Verify user exists and password is correct
        if user and check_password_hash(user['password_hash'], password):
            # Store data in session
            session.clear()
            session['logged_in'] = True
            session['username'] = username
            session['role'] = user['role']
            session['api_token'] = _generate_api_token(username)

            # Check if password change is required
            if user['password_must_change']:
                session['password_must_change'] = True
                logger.info(f"User '{username}' must change password on first login.")
                return redirect(url_for('change_password'))

            logger.info(f"User '{username}' logged in successfully.")
            return redirect(url_for('index'))
        else:
            logger.warning(f"Failed login attempt for username: {username}")
            await flash("ACCESS DENIED: INVALID CREDENTIALS", "error")

    return await render_template('login.html', version=VERSION)


@app.route('/change-password', methods=['GET', 'POST'])
async def change_password():
    """Force password change on first login."""
    if 'logged_in' not in session:
        return redirect(url_for('login'))

    if request.method == 'POST':
        from werkzeug.security import generate_password_hash
        form = await request.form
        new_password = form.get('new_password', '')
        confirm_password = form.get('confirm_password', '')

        if len(new_password) < 12:
            await flash('PASSWORD MUST BE AT LEAST 12 CHARACTERS', 'error')
            return await render_template('change_password.html', version=VERSION)

        if new_password != confirm_password:
            await flash('PASSWORDS DO NOT MATCH', 'error')
            return await render_template('change_password.html', version=VERSION)

        with get_db() as conn:
            conn.execute(
                'UPDATE users SET password_hash = ?, password_must_change = 0 WHERE username = ?',
                (generate_password_hash(new_password), session['username'])
            )

        session.pop('password_must_change', None)
        logger.info(f"User '{session['username']}' changed password successfully.")
        await flash('PASSWORD UPDATED SUCCESSFULLY', 'success')
        return redirect(url_for('index'))

    return await render_template('change_password.html', version=VERSION)

@app.route('/')
async def index() -> str:
    tools = {
        'rtl_fm': check_tool('rtl_fm'),
        'multimon': check_tool('multimon-ng'),
        'rtl_433': check_tool('rtl_433'),
        'rtlamr': check_tool('rtlamr')
    }
    devices = [d.to_dict() for d in await detect_devices_async()]
    return await render_template(
        'index.html',
        tools=tools,
        devices=devices,
        version=VERSION,
        changelog=CHANGELOG,
        shared_observer_location=SHARED_OBSERVER_LOCATION_ENABLED,
        default_latitude=DEFAULT_LATITUDE,
        default_longitude=DEFAULT_LONGITUDE,
        api_token=session.get('api_token', ''),
    )


@app.route('/favicon.svg')
async def favicon() -> Response:
    return await send_file('favicon.svg', mimetype='image/svg+xml')


@app.route('/devices')
async def get_devices() -> Response:
    """Get all detected SDR devices with hardware type info."""
    # An explicit device list request (the Refresh button) re-detects
    devices = await detect_devices_async(max_age=0)
    return jsonify([d.to_dict() for d in devices])


@app.route('/devices/status')
async def get_devices_status() -> Response:
    """Get all SDR devices with usage status."""
    devices = await detect_devices_async()
    registry = get_sdr_device_status()

    result = []
    for device in devices:
        d = device.to_dict()
        key = sdr_device_key(device.index, device.sdr_type)
        d['in_use'] = key in registry
        d['used_by'] = registry.get(key)
        result.append(d)

    return jsonify(result)


@app.route('/devices/debug')
async def get_devices_debug() -> Response:
    """Get detailed SDR device detection diagnostics."""
    # The diagnostics run rtl_test, SoapySDRUtil and hackrf_info (seconds
    # each): collect them in a worker so other clients keep being served.
    return jsonify(await asyncio.to_thread(_collect_device_diagnostics))


def _collect_device_diagnostics() -> dict:
    """Run the SDR detection tools and gather their output (blocking)."""
    import shutil

    diagnostics = {
        'tools': {},
        'rtl_test': {},
        'soapy': {},
        'usb': {},
        'kernel_modules': {},
        'detected_devices': [],
        'suggestions': []
    }

    # Check for required tools
    diagnostics['tools']['rtl_test'] = shutil.which('rtl_test') is not None
    diagnostics['tools']['SoapySDRUtil'] = shutil.which('SoapySDRUtil') is not None
    diagnostics['tools']['lsusb'] = shutil.which('lsusb') is not None

    # Run rtl_test and capture full output
    if diagnostics['tools']['rtl_test']:
        try:
            result = subprocess.run(
                ['rtl_test', '-t'],
                capture_output=True,
                text=True,
                timeout=5
            )
            diagnostics['rtl_test'] = {
                'returncode': result.returncode,
                'stdout': result.stdout[:2000] if result.stdout else '',
                'stderr': result.stderr[:2000] if result.stderr else ''
            }

            # Check for common errors
            combined = (result.stdout or '') + (result.stderr or '')
            if 'No supported devices found' in combined:
                diagnostics['suggestions'].append('No RTL-SDR device detected. Check USB connection.')
            if 'usb_claim_interface error' in combined:
                diagnostics['suggestions'].append('Device busy - kernel DVB driver may have claimed it. Run: sudo modprobe -r dvb_usb_rtl28xxu')
            if 'Permission denied' in combined.lower():
                diagnostics['suggestions'].append('USB permission denied. Add udev rules or run as root.')

        except subprocess.TimeoutExpired:
            diagnostics['rtl_test'] = {'error': 'Timeout after 5 seconds'}
        except Exception as e:
            diagnostics['rtl_test'] = {'error': str(e)}
    else:
        diagnostics['suggestions'].append('rtl_test not found. Install rtl-sdr package.')

    # Run SoapySDRUtil
    if diagnostics['tools']['SoapySDRUtil']:
        try:
            result = subprocess.run(
                ['SoapySDRUtil', '--find'],
                capture_output=True,
                text=True,
                timeout=10
            )
            diagnostics['soapy'] = {
                'returncode': result.returncode,
                'stdout': result.stdout[:2000] if result.stdout else '',
                'stderr': result.stderr[:2000] if result.stderr else ''
            }
        except subprocess.TimeoutExpired:
            diagnostics['soapy'] = {'error': 'Timeout after 10 seconds'}
        except Exception as e:
            diagnostics['soapy'] = {'error': str(e)}

    # Check USB devices (Linux)
    if diagnostics['tools']['lsusb']:
        try:
            result = subprocess.run(
                ['lsusb'],
                capture_output=True,
                text=True,
                timeout=5
            )
            # Filter for common SDR vendor IDs
            sdr_vendors = ['0bda', '1d50', '1df7', '0403']  # Realtek, OpenMoko/HackRF, SDRplay, FTDI
            usb_lines = [l for l in result.stdout.split('\n')
                        if any(v in l.lower() for v in sdr_vendors) or 'rtl' in l.lower() or 'sdr' in l.lower()]
            diagnostics['usb']['devices'] = usb_lines if usb_lines else ['No SDR-related USB devices found']
        except Exception as e:
            diagnostics['usb'] = {'error': str(e)}

    # Check for loaded kernel modules that conflict (Linux)
    if platform.system() == 'Linux':
        try:
            result = subprocess.run(
                ['lsmod'],
                capture_output=True,
                text=True,
                timeout=5
            )
            conflicting = ['dvb_usb_rtl28xxu', 'rtl2832', 'rtl2830']
            loaded = [m for m in conflicting if m in result.stdout]
            diagnostics['kernel_modules']['conflicting_loaded'] = loaded
            if loaded:
                diagnostics['suggestions'].append(f"Conflicting kernel modules loaded: {', '.join(loaded)}. Run: sudo modprobe -r {' '.join(loaded)}")
        except Exception as e:
            diagnostics['kernel_modules'] = {'error': str(e)}

    # Get detected devices
    devices = SDRFactory.detect_devices()
    diagnostics['detected_devices'] = [d.to_dict() for d in devices]

    if not devices and not diagnostics['suggestions']:
        diagnostics['suggestions'].append('No devices detected. Check USB connection and driver installation.')

    return diagnostics


@app.route('/dependencies')
async def get_dependencies() -> Response:
    """Get status of all tool dependencies."""
    results = await asyncio.to_thread(check_all_dependencies)

    # Determine OS for install instructions
    system = platform.system().lower()
    if system == 'darwin':
        pkg_manager = 'brew'
    elif system == 'linux':
        pkg_manager = 'apt'
    else:
        pkg_manager = 'manual'

    return jsonify({
        'status': 'success',
        'os': system,
        'pkg_manager': pkg_manager,
        'modes': results
    })


@app.route('/export/aircraft', methods=['GET'])
async def export_aircraft() -> Response:
    """Export aircraft data as JSON or CSV."""
    import csv
    import io

    format_type = request.args.get('format', 'json').lower()

    if format_type == 'csv':
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(['icao', 'callsign', 'altitude', 'speed', 'heading', 'lat', 'lon', 'squawk', 'last_seen'])

        for icao, ac in adsb_aircraft.items():
            writer.writerow([
                icao,
                ac.get('callsign', '') if isinstance(ac, dict) else '',
                ac.get('altitude', '') if isinstance(ac, dict) else '',
                ac.get('speed', '') if isinstance(ac, dict) else '',
                ac.get('heading', '') if isinstance(ac, dict) else '',
                ac.get('lat', '') if isinstance(ac, dict) else '',
                ac.get('lon', '') if isinstance(ac, dict) else '',
                ac.get('squawk', '') if isinstance(ac, dict) else '',
                ac.get('lastSeen', '') if isinstance(ac, dict) else ''
            ])

        response = Response(output.getvalue(), mimetype='text/csv')
        response.headers['Content-Disposition'] = 'attachment; filename=aircraft.csv'
        return response
    else:
        return jsonify({
            'timestamp': __import__('datetime').datetime.utcnow().isoformat(),
            'aircraft': adsb_aircraft.values()
        })


@app.route('/export/wifi', methods=['GET'])
async def export_wifi() -> Response:
    """Export WiFi networks as JSON or CSV."""
    import csv
    import io

    format_type = request.args.get('format', 'json').lower()

    if format_type == 'csv':
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(['bssid', 'ssid', 'channel', 'signal', 'encryption', 'clients'])

        for bssid, net in wifi_networks.items():
            writer.writerow([
                bssid,
                net.get('ssid', '') if isinstance(net, dict) else '',
                net.get('channel', '') if isinstance(net, dict) else '',
                net.get('signal', '') if isinstance(net, dict) else '',
                net.get('encryption', '') if isinstance(net, dict) else '',
                net.get('clients', 0) if isinstance(net, dict) else 0
            ])

        response = Response(output.getvalue(), mimetype='text/csv')
        response.headers['Content-Disposition'] = 'attachment; filename=wifi_networks.csv'
        return response
    else:
        return jsonify({
            'timestamp': __import__('datetime').datetime.utcnow().isoformat(),
            'networks': wifi_networks.values(),
            'clients': wifi_clients.values()
        })


@app.route('/export/bluetooth', methods=['GET'])
async def export_bluetooth() -> Response:
    """Export Bluetooth devices as JSON or CSV."""
    import csv
    import io

    format_type = request.args.get('format', 'json').lower()

    if format_type == 'csv':
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(['mac', 'name', 'rssi', 'type', 'manufacturer', 'last_seen'])

        for mac, dev in bt_devices.items():
            writer.writerow([
                mac,
                dev.get('name', '') if isinstance(dev, dict) else '',
                dev.get('rssi', '') if isinstance(dev, dict) else '',
                dev.get('type', '') if isinstance(dev, dict) else '',
                dev.get('manufacturer', '') if isinstance(dev, dict) else '',
                dev.get('lastSeen', '') if isinstance(dev, dict) else ''
            ])

        response = Response(output.getvalue(), mimetype='text/csv')
        response.headers['Content-Disposition'] = 'attachment; filename=bluetooth_devices.csv'
        return response
    else:
        return jsonify({
            'timestamp': __import__('datetime').datetime.utcnow().isoformat(),
            'devices': bt_devices.values(),
            'beacons': bt_beacons.values()
        })


def _is_uat_running() -> bool:
    """Check if UAT decoder is running."""
    try:
        from routes.uat import uat_running
        return uat_running
    except ImportError:
        return False


@app.route('/health')
async def health_check() -> Response:
    """Health check endpoint for monitoring."""
    import time
    return jsonify({
        'status': 'healthy',
        'version': VERSION,
        'uptime_seconds': round(time.time() - _app_start_time, 2),
        'processes': {
            'pager': current_process is not None and (current_process.poll() is None if current_process else False),
            'sensor': sensor_process is not None and (sensor_process.poll() is None if sensor_process else False),
            'adsb': adsb_process is not None and (adsb_process.poll() is None if adsb_process else False),
            'ais': ais_process is not None and (ais_process.poll() is None if ais_process else False),
            'acars': acars_process is not None and (acars_process.poll() is None if acars_process else False),
            'aprs': aprs_process is not None and (aprs_process.poll() is None if aprs_process else False),
            'wifi': wifi_process is not None and (wifi_process.poll() is None if wifi_process else False),
            'bluetooth': bt_process is not None and (bt_process.poll() is None if bt_process else False),
            'dsc': dsc_process is not None and (dsc_process.poll() is None if dsc_process else False),
            'dmr': dmr_process is not None and (dmr_process.poll() is None if dmr_process else False),
            'uat': _is_uat_running(),
        },
        'data': {
            'aircraft_count': len(adsb_aircraft),
            'vessel_count': len(ais_vessels),
            'wifi_networks_count': len(wifi_networks),
            'wifi_clients_count': len(wifi_clients),
            'bt_devices_count': len(bt_devices),
            'dsc_messages_count': len(dsc_messages),
        }
    })


@app.route('/killall', methods=['POST'])
async def kill_all() -> Response:
    """Stop the processes owned by this app, including the selected ADS-B decoder."""
    result = await asyncio.to_thread(_stop_owned_receivers)
    return jsonify(result), (500 if result.get('errors') else 200)


def _stop_owned_receivers() -> dict:
    """Stop a snapshot of owned receivers without losing failed or newer handles."""
    from routes import adsb, ais, dmr, listening_post, rtlamr, uat, audio_websocket
    from routes import pager, sensor, acars, aprs, dsc, vdl2
    from utils.process import get_registered_processes, safe_terminate, register_process
    from utils.bluetooth import reset_bluetooth_scanner
    from utils.wifi.scanner import reset_wifi_scanner

    # Snapshot before any slow stop operation. A receiver started while this
    # worker runs belongs to the next session and must retain its ownership.
    allocations = _sdr_registry.snapshot()
    registered = get_registered_processes()
    application = sys.modules[__name__]
    active_slots = (
        (pager, 'pager_active_device', 'pager'), (sensor, 'sensor_active_device', 'sensor'),
        (acars, 'acars_active_device', 'acars'), (aprs, 'aprs_active_device', 'aprs'),
        (dsc, 'dsc_active_device', 'dsc'),
        (adsb, 'adsb_active_device', 'adsb'), (ais, 'ais_active_device', 'ais'),
        (dmr, 'dmr_active_device', 'dmr'), (rtlamr, 'rtlamr_active_device', 'rtlamr'),
        (uat, 'uat_active_device', 'uat'),
        (vdl2, 'vdl2_active_device', 'vdl2'),
        (listening_post, 'scanner_active_device', 'scanner'),
        (listening_post, 'listening_active_device', 'listening'),
        (listening_post, 'waterfall_active_device', 'waterfall'),
    )
    active_snapshot = [
        (module, name, mode, getattr(module, name, None))
        for module, name, mode in active_slots
    ]
    slots = [(application, name, mode) for name, mode in (
        ('current_process', 'pager'), ('sensor_process', 'sensor'),
        ('wifi_process', 'wifi'), ('bt_process', 'bluetooth'),
        ('adsb_process', 'adsb'), ('ais_process', 'ais'),
        ('acars_process', 'acars'), ('aprs_process', 'aprs'),
        ('aprs_rtl_process', 'aprs'), ('dsc_process', 'dsc'),
        ('dsc_rtl_process', 'dsc'), ('dmr_process', 'dmr'),
        ('dmr_rtl_process', 'dmr'), ('rtlamr_process', 'rtlamr'),
        ('satellite_process', 'satellite'), ('vdl2_process', 'vdl2'),
    )]
    slots.extend([
        (dmr, 'dmr_dsd_process', 'dmr'), (dmr, 'dmr_rtl_process', 'dmr'),
        (rtlamr, 'rtl_tcp_process', 'rtlamr'),
        (listening_post, 'scanner_power_process', 'scanner'),
        (listening_post, 'waterfall_process', 'waterfall'),
        (listening_post, 'audio_process', 'listening'),
        (listening_post, 'audio_rtl_process', 'listening'),
        (audio_websocket, 'audio_process', 'audio'),
        (audio_websocket, 'rtl_process', 'audio'),
        (uat, '_uat_dump978_process', 'uat'), (uat, '_uat_json_process', 'uat'),
    ])
    # Inspect existing singleton decoders without constructing idle instances,
    # which can probe tools or create output directories during Stop All.
    decoders = []
    for module_name, attribute, mode, process_name in (
        ('utils.sstv.sstv_decoder', '_decoder', 'sstv', '_rtl_process'),
        ('utils.sstv.sstv_decoder', '_general_decoder', 'sstv_general', '_rtl_process'),
        ('utils.weather_sat', '_decoder', 'weather_sat', '_process'),
    ):
        module = sys.modules.get(module_name)
        decoder = getattr(module, attribute, None) if module else None
        if decoder is not None:
            slots.append((decoder, process_name, mode))
            decoders.append(decoder)
    owned = [(module, name, mode, getattr(module, name, None)) for module, name, mode in slots]

    # Tell reader/scanner loops to stop before terminating their producers.
    adsb.adsb_using_service = False
    ais.ais_running = False
    dmr.dmr_running = False
    dmr.dmr_has_audio = False
    listening_post.scanner_running = False
    listening_post.waterfall_running = False
    listening_post.audio_running = False
    uat.uat_running = False
    for decoder in decoders:
        decoder._running = False

    stopped, errors, failed_modes = [], [], set()
    for name, stop in (
        ('bluetooth', reset_bluetooth_scanner),
        ('wifi', reset_wifi_scanner),
    ):
        try:
            stop()
        except Exception as exc:
            errors.append(f'{name}: {exc}')
            failed_modes.add(name)

    outcomes = {}

    def terminate(process, name):
        identity = id(process)
        if identity not in outcomes:
            try:
                safe_terminate(process)
                outcomes[identity] = process.poll() is not None
            except Exception as exc:
                errors.append(f'{name}: {exc}')
                outcomes[identity] = False
            if not outcomes[identity]:
                errors.append(f'{name}: process did not stop')
                # Keep an app-wide cleanup reference even for legacy processes
                # whose owner may independently reset its global handle.
                if not any(item is process for item in get_registered_processes()):
                    register_process(process)
        return outcomes[identity]

    for module, name, mode, process in owned:
        if process is None:
            continue
        if not terminate(process, name):
            failed_modes.add(mode)
        else:
            if getattr(module, name, None) is process:
                setattr(module, name, None)
            stopped.append(name)

    # Connection-owned capture processes have no module slot. Stop only the
    # initial registration snapshot, never newly registered receivers.
    unidentified_failure = False
    for process in registered:
        if not terminate(process, 'registered receiver'):
            if not any(old is process for _, _, _, old in owned):
                unidentified_failure = True

    new_modes = set()
    for module, name, mode, previous in owned:
        current = getattr(module, name, None)
        if current is not None and current is not previous:
            new_modes.add(mode)
    # A new WebSocket capture has no global slot to identify its device. Keep
    # its existing claim rather than freeing hardware that is already in use.
    if any(not any(current is old for old in registered)
           for current in get_registered_processes()
           if not any(current is old for _, _, _, old in owned)):
        new_modes.add('waterfall')

    blocked_modes = failed_modes | new_modes
    protocol_labels = {str(name).upper() for name in dmr.VALID_PROTOCOLS} | {'DMR'}

    def canonical_mode(owner):
        return 'dmr' if owner.upper() in protocol_labels else owner

    for module, name, mode, previous in active_snapshot:
        if (not unidentified_failure and mode not in blocked_modes
                and getattr(module, name, None) == previous):
            setattr(module, name, None)
    if not unidentified_failure:
        for key, (owner, lease) in allocations.items():
            if canonical_mode(owner) not in blocked_modes:
                _sdr_registry.release_key(key, owner, lease)
    result = {'status': 'error' if errors else 'killed', 'processes': stopped}
    if errors:
        result['errors'] = errors
    return result


# ============================================
# MODULE ORCHESTRATION
# ============================================

def _get_module_registry() -> dict:
    """Build registry mapping module names to (start_function, url_path).

    Lazy imports avoid circular dependencies and keep startup fast.
    Only SDR-backed modules with dedicated start routes are included.
    """
    from routes.adsb import start_adsb
    from routes.pager import start_decoding as start_pager
    from routes.sensor import start_sensor
    from routes.acars import start_acars
    from routes.ais import start_ais
    from routes.aprs import start_aprs
    from routes.dsc import start_decoding as start_dsc
    from routes.dmr import start_dmr
    from routes.rtlamr import start_rtlamr

    return {
        'adsb':   (start_adsb,   '/adsb/start'),
        'pager':  (start_pager,  '/start'),
        'sensor': (start_sensor, '/start_sensor'),
        'acars':  (start_acars,  '/acars/start'),
        'ais':    (start_ais,    '/ais/start'),
        'aprs':   (start_aprs,   '/aprs/start'),
        'dsc':    (start_dsc,    '/dsc/start'),
        'dmr':    (start_dmr,    '/dmr/start'),
        'rtlamr': (start_rtlamr, '/start_rtlamr'),
    }


@app.route('/start_enabled_modules', methods=['POST'])
async def start_enabled_modules() -> Response:
    """Start multiple SDR modules in a single call.

    Expects JSON: {"modules": ["adsb", "sensor"], "params": {"adsb": {...}, "sensor": {...}}}
    Each module's params are forwarded to its existing start route function.
    Returns per-module success/failure so the frontend can reflect real state.
    """
    import json as json_module

    data = await request.get_json(silent=True) or {}
    modules = data.get('modules', [])
    module_params = data.get('params', {})

    if not isinstance(modules, list) or not modules:
        return jsonify({
            'status': 'error',
            'message': 'modules must be a non-empty list'
        }), 400

    registry = _get_module_registry()
    valid_modules = list(registry.keys())
    results: dict[str, Any] = {}

    for module_name in modules:
        if module_name not in registry:
            results[module_name] = {
                'status': 'error',
                'message': f'Unknown module: {module_name}. Valid: {valid_modules}'
            }
            continue

        view_fn, url_path = registry[module_name]
        params = module_params.get(module_name, {})

        try:
            # Call the module's start function directly using a request context.
            # This is NOT HTTP loopback — it creates an in-memory request
            # context so the view function can access `request.get_json()`.
            async with app.test_request_context(
                url_path, method='POST', json=params
            ):
                raw_result = await view_fn()

                # Route functions return Response or (Response, status_code)
                if isinstance(raw_result, tuple):
                    resp_obj, status_code = raw_result[0], raw_result[1]
                else:
                    resp_obj = raw_result
                    status_code = resp_obj.status_code

                body = await resp_obj.get_data(as_text=True)
                result = json_module.loads(body)
                result['http_status'] = status_code
                results[module_name] = result

        except Exception as e:
            logger.exception(f"Orchestrator: failed to start {module_name}")
            results[module_name] = {
                'status': 'error',
                'message': str(e)
            }

    any_started = any(
        r.get('status') in ('started', 'already_running')
        for r in results.values()
    )
    return jsonify({
        'status': 'success' if any_started else 'error',
        'results': results
    })


def main() -> None:
    """Main entry point."""
    import argparse
    import config

    parser = argparse.ArgumentParser(
        description='VALENTINE RF - Signal Intelligence Platform',
        epilog='Environment variables: VALENTINE_HOST, VALENTINE_PORT, VALENTINE_DEBUG, VALENTINE_LOG_LEVEL'
    )
    parser.add_argument(
        '-p', '--port',
        type=int,
        default=config.PORT,
        help=f'Port to run server on (default: {config.PORT})'
    )
    parser.add_argument(
        '-H', '--host',
        default=config.HOST,
        help=f'Host to bind to (default: {config.HOST})'
    )
    parser.add_argument(
        '-d', '--debug',
        action='store_true',
        default=config.DEBUG,
        help='Enable debug mode'
    )
    parser.add_argument(
        '--check-deps',
        action='store_true',
        help='Check dependencies and exit'
    )
    args = parser.parse_args()

    # Check dependencies only
    if args.check_deps:
        results = check_all_dependencies()
        logger.info("Dependency Status:")
        for mode, info in results.items():
            status = "ready" if info['ready'] else "missing"
            logger.info(f"  {info['name']}: {status}")
            for tool, tool_info in info['tools'].items():
                tool_status = "installed" if tool_info['installed'] else "missing"
                req = " (required)" if tool_info['required'] else ""
                logger.info(f"    {tool}: {tool_status}{req}")
        sys.exit(0)

    logger.info("=" * 50)
    logger.info("  VALENTINE RF // Signal Intelligence")
    logger.info("  Pager / 433MHz / Aircraft / ACARS / Satellite / WiFi / BT")
    logger.info("=" * 50)

    # Check if running as root (required for WiFi monitor mode, some BT operations)
    import os
    if os.geteuid() != 0:
        logger.warning("Not running as root/sudo. Some features require root privileges: "
                        "WiFi monitor mode, Bluetooth low-level operations, RTL-SDR access.")
        # Store for API access
        app.config['RUNNING_AS_ROOT'] = False
    else:
        app.config['RUNNING_AS_ROOT'] = True
        logger.info("Running as root - full capabilities enabled")

    # Clean up any stale processes from previous runs
    cleanup_stale_processes()

    # Initialize database for settings storage
    from utils.database import init_db
    init_db()

    # Register database cleanup functions
    from utils.database import (
        cleanup_old_signal_history,
        cleanup_old_timeline_entries,
        cleanup_old_dsc_alerts,
        cleanup_old_payloads
    )
    cleanup_manager.register_db_cleanup(cleanup_old_signal_history, interval_multiplier=1440)  # Every 24 hours
    cleanup_manager.register_db_cleanup(cleanup_old_timeline_entries, interval_multiplier=1440)  # Every 24 hours
    cleanup_manager.register_db_cleanup(cleanup_old_dsc_alerts, interval_multiplier=1440)  # Every 24 hours
    cleanup_manager.register_db_cleanup(cleanup_old_payloads, interval_multiplier=1440)  # Every 24 hours

    # Start automatic cleanup of stale data entries
    cleanup_manager.start()

    # Register blueprints
    from routes import register_blueprints
    register_blueprints(app)

    # Initialize TLE auto-refresh (must be after blueprint registration)
    try:
        from routes.satellite import init_tle_auto_refresh
        import os
        if not os.environ.get('TESTING'):
            init_tle_auto_refresh()
    except Exception as e:
        logger.warning(f"Failed to initialize TLE auto-refresh: {e}")

    # Update TLE data in background thread (non-blocking)
    def update_tle_background():
        try:
            from routes.satellite import refresh_tle_data
            logger.info("Updating satellite TLE data from CelesTrak...")
            updated = refresh_tle_data()
            if updated:
                logger.info(f"TLE data updated for: {', '.join(updated)}")
            else:
                logger.info("TLE update: No satellites updated (may be offline)")
        except Exception as e:
            logger.warning(f"TLE update failed (will use cached data): {e}")

    tle_thread = threading.Thread(target=update_tle_background, daemon=True)
    tle_thread.start()

    # Initialize WebSocket for audio streaming
    try:
        from routes.audio_websocket import init_audio_websocket
        init_audio_websocket(app)
        logger.info("WebSocket audio streaming enabled")
    except ImportError as e:
        logger.warning(f"WebSocket audio disabled: {e}")

    # Initialize KiwiSDR WebSocket audio proxy
    try:
        from routes.websdr import init_websdr_audio
        init_websdr_audio(app)
        logger.info("KiwiSDR audio proxy enabled")
    except ImportError as e:
        logger.warning(f"KiwiSDR audio proxy disabled: {e}")

    # Initialize WebSocket for waterfall streaming
    try:
        from routes.waterfall_websocket import init_waterfall_websocket
        init_waterfall_websocket(app)
        logger.info("WebSocket waterfall streaming enabled")
    except ImportError as e:
        logger.warning(f"WebSocket waterfall disabled: {e}")

    logger.info(f"Open http://localhost:{args.port} in your browser")
    logger.info("Press Ctrl+C to stop")

    @app.after_serving
    async def shutdown_cleanup():
        """Ensure subprocesses and SDR resources are cleaned up on shutdown."""
        logger.info("Shutting down — cleaning up subprocesses and resources...")
        cleanup_all_processes()
        from utils.database import close_db
        close_db()
        logger.info("Shutdown cleanup complete.")

# Quart uses Hypercorn as its ASGI server (replaces Flask's threaded Werkzeug).
    # This eliminates the thread-per-SSE-connection bottleneck.
    app.run(
        host=args.host,
        port=args.port,
        debug=args.debug,
    )
