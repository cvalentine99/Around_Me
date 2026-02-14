"""Tests for the UAT (978 MHz) ADS-B decoding module."""

from unittest.mock import patch, MagicMock
import json
import pytest

from routes.uat import (
    _parse_uat_aircraft,
    find_dump978,
    find_uat2json,
)


# ============================================
# _parse_uat_aircraft() tests
# ============================================


def test_parse_basic_aircraft():
    """Should parse a minimal UAT aircraft message with ICAO address."""
    data = {
        'address': 'A12345',
        'callsign': 'N12345',
    }
    result = _parse_uat_aircraft(data)
    assert result is not None
    assert result['icao'] == 'A12345'
    assert result['callsign'] == 'N12345'
    assert result['source'] == 'uat'


def test_parse_missing_address():
    """Should return None when ICAO address is missing."""
    data = {'callsign': 'N12345'}
    result = _parse_uat_aircraft(data)
    assert result is None


def test_parse_empty_address():
    """Should return None when ICAO address is empty string."""
    data = {'address': '', 'callsign': 'N12345'}
    result = _parse_uat_aircraft(data)
    assert result is None


def test_parse_full_aircraft():
    """Should parse a complete UAT aircraft message with all fields."""
    data = {
        'address': 'ABCDEF',
        'callsign': '  UAL123  ',
        'altitude': {'baro': 5500},
        'position': {'lat': 40.7128, 'lon': -74.0060},
        'velocity': {
            'groundspeed': 120,
            'heading': 270,
            'vertical_rate': -500,
        },
        'squawk': 1200,
    }
    result = _parse_uat_aircraft(data)
    assert result is not None
    assert result['icao'] == 'ABCDEF'
    assert result['callsign'] == 'UAL123'
    assert result['altitude'] == 5500
    assert result['lat'] == 40.7128
    assert result['lon'] == -74.0060
    assert result['speed'] == 120
    assert result['heading'] == 270
    assert result['vertical_rate'] == -500
    assert result['squawk'] == '1200'
    assert result['source'] == 'uat'


def test_parse_partial_position():
    """Should not set lat/lon when only one coordinate is present."""
    data = {
        'address': 'A00001',
        'position': {'lat': 40.7128},
    }
    result = _parse_uat_aircraft(data)
    assert result is not None
    assert 'lat' not in result
    assert 'lon' not in result


def test_parse_invalid_altitude():
    """Should handle non-numeric altitude gracefully."""
    data = {
        'address': 'A00002',
        'altitude': {'baro': 'invalid'},
    }
    result = _parse_uat_aircraft(data)
    assert result is not None
    assert 'altitude' not in result


def test_parse_address_uppercased():
    """Should uppercase the ICAO address."""
    data = {'address': 'abcdef'}
    result = _parse_uat_aircraft(data)
    assert result['icao'] == 'ABCDEF'


def test_parse_squawk_as_string():
    """Should store squawk as string."""
    data = {'address': 'A00003', 'squawk': 7700}
    result = _parse_uat_aircraft(data)
    assert result['squawk'] == '7700'


# ============================================
# Tool discovery tests
# ============================================


@patch('shutil.which')
def test_find_dump978_in_path(mock_which):
    """Should find dump978-fa via shutil.which."""
    mock_which.side_effect = lambda name: '/usr/bin/dump978-fa' if name == 'dump978-fa' else None
    assert find_dump978() == '/usr/bin/dump978-fa'


@patch('shutil.which', return_value=None)
@patch('os.path.isfile', return_value=False)
@patch('os.access', return_value=False)
def test_find_dump978_not_installed(mock_access, mock_isfile, mock_which):
    """Should return None when dump978 is not installed."""
    assert find_dump978() is None


@patch('shutil.which')
def test_find_uat2json_in_path(mock_which):
    """Should find uat2json via shutil.which."""
    mock_which.return_value = '/usr/bin/uat2json'
    assert find_uat2json() == '/usr/bin/uat2json'


@patch('shutil.which', return_value=None)
@patch('os.path.isfile', return_value=False)
@patch('os.access', return_value=False)
def test_find_uat2json_not_installed(mock_access, mock_isfile, mock_which):
    """Should return None when uat2json is not installed."""
    assert find_uat2json() is None


# ============================================
# Route tests (require app fixture)
# ============================================


def test_uat_tools_endpoint(client):
    """Should return UAT tool availability."""
    response = client.get('/uat/tools')
    assert response.status_code == 200
    data = json.loads(response.data)
    assert 'enabled' in data
    assert 'dump978' in data
    assert 'uat2json' in data


def test_uat_status_endpoint(client):
    """Should return UAT status."""
    response = client.get('/uat/status')
    assert response.status_code == 200
    data = json.loads(response.data)
    assert 'running' in data
    assert 'messages_received' in data


def test_uat_start_disabled(client):
    """Should reject start when UAT is disabled."""
    with patch('routes.uat.UAT_ENABLED', False):
        response = client.post(
            '/uat/start',
            data=json.dumps({'device': 1}),
            content_type='application/json',
        )
        assert response.status_code == 400
        data = json.loads(response.data)
        assert data['status'] == 'error'


def test_uat_stop_endpoint(client):
    """Should return stopped status."""
    response = client.post('/uat/stop')
    assert response.status_code == 200
    data = json.loads(response.data)
    assert data['status'] == 'stopped'
