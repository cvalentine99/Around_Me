"""Tests for configuration module."""

import os
import pytest


class TestConfigEnvVars:
    """Tests for environment variable configuration."""

    def test_default_values(self):
        """Test that default values are set."""
        from config import PORT, HOST, DEBUG

        assert PORT == 5050
        assert HOST == '0.0.0.0'
        assert DEBUG is False

    def test_env_override(self, monkeypatch):
        """Test that environment variables override defaults."""
        monkeypatch.setenv('VALENTINE_PORT', '8080')
        monkeypatch.setenv('VALENTINE_DEBUG', 'true')

        # Re-import to get new values
        import importlib
        import config
        importlib.reload(config)

        assert config.PORT == 8080
        assert config.DEBUG is True

        # Reset
        monkeypatch.delenv('VALENTINE_PORT', raising=False)
        monkeypatch.delenv('VALENTINE_DEBUG', raising=False)
        importlib.reload(config)

    def test_invalid_env_values(self, monkeypatch):
        """Test that invalid env values fall back to defaults."""
        monkeypatch.setenv('VALENTINE_PORT', 'invalid')

        import importlib
        import config
        importlib.reload(config)

        # Should fall back to default
        assert config.PORT == 5050

        monkeypatch.delenv('VALENTINE_PORT', raising=False)
        importlib.reload(config)
