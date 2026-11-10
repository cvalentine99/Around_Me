"""Regression coverage for viewer-independent event processing and SSE fanout."""

import asyncio
from io import BytesIO
import json
from pathlib import Path
import shutil
import subprocess
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from quart import Quart

from utils.sse import EventQueue, event_stream_response, queue_events


def test_every_viewer_receives_each_event_and_slow_viewer_cannot_block_producer(monkeypatch):
    processed = Mock()
    monkeypatch.setattr('utils.event_pipeline.process_event', processed)
    events = EventQueue(maxsize=2, mode='sensor')
    with events.subscribe(replay=False) as first, events.subscribe(replay=False) as slow:
        for number in range(5):
            events.put({'type': 'sensor', 'number': number})
            assert first.get_nowait()['number'] == number
        assert [slow.get_nowait()['number'] for _ in range(2)] == [3, 4]
    assert processed.call_count == 5
    assert events.qsize() == 2
    assert not events._subscribers


def test_replay_is_a_snapshot_and_does_not_repeat_recordings_or_alerts(monkeypatch):
    processed = Mock()
    monkeypatch.setattr('utils.event_pipeline.process_event', processed)
    events = EventQueue(maxsize=4, mode='sensor')
    original = {'type': 'sensor', 'reading': {'temperature': 20}}
    events.put(original)
    original['reading']['temperature'] = 99
    with events.subscribe() as first, events.subscribe() as second:
        assert first.get_nowait()['reading']['temperature'] == 20
        assert second.get_nowait()['reading']['temperature'] == 20
    assert processed.call_count == 1


async def test_subscribing_does_not_wait_for_producer_pipeline_io(monkeypatch):
    started = threading.Event()
    finish = threading.Event()

    def processing(*args):
        started.set()
        assert finish.wait(2)

    monkeypatch.setattr('utils.event_pipeline.process_event', processing)
    events = EventQueue(maxsize=4, mode='sensor')
    producer = asyncio.create_task(asyncio.to_thread(events.put, {'type': 'sensor'}))
    await asyncio.wait_for(asyncio.to_thread(started.wait), 1)
    try:
        with events.subscribe(replay=False) as subscriber:
            assert subscriber.empty()
            finish.set()
            await asyncio.wait_for(producer, 1)
            assert subscriber.get_nowait() == {'type': 'sensor'}
    finally:
        finish.set()


async def test_async_streams_deliver_to_both_clients_and_release_subscriptions():
    events = EventQueue(maxsize=4)
    first = queue_events(events, timeout=.02)
    second = queue_events(events, timeout=.02)
    receives = [asyncio.create_task(first.__anext__()), asyncio.create_task(second.__anext__())]
    while len(events._subscribers) < 2:
        await asyncio.sleep(0)
    event = {'type': 'sensor', 'id': 1234}
    events.put(event)
    assert await asyncio.wait_for(asyncio.gather(*receives), 1) == [event, event]
    await first.aclose()
    await second.aclose()
    assert not events._subscribers


async def test_disconnect_does_not_consume_another_viewers_event():
    events = EventQueue(maxsize=4)
    first = queue_events(events, timeout=.02)
    second = queue_events(events, timeout=.02)
    abandoned = asyncio.create_task(first.__anext__())
    survivor = asyncio.create_task(second.__anext__())
    while len(events._subscribers) < 2:
        await asyncio.sleep(0)
    abandoned.cancel()
    with pytest.raises(asyncio.CancelledError):
        await abandoned
    events.put({'type': 'sensor', 'id': 'after-disconnect'})
    assert (await asyncio.wait_for(survivor, 1))['id'] == 'after-disconnect'
    await second.aclose()
    assert not events._subscribers


async def test_sensor_stream_survives_the_normal_response_deadline():
    app = Quart(__name__)
    app.config['RESPONSE_TIMEOUT'] = .01
    events = EventQueue(maxsize=4)

    @app.route('/events')
    async def stream():
        return event_stream_response(events, timeout=.01, keepalive_interval=.02)

    async with app.test_client().request('/events', method='GET') as connection:
        await asyncio.sleep(.04)
        events.put({'type': 'sensor', 'id': 'after-deadline'})
        received = b''
        while b'after-deadline' not in received:
            received += await asyncio.wait_for(connection.receive(), 1)
        assert connection.status_code == 200
        await connection.disconnect()
    assert not events._subscribers


async def test_idle_wifi_stream_does_not_block_unrelated_coroutines(monkeypatch):
    from routes import wifi_v2
    from utils.wifi.scanner import UnifiedWiFiScanner

    scanner = UnifiedWiFiScanner()
    monkeypatch.setattr(wifi_v2, 'get_wifi_scanner', lambda: scanner)
    response = await wifi_v2.event_stream()
    body = response.response.__aiter__()
    pending = asyncio.create_task(body.__anext__())
    # An idle synchronous queue read lasts one second. Other work must finish
    # while the read is outstanding, rather than being delayed by that second.
    await asyncio.wait_for(asyncio.sleep(.02), .2)
    assert not pending.done()
    scanner._queue_event({'type': 'network_update', 'bssid': 'AA:BB:CC:DD:EE:FF'})
    assert 'network_update' in await asyncio.wait_for(pending, 1)
    await body.aclose()
    assert not scanner._event_queue._subscribers


async def test_canceling_idle_wifi_stream_unregisters_its_viewer(monkeypatch):
    from routes import wifi_v2
    from utils.wifi.scanner import UnifiedWiFiScanner

    scanner = UnifiedWiFiScanner()
    monkeypatch.setattr(wifi_v2, 'get_wifi_scanner', lambda: scanner)
    response = await wifi_v2.event_stream()
    body = response.response.__aiter__()
    pending = asyncio.create_task(body.__anext__())
    while not scanner._event_queue._subscribers:
        await asyncio.sleep(0)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(pending, 2)
    assert not scanner._event_queue._subscribers


def test_decoder_records_and_alerts_without_a_browser(tmp_path, monkeypatch):
    import app as app_module
    from routes import sensor
    import utils.alerts as alerts
    import utils.database as database
    import utils.recording as recording

    monkeypatch.setattr(database, 'DB_DIR', tmp_path)
    monkeypatch.setattr(database, 'DB_PATH', tmp_path / 'events.db')
    monkeypatch.setattr(recording, 'RECORDING_ROOT', tmp_path / 'recordings')
    database.init_db()
    recordings = recording.RecordingManager()
    alert_manager = alerts.AlertManager()
    monkeypatch.setattr(recording, '_recording_manager', recordings)
    monkeypatch.setattr(alerts, '_alert_manager', alert_manager)
    alert_manager.add_rule({'name': 'Sensor seen', 'mode': 'sensor', 'event_type': 'sensor', 'match': {'id': 1234}})
    recording_session = recordings.start_recording('sensor')
    events = EventQueue(maxsize=4, mode='sensor')
    monkeypatch.setattr(app_module, 'sensor_queue', events)
    monkeypatch.setattr(sensor, 'sensor_active_device', None)
    process = Mock()
    process.stdout = BytesIO(b'{"model":"review-sensor","id":1234}\n')
    process.poll.return_value = 0

    sensor.stream_sensor_output(process)

    assert not events._subscribers
    assert recording_session.event_count == 3  # started, observation, stopped
    records = [json.loads(line) for line in recording_session.file_path.read_text().splitlines()]
    assert sum(record['event_type'] == 'sensor' for record in records) == 1
    assert len(alert_manager.list_events(mode='sensor')) == 1
    # Opening viewers only replays delivery copies; it cannot duplicate storage.
    with events.subscribe() as first, events.subscribe() as second:
        assert first.qsize() == second.qsize() == 3
    assert recording_session.event_count == 3
    assert len(alert_manager.list_events(mode='sensor')) == 1
    recordings.stop_recording(mode='sensor')


def test_wifi_and_bluetooth_publish_without_sse(monkeypatch):
    from utils.bluetooth.scanner import BluetoothScanner
    from utils.wifi.scanner import UnifiedWiFiScanner

    processed = Mock()
    monkeypatch.setattr('utils.event_pipeline.process_event', processed)
    wifi = UnifiedWiFiScanner()
    wifi._queue_event({'type': 'network_update', 'bssid': 'AA:BB:CC:DD:EE:FF'})
    bluetooth = BluetoothScanner()
    device = {'address': 'AA:BB:CC:DD:EE:FF'}
    bluetooth._queue_event({'type': 'device', 'device': device})
    processed.assert_any_call('wifi', {'type': 'network_update', 'bssid': 'AA:BB:CC:DD:EE:FF'}, 'network_update')
    processed.assert_any_call('bluetooth', device, 'device_update')


def test_new_wifi_scan_does_not_replay_previous_session_stop(monkeypatch):
    from utils.wifi.scanner import UnifiedWiFiScanner

    monkeypatch.setattr('utils.event_pipeline.process_event', Mock())
    scanner = UnifiedWiFiScanner()
    scanner._capabilities = SimpleNamespace(can_deep_scan=True, monitor_interface='wlan0mon')
    monkeypatch.setattr(scanner, '_run_deep_scan', Mock())
    monkeypatch.setattr(scanner, '_start_deauth_detector', Mock())
    monkeypatch.setattr(scanner, '_stop_deauth_detector', Mock())
    assert scanner.start_deep_scan()
    assert scanner.stop_deep_scan()
    assert scanner.start_deep_scan()
    stream = scanner.get_event_stream()
    try:
        assert next(stream)['type'] == 'scan_started'
        assert scanner._event_queue.qsize() == 1
    finally:
        stream.close()
        scanner.stop_deep_scan()


def test_new_bluetooth_scan_does_not_replay_previous_session_stop(monkeypatch):
    from utils.bluetooth.scanner import BluetoothScanner

    monkeypatch.setattr('utils.event_pipeline.process_event', Mock())
    monkeypatch.setattr('utils.bluetooth.scanner.check_capabilities', lambda: SimpleNamespace(default_adapter='hci0'))
    scanner = BluetoothScanner()
    monkeypatch.setattr(scanner, '_start_fallback', lambda *args: (True, 'bleak'))
    assert scanner.start_scan(mode='bleak')
    scanner.stop_scan()
    assert scanner.start_scan(mode='bleak')
    stream = scanner.stream_events()
    try:
        event = next(stream)
        assert event['type'] == 'status'
        assert event['status'] == 'started'
        assert scanner._event_queue.qsize() == 1
    finally:
        stream.close()
        scanner.stop_scan()


@pytest.mark.skipif(shutil.which('node') is None, reason='Node is needed to execute the browser event handler')
def test_wifi_browser_updates_running_state_when_a_scan_starts():
    source = (Path(__file__).parents[1] / 'static/js/modes/wifi.js').read_text()
    start = source.index('    function handleStreamEvent(event) {')
    end = source.index('    function handleNetworkUpdate(', start)
    handler = source[start:end]
    script = """
        const assert = require('node:assert/strict');
        const transitions = [];
        function setScanning(running, mode) { transitions.push([running, mode]); }
    """ + handler + """
        handleStreamEvent({type: 'scan_stopped'});
        handleStreamEvent({type: 'scan_started', mode: 'deep'});
        assert.deepEqual(transitions, [[false, undefined], [true, 'deep']]);
    """
    result = subprocess.run(['node', '-e', script], capture_output=True, text=True, timeout=3)
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(shutil.which('node') is None, reason='Node is needed to execute browser reconnect handlers')
@pytest.mark.parametrize('filename,next_function', [('wifi.js', 'handleStreamEvent'), ('bluetooth.js', 'stopEventStream')])
def test_wireless_ui_keeps_eventsource_instance_for_native_cursor_retry(filename, next_function):
    source = (Path(__file__).parents[1] / 'static/js/modes' / filename).read_text()
    start = source.index('    function startEventStream() {')
    end = source.index(f'    function {next_function}(', start)
    handler = source[start:end]
    script = """
        const assert = require('node:assert/strict');
        let eventSource = null;
        let isScanning = true;
        let scanMode = 'deep';
        const CONFIG = {apiBase: '/wifi/v2'};
        const connections = [];
        const timers = [];
        function getCurrentAgentName() { return 'Local'; }
        function setTimeout(callback) { timers.push(callback); }
        class EventSource {
            constructor(url) { this.url = url; this.closed = false; connections.push(this); }
            close() { this.closed = true; }
            addEventListener() {}
        }
    """ + handler + """
        startEventStream();
        const original = eventSource;
        original.onerror(new Error('temporary network interruption'));
        original.onerror(new Error('second interruption'));
        assert.equal(eventSource, original);
        assert.equal(original.closed, false);
        assert.equal(connections.length, 1);
        assert.equal(timers.length, 0);
    """
    result = subprocess.run(['node', '-e', script], capture_output=True, text=True, timeout=3)
    assert result.returncode == 0, result.stderr


def _sse_fields(frame):
    if isinstance(frame, bytes):
        frame = frame.decode()
    return dict(line.split(': ', 1) for line in frame.splitlines() if ': ' in line)


async def test_reconnecting_eventsource_resumes_after_last_received_id(monkeypatch):
    processed = Mock()
    monkeypatch.setattr('utils.event_pipeline.process_event', processed)
    events = EventQueue(maxsize=4, mode='sensor')
    events.put({'type': 'sensor', 'reading': 'first'})
    app = Quart(__name__)

    @app.route('/events')
    async def stream():
        return event_stream_response(events, timeout=.01, keepalive_interval=.02)

    client = app.test_client()
    async with client.request('/events', method='GET') as connection:
        first = _sse_fields(await asyncio.wait_for(connection.receive(), 1))
        assert json.loads(first['data'])['reading'] == 'first'
        assert first['id']
        await connection.disconnect()

    events.put({'type': 'sensor', 'reading': 'while-disconnected'})
    async with client.request('/events', method='GET', headers={'Last-Event-ID': first['id']}) as connection:
        resumed = _sse_fields(await asyncio.wait_for(connection.receive(), 1))
        assert json.loads(resumed['data'])['reading'] == 'while-disconnected'
        assert resumed['id'] != first['id']
        keepalive = _sse_fields(await asyncio.wait_for(connection.receive(), 1))
        assert json.loads(keepalive['data']) == {'type': 'keepalive'}
        assert 'id' not in keepalive  # Keep the browser's last real event cursor.
        await connection.disconnect()
    assert processed.call_count == 2  # Replay and reconnect never reprocess events.
    assert not events._subscribers


async def test_bluetooth_named_event_reconnect_preserves_cursor(monkeypatch):
    from routes import bluetooth_v2
    from utils.bluetooth.scanner import BluetoothScanner

    processed = Mock()
    monkeypatch.setattr('utils.event_pipeline.process_event', processed)
    scanner = BluetoothScanner()
    monkeypatch.setattr(bluetooth_v2, 'get_bluetooth_scanner', lambda: scanner)
    app = Quart(__name__)
    app.register_blueprint(bluetooth_v2.bluetooth_v2_bp)
    scanner._queue_event({'type': 'device', 'device': {'address': 'first'}})
    client = app.test_client()
    async with client.request('/api/bluetooth/stream', method='GET') as connection:
        first = _sse_fields(await asyncio.wait_for(connection.receive(), 1))
        assert first['event'] == 'device_update'
        assert json.loads(first['data']) == {'address': 'first'}
        assert first['id']
        await connection.disconnect()
    scanner._queue_event({'type': 'device', 'device': {'address': 'second'}})
    async with client.request('/api/bluetooth/stream', method='GET', headers={'Last-Event-ID': first['id']}) as connection:
        second = _sse_fields(await asyncio.wait_for(connection.receive(), 1))
        assert second['event'] == 'device_update'
        assert json.loads(second['data']) == {'address': 'second'}
        assert second['id'] != first['id']
        await connection.disconnect()
    assert processed.call_count == 2
    assert not scanner._event_queue._subscribers


def test_cursor_metadata_keeps_dictionary_queue_and_json_semantics():
    events = EventQueue(maxsize=4)
    original = {'type': 'sensor', 'reading': 42}
    events.put(original)
    item = events.get_nowait()
    assert isinstance(item, dict)
    assert item == original
    assert json.loads(json.dumps(item)) == original
    assert item.event_id
    assert 'event_id' not in item


def test_cursor_from_old_queue_does_not_hide_new_queue_events():
    old = EventQueue(maxsize=4)
    old.put({'type': 'sensor', 'reading': 'old-instance'})
    old_cursor = old.get_nowait().event_id
    new = EventQueue(maxsize=4)
    new.put({'type': 'sensor', 'reading': 'new-instance'})
    with new.subscribe(last_event_id=old_cursor) as subscriber:
        assert subscriber.get_nowait()['reading'] == 'new-instance'


def test_cursor_still_advances_after_clearing_scan_history():
    events = EventQueue(maxsize=4)
    events.put({'type': 'scan_stopped'})
    with events.subscribe() as subscriber:
        old_cursor = subscriber.get_nowait().event_id
    events.clear_history()
    events.put({'type': 'scan_started'})
    with events.subscribe(last_event_id=old_cursor) as subscriber:
        assert subscriber.get_nowait()['type'] == 'scan_started'
