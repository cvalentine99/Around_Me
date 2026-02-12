"""Logging utilities for Valentine RF application."""

from __future__ import annotations

import logging
import sys

from config import LOG_LEVEL, LOG_FORMAT


def get_logger(name: str) -> logging.Logger:
    """Get a configured logger for a module."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter(LOG_FORMAT))
        logger.addHandler(handler)
        logger.setLevel(LOG_LEVEL)
        logger.propagate = False  # Prevent duplicate logs from parent handlers
    return logger


# Pre-configured loggers for each module
app_logger = get_logger('valentine')
pager_logger = get_logger('valentine.pager')
sensor_logger = get_logger('valentine.sensor')
wifi_logger = get_logger('valentine.wifi')
bluetooth_logger = get_logger('valentine.bluetooth')
adsb_logger = get_logger('valentine.adsb')
satellite_logger = get_logger('valentine.satellite')
