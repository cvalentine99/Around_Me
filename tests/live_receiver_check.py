"""Manual receive-only validation using an isolated database.

Requires two RTL-SDR receivers; also checks a HackRF when one and rx_sdr are
available. Run: venv/bin/python tests/live_receiver_check.py --sustained
The sustained check keeps FM audio open for 65 seconds. App-owned receivers
are stopped afterward; existing account data is not accessed.
"""
import asyncio
import json
import logging
from pathlib import Path
import secrets
import shutil
import struct
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
logging.disable(logging.CRITICAL)

def emit(case, **values):
    print(json.dumps({'case': case, **values}), flush=True)

async def frames(socket, family):
    await socket.send_json({'cmd': 'start', 'center_freq': 100.0, 'span_mhz': 2.0,
                            'device': 0, 'sdr_type': family, 'fft_size': 1024, 'fps': 10})
    count = 0
    while count < 3:
        payload = await asyncio.wait_for(socket.receive(), 8)
        if isinstance(payload, str):
            status = json.loads(payload)
            if status.get('status') == 'error':
                raise RuntimeError(f'{family}: {status}')
        else:
            frame_type, lower, upper, bins = struct.unpack('<BffH', payload[:11])
            assert frame_type == 1 and len(payload) == bins + 11
            count += 1
    emit('waterfall_frames', family=family, count=count, bins=bins, bytes_per_frame=len(payload))

async def stop_socket(socket):
    await socket.send_json({'cmd': 'stop'})
    while True:
        payload = await asyncio.wait_for(socket.receive(), 5)
        if isinstance(payload, str) and json.loads(payload).get('status') == 'stopped':
            return

async def main():
    import app as mod
    import config
    import utils.database as database
    import utils.recording as recording
    from routes import register_blueprints, adsb, listening_post, sensor
    from routes.audio_websocket import init_audio_websocket
    from routes.waterfall_websocket import init_waterfall_websocket
    from utils.process import cleanup_all_processes

    with tempfile.TemporaryDirectory(prefix='around_me_fixed_live_') as tmp:
        database.DB_DIR = Path(tmp)
        database.DB_PATH = Path(tmp) / 'validation.db'
        recording.RECORDING_ROOT = Path(tmp) / 'recordings'
        database.init_db()
        app = mod.app
        app.config['TESTING'] = True
        register_blueprints(app)
        init_audio_websocket(app)
        init_waterfall_websocket(app)
        client = app.test_client()
        try:
            response = await client.post('/login', form={'username': config.ADMIN_USERNAME, 'password': config.ADMIN_PASSWORD})
            assert response.status_code == 302
            if response.headers['Location'].endswith('/change-password'):
                password = secrets.token_urlsafe(24)
                response = await client.post('/change-password', form={'new_password': password, 'confirm_password': password})
                assert response.status_code == 302 and response.headers['Location'].endswith('/')
            response = await client.get('/controller/agents')
            assert response.status_code == 200
            emit('browser_login_and_controller', status=response.status_code, bearer_token_used=False)
            response = await client.get('/devices')
            devices = await response.get_json()
            emit('devices', devices=[{key:d.get(key) for key in ('index', 'name', 'sdr_type')} for d in devices])
            assert sum(d['sdr_type'] == 'rtlsdr' for d in devices) >= 2, 'This manual check requires two RTL-SDR receivers'

            async with client.websocket('/ws/waterfall') as rtl:
                await frames(rtl, 'rtlsdr')
                if any(d['sdr_type'] == 'hackrf' for d in devices) and shutil.which('rx_sdr'):
                    async with client.websocket('/ws/waterfall') as hackrf:
                        await frames(hackrf, 'hackrf')
                        registry = mod.get_sdr_device_status()
                        assert registry.get(0) == registry.get('hackrf:0') == 'waterfall'
                        emit('simultaneous_mixed_family_capture', registry=registry)
                        await stop_socket(hackrf)
                await stop_socket(rtl)
            assert mod.get_sdr_device_status() == {}

            response = await client.post('/adsb/start', json={'device': 1, 'sdr_type': 'rtlsdr', 'gain': 40})
            body = await response.get_json()
            assert response.status_code == 200 and body['status'] == 'started', body
            process = mod.adsb_process
            await asyncio.sleep(3)
            response = await client.get('/adsb/status')
            status = await response.get_json()
            assert status['dump1090_running'] and status['port_30003_open'] and status['connected_to_sbs'], status
            emit('adsb_pipeline', decoder=Path(process.args[0]).name, connected_to_sbs=status['connected_to_sbs'],
                 sbs_port_open=status['port_30003_open'], messages=status['messages_received'])
            response = await client.post('/killall')
            body = await response.get_json()
            assert response.status_code == 200 and process.poll() is not None, body
            assert mod.get_sdr_device_status() == {}
            emit('stop_all_owned_adsb', status=response.status_code, process_exited=True, registry={})

            response = await client.post('/listening/audio/start', json={'frequency': 100.0, 'modulation': 'wfm',
                                                                         'device': 0, 'gain': 30, 'squelch': 0})
            body = await response.get_json()
            assert response.status_code == 200 and body['status'] == 'started', body
            started = time.monotonic()
            total_bytes, chunks, first = 0, 0, b''
            target = 65 if '--sustained' in sys.argv else 3
            next_progress = 10
            async with client.request('/listening/audio/stream', method='GET') as connection:
                while time.monotonic() - started < target:
                    chunk = await asyncio.wait_for(connection.receive(), 5)
                    assert chunk, 'Audio response ended before the sustained check completed'
                    if not first:
                        first = chunk
                    total_bytes += len(chunk)
                    chunks += 1
                    elapsed = time.monotonic() - started
                    if elapsed >= next_progress:
                        emit('audio_progress', seconds=round(elapsed, 1), bytes=total_bytes)
                        next_progress += 10
                await connection.disconnect()
            assert first.startswith(b'RIFF') and first[8:12] == b'WAVE'
            emit('browser_audio', status=connection.status_code, bearer_token_used=False,
                 seconds=round(time.monotonic() - started, 1), bytes=total_bytes, chunks=chunks, wave_header=True)
            response = await client.post('/listening/audio/stop')
            assert response.status_code == 200 and mod.get_sdr_device_status() == {}

            response = await client.post('/start_enabled_modules', json={
                'modules': ['sensor'], 'params': {'sensor': {'device': 0, 'frequency': 433.92}},
            })
            body = await response.get_json()
            assert body['status'] == 'success' and body['results']['sensor']['status'] == 'started', body
            await asyncio.sleep(3)
            response = await client.get('/sensor/status')
            assert (await response.get_json())['running']
            emit('start_enabled_modules_live', status=body['status'], module_status=body['results']['sensor']['status'],
                 receiver_still_running=True)
            response = await client.post('/stop_sensor')
            assert response.status_code == 200
            await asyncio.sleep(.2)
            assert mod.get_sdr_device_status() == {}
            emit('final_cleanup', registry={})
        finally:
            if listening_post.audio_running:
                await client.post('/listening/audio/stop')
            if mod.sensor_process:
                await client.post('/stop_sensor')
            if mod.adsb_process:
                await client.post('/adsb/stop')
            cleanup_all_processes()

asyncio.run(main())
