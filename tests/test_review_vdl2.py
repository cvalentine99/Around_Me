"""Regression tests for VDL2 start/stop and its reader thread."""

from __future__ import annotations

import io
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from quart import Quart

from routes import vdl2
from tests.test_review_aprs import SLOW, STALL_LIMIT, fake_process, run_measuring_loop_stall, slow
from utils.sdr.registry import SDRDeviceRegistry
from utils.sse import EventQueue


@pytest.fixture
def env(monkeypatch):
    import app as app_module

    registry = SDRDeviceRegistry(probe=lambda device: None)
    monkeypatch.setattr(app_module, '_sdr_registry', registry)
    monkeypatch.setattr(app_module, 'vdl2_process', None)
    monkeypatch.setattr(app_module, 'vdl2_queue', EventQueue(maxsize=100))
    monkeypatch.setattr(vdl2, 'vdl2_active_device', None)
    monkeypatch.setattr(vdl2, 'find_dumpvdl2', Mock(return_value='/mock/dumpvdl2'))
    monkeypatch.setattr(vdl2, 'PROCESS_START_WAIT', 0)
    monkeypatch.setattr(vdl2, 'register_process', Mock())
    monkeypatch.setattr(vdl2, 'unregister_process', Mock())
    monkeypatch.setattr(vdl2.platform, 'system', lambda: 'Linux')

    app = Quart(__name__)
    app.config['TESTING'] = True
    app.register_blueprint(vdl2.vdl2_bp)
    return SimpleNamespace(client=app.test_client(), registry=registry, app=app_module)


async def test_vdl2_start_reads_the_json_body(env, monkeypatch):
    """request.json is a coroutine in Quart: every start used to fail with a 500."""
    spawn = Mock(return_value=fake_process())
    monkeypatch.setattr(vdl2.subprocess, 'Popen', spawn)
    monkeypatch.setattr(vdl2, 'stream_vdl2_output', Mock())

    response = await env.client.post('/vdl2/start', json={'device': 1, 'frequencies': ['136975000', 136725000]})

    assert response.status_code == 200, await response.get_data(as_text=True)
    body = await response.get_json()
    assert body['status'] == 'started'
    assert spawn.call_args.args[0][-2:] == ['136975000', '136725000']
    assert env.registry.status() == {1: 'vdl2'}


async def test_vdl2_start_keeps_the_event_loop_responsive(env, monkeypatch):
    monkeypatch.setattr(vdl2.subprocess, 'Popen', Mock(return_value=fake_process()))
    monkeypatch.setattr(vdl2, 'stream_vdl2_output', Mock())
    monkeypatch.setattr(vdl2, 'PROCESS_START_WAIT', SLOW)

    response, stall = await run_measuring_loop_stall(env.client.post('/vdl2/start', json={'device': 0}))

    assert response.status_code == 200, await response.get_data(as_text=True)
    assert not env.app.vdl2_lock.locked()
    assert stall < STALL_LIMIT, f'/vdl2/start froze the event loop for {stall:.2f}s'


@pytest.mark.parametrize('frequencies', [['--output', 'x'], [None], 'abc', [], [1.5e12]])
async def test_bad_vdl2_frequencies_are_rejected_before_the_claim(env, monkeypatch, frequencies):
    spawn = Mock(return_value=fake_process())
    monkeypatch.setattr(vdl2.subprocess, 'Popen', spawn)

    response = await env.client.post('/vdl2/start', json={'device': 0, 'frequencies': frequencies})

    assert response.status_code == 400
    spawn.assert_not_called()
    assert env.registry.status() == {}
    assert vdl2.vdl2_active_device is None


async def test_vdl2_stop_keeps_the_event_loop_responsive(env):
    process = fake_process()
    process.wait.side_effect = slow(0)
    env.app.vdl2_process = process
    vdl2.vdl2_active_device = 1
    assert env.registry.claim(1, 'vdl2') is None

    response, stall = await run_measuring_loop_stall(env.client.post('/vdl2/stop'))

    assert response.status_code == 200
    process.terminate.assert_called_once()
    assert env.app.vdl2_process is None and vdl2.vdl2_active_device is None
    assert env.registry.status() == {}
    assert not env.app.vdl2_lock.locked()
    assert stall < STALL_LIMIT, f'/vdl2/stop froze the event loop for {stall:.2f}s'


def test_reader_of_a_previous_session_leaves_the_new_session_alone(env):
    old = fake_process()
    old.stdout = io.BytesIO(b'')
    new = fake_process()
    env.app.vdl2_process = new
    vdl2.vdl2_active_device = 0
    assert env.registry.claim(0, 'vdl2') is None

    with env.app.vdl2_queue.subscribe(replay=False) as viewer:
        vdl2.stream_vdl2_output(old)
        events = []
        while not viewer.empty():
            events.append(viewer.get_nowait())

    assert env.app.vdl2_process is new
    assert vdl2.vdl2_active_device == 0
    assert env.registry.status() == {0: 'vdl2'}
    assert {'type': 'status', 'status': 'stopped'} not in events


def test_reader_resets_its_own_session_when_dumpvdl2_exits(env):
    process = fake_process()
    process.stdout = io.BytesIO(b'')
    env.app.vdl2_process = process
    vdl2.vdl2_active_device = 0
    assert env.registry.claim(0, 'vdl2') is None

    vdl2.stream_vdl2_output(process)

    assert env.app.vdl2_process is None and vdl2.vdl2_active_device is None
    assert env.registry.status() == {}
