"""
Views — Dashboard page routes for new frontend panels.

Serves the standalone HTML dashboard pages for features that
previously had no frontend: Space Weather, Analytics, BT Locate,
Geospatial, History, Weather Satellite, TSCM Advanced,
WiFi Advanced, and System Status.
"""

from __future__ import annotations

from quart import Blueprint, render_template

from config import VERSION, SHARED_OBSERVER_LOCATION_ENABLED

views_bp = Blueprint('views', __name__)


@views_bp.route('/space-weather/dashboard')
async def space_weather_dashboard():
    """Space weather conditions dashboard."""
    return await render_template(
        'space_weather.html',
        shared_observer_location=SHARED_OBSERVER_LOCATION_ENABLED,
        version=VERSION,
    )


@views_bp.route('/analytics/dashboard')
async def analytics_dashboard():
    """Cross-mode analytics and insights dashboard."""
    return await render_template(
        'analytics_dashboard.html',
        shared_observer_location=SHARED_OBSERVER_LOCATION_ENABLED,
        version=VERSION,
    )


@views_bp.route('/bt-locate/dashboard')
async def bt_locate_dashboard():
    """Bluetooth device location tracking dashboard."""
    return await render_template(
        'bt_locate.html',
        shared_observer_location=SHARED_OBSERVER_LOCATION_ENABLED,
        version=VERSION,
    )


@views_bp.route('/geospatial')
async def geospatial_dashboard():
    """Unified geospatial map with all signal layers."""
    return await render_template(
        'geospatial.html',
        shared_observer_location=SHARED_OBSERVER_LOCATION_ENABLED,
        version=VERSION,
    )


@views_bp.route('/history')
async def history_dashboard():
    """Session recordings, ADS-B history, and TSCM reports."""
    return await render_template(
        'history.html',
        shared_observer_location=SHARED_OBSERVER_LOCATION_ENABLED,
        version=VERSION,
    )


@views_bp.route('/weather-sat/dashboard')
async def weather_sat_dashboard():
    """Weather satellite capture and image dashboard."""
    return await render_template(
        'weather_sat_dashboard.html',
        shared_observer_location=SHARED_OBSERVER_LOCATION_ENABLED,
        version=VERSION,
    )


@views_bp.route('/tscm/dashboard')
async def tscm_dashboard():
    """Advanced TSCM threat management and reporting."""
    return await render_template(
        'tscm_dashboard.html',
        shared_observer_location=SHARED_OBSERVER_LOCATION_ENABLED,
        version=VERSION,
    )


@views_bp.route('/wifi/advanced')
async def wifi_advanced_dashboard():
    """Advanced WiFi v2 analysis dashboard."""
    return await render_template(
        'wifi_advanced.html',
        shared_observer_location=SHARED_OBSERVER_LOCATION_ENABLED,
        version=VERSION,
    )


@views_bp.route('/system/status')
async def system_status_dashboard():
    """System status: offline mode, WebSDR, updates."""
    return await render_template(
        'system_status.html',
        shared_observer_location=SHARED_OBSERVER_LOCATION_ENABLED,
        version=VERSION,
    )
