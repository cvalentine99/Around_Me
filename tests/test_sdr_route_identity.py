"""Generic receiver routes preserve the hardware family they actually claimed."""

import asyncio
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from quart import Quart

import app as app_module
from routes import ais, listening_post as lp, pager, sensor, waterfall_websocket
from utils.sdr import SDRFactory, SDRType
from utils.sdr.registry import SDRDeviceRegistry


@pytest.fixture
def route_client(monkeypatch):
    app = Quart(__name__)
    app.config['TESTING'] = True
    for blueprint in (pager.pager_bp, sensor.sensor_bp, ais.ais_bp, lp.listening_post_bp):
        app.register_blueprint(blueprint)
    waterfall_websocket.init_waterfall_websocket(app)
    monkeypatch.setattr(app_module, 'current_process', None)
    monkeypatch.setattr(app_module, 'sensor_process', None)
    monkeypatch.setattr(app_module, 'ais_process', None)
    monkeypatch.setattr(pager, 'pager_active_device', None)
    monkeypatch.setattr(sensor, 'sensor_active_device', None)
    monkeypatch.setattr(ais, 'ais_active_device', None)
    monkeypatch.setattr(ais, 'ais_running', False)
    monkeypatch.setattr(lp, 'scanner_running', False)
    monkeypatch.setattr(lp, 'scanner_active_device', None)
    monkeypatch.setattr(lp, 'listening_active_device', None)
    monkeypatch.setattr(lp, 'audio_running', False)
    monkeypatch.setattr(lp, 'waterfall_running', False)
    monkeypatch.setattr(lp, 'scanner_thread', None)
    monkeypatch.setattr(lp, 'scanner_power_process', None)
    monkeypatch.setattr(lp, 'scanner_config', dict(lp.scanner_config))
    monkeypatch.setattr(pager, 'get_tool_path', lambda name: f'/mock/{name}')
    monkeypatch.setattr(ais, 'find_ais_catcher', lambda: '/mock/AIS-catcher')

    registry = SDRDeviceRegistry(probe=lambda index: None)
    registry.claim(0, 'other-rtl-mode')
    claim = Mock(wraps=registry.claim)
    leased_claim = Mock(wraps=registry.claim_with_lease)
    release = Mock(wraps=registry.release)
    monkeypatch.setattr(app_module, 'claim_sdr_device', claim)
    monkeypatch.setattr(app_module, 'claim_sdr_device_with_lease', leased_claim, raising=False)
    monkeypatch.setattr(app_module, 'release_sdr_device', release)
    return SimpleNamespace(client=app.test_client(), registry=registry, claim=claim, leased_claim=leased_claim, release=release)


@pytest.mark.parametrize('path,mode', [('/start', 'pager'), ('/start_sensor', 'sensor'), ('/ais/start', 'ais')])
async def test_start_failure_releases_requested_family_without_releasing_rtl(route_client, monkeypatch, path, mode):
    monkeypatch.setattr(pager.subprocess, 'Popen', Mock(side_effect=FileNotFoundError('mock missing executable')))
    response = await route_client.client.post(path, json={'device': 0, 'sdr_type': 'hackrf'})
    assert (await response.get_json())['status'] == 'error'
    route_client.claim.assert_called_once_with(0, mode, sdr_type=SDRType.HACKRF)
    route_client.release.assert_called_once_with(0, sdr_type=SDRType.HACKRF, mode_name=mode)
    assert route_client.registry.status() == {0: 'other-rtl-mode'}


@pytest.mark.parametrize('path', ['/start', '/start_sensor', '/ais/start', '/listening/scanner/start', '/listening/audio/start'])
async def test_invalid_family_is_rejected_before_claim(route_client, path):
    response = await route_client.client.post(path, json={'device': 0, 'sdr_type': 'unknown-radio', 'frequency': 100})
    assert response.status_code == 400
    route_client.claim.assert_not_called()


async def test_missing_pager_decoder_does_not_claim_receiver(route_client, monkeypatch):
    monkeypatch.setattr(pager, 'get_tool_path', lambda name: None)
    response = await route_client.client.post('/start', json={'device': 0, 'sdr_type': 'hackrf'})
    assert response.status_code == 400
    route_client.claim.assert_not_called()


async def test_listening_stop_uses_claimed_family_after_config_changes(route_client, monkeypatch):
    route_client.registry.claim(0, 'listening', 'hackrf')
    monkeypatch.setattr(lp, 'listening_active_device', 0)
    monkeypatch.setattr(lp, 'listening_active_sdr_type', 'hackrf')
    lp.scanner_config['sdr_type'] = 'rtlsdr'
    monkeypatch.setattr(lp, '_stop_audio_stream', Mock())
    response = await route_client.client.post('/listening/audio/stop')
    assert response.status_code == 200
    route_client.release.assert_called_once_with(0, sdr_type='hackrf', mode_name='listening')
    assert route_client.registry.status() == {0: 'other-rtl-mode'}


async def test_scanner_claim_and_stop_keep_family_separate_from_mutable_config(route_client, monkeypatch):
    monkeypatch.setattr(lp, 'find_rx_fm', lambda: '/mock/rx_fm')
    monkeypatch.setattr(lp, 'find_rtl_power', lambda: None)
    monkeypatch.setattr(lp, 'threading', SimpleNamespace(Thread=Mock()))
    monkeypatch.setattr(lp, '_stop_audio_stream', Mock())
    response = await route_client.client.post('/listening/scanner/start', json={'device': 0, 'sdr_type': 'hackrf'})
    assert response.status_code == 200
    route_client.claim.assert_called_once_with(0, 'scanner', sdr_type='hackrf')
    assert route_client.registry.status()['hackrf:0'] == 'scanner'
    lp.scanner_config['sdr_type'] = 'rtlsdr'
    response = await route_client.client.post('/listening/scanner/stop')
    assert response.status_code == 200
    route_client.release.assert_called_once_with(0, sdr_type='hackrf', mode_name='scanner')
    assert route_client.registry.status() == {0: 'other-rtl-mode'}


async def test_waterfall_failure_releases_hackrf_without_touching_rtl(route_client, monkeypatch):
    caps = SDRFactory.get_capabilities(SDRType.HACKRF)
    builder = Mock()
    builder.get_capabilities.return_value = caps
    builder.build_iq_capture_command.side_effect = NotImplementedError('test capture unavailable')
    monkeypatch.setattr(SDRFactory, 'get_builder', Mock(return_value=builder))
    async with route_client.client.websocket('/ws/waterfall') as ws:
        await ws.send_json({'cmd': 'start', 'device': 0, 'sdr_type': 'hackrf'})
        response = await asyncio.wait_for(ws.receive_json(), 1)
        assert response['status'] == 'error'
        await ws.send_json({'cmd': 'stop'})
        assert (await asyncio.wait_for(ws.receive_json(), 1))['status'] == 'stopped'
    route_client.leased_claim.assert_called_once_with(0, 'waterfall', sdr_type=SDRType.HACKRF)
    route_client.release.assert_called_once_with(0, sdr_type=SDRType.HACKRF, mode_name='waterfall', lease=2)
    assert route_client.registry.status() == {0: 'other-rtl-mode'}


async def test_dead_waterfall_connection_cannot_release_new_same_mode_capture(route_client, monkeypatch):
    caps = SDRFactory.get_capabilities(SDRType.HACKRF)
    builder = Mock()
    builder.get_capabilities.return_value = caps
    builder.build_iq_capture_command.return_value = ['/mock/rx_sdr']
    monkeypatch.setattr(SDRFactory, 'get_builder', Mock(return_value=builder))
    proc = Mock()
    proc.stdout = BytesIO(b'')
    proc.poll.return_value = None
    monkeypatch.setattr(waterfall_websocket.subprocess, 'Popen', Mock(return_value=proc))
    async with route_client.client.websocket('/ws/waterfall') as ws:
        await ws.send_json({'cmd': 'start', 'device': 0, 'sdr_type': 'hackrf'})
        assert (await asyncio.wait_for(ws.receive_json(), 1))['status'] == 'started'
        # Model Stop All's completed hardware shutdown and a fresh connection
        # acquiring the same hardware for the same mode before this one closes.
        proc.poll.return_value = 0
        route_client.registry.release(0, 'hackrf')
        error, new_lease = route_client.registry.claim_with_lease(0, 'waterfall', 'hackrf')
        assert error is None
        reply = await asyncio.wait_for(ws.receive_json(), 1)
        assert reply['status'] == 'error'
        assert route_client.registry.snapshot()['hackrf:0'] == ('waterfall', new_lease)
    assert route_client.registry.snapshot()['hackrf:0'] == ('waterfall', new_lease)


@pytest.mark.parametrize('module,process_name,active_name,family_name,mode', [
    (sensor, 'sensor_process', 'sensor_active_device', 'sensor_active_sdr_type', 'sensor'),
    (pager, 'current_process', 'pager_active_device', 'pager_active_sdr_type', 'pager'),
])
def test_late_reader_does_not_clear_new_receiver(route_client, monkeypatch, module, process_name, active_name, family_name, mode):
    current = Mock()
    monkeypatch.setattr(app_module, process_name, current)
    monkeypatch.setattr(module, active_name, 0)
    monkeypatch.setattr(module, family_name, SDRType.HACKRF)
    route_client.registry.claim(0, mode, 'hackrf')
    old = Mock()
    old.stdout = BytesIO(b'')
    if module is sensor:
        sensor.stream_sensor_output(old)
    else:
        monkeypatch.setattr(pager.select, 'select', Mock(side_effect=OSError('closed test fd')))
        monkeypatch.setattr(pager.os, 'close', Mock())
        pager.stream_decoder(-1, old)
    assert getattr(app_module, process_name) is current
    assert route_client.registry.status()['hackrf:0'] == mode
    route_client.release.assert_not_called()


@pytest.mark.parametrize('path,lock_name', [('/start', 'process_lock'), ('/start_sensor', 'sensor_lock')])
async def test_waiting_for_scan_lock_keeps_event_loop_responsive(route_client, path, lock_name):
    lock = getattr(app_module, lock_name)
    lock.acquire()
    pending = asyncio.create_task(route_client.client.post(path, json={'sdr_type': 'invalid'}))
    try:
        await asyncio.wait_for(asyncio.sleep(.02), timeout=.5)
        assert not pending.done()
    finally:
        lock.release()
    response = await asyncio.wait_for(pending, 1)
    assert response.status_code == 400


@pytest.mark.parametrize('module,path,active_name,family_name', [
    (sensor, '/stop_sensor', 'sensor_active_device', 'sensor_active_sdr_type'),
    (pager, '/stop', 'pager_active_device', 'pager_active_sdr_type'),
])
async def test_duplicate_empty_stop_preserves_new_mode_owner(route_client, monkeypatch, module, path, active_name, family_name):
    # A delayed second stop still has stale metadata, but its process was
    # already stopped and another mode now owns that physical receiver.
    route_client.registry.claim(0, 'new-mode', 'hackrf')
    monkeypatch.setattr(module, active_name, 0)
    monkeypatch.setattr(module, family_name, SDRType.HACKRF)
    response = await route_client.client.post(path)
    assert response.status_code == 200
    assert (await response.get_json())['status'] == 'not_running'
    assert route_client.registry.status() == {0: 'other-rtl-mode', 'hackrf:0': 'new-mode'}
    assert getattr(module, active_name) is None
