"""Aircraft modes must honor receiver families instead of falling back to RTL0."""

from io import BytesIO
import queue
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from quart import Quart

from routes import acars, adsb, uat
from utils.sdr import SDRType
from utils.sdr.registry import SDRDeviceRegistry


@pytest.fixture
def aircraft_client(monkeypatch):
    import app as app_module

    acars_reader, uat_reader = acars.stream_acars_output, uat._stream_uat_output
    registry = SDRDeviceRegistry(probe=lambda device: None)
    monkeypatch.setattr(app_module, '_sdr_registry', registry)
    monkeypatch.setattr(app_module, 'sdr_device_registry', registry.allocations)
    monkeypatch.setattr(app_module, 'sdr_device_registry_lock', registry.lock)
    claim = Mock(wraps=app_module.claim_sdr_device)
    monkeypatch.setattr(app_module, 'claim_sdr_device', claim)
    monkeypatch.setattr(app_module, 'acars_process', None)
    monkeypatch.setattr(app_module, 'adsb_process', None)
    monkeypatch.setattr(app_module, 'acars_queue', queue.Queue())
    monkeypatch.setattr(app_module, 'adsb_queue', queue.Queue())
    monkeypatch.setattr(acars, 'acars_active_device', None)
    monkeypatch.setattr(acars, 'find_acarsdec', Mock(return_value='/mock/acarsdec'))
    monkeypatch.setattr(acars, 'get_acarsdec_json_flag', lambda path: '-j')
    monkeypatch.setattr(acars, 'PROCESS_START_WAIT', 0)
    monkeypatch.setattr(acars, 'register_process', Mock())
    monkeypatch.setattr(acars, 'unregister_process', Mock())
    monkeypatch.setattr(acars, 'stream_acars_output', Mock())
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
    monkeypatch.setattr(uat, '_stream_uat_output', Mock())
    monkeypatch.setattr(adsb, 'adsb_active_device', None)
    monkeypatch.setattr(adsb, 'adsb_active_sdr_type', SDRType.RTL_SDR)
    monkeypatch.setattr(adsb, 'adsb_using_service', False)
    monkeypatch.setattr(adsb, 'DUMP1090_START_WAIT', 0)
    monkeypatch.setattr(adsb, 'check_dump1090_service', Mock(return_value=None))
    monkeypatch.setattr(adsb, 'find_dump1090', Mock(return_value=None))
    monkeypatch.setattr(adsb, '_get_active_session', Mock(return_value=None))
    monkeypatch.setattr(adsb, '_build_local_adsb_command', Mock(return_value=['mock-readsb']))
    monkeypatch.setattr(adsb, 'register_process', Mock())
    monkeypatch.setattr(adsb, 'unregister_process', Mock())
    app = Quart(__name__)
    app.config['TESTING'] = True
    for blueprint in (acars.acars_bp, adsb.adsb_bp, uat.uat_bp):
        app.register_blueprint(blueprint)
    return SimpleNamespace(client=app.test_client(), registry=registry, claim=claim, app=app_module,
                           acars_reader=acars_reader, uat_reader=uat_reader)


@pytest.mark.parametrize('path', ['/acars/start', '/uat/start'])
@pytest.mark.parametrize('family', ['hackrf', 'airspy', 'limesdr', 'invalid-radio'])
async def test_rtl_only_modes_reject_other_families_before_tools_or_claims(aircraft_client, path, family):
    fixture = aircraft_client
    assert fixture.registry.claim(0, 'running-rtl-receiver') is None
    response = await fixture.client.post(path, json={'device': 0, 'sdr_type': family})
    assert response.status_code == 400
    assert (await response.get_json())['status'] == 'error'
    fixture.claim.assert_not_called()
    assert fixture.registry.status() == {0: 'running-rtl-receiver'}
    acars.find_acarsdec.assert_not_called()
    uat.find_dump978.assert_not_called()
    uat.find_uat2json.assert_not_called()


async def test_adsb_invalid_family_cannot_touch_an_existing_receiver(aircraft_client):
    fixture = aircraft_client
    receiver = Mock()
    receiver.poll.return_value = None
    fixture.app.adsb_process = receiver
    adsb.adsb_active_device = 1
    adsb.adsb_active_sdr_type = SDRType.HACKRF
    assert fixture.registry.claim(1, 'adsb', 'hackrf') is None
    response = await fixture.client.post('/adsb/start', json={'device': 0, 'sdr_type': 'unknown'})
    assert response.status_code == 400
    adsb._build_local_adsb_command.assert_not_called()
    adsb.check_dump1090_service.assert_not_called()
    fixture.claim.assert_not_called()
    receiver.terminate.assert_not_called()
    assert fixture.app.adsb_process is receiver
    assert fixture.registry.status() == {'hackrf:1': 'adsb'}


async def test_adsb_selects_hackrf_without_disturbing_rtl_with_same_index(aircraft_client, monkeypatch):
    fixture = aircraft_client
    assert fixture.registry.claim(0, 'acars') is None
    process = Mock(stderr=BytesIO(b'mocked startup failure'))
    process.poll.return_value = 1
    monkeypatch.setattr(adsb.subprocess, 'Popen', Mock(return_value=process))
    response = await fixture.client.post('/adsb/start', json={'device': 0, 'sdr_type': 'hackrf'})
    assert response.status_code == 500
    adsb._build_local_adsb_command.assert_called_once_with(SDRType.HACKRF, 0, 40.0, False)
    fixture.claim.assert_called_once_with(0, 'adsb', sdr_type=SDRType.HACKRF)
    assert fixture.registry.status() == {0: 'acars'}


@pytest.mark.parametrize('mode', ['acars', 'uat'])
async def test_rtl_modes_start_and_report_selected_physical_index(aircraft_client, monkeypatch, mode):
    fixture = aircraft_client
    assert fixture.registry.claim(0, 'adsb', 'hackrf') is None
    processes = [Mock(stdout=BytesIO(), stderr=BytesIO()) for _ in range(2)]
    for process in processes:
        process.poll.return_value = None
    spawn = Mock(side_effect=processes)
    monkeypatch.setattr(acars.subprocess, 'Popen', spawn)
    response = await fixture.client.post(f'/{mode}/start', json={'device': 2, 'sdr_type': 'rtl_sdr'})
    assert response.status_code == 200
    body = await response.get_json()
    assert body['receiver'] == {'device': 2, 'sdr_type': 'rtlsdr'}
    status = await (await fixture.client.get(f'/{mode}/status')).get_json()
    assert status['active_device'] == 2
    assert status['active_sdr_type'] == 'rtlsdr'
    assert status['sdr_type'] == 'rtlsdr'
    assert status['receiver'] == body['receiver']
    assert fixture.registry.status() == {'hackrf:0': 'adsb', 2: mode}


async def test_adsb_status_and_session_report_active_family(aircraft_client):
    fixture = aircraft_client
    adsb.adsb_active_device = 0
    adsb.adsb_active_sdr_type = SDRType.HACKRF
    for path in ('/adsb/status', '/adsb/session'):
        data = await (await fixture.client.get(path)).get_json()
        assert data['active_device'] == 0
        assert data['active_sdr_type'] == 'hackrf'
        assert data['sdr_type'] == 'hackrf'
        assert data['receiver'] == {'device': 0, 'sdr_type': 'hackrf'}


@pytest.mark.parametrize('mode', ['adsb', 'acars', 'uat'])
async def test_idle_status_does_not_invent_receiver_identity(aircraft_client, mode):
    data = await (await aircraft_client.client.get(f'/{mode}/status')).get_json()
    assert data['active_device'] is None
    assert data['active_sdr_type'] is None
    assert data['receiver'] is None


def test_old_acars_reader_cannot_release_a_newer_receiver(aircraft_client, monkeypatch):
    fixture = aircraft_client
    old, current = Mock(stdout=BytesIO()), Mock()
    old.wait.return_value = 0
    fixture.app.acars_process = current
    acars.acars_active_device = 1
    assert fixture.registry.claim(1, 'acars') is None
    fixture.acars_reader(old)
    assert fixture.app.acars_process is current
    assert acars.acars_active_device == 1
    assert fixture.registry.status() == {1: 'acars'}
    events = list(fixture.app.acars_queue.queue)
    assert not any(event.get('status') == 'stopped' for event in events)


def test_old_uat_parser_cannot_publish_a_new_sessions_stop(aircraft_client):
    fixture = aircraft_client
    old, current = Mock(stdout=BytesIO()), Mock()
    uat._uat_json_process = current
    uat.uat_running = True
    fixture.uat_reader(old)
    assert uat._uat_json_process is current
    assert uat.uat_running is True
    events = list(fixture.app.adsb_queue.queue)
    assert not any(event.get('text') == 'uat_stopped' for event in events)
