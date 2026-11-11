"""Sub-GHz, BT Locate and analytics: modules restored from origin/main that
could not load (missing constants and IRK extractor) or crashed on every
POST (request bodies read without await)."""

from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from quart import Quart

import app as app_module
from routes import analytics, bt_locate, subghz
from utils.bluetooth.irk_extractor import get_paired_irks
from utils.bt_locate import resolve_rpa
from utils.sdr.registry import SDRDeviceRegistry

# Bluetooth Core Spec Vol 3 Part H, Appendix D.7: ah(IRK, 0x708194) = 0x0dfbaa
SPEC_IRK = 'ec0234a357c8ad05341010a60a397d9b'
SPEC_RPA = '70:81:94:0D:FB:AA'


# ---------------------------------------------------------------- IRK extractor

def write_bluez_device(root, adapter, device, key_hex, name='Phone'):
    folder = root / adapter / device
    folder.mkdir(parents=True)
    (folder / 'info').write_text(
        f'[General]\nName={name}\nAddressType=public\n\n'
        f'[IdentityResolvingKey]\nKey={key_hex}\n\n[LinkKey]\nKey=00112233445566778899AABBCCDDEEFF\n')


def test_paired_irks_are_returned_in_spec_order_and_resolve(tmp_path):
    # BlueZ stores the key as received over SMP: least significant byte first
    stored = bytes.fromhex(SPEC_IRK)[::-1].hex().upper()
    write_bluez_device(tmp_path, '00:1A:7D:DA:71:13', 'AA:BB:CC:DD:EE:01', stored)
    write_bluez_device(tmp_path, '00:1A:7D:DA:71:13', 'AA:BB:CC:DD:EE:02', 'not-hex')
    (tmp_path / '00:1A:7D:DA:71:13' / 'cache').mkdir()

    devices = get_paired_irks(tmp_path)

    assert [d['address'] for d in devices] == ['AA:BB:CC:DD:EE:01']
    assert devices[0]['name'] == 'Phone' and devices[0]['adapter'] == '00:1A:7D:DA:71:13'
    assert devices[0]['irk_hex'] == SPEC_IRK
    assert resolve_rpa(bytes.fromhex(devices[0]['irk_hex']), SPEC_RPA)


def test_missing_bluez_storage_means_no_devices(tmp_path):
    assert get_paired_irks(tmp_path / 'absent') == []


@pytest.mark.skipif(os.geteuid() == 0, reason='root can read anything')
def test_unreadable_bluez_storage_is_reported(tmp_path):
    tmp_path.chmod(0)
    try:
        with pytest.raises(PermissionError):
            get_paired_irks(tmp_path)
    finally:
        tmp_path.chmod(0o700)


# ---------------------------------------------------------------- BT Locate routes

@pytest.fixture
def locate_client(monkeypatch):
    app = Quart(__name__)
    app.config['TESTING'] = True
    app.register_blueprint(bt_locate.bt_locate_bp)
    app.register_blueprint(analytics.analytics_bp)
    return app.test_client()


async def test_resolve_rpa_endpoint_reads_the_json_body(locate_client):
    response = await locate_client.post('/bt_locate/resolve_rpa', json={'irk_hex': SPEC_IRK, 'address': SPEC_RPA})
    assert response.status_code == 200, await response.get_data(as_text=True)
    assert (await response.get_json())['resolved'] is True


async def test_locate_start_reads_the_body_and_runs_off_the_loop(locate_client, monkeypatch):
    loop_thread = __import__('threading').get_ident()
    calls = []

    def start(target, *args):
        calls.append((target.mac_address, __import__('threading').get_ident()))
        return SimpleNamespace(get_status=lambda include_debug=False: {'active': True})

    monkeypatch.setattr(bt_locate, 'start_locate_session', start)
    response = await locate_client.post('/bt_locate/start', json={'mac_address': 'AA:BB:CC:DD:EE:FF'})

    assert response.status_code == 200, await response.get_data(as_text=True)
    assert calls and calls[0][0] == 'AA:BB:CC:DD:EE:FF'
    assert calls[0][1] != loop_thread


async def test_paired_irks_endpoint_reports_permission_problems(locate_client, monkeypatch):
    monkeypatch.setattr(bt_locate, 'get_paired_irks', Mock(side_effect=PermissionError('requires root')))
    response = await locate_client.get('/bt_locate/paired_irks')
    body = await response.get_json()
    assert body['devices'] == [] and 'root' in body['error']


async def test_locate_stream_is_open_ended(locate_client, monkeypatch):
    monkeypatch.setattr(bt_locate, 'get_locate_session', lambda: None)
    app = Quart(__name__)
    async with app.test_request_context('/bt_locate/stream'):
        handler_response = await bt_locate.stream_detections()
    assert handler_response.timeout is None          # no total-response deadline
    response = await locate_client.get('/bt_locate/stream')
    assert 'session_ended' in await response.get_data(as_text=True)


async def test_creating_a_geofence_reads_the_json_body(locate_client, monkeypatch):
    manager = Mock()
    manager.add_zone.return_value = 7
    monkeypatch.setattr(analytics, 'get_geofence_manager', lambda: manager)
    response = await locate_client.post('/analytics/geofences',
                                        json={'name': 'Yard', 'lat': 36.1, 'lon': -94.1, 'radius_m': 50})
    assert response.status_code == 200, await response.get_data(as_text=True)
    assert (await response.get_json())['zone_id'] == 7


# ---------------------------------------------------------------- Sub-GHz

def test_transmit_is_limited_to_ism_bands():
    from utils.subghz import SubGhzManager

    assert SubGhzManager.validate_tx_frequency(433_920_000) is None
    assert SubGhzManager.validate_tx_frequency(915_000_000) is None
    assert 'outside allowed TX bands' in SubGhzManager.validate_tx_frequency(145_500_000)
    assert 'outside allowed TX bands' in SubGhzManager.validate_tx_frequency(1_090_000_000)


class FakeManager:
    """Stands in for SubGhzManager (whose constructor creates data/subghz)."""

    def __init__(self):
        self.active_mode = 'idle'
        self.callback = None

    def set_callback(self, callback):
        self.callback = callback

    def start_receive(self, **kwargs):
        self.active_mode = 'rx'
        return {'status': 'started', 'frequency_hz': kwargs['frequency_hz']}

    def stop_receive(self):
        self.active_mode = 'idle'
        return {'status': 'stopped'}

    def start_sweep(self, **kwargs):
        return {'status': 'error', 'message': 'hackrf_sweep not found'}

    def get_status(self):
        return {'mode': self.active_mode}


@pytest.fixture
def subghz_env(monkeypatch):
    registry = SDRDeviceRegistry(probe=lambda device: None)
    monkeypatch.setattr(app_module, '_sdr_registry', registry)
    manager = FakeManager()
    monkeypatch.setattr(subghz, 'get_subghz_manager', lambda: manager)
    monkeypatch.setattr(subghz, '_hackrf_claimed', False)
    app = Quart(__name__)
    app.config['TESTING'] = True
    app.register_blueprint(subghz.subghz_bp)
    return SimpleNamespace(client=app.test_client(), registry=registry, manager=manager)


async def test_receive_reads_the_body_and_reserves_the_hackrf(subghz_env):
    response = await subghz_env.client.post('/subghz/receive/start', json={'frequency_hz': 433920000})
    assert response.status_code == 200, await response.get_data(as_text=True)
    assert (await response.get_json())['frequency_hz'] == 433920000
    assert subghz_env.registry.status() == {'hackrf:0': 'subghz'}

    # Another mode cannot open the HackRF meanwhile
    assert 'in use by subghz' in subghz_env.registry.claim(0, 'waterfall', 'hackrf')

    response = await subghz_env.client.post('/subghz/receive/stop')
    assert response.status_code == 200
    assert subghz_env.registry.status() == {}


async def test_busy_hackrf_is_reported_and_nothing_starts(subghz_env):
    assert subghz_env.registry.claim(0, 'waterfall', 'hackrf') is None
    response = await subghz_env.client.post('/subghz/receive/start', json={'frequency_hz': 433920000})
    assert response.status_code == 409
    assert (await response.get_json())['error_type'] == 'DEVICE_BUSY'
    assert subghz_env.manager.active_mode == 'idle'


async def test_failed_start_gives_the_hackrf_back(subghz_env):
    response = await subghz_env.client.post('/subghz/sweep/start', json={'freq_start_mhz': 300, 'freq_end_mhz': 928})
    assert response.status_code == 409
    assert subghz_env.registry.status() == {}


async def test_a_session_that_ended_by_itself_releases_the_hackrf(subghz_env):
    await subghz_env.client.post('/subghz/receive/start', json={'frequency_hz': 433920000})
    subghz_env.manager.active_mode = 'idle'          # capture finished on its own
    await subghz_env.client.get('/subghz/status')     # the UI polls status
    assert subghz_env.registry.status() == {}


async def test_subghz_stream_is_open_ended(subghz_env):
    async with subghz_env.client.request('/subghz/stream') as connection:
        subghz._subghz_queue.put({'type': 'info', 'text': 'hello'})
        chunk = await asyncio.wait_for(connection.receive(), 5)
        assert b'hello' in chunk
        await connection.disconnect()


# ---------------------------------------------------------------- BT Locate session plumbing

def test_scanner_supports_multiple_device_listeners():
    """BT Locate registers with add_device_callback, which the scanner lacked:
    every locate session failed to start with AttributeError."""
    from utils.bluetooth.scanner import BluetoothScanner

    scanner = BluetoothScanner()
    seen, failing = [], Mock(side_effect=RuntimeError('listener bug'))
    scanner.add_device_callback(failing)
    scanner.add_device_callback(seen.append)
    scanner.add_device_callback(seen.append)            # duplicates are ignored
    device = Mock()
    scanner._aggregator = Mock(ingest=Mock(return_value=device), device_count=1)
    scanner._heuristics = Mock()

    scanner._handle_observation(Mock())

    assert seen == [device]                             # a failing listener does not stop the others
    scanner.remove_device_callback(seen.append)
    scanner.remove_device_callback(seen.append)         # removing twice is harmless
    scanner._handle_observation(Mock())
    assert seen == [device]


def test_failed_locate_start_leaves_no_session(monkeypatch):
    """A start that raised used to leave a half-built session registered, so
    /status and /stop returned 500 until the app restarted."""
    import utils.bt_locate as locate

    monkeypatch.setattr(locate, '_session', None)
    monkeypatch.setattr(locate.LocateSession, 'start', Mock(side_effect=AttributeError('boom')))
    with pytest.raises(AttributeError):
        locate.start_locate_session(locate.LocateTarget(mac_address='AA:BB:CC:DD:EE:FF'))
    assert locate.get_locate_session() is None
