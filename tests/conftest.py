"""Pytest configuration and fixtures."""

import pytest
from app import app as flask_app
from routes import register_blueprints


@pytest.fixture(scope='session')
def app():
    """Create application for testing."""
    flask_app.config['TESTING'] = True
    # Register blueprints only if not already registered
    if 'pager' not in flask_app.blueprints:
        register_blueprints(flask_app)
    return flask_app


@pytest.fixture
def client(app):
    """Create test client."""
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
