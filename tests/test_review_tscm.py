"""Regression tests from the TSCM stability review.

Everything here is hardware-free: device detection and every scan function
are replaced by fakes, and the database lives in a temporary directory.
"""

import asyncio
import json
import threading
import time
from types import SimpleNamespace

import pytest

import routes.tscm as tscm
from utils.sse import EventQueue


@pytest.fixture
async def auth_client(client):
    """Client with logged-in session."""
    async with client.session_transaction() as sess:
        sess['logged_in'] = True
    return client


@pytest.fixture
def tscm_env(tmp_path, monkeypatch):
    """Isolated TSCM route state: temp DB, private event queue, fake radios."""
    import utils.database as database

    monkeypatch.setattr(database, 'DB_DIR', tmp_path)
    monkeypatch.setattr(database, 'DB_PATH', tmp_path / 'tscm_review.db')
    database.init_db()

    events = EventQueue(maxsize=1000)
    monkeypatch.setattr(tscm, 'tscm_queue', events)

    # The sweep loop sleeps two seconds per pass; keep the tests fast without
    # touching the real time module other threads use.
    real_sleep = time.sleep
    monkeypatch.setattr(tscm, 'time', SimpleNamespace(
        time=time.time,
        sleep=lambda seconds: real_sleep(min(seconds, 0.01)),
    ))

    calls = {'device_check_threads': []}

    def fake_check(wifi, bt, rf):
        calls['device_check_threads'].append(threading.get_ident())
        return {
            'wifi': bool(wifi), 'bluetooth': bool(bt), 'rf': bool(rf),
            'wifi_reason': 'fake', 'bt_reason': 'fake', 'rf_reason': 'fake',
        }

    monkeypatch.setattr(tscm, '_check_available_devices', fake_check)
    monkeypatch.setattr(tscm, '_scan_wifi_networks', lambda interface: [])
    monkeypatch.setattr(tscm, '_scan_wifi_clients', lambda interface: [])
    monkeypatch.setattr(tscm, '_scan_bluetooth_devices', lambda interface, duration=10: [])
    monkeypatch.setattr(tscm, 'get_tscm_bluetooth_snapshot', lambda duration=8: [], raising=False)
    monkeypatch.setattr(tscm, '_scan_rf_signals', lambda *args, **kwargs: [])
    monkeypatch.setattr(tscm, 'get_sweep_preset', lambda name: {
        'name': 'test', 'description': 'test', 'duration_seconds': 0.05, 'ranges': [],
    })

    monkeypatch.setattr(tscm, '_sweep_running', False)
    monkeypatch.setattr(tscm, '_current_sweep_id', None)
    monkeypatch.setattr(tscm, '_sweep_thread', None)

    env = SimpleNamespace(events=events, calls=calls, threads=[], release=[])
    yield env

    tscm._sweep_running = False
    for release in env.release:
        release.set()
    for thread in env.threads + [tscm._sweep_thread]:
        if thread is not None and thread.is_alive():
            thread.join(timeout=5)


def _history(events):
    with events.mutex:
        return [dict(item) for item in events.queue]


async def _wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.01)
    return predicate()


async def _start(auth_client, **body):
    payload = {'sweep_type': 'quick', 'wifi': True, 'bluetooth': False, 'rf': False}
    payload.update(body)
    response = await auth_client.post('/tscm/sweep/start', json=payload)
    data = await response.get_json()
    return response.status_code, data


def _parse_sse(raw):
    events = []
    for block in raw.decode().split('\n\n'):
        for line in block.split('\n'):
            if line.startswith('data: '):
                events.append(json.loads(line[6:]))
    return events


async def _run_one_sweep_to_completion(auth_client, env):
    status, data = await _start(auth_client)
    assert status == 200 and data['status'] == 'success', data
    env.threads.append(tscm._sweep_thread)
    assert await _wait_for(
        lambda: any(e['type'] == 'sweep_completed' for e in _history(env.events))
        and not tscm._sweep_running
    )
    return data['sweep_id']


# ---------------------------------------------------------------------------
# Sweep stream sessions
# ---------------------------------------------------------------------------

async def test_stream_of_second_sweep_does_not_replay_first_sweep(auth_client, tscm_env, monkeypatch):
    """A viewer of sweep #2 must not be told that sweep #1 completed.

    The UI calls completeTscmSweep() on a replayed 'sweep_completed' and
    POSTs /tscm/sweep/stop on a replayed 'sweep_stopped', so a replay ends or
    aborts the sweep that was just started.
    """
    first_id = await _run_one_sweep_to_completion(auth_client, tscm_env)

    # Sweep #2 stays inside its first WiFi scan until the test releases it.
    release = threading.Event()
    tscm_env.release.append(release)
    monkeypatch.setattr(tscm, '_scan_wifi_networks', lambda interface: release.wait(5) and [])

    status, data = await _start(auth_client)
    assert status == 200 and data['status'] == 'success', data
    second_id = data['sweep_id']
    tscm_env.threads.append(tscm._sweep_thread)
    assert second_id != first_id

    received = b''
    async with auth_client.request('/tscm/sweep/stream', method='GET') as connection:
        deadline = time.monotonic() + 0.6
        while time.monotonic() < deadline:
            try:
                received += await asyncio.wait_for(connection.receive(), 0.1)
            except asyncio.TimeoutError:
                continue
        await connection.disconnect()

    seen = [e for e in _parse_sse(received) if e.get('type') != 'keepalive']
    assert not [e for e in seen if e['type'] in ('sweep_completed', 'sweep_stopped')], seen
    assert all(e.get('sweep_id') in (None, second_id) for e in seen), seen
    assert [e for e in seen if e['type'] == 'sweep_started' and e['sweep_id'] == second_id], seen


# ---------------------------------------------------------------------------
# Sweep thread identity
# ---------------------------------------------------------------------------

async def test_stopped_sweep_thread_cannot_clobber_the_next_sweep(auth_client, tscm_env, monkeypatch):
    """Stop + immediate restart: the old worker is still inside a scan.

    When that scan returns the old worker must neither carry on as a second
    sweep, nor report completion for / write results into the new sweep, nor
    reset the running flag the new sweep owns.
    """
    import utils.database as database

    gates = [threading.Event(), threading.Event()]
    tscm_env.release.extend(gates)
    entered = []

    def blocking_scan(interface):
        gate = gates[min(len(entered), 1)]
        entered.append(threading.current_thread())
        gate.wait(5)
        return []

    monkeypatch.setattr(tscm, '_scan_wifi_networks', blocking_scan)

    status, first = await _start(auth_client)
    assert status == 200, first
    first_thread = tscm._sweep_thread
    tscm_env.threads.append(first_thread)
    assert await _wait_for(lambda: len(entered) == 1)

    response = await auth_client.post('/tscm/sweep/stop')
    assert (await response.get_json())['status'] == 'success'

    status, second = await _start(auth_client)
    assert status == 200 and second['status'] == 'success', second
    second_thread = tscm._sweep_thread
    tscm_env.threads.append(second_thread)
    assert second_thread is not first_thread
    assert await _wait_for(lambda: len(entered) == 2)

    # The first sweep's scan finally returns while sweep #2 is running.
    gates[0].set()
    await asyncio.to_thread(first_thread.join, 5)
    assert not first_thread.is_alive()

    assert tscm._sweep_running is True
    assert tscm._current_sweep_id == second['sweep_id']
    assert second_thread.is_alive()
    seen = _history(tscm_env.events)
    assert not [e for e in seen if e['type'] in ('sweep_completed', 'sweep_error')], seen
    assert database.get_tscm_sweep(second['sweep_id'])['status'] == 'running'
    assert len(entered) == 2, 'the stopped worker went on scanning as a second sweep'

    gates[1].set()
    await asyncio.to_thread(second_thread.join, 5)
    completed = [e for e in _history(tscm_env.events) if e['type'] == 'sweep_completed']
    assert [e['sweep_id'] for e in completed] == [second['sweep_id']]
    assert tscm._sweep_running is False


# ---------------------------------------------------------------------------
# Sweep start: event loop and concurrent starts
# ---------------------------------------------------------------------------

async def test_sweep_start_probes_devices_off_the_event_loop(auth_client, tscm_env):
    """Device probing runs rtl_test / hackrf_info / SoapySDRUtil / hciconfig
    (seconds of subprocess time); on the loop it freezes every SSE, waterfall
    and audio client for that long."""
    import utils.database as database

    loop_thread = threading.get_ident()

    status, data = await _start(auth_client)
    assert status == 200, data
    tscm_env.threads.append(tscm._sweep_thread)
    assert tscm_env.calls['device_check_threads'][-1] != loop_thread

    assert await _wait_for(lambda: not tscm._sweep_running)
    schedule_id = database.create_tscm_schedule(
        name='nightly', cron_expression='0 3 1 1 *', enabled=False)
    response = await auth_client.post(f'/tscm/schedules/{schedule_id}/run')
    assert response.status_code == 200, await response.get_json()
    tscm_env.threads.append(tscm._sweep_thread)
    assert len(tscm_env.calls['device_check_threads']) == 2
    assert tscm_env.calls['device_check_threads'][-1] != loop_thread


async def test_concurrent_sweep_starts_launch_exactly_one_sweep(tscm_env, monkeypatch):
    """The scheduler thread and a browser start (or a double click) both
    passed the 'already running' check during the slow device probe."""
    both_probing = threading.Barrier(2, timeout=0.5)

    def slow_check(wifi, bt, rf):
        try:
            both_probing.wait()
        except threading.BrokenBarrierError:
            pass
        return {'wifi': True, 'bluetooth': False, 'rf': False,
                'wifi_reason': '', 'bt_reason': '', 'rf_reason': ''}

    monkeypatch.setattr(tscm, '_check_available_devices', slow_check)
    release = threading.Event()
    tscm_env.release.append(release)
    started_threads = []

    def held_scan(interface):
        started_threads.append(threading.current_thread())
        release.wait(5)
        return []

    monkeypatch.setattr(tscm, '_scan_wifi_networks', held_scan)

    def start():
        return tscm._start_sweep_internal(
            sweep_type='quick', baseline_id=None,
            wifi_enabled=True, bt_enabled=False, rf_enabled=False)

    results = await asyncio.gather(asyncio.to_thread(start), asyncio.to_thread(start))
    await asyncio.sleep(0.1)
    tscm_env.threads.extend(started_threads)

    assert sorted(r['status'] for r in results) == ['error', 'success'], results
    assert [r.get('http_status') for r in results if r['status'] == 'error'] == [409]
    assert len(started_threads) == 1


# ---------------------------------------------------------------------------
# Hardware probing in other handlers
# ---------------------------------------------------------------------------

@pytest.fixture
def probe_threads(monkeypatch):
    """Replace every hardware probe with a fake that records its thread."""
    import subprocess

    import utils.sdr
    import utils.tscm.advanced as advanced

    seen = {'sdr': [], 'capabilities': []}

    def no_tool(*args, **kwargs):
        raise FileNotFoundError('no radios in tests')

    def fake_detect():
        seen['sdr'].append(threading.get_ident())
        return []

    def fake_capabilities(*args, **kwargs):
        seen['capabilities'].append(threading.get_ident())
        return advanced.SweepCapabilities()

    monkeypatch.setattr(subprocess, 'run', no_tool)
    monkeypatch.setattr(utils.sdr.SDRFactory, 'detect_devices', staticmethod(fake_detect))
    monkeypatch.setattr(advanced, 'detect_sweep_capabilities', fake_capabilities)
    return seen


async def test_device_and_capability_probes_run_off_the_event_loop(auth_client, tscm_env, probe_threads):
    """SDR detection (rtl_test, hackrf_info, SoapySDRUtil: up to 20 s of
    subprocess timeouts) and the capability probe (iw, hciconfig, SDR
    detection) must not run on the loop that serves every stream."""
    import utils.database as database

    loop_thread = threading.get_ident()

    response = await auth_client.get('/tscm/devices')
    assert response.status_code == 200
    assert probe_threads['sdr'] and loop_thread not in probe_threads['sdr']

    response = await auth_client.get('/tscm/capabilities?wifi_interface=wlan0')
    assert response.status_code == 200
    assert len(probe_threads['capabilities']) == 1

    sweep_id = database.create_tscm_sweep('quick')
    database.update_tscm_sweep(sweep_id, status='completed', results={'wifi_count': 0}, completed=True)
    response = await auth_client.get(f'/tscm/report/pdf?sweep_id={sweep_id}')
    assert response.status_code == 200, await response.get_data()
    response = await auth_client.get(f'/tscm/report/annex?sweep_id={sweep_id}')
    assert response.status_code == 200, await response.get_data()
    assert len(probe_threads['capabilities']) == 3
    assert loop_thread not in probe_threads['capabilities']


# ---------------------------------------------------------------------------
# Threat detector
# ---------------------------------------------------------------------------

BASELINE = {
    'id': 1,
    'name': 'office',
    'wifi_networks': [{'bssid': 'AA:BB:CC:00:00:01', 'essid': 'Office', 'channel': 6,
                       'power': -55, 'encryption': 'WPA2'}],
    'wifi_clients': [],
    'bt_devices': [{'mac': '11:22:33:44:55:66', 'name': 'Desk speaker'}],
    'rf_frequencies': [{'frequency': 433.9}],
}


def test_classifying_a_baseline_wifi_network_does_not_raise():
    """A WiFi AP that IS in the baseline took a branch that never assigned
    signal_val and then read it (UnboundLocalError)."""
    from utils.tscm.detector import ThreatDetector

    detector = ThreatDetector(BASELINE)
    result = detector.classify_wifi_device(
        {'bssid': 'aa:bb:cc:00:00:01', 'essid': 'Office', 'power': '-48', 'channel': 6})
    assert result['in_baseline'] is True
    assert result['classification'] == 'informational'
    assert result['signal_strength'] == 'strong'


async def test_baseline_sweep_reports_known_wifi_networks(auth_client, tscm_env, monkeypatch):
    """With a baseline selected, every known AP vanished from the device
    list and from the correlation profiles (the per-device handler raised)."""
    import utils.database as database
    from utils.tscm.correlation import reset_correlation_engine

    reset_correlation_engine()
    baseline_id = database.create_tscm_baseline(name='office')
    database.update_tscm_baseline(baseline_id, wifi_networks=BASELINE['wifi_networks'])
    monkeypatch.setattr(tscm, '_scan_wifi_networks', lambda interface: [
        {'bssid': 'AA:BB:CC:00:00:01', 'essid': 'Office', 'power': '-48', 'channel': 6, 'privacy': 'WPA2'},
        {'bssid': 'AA:BB:CC:00:00:02', 'essid': 'Guest', 'power': '-60', 'channel': 11, 'privacy': 'WPA2'},
    ])

    status, data = await _start(auth_client, baseline_id=baseline_id)
    assert status == 200, data
    tscm_env.threads.append(tscm._sweep_thread)
    assert await _wait_for(lambda: not tscm._sweep_running)

    devices = {e['bssid']: e for e in _history(tscm_env.events) if e['type'] == 'wifi_device'}
    assert set(devices) == {'AA:BB:CC:00:00:01', 'AA:BB:CC:00:00:02'}
    assert devices['AA:BB:CC:00:00:01']['is_new'] is False
    assert devices['AA:BB:CC:00:00:02']['is_new'] is True
    reset_correlation_engine()
