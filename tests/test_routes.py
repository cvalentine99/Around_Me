"""Tests for Quart routes and API endpoints."""

import hashlib
import hmac
import json
import pytest
from unittest.mock import patch, MagicMock


@pytest.fixture(scope='session')
def app():
    """Create application for testing."""
    import app as app_module
    from routes import register_blueprints
    from utils.database import init_db

    app_module.app.config['TESTING'] = True

    # Initialize database for settings tests
    init_db()

    # Register blueprints only if not already registered (normally done in main())
    # Check if any blueprint is already registered to avoid re-registration
    if 'pager' not in app_module.app.blueprints:
        register_blueprints(app_module.app)

    return app_module.app


@pytest.fixture
def client(app):
    """Create test client."""
    return app.test_client()


@pytest.fixture
async def auth_client(app):
    """Create an authenticated test client with session['logged_in'] = True."""
    client = app.test_client()
    async with client.session_transaction() as sess:
        sess['logged_in'] = True
    return client


def _make_api_token(app) -> str:
    """Generate a valid API token for the admin user using the app's secret key."""
    secret = app.secret_key
    if isinstance(secret, str):
        secret = secret.encode()
    return hmac.new(
        secret,
        b'valentine-api-token:admin',
        hashlib.sha256,
    ).hexdigest()


@pytest.fixture
async def audio_client(app):
    """Create a test client that passes token auth for /listening/audio/* routes."""
    client = app.test_client()
    async with client.session_transaction() as sess:
        sess['logged_in'] = True
    return client, _make_api_token(app)


class TestHealthEndpoint:
    """Tests for health check endpoint."""

    @pytest.mark.asyncio
    async def test_health_check(self, auth_client):
        """Test health endpoint returns expected data."""
        response = await auth_client.get('/health')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'healthy'
        assert 'version' in data
        assert 'uptime_seconds' in data
        assert 'processes' in data
        assert 'data' in data

    @pytest.mark.asyncio
    async def test_health_process_status(self, auth_client):
        """Test health endpoint reports process status."""
        response = await auth_client.get('/health')
        data = await response.get_json()

        processes = data['processes']
        assert 'pager' in processes
        assert 'sensor' in processes
        assert 'adsb' in processes
        assert 'wifi' in processes
        assert 'bluetooth' in processes


class TestDevicesEndpoint:
    """Tests for devices endpoint."""

    @pytest.mark.asyncio
    async def test_get_devices(self, auth_client):
        """Test getting device list."""
        response = await auth_client.get('/devices')
        assert response.status_code == 200

        data = await response.get_json()
        assert isinstance(data, list)

    @pytest.mark.asyncio
    @patch('app.SDRFactory.detect_devices')
    async def test_devices_returns_list(self, mock_detect, auth_client):
        """Test devices endpoint returns list format."""
        mock_device = MagicMock()
        mock_device.to_dict.return_value = {
            'index': 0,
            'name': 'Test RTL-SDR',
            'sdr_type': 'rtlsdr'
        }
        mock_detect.return_value = [mock_device]

        response = await auth_client.get('/devices')
        data = await response.get_json()

        assert len(data) == 1
        assert data[0]['name'] == 'Test RTL-SDR'


class TestDependenciesEndpoint:
    """Tests for dependencies endpoint."""

    @pytest.mark.asyncio
    async def test_get_dependencies(self, auth_client):
        """Test getting dependency status."""
        response = await auth_client.get('/dependencies')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'success'
        assert 'os' in data
        assert 'pkg_manager' in data
        assert 'modes' in data


class TestSettingsEndpoints:
    """Tests for settings API endpoints.

    Database functions are mocked because the production SQLite database file
    is owned by root and read-only from the test runner.
    """

    @pytest.mark.asyncio
    async def test_get_settings(self, auth_client):
        """Test getting all settings."""
        response = await auth_client.get('/settings')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'success'
        assert 'settings' in data

    @pytest.mark.asyncio
    @patch('routes.settings.set_setting')
    async def test_save_settings(self, mock_set, auth_client):
        """Test saving settings."""
        response = await auth_client.post(
            '/settings',
            json={'test_key': 'test_value'}
        )
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'success'
        assert 'test_key' in data['saved']
        mock_set.assert_called_once_with('test_key', 'test_value')

    @pytest.mark.asyncio
    async def test_save_empty_settings(self, auth_client):
        """Test saving empty settings returns error."""
        response = await auth_client.post(
            '/settings',
            json={}
        )
        assert response.status_code == 400

    @pytest.mark.asyncio
    @patch('routes.settings.get_setting', return_value='my_value')
    async def test_get_single_setting(self, mock_get, auth_client):
        """Test getting a single setting."""
        response = await auth_client.get('/settings/my_setting')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'success'
        assert data['value'] == 'my_value'
        mock_get.assert_called_once_with('my_setting')

    @pytest.mark.asyncio
    async def test_get_nonexistent_setting(self, auth_client):
        """Test getting a setting that doesn't exist."""
        response = await auth_client.get('/settings/nonexistent_key_xyz')
        assert response.status_code == 404

    @pytest.mark.asyncio
    @patch('routes.settings.set_setting')
    async def test_update_setting(self, mock_set, auth_client):
        """Test updating a setting via PUT."""
        response = await auth_client.put(
            '/settings/update_test',
            json={'value': 'updated_value'}
        )
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'success'
        assert data['value'] == 'updated_value'
        mock_set.assert_called_once_with('update_test', 'updated_value')

    @pytest.mark.asyncio
    @patch('routes.settings.delete_setting', return_value=True)
    async def test_delete_setting(self, mock_del, auth_client):
        """Test deleting a setting."""
        response = await auth_client.delete('/settings/delete_me')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'success'
        assert data['deleted'] is True
        mock_del.assert_called_once_with('delete_me')


class TestCorrelationEndpoints:
    """Tests for correlation API endpoints."""

    @pytest.mark.asyncio
    async def test_get_correlations(self, auth_client):
        """Test getting device correlations."""
        response = await auth_client.get('/correlation')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'success'
        assert 'correlations' in data
        assert 'wifi_count' in data
        assert 'bt_count' in data

    @pytest.mark.asyncio
    async def test_correlations_with_confidence_filter(self, auth_client):
        """Test correlation endpoint respects confidence filter."""
        response = await auth_client.get('/correlation?min_confidence=0.8')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'success'


class TestListeningPostEndpoints:
    """Tests for listening post endpoints."""

    @pytest.mark.asyncio
    async def test_tools_check(self, auth_client):
        """Test listening post tools availability check."""
        response = await auth_client.get('/listening/tools')
        assert response.status_code == 200

        data = await response.get_json()
        assert 'rtl_fm' in data
        assert 'available' in data

    @pytest.mark.asyncio
    async def test_scanner_status(self, auth_client):
        """Test scanner status endpoint."""
        response = await auth_client.get('/listening/scanner/status')
        assert response.status_code == 200

        data = await response.get_json()
        assert 'running' in data
        assert 'paused' in data
        assert 'current_freq' in data

    @pytest.mark.asyncio
    async def test_presets(self, auth_client):
        """Test scanner presets endpoint."""
        response = await auth_client.get('/listening/presets')
        assert response.status_code == 200

        data = await response.get_json()
        assert 'presets' in data
        assert len(data['presets']) > 0

        # Check preset structure
        preset = data['presets'][0]
        assert 'name' in preset
        assert 'start' in preset
        assert 'end' in preset
        assert 'mod' in preset

    @pytest.mark.asyncio
    async def test_scanner_stop_when_not_running(self, auth_client):
        """Test stopping scanner when not running."""
        response = await auth_client.post('/listening/scanner/stop')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'stopped'

    @pytest.mark.asyncio
    async def test_activity_log(self, auth_client):
        """Test getting activity log."""
        response = await auth_client.get('/listening/scanner/log')
        assert response.status_code == 200

        data = await response.get_json()
        assert 'log' in data
        assert 'total' in data

    @pytest.mark.asyncio
    async def test_scanner_skip_when_not_running(self, auth_client):
        """Test skip signal when scanner not running returns error."""
        response = await auth_client.post('/listening/scanner/skip')
        assert response.status_code == 400

        data = await response.get_json()
        assert data['status'] == 'error'


class TestAudioEndpoints:
    """Tests for audio demodulation endpoints.

    The /listening/audio/* routes use bearer-token auth (not session auth)
    per the app.before_request middleware, so tests must supply a valid
    API token as a ``?token=`` query parameter.
    """

    @pytest.mark.asyncio
    async def test_audio_status(self, audio_client):
        """Test audio status endpoint."""
        client, token = audio_client
        response = await client.get(f'/listening/audio/status?token={token}')
        assert response.status_code == 200

        data = await response.get_json()
        assert 'running' in data
        assert 'frequency' in data
        assert 'modulation' in data

    @pytest.mark.asyncio
    async def test_audio_stop_when_not_running(self, audio_client):
        """Test stopping audio when not running."""
        client, token = audio_client
        response = await client.post(f'/listening/audio/stop?token={token}')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'stopped'

    @pytest.mark.asyncio
    async def test_audio_start_missing_frequency(self, audio_client):
        """Test starting audio without frequency returns error."""
        client, token = audio_client
        response = await client.post(
            f'/listening/audio/start?token={token}',
            json={}
        )
        assert response.status_code == 400

        data = await response.get_json()
        assert data['status'] == 'error'
        assert 'frequency' in data['message'].lower()

    @pytest.mark.asyncio
    async def test_audio_start_invalid_modulation(self, audio_client):
        """Test starting audio with invalid modulation returns error."""
        client, token = audio_client
        response = await client.post(
            f'/listening/audio/start?token={token}',
            json={
                'frequency': 98.1,
                'modulation': 'invalid_mode'
            }
        )
        assert response.status_code == 400

        data = await response.get_json()
        assert data['status'] == 'error'
        assert 'modulation' in data['message'].lower()

    @pytest.mark.asyncio
    async def test_audio_stream_when_not_running(self, audio_client):
        """Test audio stream when not running returns 204 (no content)."""
        client, token = audio_client
        response = await client.get(f'/listening/audio/stream?token={token}')
        # The route returns 204 when audio is not running
        assert response.status_code == 204


class TestExportEndpoints:
    """Tests for data export endpoints."""

    @pytest.mark.asyncio
    async def test_export_aircraft_json(self, auth_client):
        """Test exporting aircraft data as JSON."""
        response = await auth_client.get('/export/aircraft?format=json')
        assert response.status_code == 200
        assert response.content_type == 'application/json'

    @pytest.mark.asyncio
    async def test_export_aircraft_csv(self, auth_client):
        """Test exporting aircraft data as CSV."""
        response = await auth_client.get('/export/aircraft?format=csv')
        assert response.status_code == 200
        assert 'text/csv' in response.content_type

    @pytest.mark.asyncio
    async def test_export_wifi_json(self, auth_client):
        """Test exporting WiFi data as JSON."""
        response = await auth_client.get('/export/wifi?format=json')
        assert response.status_code == 200
        assert response.content_type == 'application/json'

    @pytest.mark.asyncio
    async def test_export_wifi_csv(self, auth_client):
        """Test exporting WiFi data as CSV."""
        response = await auth_client.get('/export/wifi?format=csv')
        assert response.status_code == 200
        assert 'text/csv' in response.content_type

    @pytest.mark.asyncio
    async def test_export_bluetooth_json(self, auth_client):
        """Test exporting Bluetooth data as JSON."""
        response = await auth_client.get('/export/bluetooth?format=json')
        assert response.status_code == 200
        assert response.content_type == 'application/json'

    @pytest.mark.asyncio
    async def test_export_bluetooth_csv(self, auth_client):
        """Test exporting Bluetooth data as CSV."""
        response = await auth_client.get('/export/bluetooth?format=csv')
        assert response.status_code == 200
        assert 'text/csv' in response.content_type
