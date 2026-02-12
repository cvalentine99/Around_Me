"""Tests for main application routes."""

import pytest


def test_unauthenticated_redirect(client):
    """Test that unauthenticated requests redirect to login."""
    response = client.get('/')
    assert response.status_code == 302
    assert '/login' in response.headers.get('Location', '')


def test_index_page(auth_client):
    """Test that index page loads."""
    response = auth_client.get('/')
    assert response.status_code == 200
    assert b'Valentine RF' in response.data


def test_dependencies_endpoint(auth_client):
    """Test dependencies endpoint returns valid JSON."""
    response = auth_client.get('/dependencies')
    assert response.status_code == 200
    data = response.get_json()
    assert 'modes' in data
    assert 'os' in data


def test_devices_endpoint(auth_client):
    """Test devices endpoint returns list."""
    response = auth_client.get('/devices')
    assert response.status_code == 200
    data = response.get_json()
    assert isinstance(data, list)


def test_satellite_dashboard(auth_client):
    """Test satellite dashboard loads."""
    response = auth_client.get('/satellite/dashboard')
    assert response.status_code == 200


def test_adsb_dashboard(auth_client):
    """Test ADS-B dashboard loads."""
    response = auth_client.get('/adsb/dashboard')
    assert response.status_code == 200
