/**
 * BT Locate / IRK Tracker Module
 * Manages Bluetooth device proximity tracking sessions with IRK resolution,
 * RSSI-based distance estimation, Leaflet map visualization, and SSE streaming.
 *
 * IIFE pattern consistent with Valentine RF codebase conventions.
 */
var BtLocate = (function () {
    'use strict';

    // ========================================
    // State
    // ========================================
    let map = null;
    let observerMarker = null;
    let detectionMarkers = [];
    let trailPolyline = null;
    let eventSource = null;
    let isTracking = false;
    let sessionTimerInterval = null;
    let sessionStart = null;
    let statusPollInterval = null;
    let detectionCount = 0;
    let feedItems = [];
    let trailPoints = [];
    let lastDetection = null;

    // Path-loss exponents by environment
    const ENV_EXPONENTS = {
        indoor: 3.0,
        outdoor: 2.0,
        urban: 2.7,
        suburban: 2.5,
        rural: 2.2
    };

    // Reference RSSI at 1 meter (typical BLE beacon)
    const REF_RSSI_1M = -59;

    // ========================================
    // Initialization
    // ========================================
    function init() {
        initMap();
        initEnvironmentSelector();
        updateClock();
        setInterval(updateClock, 1000);
        checkExistingSession();
    }

    function initMap() {
        var observerLocation = (function () {
            if (window.ObserverLocation && ObserverLocation.getForModule) {
                return ObserverLocation.getForModule('btlocate_observerLocation');
            }
            return { lat: 51.5074, lon: -0.1278 };
        })();

        map = L.map('btlMap', {
            center: [observerLocation.lat, observerLocation.lon],
            zoom: 16,
            zoomControl: true
        });

        window.btlMap = map;

        // Apply tile layer via settings manager or fallback
        if (typeof Settings !== 'undefined') {
            Settings.init().then(function () {
                Settings.createTileLayer().addTo(map);
                Settings.registerMap(map);
            });
        } else {
            L.tileLayer('https://cartodb-basemaps-{s}.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
                maxZoom: 19,
                subdomains: 'abcd',
                className: 'tile-layer-cyan'
            }).addTo(map);
        }

        // Observer marker
        var obsIcon = L.divIcon({
            className: 'btl-observer-marker-wrap',
            html: '<div class="btl-observer-marker"></div>',
            iconSize: [12, 12],
            iconAnchor: [6, 6]
        });

        observerMarker = L.marker([observerLocation.lat, observerLocation.lon], { icon: obsIcon })
            .addTo(map)
            .bindPopup('<b>Observer Position</b>');

        // Try auto GPS
        autoConnectGps();
    }

    function initEnvironmentSelector() {
        var envSelect = document.getElementById('envSelect');
        var customGroup = document.getElementById('customExponentGroup');

        if (envSelect) {
            envSelect.addEventListener('change', function () {
                if (this.value === 'custom') {
                    customGroup.style.display = '';
                } else {
                    customGroup.style.display = 'none';
                }

                // If tracking, update environment on server
                if (isTracking) {
                    updateEnvironment();
                }
            });
        }
    }

    // ========================================
    // Tracking Session Lifecycle
    // ========================================
    function startTracking() {
        var macAddress = document.getElementById('macAddress').value.trim();
        var namePattern = document.getElementById('namePattern').value.trim();
        var irkHex = document.getElementById('irkHex').value.trim();
        var knownName = document.getElementById('knownName').value.trim();
        var envSelect = document.getElementById('envSelect');
        var environment = envSelect.value;

        // Require at least one targeting parameter
        if (!macAddress && !namePattern && !irkHex) {
            alert('Provide at least one target identifier: MAC address, name pattern, or IRK hex key.');
            return;
        }

        var payload = {
            environment: environment === 'custom' ? 'custom' : environment
        };

        if (macAddress) payload.mac_address = macAddress;
        if (namePattern) payload.name_pattern = namePattern;
        if (irkHex) payload.irk_hex = irkHex;
        if (knownName) payload.known_name = knownName;

        if (environment === 'custom') {
            var customExp = parseFloat(document.getElementById('customExponent').value);
            if (!isNaN(customExp)) {
                payload.custom_exponent = customExp;
            }
        }

        fetch('/bt_locate/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.status === 'started' || data.status === 'already_running' || data.status === 'success') {
                    isTracking = true;
                    onTrackingStarted();
                } else {
                    alert(data.message || data.error || 'Failed to start tracking session.');
                }
            })
            .catch(function (err) {
                alert('Error starting tracking: ' + err.message);
            });
    }

    function stopTracking() {
        fetch('/bt_locate/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        })
            .then(function (r) { return r.json(); })
            .then(function () {
                isTracking = false;
                onTrackingStopped();
            })
            .catch(function (err) {
                console.error('Error stopping tracking:', err);
            });
    }

    function onTrackingStarted() {
        // Update UI state
        document.getElementById('btnStart').style.display = 'none';
        document.getElementById('btnStop').style.display = '';
        document.getElementById('trackingDot').classList.add('active');
        document.getElementById('trackingStatus').textContent = 'TRACKING';
        document.getElementById('sessionIndicator').classList.add('active');

        var stateEl = document.getElementById('sessionState');
        stateEl.textContent = 'ACTIVE';
        stateEl.parentElement.classList.add('active');

        // Update target display
        var target = document.getElementById('macAddress').value.trim() ||
            document.getElementById('namePattern').value.trim() ||
            document.getElementById('irkHex').value.trim().substring(0, 12) + '...';
        document.getElementById('sessionTarget').textContent = target || '--';

        // Start timers and SSE
        startSessionTimer();
        connectSSE();
        startStatusPolling();
    }

    function onTrackingStopped() {
        // Update UI state
        document.getElementById('btnStart').style.display = '';
        document.getElementById('btnStop').style.display = 'none';
        document.getElementById('trackingDot').classList.remove('active');
        document.getElementById('trackingStatus').textContent = 'STANDBY';
        document.getElementById('sessionIndicator').classList.remove('active');

        var stateEl = document.getElementById('sessionState');
        stateEl.textContent = 'INACTIVE';
        stateEl.parentElement.classList.remove('active');

        // Stop timers and SSE
        stopSessionTimer();
        disconnectSSE();
        stopStatusPolling();
    }

    function checkExistingSession() {
        fetch('/bt_locate/status?debug=0')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.status === 'active' || data.active === true) {
                    isTracking = true;
                    onTrackingStarted();
                    // Load existing trail
                    loadTrail();
                }
            })
            .catch(function () {
                // No active session, that is fine
            });
    }

    // ========================================
    // SSE Stream
    // ========================================
    function connectSSE() {
        if (eventSource) {
            eventSource.close();
        }

        eventSource = new EventSource('/bt_locate/stream');

        eventSource.onmessage = function (e) {
            try {
                var data = JSON.parse(e.data);

                if (data.type === 'keepalive') return;

                handleDetectionEvent(data);
            } catch (err) {
                // Ignore parse errors from keepalive or malformed data
            }
        };

        eventSource.onerror = function () {
            // Auto-reconnect after delay if still tracking
            if (eventSource) {
                eventSource.close();
                eventSource = null;
            }
            if (isTracking) {
                setTimeout(function () {
                    if (isTracking) connectSSE();
                }, 3000);
            }
        };
    }

    function disconnectSSE() {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
    }

    // ========================================
    // Detection Event Handling
    // ========================================
    function handleDetectionEvent(data) {
        detectionCount++;
        lastDetection = data;

        var rssi = data.rssi || data.last_rssi || null;
        var address = data.address || data.mac_address || data.addr || '--';
        var timestamp = data.timestamp || new Date().toISOString();
        var lat = data.latitude || data.lat || null;
        var lon = data.longitude || data.lon || null;
        var estimatedDistance = data.estimated_distance || null;

        // Calculate distance from RSSI if not provided
        if (estimatedDistance === null && rssi !== null) {
            estimatedDistance = calculateDistance(rssi);
        }

        // Update stats
        document.getElementById('statDetections').textContent = detectionCount;
        if (rssi !== null) {
            document.getElementById('statRssi').textContent = rssi;
        }
        if (estimatedDistance !== null) {
            document.getElementById('statDistance').textContent = estimatedDistance.toFixed(1);
            document.getElementById('sessionDistance').textContent = estimatedDistance.toFixed(1) + 'm';
        }
        document.getElementById('sessionMatches').textContent = detectionCount;
        if (rssi !== null) {
            document.getElementById('sessionRssi').textContent = rssi + ' dBm';
        }

        // Add to feed
        addFeedItem(timestamp, rssi, estimatedDistance, address);

        // Add to map if we have coordinates
        if (lat !== null && lon !== null) {
            addDetectionMarker(lat, lon, rssi, estimatedDistance, timestamp, address);
            addTrailPoint(timestamp, rssi, estimatedDistance, address, lat, lon);
        } else {
            addTrailPoint(timestamp, rssi, estimatedDistance, address, null, null);
        }
    }

    // ========================================
    // Distance Calculation
    // ========================================
    function calculateDistance(rssi) {
        var envSelect = document.getElementById('envSelect');
        var environment = envSelect ? envSelect.value : 'urban';
        var n;

        if (environment === 'custom') {
            var customExp = parseFloat(document.getElementById('customExponent').value);
            n = isNaN(customExp) ? 2.7 : customExp;
        } else {
            n = ENV_EXPONENTS[environment] || 2.7;
        }

        // Log-distance path loss model:
        // distance = 10 ^ ((refRSSI - measuredRSSI) / (10 * n))
        var distance = Math.pow(10, (REF_RSSI_1M - rssi) / (10 * n));
        return Math.max(0.1, distance);
    }

    // ========================================
    // Feed Management
    // ========================================
    function addFeedItem(timestamp, rssi, distance, address) {
        var container = document.getElementById('detectionFeed');
        var countEl = document.getElementById('feedCount');

        // Remove empty state on first item
        if (feedItems.length === 0) {
            container.innerHTML = '';
        }

        var time = formatTime(timestamp);
        var rssiClass = getRssiClass(rssi);
        var distText = distance !== null ? distance.toFixed(1) + 'm' : '--';

        var item = document.createElement('div');
        item.className = 'btl-feed-item';
        item.innerHTML =
            '<span class="btl-feed-time">' + time + '</span>' +
            '<div class="btl-feed-detail">' +
            '<span class="btl-feed-rssi ' + rssiClass + '">' + (rssi !== null ? rssi + ' dBm' : '--') + '</span>' +
            '<span class="btl-feed-addr">' + escapeHtml(address) + '</span>' +
            '</div>' +
            '<span class="btl-feed-distance">' + distText + '</span>';

        // Insert at top
        container.insertBefore(item, container.firstChild);
        feedItems.unshift({ timestamp: timestamp, rssi: rssi, distance: distance, address: address });

        // Limit feed to 200 items
        while (feedItems.length > 200 && container.children.length > 200) {
            container.removeChild(container.lastChild);
            feedItems.pop();
        }

        countEl.textContent = feedItems.length + ' events';
    }

    // ========================================
    // Trail Management
    // ========================================
    function addTrailPoint(timestamp, rssi, distance, address, lat, lon) {
        var tbody = document.getElementById('trailTableBody');
        var countEl = document.getElementById('trailCount');

        // Remove empty state on first point
        if (trailPoints.length === 0) {
            tbody.innerHTML = '';
        }

        var point = {
            timestamp: timestamp,
            rssi: rssi,
            distance: distance,
            address: address,
            lat: lat,
            lon: lon
        };

        trailPoints.unshift(point);

        var time = formatTime(timestamp);
        var rssiClass = getRssiClass(rssi);
        var distText = distance !== null ? distance.toFixed(1) + 'm' : '--';
        var coordsText = (lat !== null && lon !== null) ? lat.toFixed(5) + ', ' + lon.toFixed(5) : '--';

        var row = document.createElement('tr');
        row.innerHTML =
            '<td>' + time + '</td>' +
            '<td class="btl-trail-rssi ' + rssiClass + '">' + (rssi !== null ? rssi + ' dBm' : '--') + '</td>' +
            '<td class="btl-trail-distance">' + distText + '</td>' +
            '<td>' + escapeHtml(address) + '</td>' +
            '<td class="btl-trail-coords">' + coordsText + '</td>';

        // Insert at top
        tbody.insertBefore(row, tbody.firstChild);

        // Limit trail to 500 rows
        while (trailPoints.length > 500 && tbody.children.length > 500) {
            tbody.removeChild(tbody.lastChild);
            trailPoints.pop();
        }

        countEl.textContent = trailPoints.length + ' points';
    }

    function loadTrail() {
        fetch('/bt_locate/trail')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var trail = data.trail || data.detection_trail || [];

                trail.forEach(function (point) {
                    var rssi = point.rssi || null;
                    var distance = point.estimated_distance || (rssi !== null ? calculateDistance(rssi) : null);
                    var address = point.address || point.mac_address || '--';
                    var lat = point.latitude || point.lat || null;
                    var lon = point.longitude || point.lon || null;

                    addTrailPoint(point.timestamp, rssi, distance, address, lat, lon);

                    if (lat !== null && lon !== null) {
                        addDetectionMarker(lat, lon, rssi, distance, point.timestamp, address);
                    }
                });
            })
            .catch(function (err) {
                console.error('Failed to load trail:', err);
            });
    }

    // ========================================
    // Map Markers
    // ========================================
    function addDetectionMarker(lat, lon, rssi, distance, timestamp, address) {
        // Size marker based on RSSI strength (stronger = larger)
        var radius = 6;
        if (rssi !== null) {
            // Map RSSI from -100..-30 to radius 4..16
            radius = Math.max(4, Math.min(16, Math.round(((rssi + 100) / 70) * 12 + 4)));
        }

        // Remove 'latest' class from previous markers
        detectionMarkers.forEach(function (m) {
            var el = m.getElement();
            if (el) {
                var inner = el.querySelector('.btl-detection-marker');
                if (inner) inner.classList.remove('latest');
            }
        });

        var icon = L.divIcon({
            className: 'btl-detection-marker-wrap',
            html: '<div class="btl-detection-marker latest" style="width:' + radius * 2 + 'px;height:' + radius * 2 + 'px;"></div>',
            iconSize: [radius * 2, radius * 2],
            iconAnchor: [radius, radius]
        });

        var marker = L.marker([lat, lon], { icon: icon }).addTo(map);

        var distText = distance !== null ? distance.toFixed(1) + 'm' : '--';
        var time = formatTime(timestamp);

        marker.bindPopup(
            '<div class="popup-title">Detection Point</div>' +
            '<div class="popup-row"><span class="popup-label">Time</span><span class="popup-value">' + time + '</span></div>' +
            '<div class="popup-row"><span class="popup-label">RSSI</span><span class="popup-value">' + (rssi !== null ? rssi + ' dBm' : '--') + '</span></div>' +
            '<div class="popup-row"><span class="popup-label">Distance</span><span class="popup-value">' + distText + '</span></div>' +
            '<div class="popup-row"><span class="popup-label">Address</span><span class="popup-value">' + escapeHtml(address) + '</span></div>'
        );

        detectionMarkers.push(marker);

        // Update trail polyline
        updateTrailPolyline();

        // Keep a max of 500 markers on map
        while (detectionMarkers.length > 500) {
            var old = detectionMarkers.shift();
            map.removeLayer(old);
        }
    }

    function updateTrailPolyline() {
        var coords = detectionMarkers.map(function (m) {
            return m.getLatLng();
        });

        if (coords.length < 2) return;

        if (trailPolyline) {
            trailPolyline.setLatLngs(coords);
        } else {
            trailPolyline = L.polyline(coords, {
                color: '#a78bfa',
                weight: 2,
                opacity: 0.5,
                dashArray: '6 4'
            }).addTo(map);
        }
    }

    function centerMap() {
        if (detectionMarkers.length > 0) {
            var last = detectionMarkers[detectionMarkers.length - 1];
            map.setView(last.getLatLng(), map.getZoom());
        } else if (observerMarker) {
            map.setView(observerMarker.getLatLng(), map.getZoom());
        }
    }

    // ========================================
    // Clear Trail
    // ========================================
    function clearTrail() {
        if (!confirm('Clear all detection trail data?')) return;

        fetch('/bt_locate/clear_trail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        })
            .then(function (r) { return r.json(); })
            .then(function () {
                // Clear local state
                detectionMarkers.forEach(function (m) { map.removeLayer(m); });
                detectionMarkers = [];

                if (trailPolyline) {
                    map.removeLayer(trailPolyline);
                    trailPolyline = null;
                }

                trailPoints = [];
                feedItems = [];
                detectionCount = 0;

                // Reset UI
                document.getElementById('detectionFeed').innerHTML =
                    '<div class="btl-empty-state">' +
                    '<div>No detections yet</div>' +
                    '<div class="btl-empty-hint">Start a tracking session to see live events</div>' +
                    '</div>';
                document.getElementById('feedCount').textContent = '0 events';

                document.getElementById('trailTableBody').innerHTML =
                    '<tr class="btl-trail-empty"><td colspan="5">No trail data available</td></tr>';
                document.getElementById('trailCount').textContent = '0 points';

                document.getElementById('statDetections').textContent = '0';
                document.getElementById('statDistance').textContent = '--';
                document.getElementById('statRssi').textContent = '--';
                document.getElementById('sessionMatches').textContent = '0';
                document.getElementById('sessionDistance').textContent = '--';
                document.getElementById('sessionRssi').textContent = '--';
            })
            .catch(function (err) {
                console.error('Failed to clear trail:', err);
            });
    }

    // ========================================
    // Environment Update
    // ========================================
    function updateEnvironment() {
        var envSelect = document.getElementById('envSelect');
        var environment = envSelect.value;
        var payload = { environment: environment };

        if (environment === 'custom') {
            var customExp = parseFloat(document.getElementById('customExponent').value);
            if (!isNaN(customExp)) {
                payload.custom_exponent = customExp;
            }
        }

        fetch('/bt_locate/environment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                console.log('Environment updated:', data);
            })
            .catch(function (err) {
                console.error('Failed to update environment:', err);
            });
    }

    // ========================================
    // IRK Tools
    // ========================================
    function testResolveRpa() {
        var irkHex = document.getElementById('testIrk').value.trim();
        var rpaAddress = document.getElementById('testRpa').value.trim();
        var resultEl = document.getElementById('resolveResult');

        if (!irkHex || !rpaAddress) {
            alert('Provide both IRK hex key and RPA address to test resolution.');
            return;
        }

        resultEl.style.display = '';
        resultEl.className = 'btl-resolve-result';
        resultEl.textContent = 'Resolving...';

        fetch('/bt_locate/resolve_rpa', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                irk_hex: irkHex,
                address: rpaAddress
            })
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.match || data.resolved) {
                    resultEl.className = 'btl-resolve-result success';
                    resultEl.textContent = 'MATCH: Address resolves with this IRK';
                } else {
                    resultEl.className = 'btl-resolve-result failure';
                    resultEl.textContent = 'NO MATCH: Address does not resolve with this IRK';
                }

                if (data.message) {
                    resultEl.textContent += ' - ' + data.message;
                }
            })
            .catch(function (err) {
                resultEl.className = 'btl-resolve-result failure';
                resultEl.textContent = 'Error: ' + err.message;
            });
    }

    function loadPairedIrks() {
        var listEl = document.getElementById('pairedIrkList');
        listEl.innerHTML = '<div class="btl-empty-state">Loading...</div>';

        fetch('/bt_locate/paired_irks')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var devices = data.devices || data.paired_devices || [];

                if (devices.length === 0) {
                    listEl.innerHTML = '<div class="btl-empty-state">No paired devices with IRKs found</div>';
                    return;
                }

                listEl.innerHTML = devices.map(function (dev) {
                    var name = dev.name || dev.alias || 'Unknown Device';
                    var address = dev.address || dev.mac || '--';
                    var irk = dev.irk || dev.irk_hex || '--';

                    return '<div class="btl-paired-item" onclick="BtLocate.useDeviceIrk(\'' +
                        escapeHtml(irk) + '\', \'' + escapeHtml(name) + '\')" title="Click to use this IRK for tracking">' +
                        '<div class="btl-paired-name">' + escapeHtml(name) + '</div>' +
                        '<div class="btl-paired-meta">ADDR: ' + escapeHtml(address) + '</div>' +
                        '<div class="btl-paired-meta">IRK: ' + escapeHtml(irk.substring(0, 20)) + (irk.length > 20 ? '...' : '') + '</div>' +
                        '</div>';
                }).join('');
            })
            .catch(function (err) {
                listEl.innerHTML = '<div class="btl-empty-state">Error loading: ' + escapeHtml(err.message) + '</div>';
            });
    }

    function useDeviceIrk(irk, name) {
        if (irk && irk !== '--') {
            document.getElementById('irkHex').value = irk;
        }
        if (name && name !== 'Unknown Device') {
            document.getElementById('knownName').value = name;
        }
    }

    // ========================================
    // Status Polling
    // ========================================
    function startStatusPolling() {
        stopStatusPolling();
        statusPollInterval = setInterval(function () {
            if (!isTracking) return;

            fetch('/bt_locate/status?debug=0')
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (data.status === 'inactive' || data.active === false) {
                        // Session ended externally
                        isTracking = false;
                        onTrackingStopped();
                    }
                })
                .catch(function () { });
        }, 10000);
    }

    function stopStatusPolling() {
        if (statusPollInterval) {
            clearInterval(statusPollInterval);
            statusPollInterval = null;
        }
    }

    // ========================================
    // Session Timer
    // ========================================
    function startSessionTimer() {
        sessionStart = Date.now();
        stopSessionTimer();
        sessionTimerInterval = setInterval(updateSessionTimerDisplay, 1000);
    }

    function stopSessionTimer() {
        if (sessionTimerInterval) {
            clearInterval(sessionTimerInterval);
            sessionTimerInterval = null;
        }
    }

    function updateSessionTimerDisplay() {
        if (!sessionStart) return;

        var elapsed = Date.now() - sessionStart;
        var hours = Math.floor(elapsed / 3600000);
        var mins = Math.floor((elapsed % 3600000) / 60000);
        var secs = Math.floor((elapsed % 60000) / 1000);

        var timerEl = document.getElementById('sessionTimer');
        if (timerEl) {
            timerEl.textContent =
                pad2(hours) + ':' + pad2(mins) + ':' + pad2(secs);
        }
    }

    // ========================================
    // GPS Auto-Connect
    // ========================================
    function autoConnectGps() {
        fetch('/gps/auto-connect', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.status === 'connected' && data.position) {
                    updateObserverPosition(data.position.latitude, data.position.longitude);
                    startGpsStream();
                }
            })
            .catch(function () {
                // GPS not available, use default position
            });
    }

    function startGpsStream() {
        var gpsSource = new EventSource('/gps/stream');
        gpsSource.onmessage = function (event) {
            try {
                var data = JSON.parse(event.data);
                if (data.type === 'position' && data.latitude && data.longitude) {
                    updateObserverPosition(data.latitude, data.longitude);
                }
            } catch (e) { }
        };
        gpsSource.onerror = function () {
            gpsSource.close();
            // Attempt reconnect after 10s
            setTimeout(autoConnectGps, 10000);
        };
    }

    function updateObserverPosition(lat, lon) {
        if (observerMarker) {
            observerMarker.setLatLng([lat, lon]);
        }
        if (window.ObserverLocation) {
            ObserverLocation.setForModule('btlocate_observerLocation', { lat: lat, lon: lon });
        }
    }

    // ========================================
    // Utility Functions
    // ========================================
    function updateClock() {
        var now = new Date();
        var utc = now.toISOString().slice(11, 19);
        var el = document.getElementById('utcTime');
        if (el) el.textContent = utc + ' UTC';
    }

    function formatTime(isoString) {
        try {
            var d = new Date(isoString);
            if (isNaN(d.getTime())) return isoString;
            return d.toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } catch (e) {
            return isoString || '--:--:--';
        }
    }

    function getRssiClass(rssi) {
        if (rssi === null || rssi === undefined) return '';
        if (rssi > -60) return 'strong';
        if (rssi > -80) return 'moderate';
        return 'weak';
    }

    function pad2(n) {
        return n < 10 ? '0' + n : '' + n;
    }

    function escapeHtml(str) {
        if (!str) return '';
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    // ========================================
    // Init on DOM Ready
    // ========================================
    document.addEventListener('DOMContentLoaded', init);

    // ========================================
    // Public API
    // ========================================
    return {
        startTracking: startTracking,
        stopTracking: stopTracking,
        testResolveRpa: testResolveRpa,
        loadPairedIrks: loadPairedIrks,
        useDeviceIrk: useDeviceIrk,
        clearTrail: clearTrail,
        centerMap: centerMap,
        updateEnvironment: updateEnvironment
    };

})();
