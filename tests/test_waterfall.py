"""Tests for the Waterfall / Spectrogram endpoints."""

from unittest.mock import patch, MagicMock
import pytest


@pytest.fixture
async def auth_client(client):
    """Client with logged-in session."""
    async with client.session_transaction() as sess:
        sess['logged_in'] = True
    return client


async def test_waterfall_start_no_rtl_power(auth_client):
    """Start should fail gracefully when rtl_power is not available."""
    with patch('routes.listening_post.find_rtl_power', return_value=None):
        resp = await auth_client.post('/listening/waterfall/start', json={
            'start_freq': 88.0,
            'end_freq': 108.0,
        })
        assert resp.status_code == 503
        data = await resp.get_json()
        assert 'rtl_power' in data['message']


async def test_waterfall_start_invalid_range(auth_client):
    """Start should reject end <= start."""
    with patch('routes.listening_post.find_rtl_power', return_value='/usr/bin/rtl_power'):
        resp = await auth_client.post('/listening/waterfall/start', json={
            'start_freq': 108.0,
            'end_freq': 88.0,
        })
        assert resp.status_code == 400


async def test_waterfall_start_success(auth_client):
    """Start should succeed with mocked rtl_power and device."""
    with patch('routes.listening_post.find_rtl_power', return_value='/usr/bin/rtl_power'), \
         patch('routes.listening_post.app_module') as mock_app:
        mock_app.claim_sdr_device.return_value = None  # No error, claim succeeds
        resp = await auth_client.post('/listening/waterfall/start', json={
            'start_freq': 88.0,
            'end_freq': 108.0,
            'gain': 40,
            'device': 0,
        })
        assert resp.status_code == 200
        data = await resp.get_json()
        assert data['status'] == 'started'

    # Clean up: stop waterfall
    import routes.listening_post as lp
    lp.waterfall_running = False


async def test_waterfall_stop(auth_client):
    """Stop should succeed."""
    resp = await auth_client.post('/listening/waterfall/stop')
    assert resp.status_code == 200
    data = await resp.get_json()
    assert data['status'] == 'stopped'


async def test_waterfall_stream_mimetype(auth_client):
    """Stream should return event-stream content type."""
    resp = await auth_client.get('/listening/waterfall/stream')
    assert resp.content_type.startswith('text/event-stream')


async def test_waterfall_start_device_busy(auth_client):
    """Start should fail when device is in use."""
    with patch('routes.listening_post.find_rtl_power', return_value='/usr/bin/rtl_power'), \
         patch('routes.listening_post.app_module') as mock_app:
        mock_app.claim_sdr_device.return_value = 'SDR device 0 is in use by scanner'
        resp = await auth_client.post('/listening/waterfall/start', json={
            'start_freq': 88.0,
            'end_freq': 108.0,
        })
        assert resp.status_code == 409
