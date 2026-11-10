"""Pager and sensor stop must not wait for their processes on the event loop.

The live hardware run measured 0.17-0.27 s loop stalls on every stop; a
decoder slow to release the USB device stretches that to the 2 s timeout.
"""

from __future__ import annotations

import pytest

import app as app_module
from tests.test_review_aprs import STALL_LIMIT, fake_process, run_measuring_loop_stall, slow


@pytest.fixture
def slow_process():
    process = fake_process()
    process.wait.side_effect = slow(0)
    return process


async def test_sensor_stop_keeps_the_event_loop_responsive(auth_client, monkeypatch, slow_process):
    monkeypatch.setattr(app_module, 'sensor_process', slow_process)

    response, stall = await run_measuring_loop_stall(auth_client.post('/stop_sensor'))

    assert response.status_code == 200
    assert (await response.get_json())['status'] == 'stopped'
    slow_process.terminate.assert_called_once()
    assert app_module.sensor_process is None
    assert not app_module.sensor_lock.locked()
    assert stall < STALL_LIMIT, f'/stop_sensor froze the event loop for {stall:.2f}s'


async def test_pager_stop_keeps_the_event_loop_responsive(auth_client, monkeypatch, slow_process):
    rtl = fake_process()
    rtl.wait.side_effect = slow(0)
    slow_process._rtl_process = rtl
    slow_process._master_fd = -1        # an already-closed PTY: os.close raises OSError
    monkeypatch.setattr(app_module, 'current_process', slow_process)

    response, stall = await run_measuring_loop_stall(auth_client.post('/stop'))

    assert response.status_code == 200
    assert (await response.get_json())['status'] == 'stopped'
    rtl.terminate.assert_called_once()
    slow_process.terminate.assert_called_once()
    assert app_module.current_process is None
    assert not app_module.process_lock.locked()
    assert stall < STALL_LIMIT, f'/stop froze the event loop for {stall:.2f}s'


async def test_stops_when_nothing_runs(auth_client, monkeypatch):
    monkeypatch.setattr(app_module, 'sensor_process', None)
    monkeypatch.setattr(app_module, 'current_process', None)
    for path in ('/stop_sensor', '/stop'):
        response = await auth_client.post(path)
        assert response.status_code == 200
        assert (await response.get_json())['status'] == 'not_running'
