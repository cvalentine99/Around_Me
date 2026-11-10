"""Regression tests for DSC start/stop and the decoder reader thread."""

from __future__ import annotations

import io
import os
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from quart import Quart

from routes import dsc
from tests.test_review_aprs import SLOW, STALL_LIMIT, fake_process, run_measuring_loop_stall, slow
from utils.sdr.registry import SDRDeviceRegistry
from utils.sse import EventQueue

TOOLS = {
    'ready': True,
    'rtl_fm': {'available': True, 'path': '/mock/rtl_fm'},
    'dsc_decoder': {'available': True, 'path': '/mock/dsc-decoder'},
    'scipy': {'available': True},
}


@pytest.fixture
def env(monkeypatch):
    import app as app_module

    registry = SDRDeviceRegistry(probe=lambda device: None)
    monkeypatch.setattr(app_module, '_sdr_registry', registry)
    monkeypatch.setattr(app_module, 'sdr_device_registry', registry.allocations)
    monkeypatch.setattr(app_module, 'sdr_device_registry_lock', registry.lock)
    monkeypatch.setattr(app_module, 'dsc_process', None)
    monkeypatch.setattr(app_module, 'dsc_rtl_process', None)
    monkeypatch.setattr(app_module, 'dsc_queue', EventQueue(maxsize=100))

    monkeypatch.setattr(dsc, 'dsc_active_device', None)
    monkeypatch.setattr(dsc, 'dsc_running', False)
    monkeypatch.setattr(dsc, '_check_dsc_tools', Mock(return_value=TOOLS))
    monkeypatch.setattr(dsc, 'register_process', Mock())
    monkeypatch.setattr(dsc, 'unregister_process', Mock())

    app = Quart(__name__)
    app.config['TESTING'] = True
    app.register_blueprint(dsc.dsc_bp)
    yield SimpleNamespace(client=app.test_client(), registry=registry, app=app_module)
    dsc.dsc_running = False


def closed_pty():
    """A descriptor that reports EOF at once, standing in for the decoder's PTY."""
    read_fd, write_fd = os.pipe()
    os.close(write_fd)
    return read_fd


async def test_dsc_start_keeps_the_event_loop_responsive(env, monkeypatch):
    rtl, decoder = fake_process(), fake_process()
    monkeypatch.setattr(dsc.subprocess, 'Popen', Mock(side_effect=[rtl, decoder]))
    monkeypatch.setattr(dsc, 'stream_dsc_decoder', Mock())
    monkeypatch.setattr(dsc, 'monitor_rtl_stderr', Mock())
    registry_claim = env.app.claim_sdr_device
    monkeypatch.setattr(env.app, 'claim_sdr_device',
                        lambda *args, **kwargs: slow()() or registry_claim(*args, **kwargs))

    response, stall = await run_measuring_loop_stall(env.client.post('/dsc/start', json={'device': 1}))

    assert response.status_code == 200, await response.get_json()
    assert (await response.get_json())['status'] == 'started'
    assert env.app.dsc_process is decoder and env.app.dsc_rtl_process is rtl
    assert env.registry.status() == {1: 'dsc'}
    assert not env.app.dsc_lock.locked()
    assert stall < STALL_LIMIT, f'/dsc/start froze the event loop for {stall:.2f}s'


async def test_dsc_stop_keeps_the_event_loop_responsive(env):
    rtl, decoder = fake_process(), fake_process()
    for process in (rtl, decoder):
        process.wait.side_effect = slow(0)
    env.app.dsc_process, env.app.dsc_rtl_process = decoder, rtl
    dsc.dsc_active_device = 1
    dsc.dsc_running = True
    assert env.registry.claim(1, 'dsc') is None

    response, stall = await run_measuring_loop_stall(env.client.post('/dsc/stop'))

    assert response.status_code == 200
    assert (await response.get_json())['status'] == 'stopped'
    assert env.app.dsc_process is None and env.app.dsc_rtl_process is None
    assert dsc.dsc_active_device is None and dsc.dsc_running is False
    assert env.registry.status() == {}
    assert not env.app.dsc_lock.locked()
    assert stall < STALL_LIMIT, f'/dsc/stop froze the event loop for {stall:.2f}s'


async def test_dsc_stop_when_not_running(env):
    response = await env.client.post('/dsc/stop')
    assert response.status_code == 200
    assert (await response.get_json())['status'] == 'not_running'


async def test_restart_after_decoder_death_takes_over_the_dead_session(env, monkeypatch):
    env.app.dsc_process, env.app.dsc_rtl_process = fake_process(running=False), fake_process(running=False)
    dsc.dsc_active_device = 1
    assert env.registry.claim(1, 'dsc') is None
    rtl, decoder = fake_process(), fake_process()
    monkeypatch.setattr(dsc.subprocess, 'Popen', Mock(side_effect=[rtl, decoder]))
    monkeypatch.setattr(dsc, 'stream_dsc_decoder', Mock())
    monkeypatch.setattr(dsc, 'monitor_rtl_stderr', Mock())

    response = await env.client.post('/dsc/start', json={'device': 1})

    assert response.status_code == 200, await response.get_json()
    assert env.app.dsc_process is decoder
    assert env.registry.status() == {1: 'dsc'}


def test_reader_of_a_previous_session_does_not_kill_the_new_one(env):
    """The old reader used to terminate whatever rtl_fm was CURRENT - the new session's."""
    old_rtl, old_decoder = fake_process(), fake_process(running=False)
    new_rtl, new_decoder = fake_process(), fake_process()
    env.app.dsc_process, env.app.dsc_rtl_process = new_decoder, new_rtl
    dsc.dsc_active_device = 0
    dsc.dsc_running = True
    assert env.registry.claim(0, 'dsc') is None

    with env.app.dsc_queue.subscribe(replay=False) as viewer:
        dsc.stream_dsc_decoder(closed_pty(), old_decoder, old_rtl)
        events = []
        while not viewer.empty():
            events.append(viewer.get_nowait())

    new_rtl.terminate.assert_not_called()
    new_decoder.terminate.assert_not_called()
    old_rtl.terminate.assert_called()
    assert env.app.dsc_process is new_decoder and env.app.dsc_rtl_process is new_rtl
    assert dsc.dsc_running is True
    assert env.registry.status() == {0: 'dsc'}
    assert {'type': 'status', 'status': 'stopped'} not in events


def test_reader_resets_the_session_when_the_decoder_dies_by_itself(env):
    rtl, decoder = fake_process(), fake_process(running=False)
    env.app.dsc_process, env.app.dsc_rtl_process = decoder, rtl
    dsc.dsc_active_device = 0
    dsc.dsc_running = True
    assert env.registry.claim(0, 'dsc') is None

    with env.app.dsc_queue.subscribe(replay=False) as viewer:
        dsc.stream_dsc_decoder(closed_pty(), decoder, rtl)
        events = []
        while not viewer.empty():
            events.append(viewer.get_nowait())

    rtl.terminate.assert_called()
    assert env.app.dsc_process is None and env.app.dsc_rtl_process is None
    assert dsc.dsc_running is False and dsc.dsc_active_device is None
    assert env.registry.status() == {}
    assert {'type': 'status', 'status': 'stopped'} in events
