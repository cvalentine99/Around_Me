"""Stability regressions found in the aircraft slice review (ADS-B, ACARS, UAT).

Every test here is hardware free: decoders are fake processes, sockets are
fakes, and the app-wide queues/registry are replaced per test.
"""

import asyncio
import os
import time
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from quart import Quart

from routes import acars, adsb, uat
from utils.sdr import SDRType
from utils.sdr.registry import SDRDeviceRegistry
from utils.sse import EventQueue


# A handler that sleeps, spawns or probes on the event loop stalls every other
# client for that long. The fakes below take SLOW seconds; a healthy handler
# keeps the loop responsive well inside STALL_LIMIT while they run.
SLOW = 0.3
STALL_LIMIT = 0.15


async def run_measuring_loop_stall(awaitable):
    """Await a request while a heartbeat records the longest loop stall."""
    gaps = []
    finished = False

    async def heartbeat():
        last = time.perf_counter()
        while not finished:
            await asyncio.sleep(0.01)
            now = time.perf_counter()
            gaps.append(now - last)
            last = now

    beat = asyncio.create_task(heartbeat())
    await asyncio.sleep(0)
    try:
        result = await awaitable
    finally:
        finished = True
        await beat
    return result, max(gaps, default=0.0)


def fake_process(*, running=True, stdout=b'', stderr=b'', pid=4321):
    process = Mock(pid=pid, stdout=BytesIO(stdout), stderr=BytesIO(stderr))
    process.poll.return_value = None if running else 1

    def finish(*args, **kwargs):
        process.poll.return_value = 0
        return 0

    process.wait.side_effect = finish
    return process


@pytest.fixture
def aircraft(monkeypatch):
    """Aircraft blueprints on an isolated app with fake receivers."""
    import app as app_module

    # Fake processes carry made-up pids: never let a real signal reach them.
    monkeypatch.setattr(os, 'getpgid', Mock(side_effect=lambda pid: pid))
    monkeypatch.setattr(os, 'killpg', Mock())
    registry = SDRDeviceRegistry(probe=lambda device: None)
    monkeypatch.setattr(app_module, '_sdr_registry', registry)
    monkeypatch.setattr(app_module, 'sdr_device_registry', registry.allocations)
    monkeypatch.setattr(app_module, 'sdr_device_registry_lock', registry.lock)
    monkeypatch.setattr(app_module, 'acars_process', None)
    monkeypatch.setattr(app_module, 'adsb_process', None)
    monkeypatch.setattr(app_module, 'acars_queue', EventQueue(maxsize=100))
    monkeypatch.setattr(app_module, 'adsb_queue', EventQueue(maxsize=100))
    app_module.adsb_aircraft.clear()

    monkeypatch.setattr(acars, 'acars_active_device', None)
    monkeypatch.setattr(acars, 'find_acarsdec', Mock(return_value='/mock/acarsdec'))
    monkeypatch.setattr(acars, 'get_acarsdec_json_flag', lambda path: '-j')
    monkeypatch.setattr(acars, 'PROCESS_START_WAIT', 0)
    monkeypatch.setattr(acars, 'register_process', Mock())
    monkeypatch.setattr(acars, 'unregister_process', Mock())

    monkeypatch.setattr(uat, 'uat_active_device', None)
    monkeypatch.setattr(uat, 'uat_running', False)
    monkeypatch.setattr(uat, '_uat_dump978_process', None)
    monkeypatch.setattr(uat, '_uat_json_process', None)
    monkeypatch.setattr(uat, 'UAT_ENABLED', True)
    monkeypatch.setattr(uat, 'UAT_START_WAIT', 0)
    monkeypatch.setattr(uat, 'find_dump978', Mock(return_value='/mock/dump978-fa'))
    monkeypatch.setattr(uat, 'find_uat2json', Mock(return_value='/mock/uat2json'))
    monkeypatch.setattr(uat, 'register_process', Mock())
    monkeypatch.setattr(uat, 'unregister_process', Mock())

    monkeypatch.setattr(adsb, 'adsb_active_device', None)
    monkeypatch.setattr(adsb, 'adsb_active_sdr_type', SDRType.RTL_SDR)
    monkeypatch.setattr(adsb, 'adsb_using_service', False)
    monkeypatch.setattr(adsb, 'adsb_connected', False)
    monkeypatch.setattr(adsb, 'DUMP1090_START_WAIT', 0)
    monkeypatch.setattr(adsb, 'check_dump1090_service', Mock(return_value=None))
    monkeypatch.setattr(adsb, 'find_dump1090', Mock(return_value=None))
    monkeypatch.setattr(adsb, '_get_active_session', Mock(return_value=None))
    monkeypatch.setattr(adsb, '_record_session_start', Mock(return_value=None))
    monkeypatch.setattr(adsb, '_record_session_stop', Mock(return_value=None))
    monkeypatch.setattr(adsb, '_build_local_adsb_command', Mock(return_value=['mock-readsb']))
    monkeypatch.setattr(adsb, 'register_process', Mock())
    monkeypatch.setattr(adsb, 'unregister_process', Mock())
    adsb._looked_up_icaos.clear()

    app = Quart(__name__)
    app.config['TESTING'] = True
    for blueprint in (acars.acars_bp, adsb.adsb_bp, uat.uat_bp):
        app.register_blueprint(blueprint)
    yield SimpleNamespace(client=app.test_client(), quart=app, registry=registry, app=app_module)
    # Let reader threads of a finished test observe a stopped session.
    adsb.adsb_using_service = False
    uat.uat_running = False
    app_module.adsb_aircraft.clear()
    adsb._looked_up_icaos.clear()


def slow(result=None, seconds=SLOW):
    """A blocking stand-in for a USB probe, a tool probe or a process wait."""
    def blocking(*args, **kwargs):
        time.sleep(seconds)
        return result
    return blocking


# ============================================
# ACARS
# ============================================


async def test_acars_start_keeps_the_event_loop_responsive(aircraft, monkeypatch):
    """Tool probing, the USB claim, the spawn and the startup wait run off-loop."""
    process = fake_process()
    monkeypatch.setattr(acars.subprocess, 'Popen', Mock(return_value=process))
    monkeypatch.setattr(acars, 'stream_acars_output', Mock())
    monkeypatch.setattr(acars, 'get_acarsdec_json_flag', slow('-j'))
    monkeypatch.setattr(acars, 'PROCESS_START_WAIT', SLOW)
    registry_claim = aircraft.app.claim_sdr_device
    monkeypatch.setattr(aircraft.app, 'claim_sdr_device',
                        lambda *args, **kwargs: slow()() or registry_claim(*args, **kwargs))

    response, stall = await run_measuring_loop_stall(
        aircraft.client.post('/acars/start', json={'device': 1}))

    assert response.status_code == 200
    assert (await response.get_json())['status'] == 'started'
    assert aircraft.app.acars_process is process
    assert aircraft.registry.status() == {1: 'acars'}
    assert stall < STALL_LIMIT, f'/acars/start froze the event loop for {stall:.2f}s'


async def test_acars_stop_keeps_the_event_loop_responsive(aircraft, monkeypatch):
    """Waiting for acarsdec to exit must not hold the loop (or its lock on it)."""
    process = fake_process()
    process.wait.side_effect = lambda *args, **kwargs: time.sleep(SLOW)
    aircraft.app.acars_process = process
    acars.acars_active_device = 1
    assert aircraft.registry.claim(1, 'acars') is None

    response, stall = await run_measuring_loop_stall(aircraft.client.post('/acars/stop'))

    assert response.status_code == 200
    assert (await response.get_json())['status'] == 'stopped'
    process.terminate.assert_called_once()
    assert aircraft.app.acars_process is None
    assert acars.acars_active_device is None
    assert aircraft.registry.status() == {}
    assert not aircraft.app.acars_lock.locked()
    assert stall < STALL_LIMIT, f'/acars/stop froze the event loop for {stall:.2f}s'


async def test_cancelled_acars_start_stops_decoder_and_releases_claim(aircraft, monkeypatch):
    """A client that disconnects during the startup wait must not leak the receiver."""
    process = fake_process()
    spawned = asyncio.Event()

    async def spawn(*args, **kwargs):
        spawned.set()
        return process

    monkeypatch.setattr(acars, 'async_popen', spawn)
    monkeypatch.setattr(acars, 'stream_acars_output', Mock())
    monkeypatch.setattr(acars, 'PROCESS_START_WAIT', 10)

    async with aircraft.quart.test_request_context('/acars/start', method='POST', json={'device': 1}):
        start = asyncio.create_task(acars.start_acars())
        await asyncio.wait_for(spawned.wait(), timeout=2)
        start.cancel()
        with pytest.raises(asyncio.CancelledError):
            await start

    process.terminate.assert_called_once()
    assert aircraft.app.acars_process is None
    assert acars.acars_active_device is None
    assert aircraft.registry.status() == {}
    assert not aircraft.app.acars_lock.locked()
    acars.stream_acars_output.assert_not_called()


async def test_acars_restart_after_decoder_death_does_not_report_device_busy(aircraft, monkeypatch):
    """A dead decoder whose reader has not cleaned up yet is taken over, not blocked on."""
    dead = fake_process(running=False)
    aircraft.app.acars_process = dead
    acars.acars_active_device = 1
    assert aircraft.registry.claim(1, 'acars') is None
    replacement = fake_process()
    monkeypatch.setattr(acars.subprocess, 'Popen', Mock(return_value=replacement))
    monkeypatch.setattr(acars, 'stream_acars_output', Mock())

    response = await aircraft.client.post('/acars/start', json={'device': 1})

    assert response.status_code == 200, await response.get_json()
    assert aircraft.app.acars_process is replacement
    assert aircraft.registry.status() == {1: 'acars'}


@pytest.mark.parametrize('frequencies', [
    {'131.550': True},                       # wrong container type
    [],                                      # nothing to tune
    ['131.550', 'not-a-frequency'],
    ['--output', 'json:file:/tmp/owned'],    # must never reach acarsdec's argv
    [None],
    True,
])
async def test_acars_rejects_bad_frequencies_without_claiming_the_receiver(aircraft, monkeypatch, frequencies):
    """Malformed frequencies used to raise after the claim and strand the SDR as 'in use by acars'."""
    spawn = Mock(return_value=fake_process())
    monkeypatch.setattr(acars.subprocess, 'Popen', spawn)
    monkeypatch.setattr(acars, 'stream_acars_output', Mock())

    response = await aircraft.client.post('/acars/start', json={'device': 1, 'frequencies': frequencies})

    assert response.status_code == 400
    body = await response.get_json()
    assert body['status'] == 'error' and 'frequenc' in body['message'].lower()
    spawn.assert_not_called()
    assert aircraft.registry.status() == {}
    assert acars.acars_active_device is None
    assert aircraft.app.acars_process is None


@pytest.mark.parametrize('frequencies,expected', [
    ([131.55, 130.025], ['131.55', '130.025']),      # JSON numbers from an API client
    ('131.550, 130.025', ['131.550', '130.025']),    # comma separated string
    (None, acars.DEFAULT_ACARS_FREQUENCIES),         # explicit null means "defaults"
    (129.125, ['129.125']),
])
async def test_acars_accepts_numeric_and_null_frequencies(aircraft, monkeypatch, frequencies, expected):
    spawn = Mock(return_value=fake_process())
    monkeypatch.setattr(acars.subprocess, 'Popen', spawn)
    monkeypatch.setattr(acars, 'stream_acars_output', Mock())

    response = await aircraft.client.post('/acars/start', json={'device': 1, 'frequencies': frequencies})

    assert response.status_code == 200, await response.get_json()
    assert (await response.get_json())['frequencies'] == expected
    command = spawn.call_args.args[0]
    assert command[-len(expected):] == expected
    assert aircraft.registry.status() == {1: 'acars'}


# ============================================
# UAT
# ============================================


def uat_pipeline(monkeypatch, *, dump978=None, uat2json=None):
    """Make the next two spawns return a fake dump978 and a fake uat2json."""
    dump978 = dump978 or fake_process(pid=5001)
    uat2json = uat2json or fake_process(pid=5002)
    monkeypatch.setattr(uat.subprocess, 'Popen', Mock(side_effect=[dump978, uat2json]))
    return dump978, uat2json


async def test_uat_start_keeps_the_event_loop_responsive(aircraft, monkeypatch):
    dump978, uat2json = uat_pipeline(monkeypatch)
    monkeypatch.setattr(uat, '_stream_uat_output', Mock())
    monkeypatch.setattr(uat, 'UAT_START_WAIT', SLOW)
    registry_claim = aircraft.app.claim_sdr_device
    monkeypatch.setattr(aircraft.app, 'claim_sdr_device',
                        lambda *args, **kwargs: slow()() or registry_claim(*args, **kwargs))

    response, stall = await run_measuring_loop_stall(
        aircraft.client.post('/uat/start', json={'device': 1, 'gain': 40}))

    assert response.status_code == 200, await response.get_json()
    assert uat.uat_running is True
    assert uat._uat_json_process is uat2json
    assert aircraft.registry.status() == {1: 'uat'}
    assert stall < STALL_LIMIT, f'/uat/start froze the event loop for {stall:.2f}s'


async def test_uat_stop_keeps_the_event_loop_responsive(aircraft, monkeypatch):
    dump978, uat2json = fake_process(pid=5001), fake_process(pid=5002)
    for process in (dump978, uat2json):
        process.wait.side_effect = lambda *args, **kwargs: time.sleep(SLOW)
    uat._uat_dump978_process, uat._uat_json_process = dump978, uat2json
    uat.uat_running = True
    uat.uat_active_device = 1
    assert aircraft.registry.claim(1, 'uat') is None

    response, stall = await run_measuring_loop_stall(aircraft.client.post('/uat/stop'))

    assert response.status_code == 200
    assert (await response.get_json())['status'] == 'stopped'
    assert uat.uat_running is False
    assert uat._uat_dump978_process is None and uat._uat_json_process is None
    assert uat.uat_active_device is None
    assert aircraft.registry.status() == {}
    assert {call.args for call in os.killpg.call_args_list} == {(5001, 15), (5002, 15)}
    assert stall < STALL_LIMIT, f'/uat/stop froze the event loop for {stall:.2f}s'
