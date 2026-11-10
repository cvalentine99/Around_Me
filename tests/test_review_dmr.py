"""Regression tests for DMR stop and the DSD reader thread."""

from __future__ import annotations

import io
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from quart import Quart

from routes import dmr
from tests.test_review_aprs import STALL_LIMIT, fake_process, run_measuring_loop_stall, slow
from utils.sdr.registry import SDRDeviceRegistry
from utils.sse import EventQueue


@pytest.fixture
def env(monkeypatch):
    import app as app_module

    registry = SDRDeviceRegistry(probe=lambda device: None)
    monkeypatch.setattr(app_module, '_sdr_registry', registry)
    monkeypatch.setattr(dmr, 'dmr_queue', EventQueue(maxsize=100))
    monkeypatch.setattr(dmr, 'dmr_rtl_process', None)
    monkeypatch.setattr(dmr, 'dmr_dsd_process', None)
    monkeypatch.setattr(dmr, 'dmr_running', False)
    monkeypatch.setattr(dmr, 'dmr_has_audio', False)
    monkeypatch.setattr(dmr, 'dmr_active_device', None)
    monkeypatch.setattr(dmr, 'unregister_process', Mock())

    app = Quart(__name__)
    app.config['TESTING'] = True
    app.register_blueprint(dmr.dmr_bp)
    yield SimpleNamespace(client=app.test_client(), registry=registry)
    dmr.dmr_running = False


def dead_dsd():
    process = fake_process(running=False)
    process.stderr = io.BytesIO(b'')
    return process


async def test_dmr_stop_keeps_the_event_loop_responsive(env):
    rtl, dsd = fake_process(), fake_process()
    for process in (rtl, dsd):
        process.wait.side_effect = slow(0)
    dmr.dmr_rtl_process, dmr.dmr_dsd_process = rtl, dsd
    dmr.dmr_running = True
    dmr.dmr_active_device = 1
    assert env.registry.claim(1, 'DMR') is None

    response, stall = await run_measuring_loop_stall(env.client.post('/dmr/stop'))

    assert response.status_code == 200
    rtl.terminate.assert_called_once()
    dsd.terminate.assert_called_once()
    assert dmr.dmr_rtl_process is None and dmr.dmr_dsd_process is None
    assert dmr.dmr_running is False and dmr.dmr_active_device is None
    assert env.registry.status() == {}
    assert not dmr.dmr_lock.locked()
    assert stall < STALL_LIMIT, f'/dmr/stop froze the event loop for {stall:.2f}s'


async def test_dmr_start_refuses_while_running(env):
    dmr.dmr_running = True
    response = await env.client.post('/dmr/start', json={})
    assert response.status_code == 409
    assert not dmr.dmr_lock.locked()


def test_reader_of_a_previous_session_does_not_clobber_the_new_one(env):
    """After stop + quick restart the old reader used to drop the NEW pipeline's
    handles (orphaning it), stop its reader and release its receiver."""
    old_rtl, old_dsd = fake_process(), dead_dsd()
    new_rtl, new_dsd = fake_process(), fake_process()
    dmr.dmr_rtl_process, dmr.dmr_dsd_process = new_rtl, new_dsd
    dmr.dmr_running = True
    dmr.dmr_active_device = 0
    assert env.registry.claim(0, 'DMR') is None

    with dmr.dmr_queue.subscribe(replay=False) as viewer:
        dmr.stream_dsd_output(old_rtl, old_dsd)
        events = []
        while not viewer.empty():
            events.append(viewer.get_nowait())

    new_rtl.terminate.assert_not_called()
    new_dsd.terminate.assert_not_called()
    assert dmr.dmr_rtl_process is new_rtl and dmr.dmr_dsd_process is new_dsd
    assert dmr.dmr_running is True and dmr.dmr_active_device == 0
    assert env.registry.status() == {0: 'DMR'}
    assert not any(e.get('type') == 'status' and e.get('text') in ('stopped', 'crashed') for e in events)


def test_reader_resets_its_own_session_when_dsd_dies(env):
    rtl, dsd = fake_process(), dead_dsd()
    dmr.dmr_rtl_process, dmr.dmr_dsd_process = rtl, dsd
    dmr.dmr_running = True
    dmr.dmr_has_audio = True
    dmr.dmr_active_device = 0
    assert env.registry.claim(0, 'DMR') is None

    with dmr.dmr_queue.subscribe(replay=False) as viewer:
        dmr.stream_dsd_output(rtl, dsd)
        events = []
        while not viewer.empty():
            events.append(viewer.get_nowait())

    assert dmr.dmr_rtl_process is None and dmr.dmr_dsd_process is None
    assert dmr.dmr_running is False and dmr.dmr_has_audio is False
    assert dmr.dmr_active_device is None
    assert env.registry.status() == {}
    assert any(e.get('type') == 'status' and e.get('text') == 'crashed' for e in events)
