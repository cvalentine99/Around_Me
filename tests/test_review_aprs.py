"""Regression tests for APRS start/stop, the reader thread and the spectrum scan.

Each blocking step is replaced by a fake that takes SLOW seconds. A handler
that runs such a step on the event loop stalls every other client (SSE
streams, waterfall and audio sockets) for that long; a healthy handler keeps
the loop responsive well inside STALL_LIMIT.
"""

from __future__ import annotations

import asyncio
import io
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from quart import Quart

from routes import aprs
from utils.sdr.registry import SDRDeviceRegistry
from utils.sse import EventQueue

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


def fake_process(*, running=True, stdout=b'', stderr=b''):
    process = Mock(stdout=io.BytesIO(stdout), stderr=io.BytesIO(stderr), returncode=None)
    process.poll.return_value = None if running else 1

    def finish(*args, **kwargs):
        process.poll.return_value = 0
        return 0

    process.wait.side_effect = finish
    return process


def slow(result=None, seconds=SLOW):
    def blocking(*args, **kwargs):
        time.sleep(seconds)
        return result
    return blocking


@pytest.fixture
def env(monkeypatch, tmp_path):
    import app as app_module

    registry = SDRDeviceRegistry(probe=lambda device: None)
    monkeypatch.setattr(app_module, '_sdr_registry', registry)
    monkeypatch.setattr(app_module, 'sdr_device_registry', registry.allocations)
    monkeypatch.setattr(app_module, 'sdr_device_registry_lock', registry.lock)
    monkeypatch.setattr(app_module, 'aprs_process', None)
    monkeypatch.setattr(app_module, 'aprs_rtl_process', None)
    monkeypatch.setattr(app_module, 'aprs_queue', EventQueue(maxsize=100))

    monkeypatch.setattr(aprs, 'aprs_active_device', None)
    monkeypatch.setattr(aprs, 'find_rtl_fm', Mock(return_value='/mock/rtl_fm'))
    monkeypatch.setattr(aprs, 'find_direwolf', Mock(return_value='/mock/direwolf'))
    monkeypatch.setattr(aprs, 'find_multimon_ng', Mock(return_value=None))
    monkeypatch.setattr(aprs, 'find_rtl_power', Mock(return_value='/mock/rtl_power'))
    monkeypatch.setattr(aprs, 'create_direwolf_config', Mock(return_value=str(tmp_path / 'direwolf.conf')))
    monkeypatch.setattr(aprs, 'PROCESS_START_WAIT', 0)
    monkeypatch.setattr(aprs.tempfile, 'gettempdir', lambda: str(tmp_path))

    app = Quart(__name__)
    app.config['TESTING'] = True
    app.register_blueprint(aprs.aprs_bp)
    return SimpleNamespace(client=app.test_client(), registry=registry, app=app_module)


def pipeline(monkeypatch, *processes):
    spawn = Mock(side_effect=list(processes))
    monkeypatch.setattr(aprs.subprocess, 'Popen', spawn)
    return spawn


async def test_aprs_start_keeps_the_event_loop_responsive(env, monkeypatch):
    rtl, decoder = fake_process(), fake_process()
    pipeline(monkeypatch, rtl, decoder)
    monkeypatch.setattr(aprs, 'stream_aprs_output', Mock())
    monkeypatch.setattr(aprs, 'PROCESS_START_WAIT', SLOW)
    registry_claim = env.app.claim_sdr_device
    monkeypatch.setattr(env.app, 'claim_sdr_device',
                        lambda *args, **kwargs: slow()() or registry_claim(*args, **kwargs))

    response, stall = await run_measuring_loop_stall(env.client.post('/aprs/start', json={'device': 1}))

    assert response.status_code == 200, await response.get_json()
    assert (await response.get_json())['status'] == 'started'
    assert env.app.aprs_process is decoder and env.app.aprs_rtl_process is rtl
    assert env.registry.status() == {1: 'aprs'}
    assert not env.app.aprs_lock.locked()
    assert stall < STALL_LIMIT, f'/aprs/start froze the event loop for {stall:.2f}s'


async def test_aprs_stop_keeps_the_event_loop_responsive(env):
    rtl, decoder = fake_process(), fake_process()
    for process in (rtl, decoder):
        process.wait.side_effect = slow(0)
    env.app.aprs_process, env.app.aprs_rtl_process = decoder, rtl
    aprs.aprs_active_device = 1
    assert env.registry.claim(1, 'aprs') is None

    response, stall = await run_measuring_loop_stall(env.client.post('/aprs/stop'))

    assert response.status_code == 200
    assert (await response.get_json())['status'] == 'stopped'
    rtl.terminate.assert_called_once()
    decoder.terminate.assert_called_once()
    assert env.app.aprs_process is None and env.app.aprs_rtl_process is None
    assert aprs.aprs_active_device is None
    assert env.registry.status() == {}
    assert not env.app.aprs_lock.locked()
    assert stall < STALL_LIMIT, f'/aprs/stop froze the event loop for {stall:.2f}s'


async def test_aprs_stop_when_not_running_is_a_clean_400(env):
    response = await env.client.post('/aprs/stop')
    assert response.status_code == 400
    assert (await response.get_json())['status'] == 'error'
    assert not env.app.aprs_lock.locked()


@pytest.mark.parametrize('frequency', ['not-a-number', '1e9', [144.39]])
async def test_bad_aprs_frequency_is_rejected_without_claiming_the_receiver(env, monkeypatch, frequency):
    """float() of a custom frequency used to raise after the claim: 500 and an SDR stuck 'in use'."""
    spawn = pipeline(monkeypatch, fake_process(), fake_process())
    monkeypatch.setattr(aprs, 'stream_aprs_output', Mock())

    response = await env.client.post('/aprs/start', json={'device': 1, 'frequency': frequency})

    assert response.status_code == 400
    assert 'frequency' in (await response.get_json())['message'].lower()
    spawn.assert_not_called()
    assert env.registry.status() == {}
    assert aprs.aprs_active_device is None


async def test_restart_after_decoder_death_takes_over_the_dead_session(env, monkeypatch):
    """A dead decoder whose reader has not cleaned up yet must not block a new start."""
    env.app.aprs_process, env.app.aprs_rtl_process = fake_process(running=False), fake_process(running=False)
    aprs.aprs_active_device = 1
    assert env.registry.claim(1, 'aprs') is None
    rtl, decoder = fake_process(), fake_process()
    pipeline(monkeypatch, rtl, decoder)
    monkeypatch.setattr(aprs, 'stream_aprs_output', Mock())

    response = await env.client.post('/aprs/start', json={'device': 1})

    assert response.status_code == 200, await response.get_json()
    assert env.app.aprs_process is decoder
    assert env.registry.status() == {1: 'aprs'}


def test_reader_of_a_previous_session_leaves_the_new_session_alone(env):
    """After stop + quick restart the old reader used to release the NEW claim and announce 'stopped'."""
    old_rtl, old_decoder = fake_process(), fake_process()
    old_decoder.stdout = io.StringIO('')          # EOF right away
    new_decoder = fake_process()
    env.app.aprs_process, env.app.aprs_rtl_process = new_decoder, fake_process()
    aprs.aprs_active_device = 0
    assert env.registry.claim(0, 'aprs') is None
    with env.app.aprs_queue.subscribe(replay=False) as viewer:
        aprs.stream_aprs_output(old_rtl, old_decoder)
        events = []
        while not viewer.empty():
            events.append(viewer.get_nowait())

    assert env.registry.status() == {0: 'aprs'}
    assert aprs.aprs_active_device == 0
    assert env.app.aprs_process is new_decoder
    assert {'type': 'status', 'status': 'stopped'} not in events
    old_rtl.terminate.assert_called()


def test_reader_resets_the_session_when_the_decoder_dies_by_itself(env):
    rtl, decoder = fake_process(), fake_process()
    decoder.stdout = io.StringIO('')
    env.app.aprs_process, env.app.aprs_rtl_process = decoder, rtl
    aprs.aprs_active_device = 0
    assert env.registry.claim(0, 'aprs') is None
    with env.app.aprs_queue.subscribe(replay=False) as viewer:
        aprs.stream_aprs_output(rtl, decoder)
        events = []
        while not viewer.empty():
            events.append(viewer.get_nowait())

    assert env.registry.status() == {}
    assert aprs.aprs_active_device is None
    assert env.app.aprs_process is None and env.app.aprs_rtl_process is None
    assert {'type': 'status', 'status': 'stopped'} in events


async def test_spectrum_scan_runs_off_the_event_loop(env, monkeypatch, tmp_path):
    """rtl_power runs for 5-60 s; it used to run on the event loop and freeze the app."""
    def fake_rtl_power(cmd, **kwargs):
        time.sleep(SLOW)
        with open(cmd[-1], 'w') as handle:
            handle.write('2026-11-10, 12:00:00, 144380000, 144400000, 200, 10, -60.0, -40.0, -61.0\n')
        return SimpleNamespace(returncode=0, stdout='', stderr='')

    monkeypatch.setattr(aprs.subprocess, 'run', fake_rtl_power)

    response, stall = await run_measuring_loop_stall(
        env.client.post('/aprs/spectrum', json={'device': 0, 'region': 'north_america', 'duration': 5}))

    assert response.status_code == 200, await response.get_json()
    body = await response.get_json()
    assert body['status'] == 'success' and body['results']['total_bins'] == 3
    assert list(tmp_path.glob('valentine_rtl_power_*.csv')) == []
    assert stall < STALL_LIMIT, f'/aprs/spectrum froze the event loop for {stall:.2f}s'


async def test_spectrum_scan_rejects_a_bad_frequency(env, monkeypatch):
    monkeypatch.setattr(aprs.subprocess, 'run', Mock())
    response = await env.client.post('/aprs/spectrum', json={'frequency': 'abc'})
    assert response.status_code == 400
    aprs.subprocess.run.assert_not_called()
