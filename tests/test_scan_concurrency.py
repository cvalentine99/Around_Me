"""Regression coverage for scan requests sharing locks with output threads."""

import asyncio
from datetime import datetime
import queue
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from quart import Quart

from utils.async_lock import async_thread_lock
from utils.async_process import async_popen
from utils.bluetooth.aggregator import DeviceAggregator
from utils.bluetooth.models import BTObservation
from utils.bluetooth.ring_buffer import RingBuffer


async def test_cancelled_lock_waiter_cannot_acquire_after_cancellation():
    lock = threading.Lock()
    lock.acquire()
    acquired = []

    async def waiter():
        async with async_thread_lock(lock):
            acquired.append(True)

    task = asyncio.create_task(waiter())
    await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert lock.locked()
    lock.release()
    await asyncio.sleep(0.02)
    assert acquired == []
    assert lock.acquire(blocking=False)
    lock.release()


async def test_cancelled_lock_owner_releases_for_reader_thread():
    lock = threading.Lock()
    entered = asyncio.Event()

    async def owner():
        async with async_thread_lock(lock):
            entered.set()
            await asyncio.Future()

    task = asyncio.create_task(owner())
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert lock.acquire(blocking=False)
    lock.release()


async def test_cancelled_process_start_cleans_result_created_by_worker(monkeypatch):
    import utils.async_process as processes

    entered = threading.Event()
    release = threading.Event()
    process = Mock()
    process.poll.return_value = None

    def delayed_popen(*args, **kwargs):
        entered.set()
        assert release.wait(timeout=2)
        return process

    monkeypatch.setattr(processes.subprocess, 'Popen', delayed_popen)
    task = asyncio.create_task(async_popen(['mock-receiver']))
    try:
        for _ in range(100):
            if entered.is_set():
                break
            await asyncio.sleep(0.005)
        assert entered.is_set()
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=1)
    process.terminate.assert_called_once()
    process.wait.assert_called_once()


async def test_cancelled_rtlamr_start_releases_process_device_and_lock(monkeypatch):
    from routes import rtlamr

    lock = threading.Lock()
    state = SimpleNamespace(
        rtlamr_lock=lock, rtlamr_process=None, rtlamr_queue=queue.Queue(),
        claim_sdr_device=Mock(return_value=None), release_sdr_device=Mock(),
        claim_sdr_device_async=AsyncMock(return_value=None),
    )
    process = Mock()
    process.poll.return_value = None
    monkeypatch.setattr(rtlamr, 'app_module', state)
    monkeypatch.setattr(rtlamr, 'rtl_tcp_process', None)
    monkeypatch.setattr(rtlamr, 'rtlamr_active_device', None)
    monkeypatch.setattr(rtlamr, 'rtl_tcp_lock', threading.Lock())
    monkeypatch.setattr(rtlamr, 'register_process', lambda process: None)
    monkeypatch.setattr(rtlamr.subprocess, 'Popen', lambda *args, **kwargs: process)
    entered = asyncio.Event()
    original_sleep = asyncio.sleep

    async def startup_sleep(delay):
        if delay == 3:
            entered.set()
            await asyncio.Future()
        else:
            await original_sleep(delay)

    monkeypatch.setattr(rtlamr.asyncio, 'sleep', startup_sleep)
    app = Quart(__name__)
    async with app.test_request_context('/start_rtlamr', method='POST', json={}):
        task = asyncio.create_task(rtlamr.start_rtlamr())
        await asyncio.wait_for(entered.wait(), timeout=1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=1)
    assert rtlamr.rtl_tcp_process is None
    assert rtlamr.rtlamr_active_device is None
    state.release_sdr_device.assert_called_once_with(0)
    process.terminate.assert_called_once()
    assert not lock.locked()
    assert not rtlamr.rtl_tcp_lock.locked()


@pytest.mark.parametrize('mode', ['wifi', 'bluetooth', 'rtlamr', 'pmkid'])
async def test_cancelled_stop_finishes_handle_cleanup_before_unlocking(mode, monkeypatch):
    from routes import bluetooth, rtlamr, wifi

    module, stop, prefix = {
        'wifi': (wifi, wifi.stop_wifi_scan, 'wifi'),
        'bluetooth': (bluetooth, bluetooth.stop_bt_scan, 'bt'),
        'rtlamr': (rtlamr, rtlamr.stop_rtlamr, 'rtlamr'),
        'pmkid': (wifi, wifi.stop_pmkid, 'wifi'),
    }[mode]
    lock = threading.Lock()
    process, companion = Mock(), Mock()
    state = SimpleNamespace(**{
        f'{prefix}_lock': lock, f'{prefix}_process': process,
        'release_sdr_device': Mock(),
    })
    monkeypatch.setattr(module, 'app_module', state)
    entered, release = threading.Event(), threading.Event()

    def delayed_wait(**kwargs):
        entered.set()
        assert release.wait(timeout=2)
        return 0

    process.wait.side_effect = delayed_wait
    if mode == 'rtlamr':
        process.wait.side_effect = None
        companion.wait.side_effect = delayed_wait
        monkeypatch.setattr(rtlamr, 'rtl_tcp_process', companion)
        monkeypatch.setattr(rtlamr, 'rtl_tcp_lock', threading.Lock())
        monkeypatch.setattr(rtlamr, 'rtlamr_active_device', 0)
    if mode == 'pmkid':
        monkeypatch.setattr(wifi, 'pmkid_process', process)
        monkeypatch.setattr(wifi, 'pmkid_lock', lock)
    app = Quart(__name__)
    async with app.test_request_context('/mock-stop', method='POST'):
        task = asyncio.create_task(stop())
        try:
            for _ in range(100):
                if entered.is_set():
                    break
                await asyncio.sleep(0.005)
            assert entered.is_set()
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()  # Repeated cancellation must not abandon cleanup.
            await asyncio.sleep(0.01)
            assert not task.done()
            assert lock.locked()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=1)
    assert not lock.locked()
    if mode == 'pmkid':
        assert wifi.pmkid_process is None
    else:
        assert getattr(state, f'{prefix}_process') is None
    if mode == 'rtlamr':
        assert rtlamr.rtl_tcp_process is None
        assert rtlamr.rtlamr_active_device is None
        state.release_sdr_device.assert_called_once_with(0, mode_name='rtlamr')


@pytest.mark.parametrize('mode', ['wifi', 'bluetooth', 'rtlamr'])
async def test_stop_during_start_keeps_event_loop_responsive(mode, monkeypatch):
    from routes import bluetooth, rtlamr, wifi

    module, blueprint, start_url, stop_url, payload, prefix, output_reader = {
        'wifi': (wifi, wifi.wifi_bp, '/wifi/scan/start', '/wifi/scan/stop',
                 {'interface': 'wlan0mon'}, 'wifi', 'stream_airodump_output'),
        'bluetooth': (bluetooth, bluetooth.bluetooth_bp, '/bt/scan/start', '/bt/scan/stop',
                      {'interface': 'hci0', 'mode': 'hcitool'}, 'bt', 'stream_bt_scan'),
        'rtlamr': (rtlamr, rtlamr.rtlamr_bp, '/start_rtlamr', '/stop_rtlamr',
                   {}, 'rtlamr', 'stream_rtlamr_output'),
    }[mode]
    state = SimpleNamespace(**{
        f'{prefix}_lock': threading.Lock(), f'{prefix}_process': None,
        f'{prefix}_queue': queue.Queue(), 'wifi_monitor_interface': None,
        'claim_sdr_device': Mock(return_value=None), 'release_sdr_device': Mock(),
        'claim_sdr_device_async': AsyncMock(return_value=None),
    })
    monkeypatch.setattr(module, 'app_module', state)
    monkeypatch.setattr(module, output_reader, lambda *args: None)
    if mode == 'wifi':
        monkeypatch.setattr(wifi.os.path, 'exists', lambda path: True)
        monkeypatch.setattr(wifi, 'get_tool_path', lambda name: name)
    if mode == 'rtlamr':
        monkeypatch.setattr(rtlamr, 'rtl_tcp_process', None)
        monkeypatch.setattr(rtlamr, 'rtl_tcp_lock', threading.Lock())
        monkeypatch.setattr(rtlamr, 'register_process', lambda process: None)

    entered = threading.Event()
    release = threading.Event()
    spawned = []

    def popen(*args, **kwargs):
        if not spawned:
            entered.set()
            assert release.wait(timeout=2), 'test did not release mocked startup'
        process = Mock()
        process.poll.return_value = None
        process.stderr = []
        spawned.append(process)
        return process

    monkeypatch.setattr(module.subprocess, 'Popen', popen)
    original_sleep = asyncio.sleep

    async def short_startup_sleep(delay):
        await original_sleep(min(delay, 0.02))

    monkeypatch.setattr(module.asyncio, 'sleep', short_startup_sleep)
    app = Quart(__name__)
    app.register_blueprint(blueprint)
    client = app.test_client()
    start_task = asyncio.create_task(client.post(start_url, json=payload))
    stop_task = None
    try:
        for _ in range(100):
            if entered.is_set():
                break
            await original_sleep(0.005)
        assert entered.is_set()
        stop_task = asyncio.create_task(client.post(stop_url))
        # This heartbeat cannot run if stop synchronously acquires startup's lock.
        await asyncio.wait_for(original_sleep(0.03), timeout=0.5)
        assert not stop_task.done()
    finally:
        release.set()
        if stop_task is not None:
            start_response, stop_response = await asyncio.wait_for(
                asyncio.gather(start_task, stop_task), timeout=2
            )
        else:
            await asyncio.wait_for(start_task, timeout=2)
    assert (await start_response.get_json())['status'] == 'started'
    assert (await stop_response.get_json())['status'] == 'stopped'
    assert getattr(state, f'{prefix}_process') is None
    assert all(process.terminate.called for process in spawned)


def test_populated_bluetooth_heatmap_returns_device_metadata():
    aggregator = DeviceAggregator()
    aggregator._ring_buffer = RingBuffer()
    observation = BTObservation(
        timestamp=datetime.now(), address='AA:BB:CC:DD:EE:FF',
        address_type='public', rssi=-55, tx_power=None, name='Test Device',
        manufacturer_id=None, manufacturer_data=None, service_uuids=[], service_data={},
        appearance=None, is_connectable=True, is_paired=False, is_connected=False,
        class_of_device=None, major_class=None, minor_class=None,
    )
    device = aggregator.ingest(observation)
    results = queue.Queue()
    worker = threading.Thread(target=lambda: results.put(aggregator.get_heatmap_data()), daemon=True)
    worker.start()
    worker.join(timeout=1)
    assert not worker.is_alive(), 'populated heatmap deadlocked'
    data = results.get_nowait()
    assert len(data['devices']) == 1
    assert data['devices'][0]['device_key'] == device.device_key
    assert data['devices'][0]['name'] == 'Test Device'
    assert data['devices'][0]['rssi_current'] == -55


@pytest.fixture
def stop_all_state(monkeypatch):
    """Isolate Stop All from actual radios and other tests' process handles."""
    import app as application
    from routes import adsb, ais, audio_websocket, dmr, listening_post, rtlamr, uat
    import utils.bluetooth
    import utils.process as process_utils
    import utils.wifi.scanner
    import utils.weather_sat
    import utils.sstv.sstv_decoder

    for name in (
        'current_process', 'sensor_process', 'wifi_process', 'bt_process',
        'adsb_process', 'ais_process', 'acars_process', 'aprs_process',
        'aprs_rtl_process', 'dsc_process', 'dsc_rtl_process', 'dmr_process',
        'dmr_rtl_process', 'rtlamr_process', 'satellite_process',
    ):
        monkeypatch.setattr(application, name, None)
    for module, names in (
        (dmr, ('dmr_dsd_process', 'dmr_rtl_process', 'dmr_active_device')),
        (rtlamr, ('rtl_tcp_process', 'rtlamr_active_device')),
        (listening_post, ('scanner_power_process', 'waterfall_process', 'audio_process',
                          'audio_rtl_process', 'scanner_active_device', 'listening_active_device',
                          'waterfall_active_device')),
        (audio_websocket, ('audio_process', 'rtl_process')),
        (uat, ('_uat_dump978_process', '_uat_json_process', 'uat_active_device')),
        (adsb, ('adsb_active_device',)), (ais, ('ais_active_device',)),
    ):
        for name in names:
            monkeypatch.setattr(module, name, None, raising=False)
    monkeypatch.setattr(utils.weather_sat, '_decoder', None)
    monkeypatch.setattr(utils.sstv.sstv_decoder, '_decoder', None)
    monkeypatch.setattr(utils.sstv.sstv_decoder, '_general_decoder', None)
    from utils.sdr.registry import SDRDeviceRegistry
    manager, registered = SDRDeviceRegistry(probe=lambda index: None), []
    registry = manager.allocations
    monkeypatch.setattr(application, '_sdr_registry', manager)
    monkeypatch.setattr(application, 'sdr_device_registry', registry)
    monkeypatch.setattr(application, 'sdr_device_registry_lock', threading.Lock())
    monkeypatch.setattr(application, 'get_sdr_device_status', lambda: dict(registry))
    monkeypatch.setattr(process_utils, 'get_registered_processes', lambda: tuple(registered))
    monkeypatch.setattr(process_utils, 'register_process', registered.append)
    monkeypatch.setattr(utils.bluetooth, 'reset_bluetooth_scanner', lambda: None)
    monkeypatch.setattr(utils.wifi.scanner, 'reset_wifi_scanner', lambda: None)
    monkeypatch.setattr(application, 'cleanup_all_processes', Mock(side_effect=AssertionError('global cleanup')))
    monkeypatch.setattr(application.subprocess, 'run', Mock(side_effect=AssertionError('system-wide command')))
    return SimpleNamespace(app=application, registry=registry, manager=manager, registered=registered, utils=process_utils)


def test_stop_all_stops_readsb_handle_without_system_wide_kill(stop_all_state, monkeypatch):
    state = stop_all_state
    process = Mock()
    process.poll.return_value = None
    state.app.adsb_process = process
    state.registry[0] = 'adsb'
    state.registered.append(process)

    def terminate(target):
        assert target is process
        target.poll.return_value = 0

    monkeypatch.setattr(state.utils, 'safe_terminate', terminate)
    result = state.app._stop_owned_receivers()
    assert result['status'] == 'killed'
    assert state.app.adsb_process is None
    assert state.registry == {}


def test_stop_all_preserves_failed_process_handle_and_device(stop_all_state, monkeypatch):
    state = stop_all_state
    process = Mock()
    process.poll.return_value = None
    state.app.adsb_process = process
    state.registry[0] = 'adsb'
    monkeypatch.setattr(state.utils, 'safe_terminate', lambda target: False)
    result = state.app._stop_owned_receivers()
    assert result['status'] == 'error'
    assert state.app.adsb_process is process
    assert state.registry == {0: 'adsb'}
    assert any(item is process for item in state.registered)


def test_stop_all_does_not_clear_or_terminate_new_receiver(stop_all_state, monkeypatch):
    state = stop_all_state
    previous, current = Mock(), Mock()
    previous.poll.return_value = None
    current.poll.return_value = None
    state.app.adsb_process = previous
    state.registry[0] = 'adsb'
    state.registered.append(previous)
    seen = []

    def terminate(target):
        seen.append(target)
        target.poll.return_value = 0
        state.app.adsb_process = current
        state.registered.append(current)
        state.registry[1] = 'sensor'

    monkeypatch.setattr(state.utils, 'safe_terminate', terminate)
    result = state.app._stop_owned_receivers()
    assert result['status'] == 'killed'
    assert seen == [previous]
    assert state.app.adsb_process is current
    assert state.registry == {0: 'adsb', 1: 'sensor'}


def test_stop_all_keeps_unconfirmed_connection_receiver_claim(stop_all_state, monkeypatch):
    state = stop_all_state
    process = Mock()
    process.poll.return_value = None
    state.registered.append(process)
    state.registry[0] = 'waterfall'
    monkeypatch.setattr(state.utils, 'safe_terminate', lambda target: False)
    result = state.app._stop_owned_receivers()
    assert result['status'] == 'error'
    assert state.registry == {0: 'waterfall'}


def test_stop_all_does_not_release_a_new_same_mode_generation(stop_all_state, monkeypatch):
    state = stop_all_state
    process = Mock()
    process.poll.return_value = None
    state.app.adsb_process = process
    assert state.manager.claim(0, 'adsb') is None
    old_generation = state.manager.snapshot()[0][1]

    def terminate(target):
        target.poll.return_value = 0
        state.manager.release(0)
        assert state.manager.claim(0, 'adsb') is None

    monkeypatch.setattr(state.utils, 'safe_terminate', terminate)
    result = state.app._stop_owned_receivers()
    assert result['status'] == 'killed'
    assert state.registry == {0: 'adsb'}
    assert state.manager.snapshot()[0][1] != old_generation
