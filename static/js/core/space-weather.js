/**
 * Space Weather Dashboard Module
 * Fetches and renders space weather data from NOAA SWPC, HamQSL, and SDO sources.
 * Uses IIFE pattern consistent with other Valentine RF modules.
 */

const SpaceWeather = (function () {
    'use strict';

    // =========================================================================
    // State
    // =========================================================================

    let refreshTimer = null;
    const REFRESH_INTERVAL = 60000; // 60 seconds
    const DATA_URL = '/space-weather/data';
    const IMAGE_URL = '/space-weather/image/';

    // Image keys and labels for the gallery
    const GALLERY_IMAGES = [
        { key: 'sdo_193', label: 'SDO 193\u00c5 (Corona)' },
        { key: 'sdo_304', label: 'SDO 304\u00c5 (Chromosphere)' },
        { key: 'aurora_north', label: 'Aurora Forecast (North)' },
        { key: 'drap_global', label: 'D-RAP HF Absorption' },
    ];

    // Band frequency reference
    const BAND_FREQ_MAP = {
        '80m-40m': '3.5 - 7 MHz',
        '30m-20m': '10 - 14 MHz',
        '17m-15m': '18 - 21 MHz',
        '12m-10m': '24 - 28 MHz',
    };

    // =========================================================================
    // Initialization
    // =========================================================================

    function init() {
        fetchData();
        startAutoRefresh();
    }

    function startAutoRefresh() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(fetchData, REFRESH_INTERVAL);
    }

    function stopAutoRefresh() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
    }

    // =========================================================================
    // Data Fetching
    // =========================================================================

    async function fetchData() {
        updateStatus('fetching');
        try {
            const resp = await fetch(DATA_URL);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const json = await resp.json();
            renderAll(json);
            updateStatus('online');
            updateTimestamp(json.timestamp);
        } catch (err) {
            console.error('[SpaceWeather] Fetch error:', err);
            updateStatus('error');
            showError('Failed to fetch space weather data');
        }
    }

    // =========================================================================
    // Status / Timestamp
    // =========================================================================

    function updateStatus(state) {
        const dot = document.getElementById('swStatusDot');
        const label = document.getElementById('swStatusLabel');
        if (!dot || !label) return;

        dot.className = 'status-dot';
        if (state === 'online') {
            label.textContent = 'LIVE';
        } else if (state === 'fetching') {
            label.textContent = 'UPDATING';
        } else {
            dot.classList.add('error');
            label.textContent = 'ERROR';
        }
    }

    function updateTimestamp(ts) {
        const el = document.getElementById('swLastUpdate');
        if (!el) return;
        if (ts) {
            const d = new Date(ts * 1000);
            el.textContent = 'LAST UPDATE: ' + d.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
        } else {
            el.textContent = 'LAST UPDATE: --';
        }
    }

    function showError(msg) {
        const el = document.getElementById('swErrorMsg');
        if (el) {
            el.textContent = msg;
            el.style.display = 'block';
            setTimeout(function () { el.style.display = 'none'; }, 10000);
        }
    }

    // =========================================================================
    // Render Orchestrator
    // =========================================================================

    function renderAll(data) {
        renderKpIndex(data.kp_index);
        renderKpForecast(data.kp_forecast);
        renderXray(data.xrays);
        renderSolarWind(data.solar_wind_plasma, data.solar_wind_mag);
        renderScales(data.scales);
        renderBandConditions(data.band_conditions);
        renderFlares(data.xray_flares);
        renderAlerts(data.alerts);
        renderImageGallery();
        renderStripStats(data);
    }

    // =========================================================================
    // Kp Index
    // =========================================================================

    function renderKpIndex(kpData) {
        var valueEl = document.getElementById('kpValue');
        var labelEl = document.getElementById('kpLabel');
        var segContainer = document.getElementById('kpBarSegments');
        if (!valueEl || !segContainer) return;

        var kp = 0;
        var kpText = '--';

        if (kpData && Array.isArray(kpData) && kpData.length > 1) {
            // NOAA Kp index JSON: header row + data rows, last row is most recent
            var latest = kpData[kpData.length - 1];
            // Format: [time_tag, Kp, Kp_fraction, a_running, station_count]
            // or similar SWPC format
            if (Array.isArray(latest)) {
                kp = parseFloat(latest[1]) || 0;
            } else if (typeof latest === 'object') {
                kp = parseFloat(latest.kp_index || latest.Kp || latest.kp || 0);
            }
            kpText = kp.toFixed(1);
        }

        valueEl.textContent = kpText;
        valueEl.className = 'kp-value-display ' + getKpClass(kp);

        if (labelEl) {
            labelEl.textContent = getKpDescription(kp);
        }

        // Update bar segments (0-9 scale)
        var segments = segContainer.querySelectorAll('.kp-bar-segment');
        for (var i = 0; i < segments.length; i++) {
            if (i < Math.ceil(kp)) {
                segments[i].classList.add('active');
            } else {
                segments[i].classList.remove('active');
            }
        }
    }

    function getKpClass(kp) {
        if (kp >= 8) return 'kp-severe';
        if (kp >= 6) return 'kp-storm';
        if (kp >= 4) return 'kp-unsettled';
        return 'kp-quiet';
    }

    function getKpDescription(kp) {
        if (kp >= 9) return 'EXTREME STORM (G5)';
        if (kp >= 8) return 'SEVERE STORM (G4)';
        if (kp >= 7) return 'STRONG STORM (G3)';
        if (kp >= 6) return 'MODERATE STORM (G2)';
        if (kp >= 5) return 'MINOR STORM (G1)';
        if (kp >= 4) return 'UNSETTLED';
        if (kp >= 2) return 'QUIET';
        return 'VERY QUIET';
    }

    function renderKpForecast(forecastData) {
        var container = document.getElementById('kpForecast');
        if (!container) return;

        if (!forecastData || !Array.isArray(forecastData) || forecastData.length < 2) {
            container.innerHTML = '<div class="sw-empty">No forecast data</div>';
            return;
        }

        // Show next 3 forecast periods
        var html = '';
        var count = 0;
        for (var i = forecastData.length - 1; i >= 1 && count < 3; i--) {
            var entry = forecastData[i];
            var kpVal = 0;
            var timeLabel = '';

            if (Array.isArray(entry)) {
                kpVal = parseFloat(entry[1]) || 0;
                timeLabel = entry[0] ? entry[0].substring(5, 16).replace(' ', 'T') : '---';
            } else if (typeof entry === 'object') {
                kpVal = parseFloat(entry.kp || entry.Kp || 0);
                timeLabel = entry.time_tag ? entry.time_tag.substring(5, 16) : '---';
            }

            html += '<div class="kp-forecast-item">' +
                '<div class="value ' + getKpClass(kpVal) + '">' + kpVal.toFixed(1) + '</div>' +
                '<div class="label">' + escapeHtml(timeLabel) + '</div>' +
                '</div>';
            count++;
        }

        container.innerHTML = html;
    }

    // =========================================================================
    // X-Ray Flux
    // =========================================================================

    function renderXray(xrayData) {
        var valueEl = document.getElementById('xrayValue');
        var classEl = document.getElementById('xrayClass');
        var detailEl = document.getElementById('xrayDetail');
        if (!valueEl) return;

        if (!xrayData || !Array.isArray(xrayData) || xrayData.length === 0) {
            valueEl.textContent = '--';
            if (classEl) classEl.textContent = 'N/A';
            return;
        }

        // Latest entry (last item in array)
        var latest = xrayData[xrayData.length - 1];
        var flux = 0;

        if (typeof latest === 'object') {
            flux = parseFloat(latest.flux || latest.current_flux || latest.observed_flux || 0);
        }

        // Determine X-ray class from flux
        var xClass = classifyXray(flux);
        var colorClass = 'xray-' + xClass.charAt(0).toLowerCase();

        valueEl.textContent = xClass;
        valueEl.className = 'sw-metric-value ' + colorClass;

        if (classEl) {
            classEl.textContent = flux > 0 ? flux.toExponential(1) + ' W/m\u00b2' : 'N/A';
        }

        if (detailEl && latest.time_tag) {
            detailEl.textContent = latest.time_tag.substring(0, 19);
        }
    }

    function classifyXray(flux) {
        if (flux >= 1e-4) return 'X' + (flux / 1e-4).toFixed(1);
        if (flux >= 1e-5) return 'M' + (flux / 1e-5).toFixed(1);
        if (flux >= 1e-6) return 'C' + (flux / 1e-6).toFixed(1);
        if (flux >= 1e-7) return 'B' + (flux / 1e-7).toFixed(1);
        if (flux > 0) return 'A' + (flux / 1e-8).toFixed(1);
        return 'N/A';
    }

    // =========================================================================
    // Solar Wind
    // =========================================================================

    function renderSolarWind(plasmaData, magData) {
        var speedEl = document.getElementById('swSpeed');
        var densityEl = document.getElementById('swDensity');
        var tempEl = document.getElementById('swTemp');
        var btEl = document.getElementById('swBt');
        var bzEl = document.getElementById('swBz');

        // Solar wind plasma: speed, density, temperature
        if (plasmaData && Array.isArray(plasmaData) && plasmaData.length > 1) {
            var latest = plasmaData[plasmaData.length - 1];
            if (Array.isArray(latest)) {
                // Format: [time_tag, density, speed, temperature]
                if (speedEl) speedEl.textContent = parseFloat(latest[2] || 0).toFixed(0);
                if (densityEl) densityEl.textContent = parseFloat(latest[1] || 0).toFixed(1);
                if (tempEl) tempEl.textContent = formatTemp(parseFloat(latest[3] || 0));
            } else if (typeof latest === 'object') {
                if (speedEl) speedEl.textContent = parseFloat(latest.speed || 0).toFixed(0);
                if (densityEl) densityEl.textContent = parseFloat(latest.density || 0).toFixed(1);
                if (tempEl) tempEl.textContent = formatTemp(parseFloat(latest.temperature || 0));
            }
        } else {
            if (speedEl) speedEl.textContent = '--';
            if (densityEl) densityEl.textContent = '--';
            if (tempEl) tempEl.textContent = '--';
        }

        // Solar wind magnetic: Bt, Bz
        if (magData && Array.isArray(magData) && magData.length > 1) {
            var latestMag = magData[magData.length - 1];
            if (Array.isArray(latestMag)) {
                // Format: [time_tag, bt, bx_gsm, by_gsm, bz_gsm, ...]
                if (btEl) btEl.textContent = parseFloat(latestMag[1] || 0).toFixed(1);
                if (bzEl) {
                    var bz = parseFloat(latestMag[4] || latestMag[3] || 0);
                    bzEl.textContent = bz.toFixed(1);
                    bzEl.style.color = bz < 0 ? 'var(--accent-red)' : 'var(--accent-green)';
                }
            } else if (typeof latestMag === 'object') {
                if (btEl) btEl.textContent = parseFloat(latestMag.bt || 0).toFixed(1);
                if (bzEl) {
                    var bzVal = parseFloat(latestMag.bz_gsm || 0);
                    bzEl.textContent = bzVal.toFixed(1);
                    bzEl.style.color = bzVal < 0 ? 'var(--accent-red)' : 'var(--accent-green)';
                }
            }
        } else {
            if (btEl) btEl.textContent = '--';
            if (bzEl) bzEl.textContent = '--';
        }
    }

    function formatTemp(t) {
        if (!t || t === 0) return '--';
        if (t >= 1e6) return (t / 1e6).toFixed(1) + 'M';
        if (t >= 1e3) return (t / 1e3).toFixed(0) + 'K';
        return t.toFixed(0);
    }

    // =========================================================================
    // NOAA Scales
    // =========================================================================

    function renderScales(scalesData) {
        var rEl = document.getElementById('scaleR');
        var sEl = document.getElementById('scaleS');
        var gEl = document.getElementById('scaleG');
        if (!rEl || !sEl || !gEl) return;

        if (!scalesData || typeof scalesData !== 'object') {
            rEl.textContent = '--';
            sEl.textContent = '--';
            gEl.textContent = '--';
            return;
        }

        // NOAA scales format: { "0": { "R": {...}, "S": {...}, "G": {...} } }
        // The key is usually "0" for current
        var current = scalesData['0'] || scalesData;

        renderScaleValue(rEl, current.R || current.r, 'R');
        renderScaleValue(sEl, current.S || current.s, 'S');
        renderScaleValue(gEl, current.G || current.g, 'G');
    }

    function renderScaleValue(el, scaleObj, prefix) {
        if (!el) return;
        var val = 0;
        if (scaleObj) {
            if (typeof scaleObj === 'object') {
                val = parseInt(scaleObj.Scale || scaleObj.scale || scaleObj.Value || scaleObj.value || 0, 10);
            } else {
                val = parseInt(scaleObj, 10) || 0;
            }
        }

        el.textContent = prefix + val;
        el.className = 'sw-scale-value ' + getScaleColorClass(val);
    }

    function getScaleColorClass(val) {
        if (val >= 5) return 'scale-severe';
        if (val >= 3) return 'scale-strong';
        if (val >= 2) return 'scale-moderate';
        if (val >= 1) return 'scale-minor';
        return 'scale-none';
    }

    // =========================================================================
    // Band Conditions (HamQSL)
    // =========================================================================

    function renderBandConditions(bandData) {
        var tbody = document.getElementById('bandConditionsBody');
        if (!tbody) return;

        if (!bandData || typeof bandData !== 'object' || !bandData.bands || !Array.isArray(bandData.bands)) {
            tbody.innerHTML = '<tr><td colspan="3" class="sw-empty">No band data available</td></tr>';
            return;
        }

        // Group bands by name
        var bandMap = {};
        bandData.bands.forEach(function (b) {
            var name = b.name || '';
            if (!bandMap[name]) bandMap[name] = {};
            bandMap[name][b.time || 'day'] = b.condition || '--';
        });

        var html = '';
        Object.keys(bandMap).forEach(function (name) {
            var dayCondition = bandMap[name]['day'] || '--';
            var nightCondition = bandMap[name]['night'] || '--';
            html += '<tr>' +
                '<td class="band-name">' + escapeHtml(name) + '</td>' +
                '<td>' + conditionBadge(dayCondition) + '</td>' +
                '<td>' + conditionBadge(nightCondition) + '</td>' +
                '</tr>';
        });

        tbody.innerHTML = html || '<tr><td colspan="3" class="sw-empty">No band data</td></tr>';

        // Update additional info
        var sfiEl = document.getElementById('bandSfi');
        var aEl = document.getElementById('bandAindex');
        var snEl = document.getElementById('bandSn');
        if (sfiEl && bandData.sfi) sfiEl.textContent = bandData.sfi;
        if (aEl && bandData.aindex) aEl.textContent = bandData.aindex;
        if (snEl && bandData.sunspots) snEl.textContent = bandData.sunspots;
    }

    function conditionBadge(condition) {
        var cls = 'poor';
        var condLower = (condition || '').toLowerCase();
        if (condLower === 'good' || condLower === 'excellent') cls = 'good';
        else if (condLower === 'fair') cls = 'fair';
        return '<span class="band-cond ' + cls + '">' + escapeHtml(condition) + '</span>';
    }

    // =========================================================================
    // Flares
    // =========================================================================

    function renderFlares(flareData) {
        var container = document.getElementById('flareList');
        if (!container) return;

        if (!flareData || !Array.isArray(flareData) || flareData.length === 0) {
            container.innerHTML = '<li class="sw-empty">No recent flares</li>';
            return;
        }

        // Show last 10 flares in reverse chronological order
        var items = flareData.slice(-10).reverse();
        var html = '';

        items.forEach(function (flare) {
            if (typeof flare !== 'object') return;

            var classStr = flare.classtype || flare['class'] || flare.xray_class || '--';
            var classLetter = classStr.charAt(0).toUpperCase();
            var colorClass = 'class-' + classLetter.toLowerCase();
            var begin = flare.begin_time || flare.time_tag || flare.begin || '';
            var region = flare.active_region || flare.region || '';

            // Format time
            var timeStr = begin ? begin.substring(0, 16).replace('T', ' ') : '--';

            html += '<li class="flare-item">' +
                '<span class="flare-class ' + colorClass + '">' + escapeHtml(classStr) + '</span>' +
                '<span class="flare-region">' + (region ? 'AR ' + escapeHtml(String(region)) : '') + '</span>' +
                '<span class="flare-time">' + escapeHtml(timeStr) + '</span>' +
                '</li>';
        });

        container.innerHTML = html || '<li class="sw-empty">No recent flares</li>';
    }

    // =========================================================================
    // Alerts
    // =========================================================================

    function renderAlerts(alertData) {
        var container = document.getElementById('swAlerts');
        if (!container) return;

        if (!alertData || !Array.isArray(alertData) || alertData.length === 0) {
            container.innerHTML = '<div class="sw-empty">No active alerts</div>';
            return;
        }

        // Show recent alerts (limit to 8)
        var recent = alertData.slice(-8).reverse();
        var html = '';

        recent.forEach(function (alert) {
            if (typeof alert !== 'object') return;

            var product_id = (alert.product_id || '').toLowerCase();
            var alertClass = 'watch';
            if (product_id.indexOf('warning') >= 0 || product_id.indexOf('warn') >= 0) {
                alertClass = 'warning';
            }
            if (product_id.indexOf('alert') >= 0) {
                alertClass = 'alert';
            }

            var issueTime = alert.issue_datetime || alert.issue_time || '';
            var message = alert.message || '';
            // Truncate very long messages
            if (message.length > 300) {
                message = message.substring(0, 300) + '...';
            }

            html += '<div class="sw-alert-item ' + alertClass + '">' +
                '<div class="sw-alert-header">' +
                '<span class="sw-alert-type">' + escapeHtml(alert.product_id || 'NOTICE') + '</span>' +
                '<span class="sw-alert-time">' + escapeHtml(issueTime.substring(0, 19)) + '</span>' +
                '</div>' +
                '<div class="sw-alert-body">' + escapeHtml(message) + '</div>' +
                '</div>';
        });

        container.innerHTML = html || '<div class="sw-empty">No active alerts</div>';
    }

    // =========================================================================
    // Image Gallery
    // =========================================================================

    function renderImageGallery() {
        var container = document.getElementById('swImageGrid');
        if (!container) return;

        var html = '';
        GALLERY_IMAGES.forEach(function (img) {
            var src = IMAGE_URL + img.key + '?t=' + Date.now();
            html += '<div class="sw-image-card" onclick="SpaceWeather.openImage(\'' + img.key + '\')">' +
                '<img src="' + src + '" alt="' + escapeHtml(img.label) + '" loading="lazy" onerror="this.style.display=\'none\'">' +
                '<div class="sw-image-label">' + escapeHtml(img.label) + '</div>' +
                '</div>';
        });

        container.innerHTML = html;
    }

    function openImage(key) {
        var modal = document.getElementById('swImageModal');
        var modalImg = document.getElementById('swImageModalImg');
        if (!modal || !modalImg) return;

        modalImg.src = IMAGE_URL + key + '?t=' + Date.now();
        modal.classList.add('active');
    }

    function closeImageModal() {
        var modal = document.getElementById('swImageModal');
        if (modal) modal.classList.remove('active');
    }

    // =========================================================================
    // Stats Strip
    // =========================================================================

    function renderStripStats(data) {
        // Kp
        var stripKp = document.getElementById('stripKp');
        if (stripKp && data.kp_index && Array.isArray(data.kp_index) && data.kp_index.length > 1) {
            var latestKp = data.kp_index[data.kp_index.length - 1];
            var kpVal = Array.isArray(latestKp) ? parseFloat(latestKp[1] || 0) : parseFloat(latestKp.kp_index || 0);
            stripKp.textContent = kpVal.toFixed(1);
        }

        // Solar wind speed
        var stripWind = document.getElementById('stripWind');
        if (stripWind && data.solar_wind_plasma && Array.isArray(data.solar_wind_plasma) && data.solar_wind_plasma.length > 1) {
            var latestPlasma = data.solar_wind_plasma[data.solar_wind_plasma.length - 1];
            var speed = Array.isArray(latestPlasma) ? parseFloat(latestPlasma[2] || 0) : parseFloat(latestPlasma.speed || 0);
            stripWind.textContent = speed.toFixed(0);
        }

        // Flare count
        var stripFlares = document.getElementById('stripFlares');
        if (stripFlares && data.xray_flares) {
            stripFlares.textContent = Array.isArray(data.xray_flares) ? data.xray_flares.length : '0';
        }

        // Alert count
        var stripAlerts = document.getElementById('stripAlerts');
        if (stripAlerts && data.alerts) {
            stripAlerts.textContent = Array.isArray(data.alerts) ? data.alerts.length : '0';
        }
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function escapeHtml(text) {
        if (!text) return '';
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(String(text)));
        return div.innerHTML;
    }

    // =========================================================================
    // Public API
    // =========================================================================

    return {
        init: init,
        refresh: fetchData,
        openImage: openImage,
        closeImageModal: closeImageModal,
        stopAutoRefresh: stopAutoRefresh,
    };
})();

// Auto-initialize on DOM ready
document.addEventListener('DOMContentLoaded', function () {
    SpaceWeather.init();
});
