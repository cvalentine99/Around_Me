"""Tests for main application routes."""

import pytest


async def test_index_page(auth_client):
    """Test that index page loads."""
    response = await auth_client.get('/')
    assert response.status_code == 200
    data = await response.get_data()
    assert b'Valentine RF' in data


async def test_dependencies_endpoint(auth_client):
    """Test dependencies endpoint returns valid JSON."""
    response = await auth_client.get('/dependencies')
    assert response.status_code == 200
    data = await response.get_json()
    assert 'modes' in data
    assert 'os' in data


async def test_devices_endpoint(auth_client):
    """Test devices endpoint returns list."""
    response = await auth_client.get('/devices')
    assert response.status_code == 200
    data = await response.get_json()
    assert isinstance(data, list)


async def test_satellite_dashboard(auth_client):
    """Test satellite dashboard loads."""
    response = await auth_client.get('/satellite/dashboard')
    assert response.status_code == 200


async def test_adsb_dashboard(auth_client):
    """Test ADS-B dashboard loads."""
    response = await auth_client.get('/adsb/dashboard')
    assert response.status_code == 200
