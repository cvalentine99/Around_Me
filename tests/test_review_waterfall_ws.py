"""Waterfall WebSocket: stop and disconnect must not block the event loop
and must always release the receiver."""

from __future__ import annotations

import asyncio
import io
import json
from unittest.mock import Mock

import pytest
from quart import Quart

from routes import waterfall_websocket
from tests.test_review_aprs import STALL_LIMIT, fake_process, run_measuring_loop_stall, slow
from utils.sdr.registry import SDRDeviceRegistry

START = {'cmd': 'start', 'center_freq': 100.0, 'span_mhz': 2.0, 'device': 0,
         'sdr_type': 'rtlsdr', 'fft_size': 1024, 'fps': 10}


@pytest.fixture
def env(monkeypatch):
    import app as app_module

    registry = SDRDeviceRegistry(probe=lambda device: None)
    monkeypatch.setattr(app_module, '_sdr_registry', registry)
    process = fake_process()
    process.stdout = io.BytesIO(b'')
    process.wait.side_effect = slow(0)          # the capture is slow to exit

    async def spawn(*args, **kwargs):
        return process

    monkeypatch.setattr(waterfall_websocket, 'async_popen', spawn)
    monkeypatch.setattr(waterfall_websocket, 'register_process', Mock())
    monkeypatch.setattr(waterfall_websocket, 'unregister_process', Mock())
    app = Quart(__name__)
    app.config['TESTING'] = True
    waterfall_websocket.init_waterfall_websocket(app)
    return app, registry, process


async def _receive_status(socket, wanted):
    while True:
        message = await asyncio.wait_for(socket.receive(), 5)
        if isinstance(message, str) and json.loads(message).get('status') == wanted:
            return


async def test_stop_releases_the_receiver_without_freezing_the_loop(env):
    app, registry, process = env
    async with app.test_client().websocket('/ws/waterfall') as socket:
        await socket.send(json.dumps(START))
        await _receive_status(socket, 'started')
        assert registry.status() == {0: 'waterfall'}

        async def stop():
            await socket.send(json.dumps({'cmd': 'stop'}))
            await _receive_status(socket, 'stopped')

        _, stall = await run_measuring_loop_stall(stop())

    process.terminate.assert_called()
    assert registry.status() == {}
    assert stall < STALL_LIMIT, f'waterfall stop froze the event loop for {stall:.2f}s'


async def test_disconnect_releases_the_receiver(env):
    app, registry, process = env
    async with app.test_client().websocket('/ws/waterfall') as socket:
        await socket.send(json.dumps(START))
        await _receive_status(socket, 'started')
        assert registry.status() == {0: 'waterfall'}
    # The handler's cleanup runs after the client is gone.
    for _ in range(100):
        if not registry.status():
            break
        await asyncio.sleep(0.05)
    process.terminate.assert_called()
    assert registry.status() == {}
