"""Tests for the Signal Identification (guess) API endpoint."""

import pytest


@pytest.fixture
async def auth_client(client):
    """Client with logged-in session."""
    async with client.session_transaction() as sess:
        sess['logged_in'] = True
    return client


async def test_signal_guess_fm_broadcast(auth_client):
    """FM broadcast frequency should return a known signal type."""
    resp = await auth_client.post('/listening/signal/guess', json={
        'frequency_mhz': 98.1,
        'modulation': 'wfm',
    })
    assert resp.status_code == 200
    data = await resp.get_json()
    assert data['status'] == 'ok'
    assert data['primary_label']
    assert data['confidence'] in ('HIGH', 'MEDIUM', 'LOW')


async def test_signal_guess_airband(auth_client):
    """Airband frequency should be identified."""
    resp = await auth_client.post('/listening/signal/guess', json={
        'frequency_mhz': 121.5,
        'modulation': 'am',
    })
    assert resp.status_code == 200
    data = await resp.get_json()
    assert data['status'] == 'ok'
    assert data['primary_label']


async def test_signal_guess_ism_band(auth_client):
    """ISM band frequency (433.92 MHz) should be identified."""
    resp = await auth_client.post('/listening/signal/guess', json={
        'frequency_mhz': 433.92,
    })
    assert resp.status_code == 200
    data = await resp.get_json()
    assert data['status'] == 'ok'
    assert data['primary_label']
    assert data['confidence'] in ('HIGH', 'MEDIUM', 'LOW')


async def test_signal_guess_missing_frequency(auth_client):
    """Missing frequency should return 400."""
    resp = await auth_client.post('/listening/signal/guess', json={})
    assert resp.status_code == 400
    data = await resp.get_json()
    assert data['status'] == 'error'


async def test_signal_guess_invalid_frequency(auth_client):
    """Invalid frequency value should return 400."""
    resp = await auth_client.post('/listening/signal/guess', json={
        'frequency_mhz': 'abc',
    })
    assert resp.status_code == 400


async def test_signal_guess_negative_frequency(auth_client):
    """Negative frequency should return 400."""
    resp = await auth_client.post('/listening/signal/guess', json={
        'frequency_mhz': -5.0,
    })
    assert resp.status_code == 400


async def test_signal_guess_with_region(auth_client):
    """Specifying region should work."""
    resp = await auth_client.post('/listening/signal/guess', json={
        'frequency_mhz': 462.5625,
        'region': 'US',
    })
    assert resp.status_code == 200
    data = await resp.get_json()
    assert data['status'] == 'ok'


async def test_signal_guess_response_structure(auth_client):
    """Response should have all expected fields."""
    resp = await auth_client.post('/listening/signal/guess', json={
        'frequency_mhz': 146.52,
        'modulation': 'fm',
    })
    assert resp.status_code == 200
    data = await resp.get_json()
    assert 'primary_label' in data
    assert 'confidence' in data
    assert 'alternatives' in data
    assert 'explanation' in data
    assert 'tags' in data
    assert isinstance(data['alternatives'], list)
    assert isinstance(data['tags'], list)
