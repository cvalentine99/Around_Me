"""Exercise real application middleware and async integrations together."""

import asyncio
import json
from pathlib import Path
import runpy
import shutil
import subprocess
from unittest.mock import AsyncMock, Mock, patch

import pytest
from quart import Quart, Response, jsonify, request
from quart.testing import WebsocketResponseError

import app as app_module
from routes import controller, listening_post
from routes.audio_websocket import init_audio_websocket
import utils.database as database


@pytest.fixture
def backend(tmp_path, monkeypatch):
    monkeypatch.setattr(database, 'DB_DIR', tmp_path)
    monkeypatch.setattr(database, 'DB_PATH', tmp_path / 'workflow.db')
    database.init_db()
    with database.get_db() as conn:
        conn.execute('UPDATE users SET password_must_change = 0')

    app = Quart('app')
    app.config.update(TESTING=True, SECRET_KEY=app_module.app.secret_key)
    app.before_request(app_module.require_login)
    app.before_websocket(app_module.require_websocket_login)
    app.after_request(app_module.add_security_headers)
    app.register_blueprint(controller.controller_bp)
    app.register_blueprint(listening_post.listening_post_bp)
    app.add_url_rule('/start_enabled_modules', view_func=app_module.start_enabled_modules, methods=['POST'])

    @app.route('/login', endpoint='login')
    async def login():
        return 'login'

    @app.route('/change-password', endpoint='change_password')
    async def password():
        return 'password'

    init_audio_websocket(app)
    return app


async def logged_in_client(app, *, must_change=False):
    client = app.test_client()
    async with client.session_transaction() as session:
        session.update(logged_in=True, username='admin', password_must_change=must_change)
    return client


async def test_browser_session_authenticates_controller_and_audio(backend):
    client = await logged_in_client(backend)
    for path in ('/controller/agents', '/listening/audio/status'):
        response = await client.get(path)
        assert response.status_code == 200
    with patch('quart.render_template', new=AsyncMock(return_value='agent management')):
        response = await client.get('/controller/manage')
        assert response.status_code == 200


@pytest.mark.parametrize('path', ['/controller/agents', '/controller/manage', '/listening/audio/status'])
async def test_anonymous_http_client_is_rejected(backend, path):
    response = await backend.test_client().get(path)
    assert response.status_code == 401


async def test_force_password_change_still_applies_to_browser_apis(backend):
    client = await logged_in_client(backend, must_change=True)
    response = await client.get('/controller/agents')
    assert response.status_code == 302
    assert response.headers['Location'].endswith('/change-password')


async def test_anonymous_websocket_cannot_reach_radio_handler(backend):
    with patch('routes.audio_websocket._locked_kill') as stop:
        with pytest.raises(WebsocketResponseError) as failure:
            async with backend.test_client().websocket('/ws/audio') as socket:
                await socket.send_json({'cmd': 'stop'})
                await socket.receive()
        assert failure.value.response.status_code == 401
        stop.assert_not_called()


@pytest.mark.parametrize('use_session', [True, False])
async def test_websocket_accepts_session_or_explicit_token(backend, use_session):
    client = await logged_in_client(backend) if use_session else backend.test_client()
    path = '/ws/audio'
    if not use_session:
        path += '?token=' + app_module._generate_api_token('admin')
    with patch('routes.audio_websocket._locked_kill') as stop:
        async with client.websocket(path) as socket:
            await socket.send_json({'cmd': 'stop'})
            assert await asyncio.wait_for(socket.receive_json(), 1) == {'status': 'stopped'}
        assert stop.called


async def test_websocket_rejects_session_requiring_password_change(backend):
    client = await logged_in_client(backend, must_change=True)
    with pytest.raises(WebsocketResponseError) as failure:
        async with client.websocket('/ws/audio') as socket:
            await socket.send_json({'cmd': 'stop'})
            await socket.receive()
    assert failure.value.response.status_code == 403


async def test_bootstrap_user_cannot_bypass_password_change_using_api_token(backend):
    with database.get_db() as conn:
        conn.execute('UPDATE users SET password_must_change = 1')
    token = app_module._generate_api_token('admin')
    response = await backend.test_client().get('/controller/agents', headers={'Authorization': f'Bearer {token}'})
    assert response.status_code == 401


async def test_agent_ingestion_uses_its_registered_api_key(backend):
    database.create_agent(name='remote', base_url='http://remote.invalid', api_key='agent-key')
    payload = {'agent_name': 'remote', 'scan_type': 'sensor', 'payload': {'id': 1}}
    response = await backend.test_client().post('/controller/api/ingest', json=payload, headers={'X-API-Key': 'agent-key'})
    assert response.status_code == 202
    response = await backend.test_client().post('/controller/api/ingest', json=payload, headers={'X-API-Key': 'wrong'})
    assert response.status_code == 401


async def test_registration_awaits_the_real_async_client(backend):
    client = await logged_in_client(backend)
    network = AsyncMock(return_value={'modes': {'sensor': True}, 'devices': []})
    with patch.object(controller.AgentClient, '_get', network):
        response = await client.post('/controller/agents', json={'name': 'remote', 'base_url': 'http://remote.invalid'})
    assert response.status_code == 201
    assert (await response.get_json())['agent']['capabilities'] == {'sensor': True}
    network.assert_awaited_once_with('/capabilities')


async def test_keyless_agent_does_not_allow_anonymous_ingestion(backend):
    database.create_agent(name='keyless', base_url='http://remote.invalid')
    payload = {'agent_name': 'keyless', 'scan_type': 'sensor', 'payload': {'id': 1}}
    response = await backend.test_client().post('/controller/api/ingest', json=payload)
    assert response.status_code == 401
    token = app_module._generate_api_token('admin')
    response = await backend.test_client().post(
        '/controller/api/ingest', json=payload, headers={'Authorization': f'Bearer {token}'},
    )
    assert response.status_code == 202
    client = await logged_in_client(backend)
    response = await client.post('/controller/api/ingest', json=payload)
    assert response.status_code == 202


async def test_health_checks_await_agent_status(backend):
    database.create_agent(name='remote', base_url='http://remote.invalid')
    remote = Mock(spec=controller.AgentClient)
    remote.health_check.return_value = True
    remote.get_status.return_value = {'running_modes': ['sensor']}
    client = await logged_in_client(backend)
    with patch.object(controller, 'create_client_from_agent', return_value=remote):
        response = await client.get('/controller/agents/health')
    assert response.status_code == 200
    assert (await response.get_json())['agents'][0]['running_modes'] == ['sensor']
    remote.health_check.assert_awaited_once()
    remote.get_status.assert_awaited_once()


async def test_orchestrator_preserves_started_and_failed_module_results(backend):
    received = []

    async def start():
        received.append(await request.get_json())
        return jsonify({'status': 'started'})

    async def fail():
        return jsonify({'status': 'error', 'message': 'device busy'}), 409

    registry = {'sensor': (start, '/start_sensor'), 'adsb': (fail, '/adsb/start')}
    client = await logged_in_client(backend)
    with patch.object(app_module, '_get_module_registry', return_value=registry):
        response = await client.post('/start_enabled_modules', json={
            'modules': ['sensor', 'adsb'], 'params': {'sensor': {'device': 1}},
        })
    body = await response.get_json()
    assert received == [{'device': 1}]
    assert body['status'] == 'success'
    assert body['results']['sensor']['status'] == 'started'
    assert body['results']['adsb']['http_status'] == 409


@pytest.mark.parametrize('mimetype', ['text/event-stream', 'audio/wav'])
async def test_live_response_survives_the_ordinary_response_deadline(backend, mimetype):
    backend.config['RESPONSE_TIMEOUT'] = .02

    @backend.route('/review-live')
    async def stream():
        async def body():
            yield b'first'
            await asyncio.sleep(.06)
            yield b'second'
        return Response(body(), mimetype=mimetype)

    client = await logged_in_client(backend)
    async with client.request('/review-live', method='GET') as connection:
        assert await asyncio.wait_for(connection.receive(), 1) == b'first'
        assert await asyncio.wait_for(connection.receive(), 1) == b'second'
        await connection.disconnect()


def test_unconfigured_admin_password_is_random(monkeypatch):
    import config
    monkeypatch.delenv('VALENTINE_ADMIN_PASSWORD', raising=False)
    first = runpy.run_path(str(Path(config.__file__)))['ADMIN_PASSWORD']
    second = runpy.run_path(str(Path(config.__file__)))['ADMIN_PASSWORD']
    assert len(first) >= 20
    assert first != second


@pytest.mark.parametrize('success', [True, False])
def test_stop_all_browser_controls_reflect_the_actual_result(success):
    node = shutil.which('node')
    if not node:
        pytest.skip('Node is required to exercise the browser handler')
    template = (Path(__file__).parents[1] / 'templates/index.html').read_text()
    start = template.index('        async function stopAllModules() {')
    end = template.index('        function startDecoding() {', start)
    handler = template[start:end]
    script = r'''
        const vm = require('node:vm');
        const button = {}, status = {style: {}}, updates = [];
        const success = SUCCESS;
        const context = {
            document: {getElementById: id => id === 'stopAllBtn' ? button : status},
            fetch: async () => ({ok: success, json: async () => success
                ? {status: 'killed', processes: ['adsb_process']}
                : {status: 'error', errors: ['ADS-B receiver is still running']}}),
            syncModeUI: (...args) => updates.push(args), console: {error: () => {}}
        };
        vm.runInNewContext(HANDLER, context);
        context.stopAllModules().then(() => console.log(JSON.stringify({
            message: status.textContent, updates, disabled: button.disabled, label: button.textContent
        })));
    '''.replace('SUCCESS', json.dumps(success)).replace('HANDLER', json.dumps(handler))
    result = subprocess.run([node, '-e', script], check=True, text=True, capture_output=True, timeout=5)
    state = json.loads(result.stdout)
    assert state['disabled'] is False and state['label'] == 'Stop All'
    if success:
        assert state['message'] == 'Stopped: adsb_process'
        assert len(state['updates']) == 11
    else:
        assert state['message'] == 'Error stopping: ADS-B receiver is still running'
        assert state['updates'] == []
