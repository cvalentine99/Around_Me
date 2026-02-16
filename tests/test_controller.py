"""
Tests for Controller routes (multi-agent management).

Tests cover:
- Agent CRUD operations via HTTP
- Proxy operations to agents
- Push data ingestion
- SSE streaming
- Location estimation
"""

import json
import os
import pytest
import sys
from unittest.mock import Mock, patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# =============================================================================
# Fixtures
# =============================================================================

@pytest.fixture
def setup_db(tmp_path):
    """Set up a temporary database."""
    import utils.database as db_module
    from utils.database import init_db

    test_db_path = tmp_path / 'test.db'
    original_db_path = db_module.DB_PATH
    db_module.DB_PATH = test_db_path
    db_module.DB_DIR = tmp_path

    init_db()

    yield

    db_module.DB_PATH = original_db_path


@pytest.fixture
def app(setup_db):
    """Create Flask app with controller blueprint."""
    from quart import Quart
    from routes.controller import controller_bp

    app = Quart(__name__)
    app.config['TESTING'] = True
    app.register_blueprint(controller_bp)

    return app


@pytest.fixture
def client(app):
    """Create test client."""
    return app.test_client()


@pytest.fixture
def sample_agent(setup_db):
    """Create a sample agent in database."""
    from utils.database import create_agent
    agent_id = create_agent(
        name='test-sensor',
        base_url='http://192.168.1.50:8020',
        api_key='test-key',
        description='Test sensor node',
        capabilities={'adsb': True, 'wifi': True},
        gps_coords={'lat': 40.7128, 'lon': -74.0060}
    )
    return agent_id


# =============================================================================
# Agent CRUD Tests
# =============================================================================

class TestAgentCRUD:
    """Tests for agent CRUD operations."""

    async def test_list_agents_empty(self, client):
        """GET /controller/agents should return empty list initially."""
        response = await client.get('/controller/agents')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'success'
        assert data['agents'] == []
        assert data['count'] == 0

    async def test_register_agent_success(self, client):
        """POST /controller/agents should register new agent."""
        with patch('routes.controller.AgentClient') as MockClient:
            # Mock successful capability fetch
            mock_instance = Mock()
            mock_instance.get_capabilities.return_value = {
                'modes': {'adsb': True, 'wifi': True},
                'devices': [{'name': 'RTL-SDR'}]
            }
            MockClient.return_value = mock_instance

            response = await client.post('/controller/agents',
                json={
                    'name': 'new-sensor',
                    'base_url': 'http://192.168.1.51:8020',
                    'api_key': 'secret123',
                    'description': 'New sensor node'
                }
            )

            assert response.status_code == 201
            data = await response.get_json()
            assert data['status'] == 'success'
            assert data['agent']['name'] == 'new-sensor'

    async def test_register_agent_missing_name(self, client):
        """POST /controller/agents should reject missing name."""
        response = await client.post('/controller/agents',
            json={'base_url': 'http://localhost:8020'}
        )

        assert response.status_code == 400
        data = await response.get_json()
        assert 'name is required' in data['message']

    async def test_register_agent_missing_url(self, client):
        """POST /controller/agents should reject missing URL."""
        response = await client.post('/controller/agents',
            json={'name': 'test-sensor'}
        )

        assert response.status_code == 400
        data = await response.get_json()
        assert 'Base URL is required' in data['message']

    async def test_register_agent_duplicate_name(self, client, sample_agent):
        """POST /controller/agents should reject duplicate name."""
        response = await client.post('/controller/agents',
            json={
                'name': 'test-sensor',  # Same as sample_agent
                'base_url': 'http://192.168.1.60:8020'
            }
        )

        assert response.status_code == 409
        data = await response.get_json()
        assert 'already exists' in data['message']

    async def test_list_agents_with_agents(self, client, sample_agent):
        """GET /controller/agents should return registered agents."""
        response = await client.get('/controller/agents')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['count'] >= 1

        names = [a['name'] for a in data['agents']]
        assert 'test-sensor' in names

    async def test_get_agent_detail(self, client, sample_agent):
        """GET /controller/agents/<id> should return agent details."""
        response = await client.get(f'/controller/agents/{sample_agent}')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'success'
        assert data['agent']['name'] == 'test-sensor'
        assert data['agent']['capabilities']['adsb'] is True

    async def test_get_agent_not_found(self, client):
        """GET /controller/agents/<id> should return 404 for missing agent."""
        response = await client.get('/controller/agents/99999')
        assert response.status_code == 404

    async def test_update_agent(self, client, sample_agent):
        """PATCH /controller/agents/<id> should update agent."""
        response = await client.patch(f'/controller/agents/{sample_agent}',
            json={'description': 'Updated description'}
        )

        assert response.status_code == 200
        data = await response.get_json()
        assert data['agent']['description'] == 'Updated description'

    async def test_delete_agent(self, client, sample_agent):
        """DELETE /controller/agents/<id> should remove agent."""
        response = await client.delete(f'/controller/agents/{sample_agent}')
        assert response.status_code == 200

        # Verify deleted
        response = await client.get(f'/controller/agents/{sample_agent}')
        assert response.status_code == 404


# =============================================================================
# Proxy Operation Tests
# =============================================================================

class TestProxyOperations:
    """Tests for proxying operations to agents."""

    async def test_proxy_start_mode(self, client, sample_agent):
        """POST /controller/agents/<id>/<mode>/start should proxy to agent."""
        with patch('routes.controller.create_client_from_agent') as mock_create:
            mock_client = Mock()
            mock_client.start_mode.return_value = {'status': 'started', 'mode': 'adsb'}
            mock_create.return_value = mock_client

            response = await client.post(
                f'/controller/agents/{sample_agent}/adsb/start',
                json={'device_index': 0}
            )

            assert response.status_code == 200
            data = await response.get_json()
            assert data['status'] == 'success'
            assert data['mode'] == 'adsb'

            mock_client.start_mode.assert_called_once_with('adsb', {'device_index': 0})

    async def test_proxy_stop_mode(self, client, sample_agent):
        """POST /controller/agents/<id>/<mode>/stop should proxy to agent."""
        with patch('routes.controller.create_client_from_agent') as mock_create:
            mock_client = Mock()
            mock_client.stop_mode.return_value = {'status': 'stopped'}
            mock_create.return_value = mock_client

            response = await client.post(
                f'/controller/agents/{sample_agent}/wifi/stop'
            )

            assert response.status_code == 200
            data = await response.get_json()
            assert data['status'] == 'success'

    async def test_proxy_get_mode_data(self, client, sample_agent):
        """GET /controller/agents/<id>/<mode>/data should return data."""
        with patch('routes.controller.create_client_from_agent') as mock_create:
            mock_client = Mock()
            mock_client.get_mode_data.return_value = {
                'mode': 'adsb',
                'data': [{'icao': 'ABC123'}]
            }
            mock_create.return_value = mock_client

            response = await client.get(f'/controller/agents/{sample_agent}/adsb/data')

            assert response.status_code == 200
            data = await response.get_json()
            assert data['status'] == 'success'
            assert 'agent_name' in data
            assert data['agent_name'] == 'test-sensor'

    async def test_proxy_agent_not_found(self, client):
        """Proxy operations should return 404 for missing agent."""
        response = await client.post('/controller/agents/99999/adsb/start')
        assert response.status_code == 404

    async def test_proxy_connection_error(self, client, sample_agent):
        """Proxy should return 503 when agent unreachable."""
        from utils.agent_client import AgentConnectionError

        with patch('routes.controller.create_client_from_agent') as mock_create:
            mock_client = Mock()
            mock_client.start_mode.side_effect = AgentConnectionError("Connection refused")
            mock_create.return_value = mock_client

            response = await client.post(
                f'/controller/agents/{sample_agent}/adsb/start',
                json={}
            )

            assert response.status_code == 503
            data = await response.get_json()
            assert 'Cannot connect' in data['message']


# =============================================================================
# Push Data Ingestion Tests
# =============================================================================

class TestPushIngestion:
    """Tests for push data ingestion endpoint."""

    async def test_ingest_success(self, client, sample_agent):
        """POST /controller/api/ingest should store payload."""
        payload = {
            'agent_name': 'test-sensor',
            'scan_type': 'adsb',
            'interface': 'rtlsdr0',
            'payload': {
                'aircraft': [{'icao': 'ABC123', 'altitude': 35000}]
            }
        }

        response = await client.post('/controller/api/ingest',
            json=payload,
            headers={'X-API-Key': 'test-key'}
        )

        assert response.status_code == 202
        data = await response.get_json()
        assert data['status'] == 'accepted'
        assert 'payload_id' in data

    async def test_ingest_unknown_agent(self, client):
        """POST /controller/api/ingest should reject unknown agent."""
        payload = {
            'agent_name': 'nonexistent-sensor',
            'scan_type': 'adsb',
            'payload': {}
        }

        response = await client.post('/controller/api/ingest',
            json=payload
        )

        assert response.status_code == 401
        data = await response.get_json()
        assert 'Unknown agent' in data['message']

    async def test_ingest_invalid_api_key(self, client, sample_agent):
        """POST /controller/api/ingest should reject invalid API key."""
        payload = {
            'agent_name': 'test-sensor',
            'scan_type': 'adsb',
            'payload': {}
        }

        response = await client.post('/controller/api/ingest',
            json=payload,
            headers={'X-API-Key': 'wrong-key'}
        )

        assert response.status_code == 401
        data = await response.get_json()
        assert 'Invalid API key' in data['message']

    async def test_ingest_missing_agent_name(self, client):
        """POST /controller/api/ingest should require agent_name."""
        response = await client.post('/controller/api/ingest',
            json={'scan_type': 'adsb', 'payload': {}}
        )

        assert response.status_code == 400
        data = await response.get_json()
        assert 'agent_name required' in data['message']

    async def test_get_payloads(self, client, sample_agent):
        """GET /controller/api/payloads should return stored payloads."""
        # First ingest some data
        for i in range(3):
            await client.post('/controller/api/ingest',
                json={
                    'agent_name': 'test-sensor',
                    'scan_type': 'adsb',
                    'payload': {'aircraft': [{'icao': f'TEST{i}'}]}
                },
                headers={'X-API-Key': 'test-key'}
            )

        response = await client.get(f'/controller/api/payloads?agent_id={sample_agent}')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['count'] == 3

    async def test_get_payloads_filter_by_type(self, client, sample_agent):
        """GET /controller/api/payloads should filter by scan_type."""
        # Ingest mixed data
        await client.post('/controller/api/ingest',
            json={'agent_name': 'test-sensor', 'scan_type': 'adsb', 'payload': {}},
            headers={'X-API-Key': 'test-key'}
        )
        await client.post('/controller/api/ingest',
            json={'agent_name': 'test-sensor', 'scan_type': 'wifi', 'payload': {}},
            headers={'X-API-Key': 'test-key'}
        )

        response = await client.get('/controller/api/payloads?scan_type=adsb')
        data = await response.get_json()

        assert all(p['scan_type'] == 'adsb' for p in data['payloads'])


# =============================================================================
# Location Estimation Tests
# =============================================================================

class TestLocationEstimation:
    """Tests for device location estimation (trilateration)."""

    async def test_add_observation(self, client):
        """POST /controller/api/location/observe should accept observation."""
        response = await client.post('/controller/api/location/observe',
            json={
                'device_id': 'AA:BB:CC:DD:EE:FF',
                'agent_name': 'sensor-1',
                'agent_lat': 40.7128,
                'agent_lon': -74.0060,
                'rssi': -55
            }
        )

        assert response.status_code == 200
        data = await response.get_json()
        assert data['status'] == 'success'
        assert data['device_id'] == 'AA:BB:CC:DD:EE:FF'

    async def test_add_observation_missing_fields(self, client):
        """POST /controller/api/location/observe should require all fields."""
        response = await client.post('/controller/api/location/observe',
            json={
                'device_id': 'AA:BB:CC:DD:EE:FF',
                'rssi': -55
                # Missing agent_name, agent_lat, agent_lon
            }
        )

        assert response.status_code == 400

    async def test_estimate_location(self, client):
        """POST /controller/api/location/estimate should compute location."""
        response = await client.post('/controller/api/location/estimate',
            json={
                'observations': [
                    {'agent_lat': 40.7128, 'agent_lon': -74.0060, 'rssi': -55, 'agent_name': 'node-1'},
                    {'agent_lat': 40.7135, 'agent_lon': -74.0055, 'rssi': -70, 'agent_name': 'node-2'},
                    {'agent_lat': 40.7120, 'agent_lon': -74.0050, 'rssi': -62, 'agent_name': 'node-3'}
                ],
                'environment': 'outdoor'
            }
        )

        assert response.status_code == 200
        data = await response.get_json()
        # Should have computed a location
        if data['location']:
            assert 'latitude' in data['location']
            assert 'longitude' in data['location']

    async def test_estimate_location_insufficient_data(self, client):
        """Estimation should require at least 2 observations."""
        response = await client.post('/controller/api/location/estimate',
            json={
                'observations': [
                    {'agent_lat': 40.7128, 'agent_lon': -74.0060, 'rssi': -55, 'agent_name': 'node-1'}
                ]
            }
        )

        assert response.status_code == 400
        data = await response.get_json()
        assert 'At least 2' in data['message']

    async def test_get_device_location_not_found(self, client):
        """GET /controller/api/location/<device_id> returns not_found for unknown device."""
        response = await client.get('/controller/api/location/unknown-device')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'not_found'
        assert data['location'] is None

    async def test_get_all_locations(self, client):
        """GET /controller/api/location/all should return all estimates."""
        response = await client.get('/controller/api/location/all')
        assert response.status_code == 200

        data = await response.get_json()
        assert data['status'] == 'success'
        assert 'devices' in data

    async def test_get_devices_near(self, client):
        """GET /controller/api/location/near should find nearby devices."""
        response = await client.get(
            '/controller/api/location/near',
            query_string={'lat': 40.7128, 'lon': -74.0060, 'radius': 100}
        )

        assert response.status_code == 200
        data = await response.get_json()
        assert data['status'] == 'success'
        assert data['center']['lat'] == 40.7128


# =============================================================================
# Agent Refresh Tests
# =============================================================================

class TestAgentRefresh:
    """Tests for agent refresh operations."""

    async def test_refresh_agent_success(self, client, sample_agent):
        """POST /controller/agents/<id>/refresh should update metadata."""
        with patch('routes.controller.create_client_from_agent') as mock_create:
            mock_client = Mock()
            mock_client.refresh_metadata.return_value = {
                'healthy': True,
                'capabilities': {
                    'modes': {'adsb': True, 'wifi': True, 'bluetooth': True},
                    'devices': [{'name': 'RTL-SDR V3'}]
                },
                'status': {'running_modes': ['adsb']},
                'config': {}
            }
            mock_create.return_value = mock_client

            response = await client.post(f'/controller/agents/{sample_agent}/refresh')

            assert response.status_code == 200
            data = await response.get_json()
            assert data['status'] == 'success'
            assert data['metadata']['healthy'] is True

    async def test_refresh_agent_unreachable(self, client, sample_agent):
        """POST /controller/agents/<id>/refresh should return 503 if unreachable."""
        with patch('routes.controller.create_client_from_agent') as mock_create:
            mock_client = Mock()
            mock_client.refresh_metadata.return_value = {'healthy': False}
            mock_create.return_value = mock_client

            response = await client.post(f'/controller/agents/{sample_agent}/refresh')

            assert response.status_code == 503


# =============================================================================
# SSE Stream Tests
# =============================================================================

class TestSSEStream:
    """Tests for SSE streaming endpoint."""

    async def test_stream_all_endpoint_exists(self, client):
        """GET /controller/stream/all should exist and return SSE."""
        # Just verify the endpoint is accessible
        # Full SSE testing requires more complex setup
        response = await client.get('/controller/stream/all')
        assert response.content_type.startswith('text/event-stream')
