"""Tests for Flask routes and API endpoints."""

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
    if 'pager' not in app_module.app.blueprints:
        register_blueprints(app_module.app)

    return app_module.app


@pytest.fixture
def client(app):
    """Create unauthenticated test client."""
    return app.test_client()


@pytest.fixture
def auth_client(app):
    """Create an authenticated test client with a CSRF token."""
    c = app.test_client()
    with c.session_transaction() as sess:
        sess['logged_in'] = True
        sess['username'] = 'admin'
        sess['role'] = 'admin'
        sess['_csrf_token'] = 'test-csrf-token'
    return c


def _csrf_headers():
    """Return headers dict with a valid test CSRF token."""
    return {'X-CSRF-Token': 'test-csrf-token'}


class TestHealthEndpoint:
    """Tests for health check endpoint."""

    def test_health_check_unauthenticated(self, client):
        """Test unauthenticated health returns minimal data."""
        response = client.get('/health')
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data['status'] == 'healthy'
        # Unauthenticated callers should NOT see detailed system info
        assert 'processes' not in data

    def test_health_check_authenticated(self, auth_client):
        """Test authenticated health endpoint returns full data."""
        response = auth_client.get('/health')
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data['status'] == 'healthy'
        assert 'version' in data
        assert 'uptime_seconds' in data
        assert 'processes' in data
        assert 'data' in data

    def test_health_process_status(self, auth_client):
        """Test health endpoint reports process status."""
        response = auth_client.get('/health')
        data = json.loads(response.data)

        processes = data['processes']
        assert 'pager' in processes
        assert 'sensor' in processes
        assert 'adsb' in processes
        assert 'wifi' in processes
        assert 'bluetooth' in processes


class TestDevicesEndpoint:
    """Tests for devices endpoint."""

    def test_get_devices(self, auth_client):
        """Test getting device list."""
        response = auth_client.get('/devices')
        assert response.status_code == 200

        data = json.loads(response.data)
        assert isinstance(data, list)

    @patch('app.SDRFactory.detect_devices')
    def test_devices_returns_list(self, mock_detect, auth_client):
        """Test devices endpoint returns list format."""
        mock_device = MagicMock()
        mock_device.to_dict.return_value = {
            'index': 0,
            'name': 'Test RTL-SDR',
            'sdr_type': 'rtlsdr'
        }
        mock_detect.return_value = [mock_device]

        response = auth_client.get('/devices')
        data = json.loads(response.data)

        assert len(data) == 1
        assert data[0]['name'] == 'Test RTL-SDR'


class TestDependenciesEndpoint:
    """Tests for dependencies endpoint."""

    def test_get_dependencies(self, auth_client):
        """Test getting dependency status."""
        response = auth_client.get('/dependencies')
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data['status'] == 'success'
        assert 'os' in data
        assert 'pkg_manager' in data
        assert 'modes' in data


class TestSettingsEndpoints:
    """Tests for settings API endpoints."""

    def test_get_settings(self, auth_client):
        """Test getting all settings."""
        response = auth_client.get('/settings')
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data['status'] == 'success'
        assert 'settings' in data

    def test_save_settings(self, auth_client):
        """Test saving settings."""
        response = auth_client.post(
            '/settings',
            data=json.dumps({'test_key': 'test_value'}),
            content_type='application/json',
            headers=_csrf_headers(),
        )
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data['status'] == 'success'
        assert 'test_key' in data['saved']

    def test_save_empty_settings(self, auth_client):
        """Test saving empty settings returns error."""
        response = auth_client.post(
            '/settings',
            data=json.dumps({}),
            content_type='application/json',
            headers=_csrf_headers(),
        )
        assert response.status_code == 400

    def test_get_single_setting(self, auth_client):
        """Test getting a single setting."""
        # First save a setting
        auth_client.post(
            '/settings',
            data=json.dumps({'my_setting': 'my_value'}),
            content_type='application/json',
            headers=_csrf_headers(),
        )

        # Then retrieve it
        response = auth_client.get('/settings/my_setting')
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data['status'] == 'success'
        assert data['value'] == 'my_value'

    def test_get_nonexistent_setting(self, auth_client):
        """Test getting a setting that doesn't exist."""
        response = auth_client.get('/settings/nonexistent_key_xyz')
        assert response.status_code == 404

    def test_update_setting(self, auth_client):
        """Test updating a setting via PUT."""
        response = auth_client.put(
            '/settings/update_test',
            data=json.dumps({'value': 'updated_value'}),
            content_type='application/json',
            headers=_csrf_headers(),
        )
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data['status'] == 'success'
        assert data['value'] == 'updated_value'

    def test_delete_setting(self, auth_client):
        """Test deleting a setting."""
        # First create a setting
        auth_client.post(
            '/settings',
            data=json.dumps({'delete_me': 'value'}),
            content_type='application/json',
            headers=_csrf_headers(),
        )

        # Then delete it
        response = auth_client.delete(
            '/settings/delete_me',
            headers=_csrf_headers(),
        )
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data['status'] == 'success'
        assert data['deleted'] is True

    def test_save_settings_without_csrf_rejected(self, auth_client):
        """Test that POST without CSRF token is rejected."""
        response = auth_client.post(
            '/settings',
            data=json.dumps({'test_key': 'test_value'}),
            content_type='application/json',
            # No CSRF header
        )
        assert response.status_code == 403


class TestCorrelationEndpoints:
    """Tests for correlation API endpoints."""

    def test_get_correlations(self, auth_client):
        """Test getting device correlations."""
        response = auth_client.get('/correlation')
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data['status'] == 'success'
        assert 'correlations' in data
        assert 'wifi_count' in data
        assert 'bt_count' in data

    def test_correlations_with_confidence_filter(self, auth_client):
        """Test correlation endpoint respects confidence filter."""
        response = auth_client.get('/correlation?min_confidence=0.8')
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data['status'] == 'success'


class TestListeningPostEndpoints:
    """Tests for listening post endpoints."""

    def test_tools_check(self, auth_client):
        """Test listening post tools availability check."""
        response = auth_client.get('/listening/tools')
        assert response.status_code == 200

        data = json.loads(response.data)
        assert 'rtl_fm' in data
        assert 'available' in data

    def test_scanner_status(self, auth_client):
        """Test scanner status endpoint."""
        response = auth_client.get('/listening/scanner/status')
        assert response.status_code == 200

        data = json.loads(response.data)
        assert 'running' in data
        assert 'paused' in data
        assert 'current_freq' in data

    def test_presets(self, auth_client):
        """Test scanner presets endpoint."""
        response = auth_client.get('/listening/presets')
        assert response.status_code == 200

        data = json.loads(response.data)
        assert 'presets' in data
        assert len(data['presets']) > 0

        # Check preset structure
        preset = data['presets'][0]
        assert 'name' in preset
        assert 'start' in preset
        assert 'end' in preset
        assert 'mod' in preset

    def test_scanner_stop_when_not_running(self, auth_client):
        """Test stopping scanner when not running."""
        response = auth_client.post(
            '/listening/scanner/stop',
            headers=_csrf_headers(),
        )
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data['status'] == 'stopped'

    def test_activity_log(self, auth_client):
        """Test getting activity log."""
        response = auth_client.get('/listening/scanner/log')
        assert response.status_code == 200

        data = json.loads(response.data)
        assert 'log' in data
        assert 'total' in data

    def test_scanner_skip_when_not_running(self, auth_client):
        """Test skip signal when scanner not running returns error."""
        response = auth_client.post(
            '/listening/scanner/skip',
            headers=_csrf_headers(),
        )
        assert response.status_code == 400

        data = json.loads(response.data)
        assert data['status'] == 'error'


class TestAudioEndpoints:
    """Tests for audio demodulation endpoints.

    Audio endpoints are under /listening/audio/ which requires bearer token auth,
    not session auth.
    """

    def test_audio_status(self, app, auth_client):
        """Test audio status endpoint (token-authenticated)."""
        token = app.extensions.get('_test_api_token')
        if not token:
            # Generate a token using the app helper
            from app import _generate_api_token
            token = _generate_api_token('admin')
        response = auth_client.get(f'/listening/audio/status?token={token}')
        assert response.status_code == 200

        data = json.loads(response.data)
        assert 'running' in data
        assert 'frequency' in data
        assert 'modulation' in data

    def test_audio_stop_when_not_running(self, app, auth_client):
        """Test stopping audio when not running."""
        from app import _generate_api_token
        token = _generate_api_token('admin')
        response = auth_client.post(f'/listening/audio/stop?token={token}')
        assert response.status_code == 200

        data = json.loads(response.data)
        assert data['status'] == 'stopped'

    def test_audio_start_missing_frequency(self, app, auth_client):
        """Test starting audio without frequency returns error."""
        from app import _generate_api_token
        token = _generate_api_token('admin')
        response = auth_client.post(
            f'/listening/audio/start?token={token}',
            data=json.dumps({}),
            content_type='application/json'
        )
        assert response.status_code == 400

        data = json.loads(response.data)
        assert data['status'] == 'error'
        assert 'frequency' in data['message'].lower()

    def test_audio_start_invalid_modulation(self, app, auth_client):
        """Test starting audio with invalid modulation returns error."""
        from app import _generate_api_token
        token = _generate_api_token('admin')
        response = auth_client.post(
            f'/listening/audio/start?token={token}',
            data=json.dumps({
                'frequency': 98.1,
                'modulation': 'invalid_mode'
            }),
            content_type='application/json'
        )
        assert response.status_code == 400

        data = json.loads(response.data)
        assert data['status'] == 'error'
        assert 'modulation' in data['message'].lower()

    def test_audio_stream_when_not_running(self, app, auth_client):
        """Test audio stream when not running returns non-200."""
        from app import _generate_api_token
        token = _generate_api_token('admin')
        response = auth_client.get(f'/listening/audio/stream?token={token}')
        # Endpoint returns 204 or 400 when no audio pipeline is active
        assert response.status_code in (204, 400)


class TestExportEndpoints:
    """Tests for data export endpoints."""

    def test_export_aircraft_json(self, auth_client):
        """Test exporting aircraft data as JSON."""
        response = auth_client.get('/export/aircraft?format=json')
        assert response.status_code == 200
        assert response.content_type == 'application/json'

    def test_export_aircraft_csv(self, auth_client):
        """Test exporting aircraft data as CSV."""
        response = auth_client.get('/export/aircraft?format=csv')
        assert response.status_code == 200
        assert 'text/csv' in response.content_type

    def test_export_wifi_json(self, auth_client):
        """Test exporting WiFi data as JSON."""
        response = auth_client.get('/export/wifi?format=json')
        assert response.status_code == 200
        assert response.content_type == 'application/json'

    def test_export_wifi_csv(self, auth_client):
        """Test exporting WiFi data as CSV."""
        response = auth_client.get('/export/wifi?format=csv')
        assert response.status_code == 200
        assert 'text/csv' in response.content_type

    def test_export_bluetooth_json(self, auth_client):
        """Test exporting Bluetooth data as JSON."""
        response = auth_client.get('/export/bluetooth?format=json')
        assert response.status_code == 200
        assert response.content_type == 'application/json'

    def test_export_bluetooth_csv(self, auth_client):
        """Test exporting Bluetooth data as CSV."""
        response = auth_client.get('/export/bluetooth?format=csv')
        assert response.status_code == 200
        assert 'text/csv' in response.content_type


class TestCSRFProtection:
    """Tests for CSRF protection."""

    def test_post_without_csrf_is_rejected(self, auth_client):
        """Test that POST without CSRF token returns 403."""
        response = auth_client.post('/killall')
        assert response.status_code == 403

    def test_post_with_wrong_csrf_is_rejected(self, auth_client):
        """Test that POST with wrong CSRF token returns 403."""
        response = auth_client.post(
            '/killall',
            headers={'X-CSRF-Token': 'wrong-token'},
        )
        assert response.status_code == 403

    def test_post_with_valid_csrf_succeeds(self, auth_client):
        """Test that POST with correct CSRF token is accepted."""
        response = auth_client.post(
            '/killall',
            headers=_csrf_headers(),
        )
        assert response.status_code == 200

    def test_get_requests_do_not_require_csrf(self, auth_client):
        """Test that GET requests are not subject to CSRF validation."""
        response = auth_client.get('/health')
        assert response.status_code == 200
