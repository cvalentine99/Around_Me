"""Decoder-specific commands and failed process cleanup for main-app ADS-B."""

import asyncio
from io import BytesIO
from unittest.mock import Mock

import pytest
from quart import Quart

from routes import adsb
from utils.sdr import SDRFactory, SDRType
from utils.sdr.adsb import build_readsb_command


NATIVE_HELP = '--device-type=<type> --device=<index|serial> --enable-biast --gain=<db>'
SOAPY_HELP = '--device-type=<type> --soapy-device=<ident> --gain=<db>'


def device(sdr_type=SDRType.RTL_SDR, index=1, serial='receiver-1'):
    return SDRFactory.create_default_device(sdr_type, index=index, serial=serial)


def test_native_readsb_uses_its_own_device_option_and_explicit_sbs_port():
    cmd = build_readsb_command(device(), '/usr/bin/readsb', gain=40.2, tcp_port=30005, help_text=NATIVE_HELP)
    assert cmd[:5] == ['/usr/bin/readsb', '--device-type', 'rtlsdr', '--device', '1']
    assert '--device-index' not in cmd
    assert cmd[cmd.index('--net-sbs-port') + 1] == '30005'
    assert cmd[cmd.index('--gain') + 1] == '40.2'


@pytest.mark.parametrize('sdr_type,driver', [(SDRType.RTL_SDR, 'rtlsdr'), (SDRType.HACKRF, 'hackrf'), (SDRType.LIME_SDR, 'lime')])
def test_soapy_readsb_selects_the_detected_receiver(sdr_type, driver):
    cmd = build_readsb_command(device(sdr_type), '/usr/bin/readsb', help_text=SOAPY_HELP)
    assert cmd[:5] == ['/usr/bin/readsb', '--device-type', 'soapysdr', '--soapy-device', f'driver={driver},serial=receiver-1']
    assert cmd[cmd.index('--net-sbs-port') + 1] == str(adsb.ADSB_SBS_PORT)


def test_soapy_readsb_requires_an_unambiguous_serial():
    with pytest.raises(ValueError, match='serial'):
        build_readsb_command(device(serial='N/A'), 'readsb', help_text=SOAPY_HELP)


def test_readsb_bias_t_uses_only_an_advertised_native_control():
    cmd = build_readsb_command(device(), 'readsb', bias_t=True, help_text=NATIVE_HELP)
    assert '--enable-biast' in cmd
    with pytest.raises(ValueError, match='bias-T'):
        build_readsb_command(device(), 'readsb', bias_t=True, help_text=SOAPY_HELP)


def test_duplicate_soapy_serials_fall_back_to_correct_native_rtl_index(monkeypatch):
    monkeypatch.setattr(adsb.shutil, 'which', lambda name: '/usr/bin/readsb')
    monkeypatch.setattr(adsb, 'find_dump1090', lambda: '/usr/bin/dump1090-fa')
    monkeypatch.setattr(adsb, 'decoder_help', lambda path: SOAPY_HELP)
    monkeypatch.setattr(SDRFactory, 'detect_devices', lambda: [device(index=0, serial='duplicate'), device(index=1, serial='duplicate')])
    cmd = adsb._build_local_adsb_command(SDRType.RTL_SDR, 1, 40, False)
    assert cmd[0] == '/usr/bin/dump1090-fa'
    assert cmd[cmd.index('--device-index') + 1] == '1'


def test_unique_soapy_serial_uses_selected_index_not_first_receiver(monkeypatch):
    monkeypatch.setattr(adsb.shutil, 'which', lambda name: '/usr/bin/readsb')
    monkeypatch.setattr(adsb, 'find_dump1090', lambda: None)
    monkeypatch.setattr(adsb, 'decoder_help', lambda path: SOAPY_HELP)
    monkeypatch.setattr(SDRFactory, 'detect_devices', lambda: [device(index=0, serial='first'), device(index=1, serial='second')])
    cmd = adsb._build_local_adsb_command(SDRType.RTL_SDR, 1, 40, False)
    assert cmd[cmd.index('--soapy-device') + 1] == 'driver=rtlsdr,serial=second'


@pytest.fixture
def client(monkeypatch):
    app = Quart(__name__)
    app.config['TESTING'] = True
    app.register_blueprint(adsb.adsb_bp)
    monkeypatch.setattr(adsb, 'adsb_using_service', False)
    monkeypatch.setattr(adsb, 'adsb_active_device', None)
    monkeypatch.setattr(adsb.app_module, 'adsb_process', None)
    monkeypatch.setattr(adsb, 'check_dump1090_service', lambda: None)
    monkeypatch.setattr(adsb, 'DUMP1090_START_WAIT', 0)
    monkeypatch.setattr(adsb, '_build_local_adsb_command', lambda *args: ['readsb', '--net-sbs-port', '30003'])
    return app.test_client()


async def test_failed_start_returns_stderr_and_releases_typed_device(client, monkeypatch):
    proc = Mock()
    proc.poll.return_value = 1
    proc.stderr = BytesIO(b'readsb: unsupported option\n' + b'x' * 350)
    monkeypatch.setattr(adsb.subprocess, 'Popen', Mock(return_value=proc))
    claim = Mock(return_value=None)
    release = Mock()
    registered, unregistered = Mock(), Mock()
    monkeypatch.setattr(adsb.app_module, 'claim_sdr_device', claim)
    monkeypatch.setattr(adsb.app_module, 'release_sdr_device', release)
    monkeypatch.setattr(adsb, 'register_process', registered)
    monkeypatch.setattr(adsb, 'unregister_process', unregistered)

    response = await client.post('/adsb/start', json={'device': 1, 'sdr_type': 'hackrf'})

    assert response.status_code == 500
    body = await response.get_json()
    assert body['status'] == 'error'
    assert 'unsupported option' in body['stderr']
    assert 'unsupported option' in body['message']
    assert adsb.app_module.adsb_process is None
    claim.assert_called_once_with(1, 'adsb', sdr_type=SDRType.HACKRF)
    release.assert_called_once_with(1, sdr_type=SDRType.HACKRF)
    registered.assert_called_once_with(proc)
    unregistered.assert_called_once_with(proc)


async def test_successful_start_registers_cleanup_and_stop_releases_same_family(client, monkeypatch):
    proc = Mock(pid=98765)
    proc.poll.return_value = None
    proc.wait.side_effect = lambda **kwargs: setattr(proc.poll, 'return_value', 0)
    monkeypatch.setattr(adsb.subprocess, 'Popen', Mock(return_value=proc))
    monkeypatch.setattr(adsb.app_module, 'claim_sdr_device', Mock(return_value=None))
    release = Mock()
    monkeypatch.setattr(adsb.app_module, 'release_sdr_device', release)
    registered, unregistered = Mock(), Mock()
    monkeypatch.setattr(adsb, 'register_process', registered)
    monkeypatch.setattr(adsb, 'unregister_process', unregistered)
    monkeypatch.setattr(adsb, 'parse_sbs_stream', Mock())
    monkeypatch.setattr(adsb, '_record_session_start', Mock(return_value={}))
    monkeypatch.setattr(adsb, '_record_session_stop', Mock(return_value={}))
    monkeypatch.setattr(adsb.os, 'getpgid', Mock(return_value=98765))
    kill_group = Mock()
    monkeypatch.setattr(adsb.os, 'killpg', kill_group)

    response = await client.post('/adsb/start', json={'device': 0, 'sdr_type': 'hackrf'})
    assert response.status_code == 200
    assert (await response.get_json())['status'] == 'started'
    registered.assert_called_once_with(proc)
    response = await client.post('/adsb/stop', json={})
    assert response.status_code == 200
    kill_group.assert_called_once_with(98765, 15)
    release.assert_called_once_with(0, sdr_type=SDRType.HACKRF)
    unregistered.assert_called_once_with(proc)
    assert adsb.app_module.adsb_process is None


async def test_cancelled_start_stops_receiver_and_releases_ownership(client, monkeypatch):
    proc = Mock(pid=98765)
    proc.poll.return_value = None
    proc.wait.side_effect = lambda **kwargs: setattr(proc.poll, 'return_value', 0)
    spawned = asyncio.Event()

    async def spawn(*args, **kwargs):
        spawned.set()
        return proc

    monkeypatch.setattr(adsb, 'async_popen', spawn)
    monkeypatch.setattr(adsb, 'DUMP1090_START_WAIT', 10)
    monkeypatch.setattr(adsb.app_module, 'claim_sdr_device', Mock(return_value=None))
    release = Mock()
    monkeypatch.setattr(adsb.app_module, 'release_sdr_device', release)
    monkeypatch.setattr(adsb, 'register_process', Mock())
    monkeypatch.setattr(adsb, 'unregister_process', Mock())
    monkeypatch.setattr(adsb.os, 'getpgid', Mock(return_value=98765))
    kill_group = Mock()
    monkeypatch.setattr(adsb.os, 'killpg', kill_group)

    async with client.app.test_request_context('/adsb/start', method='POST', json={'device': 1, 'sdr_type': 'hackrf'}):
        start = asyncio.create_task(adsb.start_adsb())
        await asyncio.wait_for(spawned.wait(), timeout=1)
        start.cancel()
        with pytest.raises(asyncio.CancelledError):
            await start

    kill_group.assert_called_once_with(98765, 15)
    release.assert_called_once_with(1, sdr_type=SDRType.HACKRF)
    assert adsb.app_module.adsb_process is None
    assert not adsb.app_module.adsb_lock.locked()


async def test_failed_stop_preserves_live_process_registration_and_claim(client, monkeypatch):
    proc = Mock(pid=98765)
    proc.poll.return_value = None
    proc.wait.side_effect = adsb.subprocess.TimeoutExpired('readsb', 1)
    monkeypatch.setattr(adsb.app_module, 'adsb_process', proc)
    monkeypatch.setattr(adsb, 'adsb_using_service', True)
    monkeypatch.setattr(adsb, 'adsb_active_device', 1)
    monkeypatch.setattr(adsb, 'adsb_active_sdr_type', SDRType.HACKRF)
    monkeypatch.setattr(adsb.os, 'getpgid', Mock(return_value=98765))
    monkeypatch.setattr(adsb.os, 'killpg', Mock())
    release, unregister = Mock(), Mock()
    monkeypatch.setattr(adsb.app_module, 'release_sdr_device', release)
    monkeypatch.setattr(adsb, 'unregister_process', unregister)
    response = await client.post('/adsb/stop')
    assert response.status_code == 500
    assert 'remains reserved' in (await response.get_json())['message']
    assert adsb.app_module.adsb_process is proc
    assert adsb.adsb_active_device == 1
    assert adsb.adsb_active_sdr_type == SDRType.HACKRF
    release.assert_not_called()
    unregister.assert_not_called()
