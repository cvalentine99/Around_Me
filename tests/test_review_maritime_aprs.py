"""Regression tests from the maritime / APRS stability review.

Hardware-free: decoders are replaced by fake Popen objects or by small real
child processes that only print text, and the receiver registry is a private
instance with a no-op USB probe.
"""

import asyncio
import io
import os
import socket
import stat
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from quart import Quart

import app as app_module
from routes import ais, aprs, dsc
from utils.sdr import SDRType
from utils.sdr.registry import SDRDeviceRegistry
from utils.sse import EventQueue


class FakeProcess:
    """A Popen stand-in that records which thread performed blocking calls."""

    _next_pid = 4_100_000

    def __init__(self, calls=None, *, exit_code=None, stdout=None, stderr=None):
        FakeProcess._next_pid += 1
        self.pid = FakeProcess._next_pid
        self.calls = calls if calls is not None else []
        self.returncode = exit_code
        self.stdout = stdout
        self.stderr = stderr if stderr is not None else io.BytesIO(b'')
        self.stdin = None
        self.signals = []

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.calls.append(('wait', threading.get_ident()))
        if self.returncode is None:
            self.returncode = -15
        return self.returncode

    def terminate(self):
        self.signals.append('terminate')
        if self.returncode is None:
            self.returncode = -15

    def kill(self):
        self.signals.append('kill')
        if self.returncode is None:
            self.returncode = -9


class LoopWatch:
    """Measure the longest stall of the running event loop."""

    def __init__(self, interval=0.01):
        self.interval = interval
        self.worst = 0.0
        self._task = None

    async def _run(self):
        last = time.monotonic()
        while True:
            await asyncio.sleep(self.interval)
            now = time.monotonic()
            self.worst = max(self.worst, now - last - self.interval)
            last = now

    async def __aenter__(self):
        self._task = asyncio.create_task(self._run())
        await asyncio.sleep(0)
        return self

    async def __aexit__(self, *exc):
        await asyncio.sleep(self.interval * 2)
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass


def _wait_until(predicate, timeout=3.0, step=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(step)
    return predicate()


async def _async_wait_until(predicate, timeout=3.0, step=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(step)
    return predicate()


def _history(event_queue):
    with event_queue.mutex:
        return [dict(item) for item in event_queue.queue]


@pytest.fixture
def maritime(monkeypatch):
    """A private Quart app with the AIS, DSC and APRS blueprints."""
    app = Quart(__name__)
    app.config['TESTING'] = True
    for blueprint in (ais.ais_bp, dsc.dsc_bp, aprs.aprs_bp):
        app.register_blueprint(blueprint)

    # Queues without a mode keep these tests away from recording and alerts.
    for name in ('ais_queue', 'dsc_queue', 'aprs_queue'):
        monkeypatch.setattr(app_module, name, EventQueue(maxsize=1000))
    for name in ('ais_process', 'dsc_process', 'dsc_rtl_process', 'aprs_process', 'aprs_rtl_process'):
        monkeypatch.setattr(app_module, name, None)
    for name in ('ais_lock', 'dsc_lock', 'aprs_lock'):
        monkeypatch.setattr(app_module, name, threading.Lock())

    monkeypatch.setattr(ais, 'ais_running', False)
    monkeypatch.setattr(ais, 'ais_connected', False)
    monkeypatch.setattr(ais, 'ais_active_device', None)
    monkeypatch.setattr(ais, 'ais_active_sdr_type', SDRType.RTL_SDR)
    monkeypatch.setattr(ais, 'find_ais_catcher', lambda: '/mock/AIS-catcher')
    monkeypatch.setattr(dsc, 'dsc_running', False)
    monkeypatch.setattr(dsc, 'dsc_active_device', None)
    monkeypatch.setattr(aprs, 'aprs_active_device', None)

    registry = SDRDeviceRegistry(probe=lambda index: None)
    claim_threads = []

    def claim(device_index, mode_name, sdr_type='rtlsdr'):
        claim_threads.append(threading.get_ident())
        return registry.claim(device_index, mode_name, sdr_type)

    monkeypatch.setattr(app_module, 'claim_sdr_device', claim)
    monkeypatch.setattr(app_module, 'release_sdr_device', registry.release)

    yield SimpleNamespace(
        app=app, client=app.test_client(), registry=registry, claim_threads=claim_threads,
    )

    # Let reader threads of the test end before monkeypatch restores globals.
    ais.ais_running = False
    dsc.dsc_running = False
    stop_event = getattr(ais, '_ais_stop_event', None)
    if stop_event is not None:
        stop_event.set()


# ---------------------------------------------------------------------------
# AIS
# ---------------------------------------------------------------------------

def _patch_ais_runtime(monkeypatch, calls, *, exit_code=None, stderr=None, startup_wait=0.25):
    """Replace AIS-catcher with a fake process and shorten its 2 s startup wait."""
    processes = []

    def fake_popen(cmd, **kwargs):
        calls.append(('popen', threading.get_ident()))
        process = FakeProcess(calls, exit_code=exit_code, stderr=stderr)
        processes.append(process)
        return process

    def fake_sleep(seconds):
        calls.append(('sleep', threading.get_ident()))
        # Only the startup wait is shortened; the reader's delays stay real.
        time.sleep(startup_wait if seconds >= 2.0 else seconds)

    monkeypatch.setattr(ais.subprocess, 'Popen', fake_popen)
    monkeypatch.setattr(ais, 'time', SimpleNamespace(
        sleep=fake_sleep, time=time.time, monotonic=time.monotonic,
    ))
    monkeypatch.setattr(ais.os, 'getpgid', lambda pid: pid)
    monkeypatch.setattr(ais.os, 'killpg', lambda pgid, sig: calls.append(('killpg', threading.get_ident())))
    return processes


async def test_ais_start_and_stop_do_not_block_the_event_loop(maritime, monkeypatch):
    calls = []
    _patch_ais_runtime(monkeypatch, calls)
    monkeypatch.setattr(ais, 'parse_ais_stream', lambda *args, **kwargs: None)
    loop_thread = threading.get_ident()

    async with LoopWatch() as watch:
        response = await maritime.client.post('/ais/start', json={'device': 0, 'gain': 40})
        assert response.status_code == 200
        assert (await response.get_json())['status'] == 'started'
        assert maritime.registry.status() == {0: 'ais'}
        response = await maritime.client.post('/ais/stop')
        assert (await response.get_json())['status'] == 'stopped'

    assert maritime.registry.status() == {}
    assert ais.ais_running is False
    assert app_module.ais_process is None
    on_loop = sorted({name for name, thread in calls if thread == loop_thread})
    assert on_loop == [], f'blocking calls ran on the event loop thread: {on_loop}'
    assert loop_thread not in maritime.claim_threads, 'USB probe (claim) ran on the event loop thread'
    assert watch.worst < 0.15, f'event loop stalled for {watch.worst:.2f}s'


async def test_ais_start_does_not_replay_previous_session_vessels(maritime, monkeypatch):
    _patch_ais_runtime(monkeypatch, [], startup_wait=0.01)
    monkeypatch.setattr(ais, 'parse_ais_stream', lambda *args, **kwargs: None)
    # A vessel published by the previous session is still in the replay history.
    app_module.ais_queue.put({'type': 'vessel', 'mmsi': '211000001', 'name': 'OLD SESSION'})

    response = await maritime.client.post('/ais/start', json={'device': 0})
    assert response.status_code == 200

    with app_module.ais_queue.subscribe() as viewer:
        replayed = [viewer.get_nowait() for _ in range(viewer.qsize())]
    assert [event for event in replayed if event.get('type') == 'vessel'] == []


class FakeAisServer:
    """The TCP side of AIS-catcher: counts readers and can die and come back."""

    def __init__(self):
        self.port = None
        self.accepted = 0
        self.connections = []
        self._listener = None
        self.open()

    def open(self):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(('127.0.0.1', self.port or 0))
        listener.listen(8)
        self.port = listener.getsockname()[1]
        self.accepted = 0
        self._listener = listener
        threading.Thread(target=self._accept, args=(listener,), daemon=True).start()

    def _accept(self, listener):
        while True:
            try:
                connection, _ = listener.accept()
            except OSError:
                return
            self.connections.append(connection)
            self.accepted += 1

    def send(self, line):
        for connection in list(self.connections):
            try:
                connection.sendall(line.encode() + b'\n')
            except OSError:
                pass

    def close(self):
        if self._listener is not None:
            # shutdown() wakes the accept thread; close() alone leaves the port bound
            try:
                self._listener.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self._listener.close()
            self._listener = None
        for connection in self.connections:
            try:
                connection.close()
            except OSError:
                pass
        self.connections = []


def _ais_reader_threads():
    return [thread for thread in threading.enumerate()
            if thread.is_alive() and 'parse_ais_stream' in thread.name]


@pytest.fixture
def ais_server(monkeypatch):
    server = FakeAisServer()
    monkeypatch.setattr(ais, 'AIS_TCP_PORT', server.port)
    yield server
    server.close()


async def test_ais_reader_of_a_stopped_session_never_joins_the_next_one(maritime, monkeypatch, ais_server):
    # The reconnect delay is longer than the (shortened) startup wait, so the
    # old reader is still waiting when the next session starts.
    monkeypatch.setattr(ais, 'AIS_RECONNECT_DELAY', 1.0)
    _patch_ais_runtime(monkeypatch, [], startup_wait=0.02)
    before = len(_ais_reader_threads())

    response = await maritime.client.post('/ais/start', json={'device': 0})
    assert response.status_code == 200
    assert await _async_wait_until(lambda: ais_server.accepted == 1)

    # Stop kills AIS-catcher: its TCP server disappears, the reader notices.
    ais_server.close()
    await asyncio.sleep(0.1)
    assert (await maritime.client.post('/ais/stop')).status_code == 200
    assert await _async_wait_until(lambda: len(_ais_reader_threads()) == before, timeout=0.5), \
        'the reader of the stopped session did not end promptly'

    ais_server.open()
    response = await maritime.client.post('/ais/start', json={'device': 0})
    assert response.status_code == 200
    assert await _async_wait_until(lambda: ais_server.accepted >= 1)
    await asyncio.sleep(1.3)  # longer than the old reader's reconnect delay

    assert ais_server.accepted == 1, 'a reader of the previous session attached to the new AIS-catcher'
    assert len(_ais_reader_threads()) == before + 1
    assert ais.ais_connected is True


async def test_ais_catcher_exit_resets_session_and_tells_viewers(maritime, monkeypatch, ais_server):
    monkeypatch.setattr(ais, 'AIS_RECONNECT_DELAY', 0.05)
    processes = _patch_ais_runtime(
        monkeypatch, [], startup_wait=0.02, stderr=io.BytesIO(b'rtlsdr: device disconnected\n'),
    )

    response = await maritime.client.post('/ais/start', json={'device': 0})
    assert response.status_code == 200
    assert await _async_wait_until(lambda: ais_server.accepted == 1)
    assert maritime.registry.status() == {0: 'ais'}

    # AIS-catcher dies by itself (dongle unplugged, crash).
    processes[0].returncode = 1
    ais_server.close()

    assert await _async_wait_until(lambda: ais.ais_running is False), \
        'state still says tracking after AIS-catcher exited'
    assert await _async_wait_until(lambda: maritime.registry.status() == {}), 'receiver claim leaked'
    assert app_module.ais_process is None
    assert ais.ais_active_device is None
    events = _history(app_module.ais_queue)
    assert {'type': 'status', 'status': 'stopped'}.items() <= events[-1].items()
    assert any(event.get('type') == 'error' for event in events)

    status = await (await maritime.client.get('/ais/status')).get_json()
    assert status['tracking_active'] is False

    # The mode can be started again without pressing Stop first.
    ais_server.open()
    response = await maritime.client.post('/ais/start', json={'device': 0})
    assert response.status_code == 200, await response.get_json()
