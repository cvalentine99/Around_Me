"""Delayed weather callbacks must not release or reset newer captures."""

import threading
from unittest.mock import Mock

from quart import Quart

from utils.sdr.registry import SDRDeviceRegistry
from utils.weather_sat_scheduler import ScheduledPass, WeatherSatScheduler


def isolated_registry(monkeypatch):
    import app as app_module

    registry = SDRDeviceRegistry(probe=lambda device: None)
    monkeypatch.setattr(app_module, '_sdr_registry', registry)
    monkeypatch.setattr(app_module, 'sdr_device_registry', registry.allocations)
    monkeypatch.setattr(app_module, 'sdr_device_registry_lock', registry.lock)
    return registry


async def test_old_route_completion_preserves_new_capture_claim(monkeypatch):
    from routes import weather_sat

    registry = isolated_registry(monkeypatch)
    decoder = Mock(is_running=False)
    decoder.start.return_value = True
    monkeypatch.setattr(weather_sat, 'is_weather_sat_available', lambda: True)
    monkeypatch.setattr(weather_sat, 'get_weather_sat_decoder', lambda: decoder)
    app = Quart(__name__)
    app.register_blueprint(weather_sat.weather_sat_bp)
    client = app.test_client()
    payload = {'satellite': 'NOAA-18', 'device': 0}
    assert (await client.post('/weather-sat/start', json=payload)).status_code == 200
    old_callback = decoder.set_on_complete.call_args.args[0]
    registry.release(0)  # Stop All ended the old receiver.
    assert (await client.post('/weather-sat/start', json=payload)).status_code == 200
    new_claim = decoder._valentine_sdr_claim
    new_callback = decoder.set_on_complete.call_args.args[0]
    old_callback()
    assert registry.status() == {0: 'weather_sat'}
    assert decoder._valentine_sdr_claim is new_claim
    new_callback()
    assert registry.status() == {}


def test_scheduler_callback_uses_original_device_and_lease(monkeypatch):
    import utils.weather_sat_scheduler as schedules

    registry = isolated_registry(monkeypatch)
    decoder = Mock(is_running=False)
    decoder.start.return_value = True
    monkeypatch.setattr(schedules, 'get_weather_sat_decoder', lambda: decoder)
    monkeypatch.setattr(schedules.threading, 'Timer', Mock())
    scheduler = WeatherSatScheduler()
    scheduler._enabled = True
    scheduler._device = 0
    scheduled = ScheduledPass({
        'satellite': 'NOAA-18', 'name': 'NOAA 18', 'frequency': 137.9125, 'mode': 'APT',
        'startTimeISO': '2024-01-01T12:00:00+00:00',
        'endTimeISO': '2024-01-01T12:15:00+00:00',
        'maxEl': 45.0, 'duration': 15.0, 'quality': 'good',
    })
    scheduler._execute_capture(scheduled)
    callback = decoder.set_on_complete.call_args.args[0]
    registry.release(0)
    assert registry.claim(0, 'weather_sat') is None
    scheduler._device = 1
    assert registry.claim(1, 'sensor') is None
    callback()
    assert registry.status() == {0: 'weather_sat', 1: 'sensor'}


def test_old_decoder_reader_does_not_reset_new_capture(monkeypatch):
    from utils.weather_sat import WeatherSatDecoder

    # Avoid constructing the decoder: this regression needs no tools, files,
    # USB access, or real file descriptors.
    decoder = object.__new__(WeatherSatDecoder)
    old_process, new_process = Mock(), Mock()
    old_process.poll.return_value = 0
    new_process.poll.return_value = None
    decoder._lock = threading.Lock()
    decoder._process = new_process
    decoder._pty_master_fd = 99
    decoder._running = True
    decoder._capture_phase = 'listening'
    old_callback, new_callback = Mock(), Mock()
    decoder._on_complete_callback = new_callback
    monkeypatch.setattr(decoder, '_read_pty_lines', lambda *args: iter(()))
    close = Mock()
    monkeypatch.setattr('utils.weather_sat.os.close', close)

    decoder._read_satdump_output(old_process, 98, old_callback)

    old_callback.assert_called_once()
    new_callback.assert_not_called()
    close.assert_not_called()
    assert decoder._process is new_process
    assert decoder._pty_master_fd == 99
    assert decoder._running is True
    assert decoder._capture_phase == 'listening'
