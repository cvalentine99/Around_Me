/**
 * Geospatial Map Module
 * Full-screen Leaflet map aggregating all Valentine RF signal layers.
 * Connects to real backend SSE streams and REST endpoints.
 *
 * IIFE pattern - exposes window.Geospatial
 */
const Geospatial = (function () {
    'use strict';

    // ========================================================================
    // STATE
    // ========================================================================

    let map = null;
    let observerMarker = null;
    let observerLocation = null; // {lat, lon}

    // Layer groups
    const layers = {
        aircraft: null,
        vessels: null,
        mesh: null,
        satellites: null,
        receivers: null,
        trilaterated: null,
        btTrail: null,
    };

    // Data stores keyed by unique ID
    const data = {
        aircraft: {},   // icao -> {marker, data, lastSeen}
        vessels: {},     // mmsi -> {marker, data, lastSeen}
        mesh: {},        // nodeId -> {marker, data}
        satellites: [],  // [{polyline, marker, data}]
        receivers: [],   // [{marker, data}]
        trilaterated: {}, // deviceId -> {marker, circle, data}
        btTrail: { markers: [], polyline: null }, // breadcrumb trail
    };

    // SSE connections
    let adsbEventSource = null;
    let aisEventSource = null;
    let meshEventSource = null;

    // Refresh timers
    let staticRefreshTimer = null;
    const STATIC_REFRESH_INTERVAL = 60000; // 60 seconds

    // Stale data cleanup interval (aircraft/vessels disappear after 5 min)
    const STALE_TIMEOUT = 300000; // 5 minutes
    let cleanupTimer = null;

    // ========================================================================
    // ICONS (SVG divIcon factories)
    // ========================================================================

    /**
     * Get altitude-based color for aircraft.
     * Low (ground) = green, medium = cyan/blue, high = purple/red
     */
    function altitudeColor(altFt) {
        if (altFt == null || altFt <= 0) return '#6ee7b7';    // ground - green
        if (altFt < 5000) return '#34d399';                    // low - emerald
        if (altFt < 15000) return '#60a5fa';                   // medium-low - blue
        if (altFt < 25000) return '#818cf8';                   // medium - indigo
        if (altFt < 35000) return '#a78bfa';                   // medium-high - violet
        if (altFt < 45000) return '#f472b6';                   // high - pink
        return '#f87171';                                       // very high - red
    }

    function aircraftIcon(heading, altitude) {
        const color = altitudeColor(altitude);
        const rotation = (heading != null && !isNaN(heading)) ? heading : 0;
        return L.divIcon({
            className: 'geo-marker-aircraft',
            html: '<svg viewBox="0 0 24 24" fill="' + color + '" stroke="' + color + '" stroke-width="0.5" ' +
                  'style="transform: rotate(' + rotation + 'deg);">' +
                  '<path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>' +
                  '</svg>',
            iconSize: [24, 24],
            iconAnchor: [12, 12],
            popupAnchor: [0, -14],
        });
    }

    function vesselIcon(course) {
        const rotation = (course != null && !isNaN(course)) ? course : 0;
        return L.divIcon({
            className: 'geo-marker-vessel',
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
                  'style="transform: rotate(' + rotation + 'deg);">' +
                  '<path d="M3 18l2 2h14l2-2"/>' +
                  '<path d="M5 18v-4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"/>' +
                  '<path d="M12 12V6"/><path d="M12 6l4 3"/>' +
                  '</svg>',
            iconSize: [22, 22],
            iconAnchor: [11, 11],
            popupAnchor: [0, -13],
        });
    }

    function meshNodeIcon(name) {
        const labelHtml = name
            ? '<span class="geo-marker-mesh-label">' + _esc(name) + '</span>'
            : '';
        return L.divIcon({
            className: 'geo-marker-mesh',
            html: labelHtml +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                  '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>' +
                  '<path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>' +
                  '</svg>',
            iconSize: [22, 22],
            iconAnchor: [11, 11],
            popupAnchor: [0, -13],
        });
    }

    function satelliteIcon() {
        return L.divIcon({
            className: 'geo-marker-satellite',
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                  '<path d="M13 7L9 3 5 7l4 4"/>' +
                  '<path d="m17 11 4 4-4 4-4-4"/>' +
                  '<path d="m8 12 4 4 6-6-4-4-6 6"/>' +
                  '<path d="m16 8 3-3"/>' +
                  '<path d="M9 21a6 6 0 0 0-6-6"/>' +
                  '</svg>',
            iconSize: [20, 20],
            iconAnchor: [10, 10],
            popupAnchor: [0, -12],
        });
    }

    function receiverIcon() {
        return L.divIcon({
            className: 'geo-marker-receiver',
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                  '<circle cx="12" cy="12" r="2"/>' +
                  '<path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49"/>' +
                  '<path d="M19.07 4.93a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/>' +
                  '</svg>',
            iconSize: [20, 20],
            iconAnchor: [10, 10],
            popupAnchor: [0, -12],
        });
    }

    function trilateratedIcon() {
        return L.divIcon({
            className: 'geo-marker-trilaterated',
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                  '<circle cx="12" cy="12" r="10"/>' +
                  '<line x1="4" y1="12" x2="20" y2="12"/>' +
                  '<line x1="12" y1="4" x2="12" y2="20"/>' +
                  '</svg>',
            iconSize: [24, 24],
            iconAnchor: [12, 12],
            popupAnchor: [0, -14],
        });
    }

    function btTrailIcon() {
        return L.divIcon({
            className: 'geo-marker-bt-trail',
            html: '<svg viewBox="0 0 24 24" fill="#fb923c" stroke="#fb923c" stroke-width="1">' +
                  '<circle cx="12" cy="12" r="5"/>' +
                  '</svg>',
            iconSize: [12, 12],
            iconAnchor: [6, 6],
            popupAnchor: [0, -8],
        });
    }

    function observerIcon() {
        return L.divIcon({
            className: 'geo-marker-observer',
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="#c084fc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                  '<circle cx="12" cy="12" r="6" fill="rgba(192,132,252,0.25)"/>' +
                  '<circle cx="12" cy="12" r="2" fill="#c084fc"/>' +
                  '<line x1="12" y1="2" x2="12" y2="6"/>' +
                  '<line x1="12" y1="18" x2="12" y2="22"/>' +
                  '<line x1="2" y1="12" x2="6" y2="12"/>' +
                  '<line x1="18" y1="12" x2="22" y2="12"/>' +
                  '</svg>',
            iconSize: [28, 28],
            iconAnchor: [14, 14],
            popupAnchor: [0, -16],
        });
    }

    // ========================================================================
    // UTILITY
    // ========================================================================

    /** HTML-escape a string */
    function _esc(s) {
        if (s == null) return '';
        var d = document.createElement('div');
        d.textContent = String(s);
        return d.innerHTML;
    }

    /** Format a coordinate pair */
    function _fmtCoord(lat, lon) {
        if (lat == null || lon == null) return '--';
        return parseFloat(lat).toFixed(4) + ', ' + parseFloat(lon).toFixed(4);
    }

    /** Update a DOM element's text */
    function _setText(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    // ========================================================================
    // INITIALIZATION
    // ========================================================================

    function init() {
        // Resolve observer location
        if (typeof ObserverLocation !== 'undefined') {
            var loc = ObserverLocation.get();
            if (loc) observerLocation = loc;
        }
        if (!observerLocation) {
            observerLocation = {
                lat: window.VALENTINE_DEFAULT_LAT || 51.5074,
                lon: window.VALENTINE_DEFAULT_LON || -0.1278,
            };
        }

        _initMap();
        _initLayerGroups();
        _placeObserver();
        _connectSSE();
        _fetchStaticLayers();
        _startStaticRefresh();
        _startCleanup();
        _startClock();

        _setText('geoStatusText', 'LIVE');
        var dot = document.getElementById('geoStatusDot');
        if (dot) dot.classList.add('online');

        _updateObserverDisplay();
    }

    function _initMap() {
        map = L.map('geoMap', {
            center: [observerLocation.lat, observerLocation.lon],
            zoom: 8,
            zoomControl: true,
            attributionControl: true,
        });

        // Dark tile layer (CartoDB dark matter)
        L.tileLayer('https://cartodb-basemaps-{s}.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 19,
        }).addTo(map);
    }

    function _initLayerGroups() {
        layers.aircraft = L.layerGroup().addTo(map);
        layers.vessels = L.layerGroup().addTo(map);
        layers.mesh = L.layerGroup().addTo(map);
        layers.satellites = L.layerGroup().addTo(map);
        layers.receivers = L.layerGroup().addTo(map);
        layers.trilaterated = L.layerGroup().addTo(map);
        layers.btTrail = L.layerGroup().addTo(map);
    }

    function _placeObserver() {
        if (!observerLocation) return;
        observerMarker = L.marker(
            [observerLocation.lat, observerLocation.lon],
            { icon: observerIcon(), zIndexOffset: 2000 }
        ).addTo(map);
        observerMarker.bindPopup(
            '<div class="geo-popup-title">OBSERVER LOCATION</div>' +
            '<div class="geo-popup-row">' +
            '<span class="geo-popup-label">Position</span>' +
            '<span class="geo-popup-value">' + _fmtCoord(observerLocation.lat, observerLocation.lon) + '</span>' +
            '</div>'
        );
    }

    function _updateObserverDisplay() {
        if (observerLocation) {
            _setText('geoObserverCoords', _fmtCoord(observerLocation.lat, observerLocation.lon));
        }
    }

    // ========================================================================
    // SSE STREAMS (Real-time: ADS-B, AIS, Meshtastic)
    // ========================================================================

    function _connectSSE() {
        _connectADSB();
        _connectAIS();
        _connectMeshtastic();
    }

    // --- ADS-B Aircraft SSE ---
    function _connectADSB() {
        if (adsbEventSource) {
            adsbEventSource.close();
        }
        adsbEventSource = new EventSource('/adsb/stream');

        adsbEventSource.onmessage = function (event) {
            try {
                var d = JSON.parse(event.data);
                if (d.type === 'aircraft' || d.icao) {
                    _processAircraft(d);
                }
            } catch (e) { /* skip keepalive/malformed */ }
        };

        adsbEventSource.onerror = function () {
            // Reconnect after 5 seconds
            setTimeout(function () {
                if (adsbEventSource) adsbEventSource.close();
                _connectADSB();
            }, 5000);
        };
    }

    function _processAircraft(d) {
        var icao = d.icao;
        if (!icao) return;
        var lat = d.lat;
        var lon = d.lon;

        if (lat == null || lon == null) {
            // Position-less update - just update data store
            if (data.aircraft[icao]) {
                Object.assign(data.aircraft[icao].data, d);
                data.aircraft[icao].lastSeen = Date.now();
            }
            return;
        }

        var existing = data.aircraft[icao];
        if (existing) {
            // Update existing marker
            existing.marker.setLatLng([lat, lon]);
            existing.marker.setIcon(aircraftIcon(d.heading, d.altitude));
            existing.marker.setPopupContent(_aircraftPopup(d));
            Object.assign(existing.data, d);
            existing.lastSeen = Date.now();
        } else {
            // New aircraft
            var marker = L.marker([lat, lon], {
                icon: aircraftIcon(d.heading, d.altitude),
                zIndexOffset: 500,
            });
            marker.bindPopup(_aircraftPopup(d));
            layers.aircraft.addLayer(marker);
            data.aircraft[icao] = { marker: marker, data: d, lastSeen: Date.now() };
        }
        _updateCounts();
    }

    function _aircraftPopup(d) {
        var callsign = d.callsign || d.flight || d.icao;
        var lines = [
            '<div class="geo-popup-title">' + _esc(callsign) + '</div>',
        ];
        if (d.icao) lines.push(_popupRow('ICAO', d.icao.toUpperCase()));
        if (d.callsign || d.flight) lines.push(_popupRow('Callsign', d.callsign || d.flight));
        if (d.registration) lines.push(_popupRow('Reg', d.registration));
        if (d.type_code) lines.push(_popupRow('Type', d.type_code + (d.type_desc ? ' ' + d.type_desc : '')));
        if (d.altitude != null) lines.push(_popupRow('Altitude', d.altitude.toLocaleString() + ' ft'));
        if (d.speed != null) lines.push(_popupRow('Speed', d.speed + ' kt'));
        if (d.heading != null) lines.push(_popupRow('Heading', d.heading + '\u00b0'));
        if (d.vertical_rate != null) lines.push(_popupRow('V/S', d.vertical_rate + ' ft/min'));
        if (d.squawk) lines.push(_popupRow('Squawk', d.squawk));
        lines.push('<div class="geo-popup-divider"></div>');
        lines.push(_popupRow('Position', _fmtCoord(d.lat, d.lon)));
        return lines.join('');
    }

    // --- AIS Vessel SSE ---
    function _connectAIS() {
        if (aisEventSource) {
            aisEventSource.close();
        }
        aisEventSource = new EventSource('/ais/stream');

        aisEventSource.onmessage = function (event) {
            try {
                var d = JSON.parse(event.data);
                if (d.type === 'vessel' || d.mmsi) {
                    _processVessel(d);
                }
            } catch (e) { /* skip keepalive/malformed */ }
        };

        aisEventSource.onerror = function () {
            setTimeout(function () {
                if (aisEventSource) aisEventSource.close();
                _connectAIS();
            }, 5000);
        };
    }

    function _processVessel(d) {
        var mmsi = d.mmsi;
        if (!mmsi) return;
        var lat = d.lat;
        var lon = d.lon;

        if (lat == null || lon == null) {
            if (data.vessels[mmsi]) {
                Object.assign(data.vessels[mmsi].data, d);
                data.vessels[mmsi].lastSeen = Date.now();
            }
            return;
        }

        var existing = data.vessels[mmsi];
        if (existing) {
            existing.marker.setLatLng([lat, lon]);
            existing.marker.setIcon(vesselIcon(d.course));
            existing.marker.setPopupContent(_vesselPopup(d));
            Object.assign(existing.data, d);
            existing.lastSeen = Date.now();
        } else {
            var marker = L.marker([lat, lon], {
                icon: vesselIcon(d.course),
                zIndexOffset: 400,
            });
            marker.bindPopup(_vesselPopup(d));
            layers.vessels.addLayer(marker);
            data.vessels[mmsi] = { marker: marker, data: d, lastSeen: Date.now() };
        }
        _updateCounts();
    }

    function _vesselPopup(d) {
        var name = d.name || d.mmsi;
        var lines = [
            '<div class="geo-popup-title">' + _esc(name) + '</div>',
        ];
        if (d.mmsi) lines.push(_popupRow('MMSI', d.mmsi));
        if (d.name) lines.push(_popupRow('Name', d.name));
        if (d.ship_type_text) lines.push(_popupRow('Type', d.ship_type_text));
        else if (d.ship_type != null) lines.push(_popupRow('Type ID', d.ship_type));
        if (d.speed != null) lines.push(_popupRow('Speed', d.speed + ' kt'));
        if (d.course != null) lines.push(_popupRow('Course', d.course + '\u00b0'));
        if (d.heading != null) lines.push(_popupRow('Heading', d.heading + '\u00b0'));
        if (d.destination) lines.push(_popupRow('Dest', d.destination));
        lines.push('<div class="geo-popup-divider"></div>');
        lines.push(_popupRow('Position', _fmtCoord(d.lat, d.lon)));
        return lines.join('');
    }

    // --- Meshtastic Node SSE ---
    function _connectMeshtastic() {
        if (meshEventSource) {
            meshEventSource.close();
        }
        meshEventSource = new EventSource('/meshtastic/stream');

        meshEventSource.onmessage = function (event) {
            try {
                var d = JSON.parse(event.data);
                // Meshtastic SSE pushes messages; we also need to poll /meshtastic/nodes for positions
                // Messages with position_latitude/position_longitude indicate POSITION_APP updates
                if (d.type === 'meshtastic' && d.portnum === 'POSITION_APP') {
                    _processMeshPosition(d);
                }
            } catch (e) { /* skip keepalive */ }
        };

        meshEventSource.onerror = function () {
            setTimeout(function () {
                if (meshEventSource) meshEventSource.close();
                _connectMeshtastic();
            }, 5000);
        };

        // Also fetch all known nodes immediately and periodically
        _fetchMeshNodes();
    }

    function _processMeshPosition(d) {
        // Position messages contain raw_packet or direct fields
        // For SSE, we primarily rely on polling /meshtastic/nodes
        // This handler catches live position updates from the stream
        _fetchMeshNodes();
    }

    function _fetchMeshNodes() {
        fetch('/meshtastic/nodes?with_position=true')
            .then(function (r) { return r.json(); })
            .then(function (resp) {
                if (resp.status !== 'ok' && resp.status !== 'success') return;
                var nodes = resp.nodes || [];
                _updateMeshLayer(nodes);
            })
            .catch(function () { /* silent - node polling may fail when no device connected */ });
    }

    function _updateMeshLayer(nodes) {
        // Track seen IDs to remove stale
        var seenIds = {};

        nodes.forEach(function (node) {
            var lat = node.latitude;
            var lon = node.longitude;
            if (lat == null || lon == null) return;
            // Skip (0,0) positions
            if (lat === 0 && lon === 0) return;

            var nodeId = node.id || node.user_id || String(node.num);
            seenIds[nodeId] = true;
            var name = node.long_name || node.short_name || nodeId;

            var existing = data.mesh[nodeId];
            if (existing) {
                existing.marker.setLatLng([lat, lon]);
                existing.marker.setIcon(meshNodeIcon(name));
                existing.marker.setPopupContent(_meshPopup(node));
                existing.data = node;
            } else {
                var marker = L.marker([lat, lon], {
                    icon: meshNodeIcon(name),
                    zIndexOffset: 300,
                });
                marker.bindPopup(_meshPopup(node));
                layers.mesh.addLayer(marker);
                data.mesh[nodeId] = { marker: marker, data: node };
            }
        });

        // Remove nodes no longer present
        Object.keys(data.mesh).forEach(function (id) {
            if (!seenIds[id]) {
                layers.mesh.removeLayer(data.mesh[id].marker);
                delete data.mesh[id];
            }
        });
        _updateCounts();
    }

    function _meshPopup(node) {
        var name = node.long_name || node.short_name || node.id || String(node.num);
        var lines = [
            '<div class="geo-popup-title">' + _esc(name) + '</div>',
        ];
        if (node.id || node.user_id) lines.push(_popupRow('ID', node.id || node.user_id));
        if (node.short_name) lines.push(_popupRow('Short', node.short_name));
        if (node.hw_model) lines.push(_popupRow('Hardware', node.hw_model));
        if (node.battery_level != null) lines.push(_popupRow('Battery', node.battery_level + '%'));
        if (node.voltage != null) lines.push(_popupRow('Voltage', node.voltage.toFixed(2) + 'V'));
        if (node.snr != null) lines.push(_popupRow('SNR', node.snr.toFixed(1) + ' dB'));
        if (node.altitude != null) lines.push(_popupRow('Altitude', node.altitude + ' m'));
        if (node.temperature != null) lines.push(_popupRow('Temp', node.temperature.toFixed(1) + '\u00b0C'));
        if (node.humidity != null) lines.push(_popupRow('Humidity', node.humidity.toFixed(1) + '%'));
        lines.push('<div class="geo-popup-divider"></div>');
        lines.push(_popupRow('Position', _fmtCoord(node.latitude, node.longitude)));
        if (node.last_heard) lines.push(_popupRow('Last Heard', new Date(node.last_heard).toLocaleTimeString()));
        return lines.join('');
    }

    // ========================================================================
    // STATIC / POLLED LAYERS
    // ========================================================================

    function _fetchStaticLayers() {
        _fetchSatellites();
        _fetchReceivers();
        _fetchTrilaterated();
        _fetchBtTrail();
        _fetchMeshNodes();
    }

    function _startStaticRefresh() {
        staticRefreshTimer = setInterval(function () {
            _fetchStaticLayers();
        }, STATIC_REFRESH_INTERVAL);
    }

    // --- Satellite Passes ---
    function _fetchSatellites() {
        if (!observerLocation) return;

        fetch('/satellite/predict', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                latitude: observerLocation.lat,
                longitude: observerLocation.lon,
                hours: 2,
                minEl: 5,
            }),
        })
            .then(function (r) { return r.json(); })
            .then(function (resp) {
                if (resp.status !== 'success' && resp.status !== 'ok') return;
                var passes = resp.passes || [];
                _updateSatelliteLayer(passes, resp.satellites || []);
            })
            .catch(function () { /* satellite predict may fail if skyfield not installed */ });
    }

    function _updateSatelliteLayer(passes, satelliteList) {
        // Clear old satellite data
        layers.satellites.clearLayers();
        data.satellites = [];

        // Group passes by satellite name for orbit track visualization
        var satGroups = {};
        passes.forEach(function (pass) {
            var name = pass.satellite || pass.name || 'Unknown';
            if (!satGroups[name]) satGroups[name] = [];
            satGroups[name].push(pass);
        });

        // Place markers for each unique satellite (at rise azimuth from observer)
        Object.keys(satGroups).forEach(function (satName) {
            var group = satGroups[satName];
            var firstPass = group[0];

            // If pass has rise_az, compute a point along that azimuth for display
            // Otherwise, just place near observer
            var displayLat = observerLocation.lat;
            var displayLon = observerLocation.lon;

            if (firstPass.rise_az != null) {
                // Project a point ~200km from observer along rise azimuth for visual placement
                var riseAzRad = (firstPass.rise_az * Math.PI) / 180;
                var dist = 200; // km
                var R = 6371;
                var lat1 = (observerLocation.lat * Math.PI) / 180;
                var lon1 = (observerLocation.lon * Math.PI) / 180;
                displayLat = Math.asin(
                    Math.sin(lat1) * Math.cos(dist / R) +
                    Math.cos(lat1) * Math.sin(dist / R) * Math.cos(riseAzRad)
                ) * (180 / Math.PI);
                displayLon = (lon1 + Math.atan2(
                    Math.sin(riseAzRad) * Math.sin(dist / R) * Math.cos(lat1),
                    Math.cos(dist / R) - Math.sin(lat1) * Math.sin(displayLat * Math.PI / 180)
                )) * (180 / Math.PI);
            }

            var marker = L.marker([displayLat, displayLon], {
                icon: satelliteIcon(),
                zIndexOffset: 200,
            });
            marker.bindPopup(_satellitePopup(satName, group));
            layers.satellites.addLayer(marker);

            // Draw an arc from rise to set if we have azimuth data
            if (firstPass.rise_az != null && firstPass.set_az != null) {
                var trackPoints = _computeSatArc(
                    observerLocation.lat, observerLocation.lon,
                    firstPass.rise_az, firstPass.set_az,
                    firstPass.max_el || 45
                );
                if (trackPoints.length > 1) {
                    var polyline = L.polyline(trackPoints, {
                        color: '#fbbf24',
                        weight: 1.5,
                        opacity: 0.5,
                        dashArray: '6 4',
                    });
                    layers.satellites.addLayer(polyline);
                    data.satellites.push({ polyline: polyline, marker: marker, data: firstPass });
                }
            } else {
                data.satellites.push({ polyline: null, marker: marker, data: firstPass });
            }
        });

        _updateCounts();
    }

    /**
     * Compute an arc of lat/lon points from rise azimuth to set azimuth
     * projected from an observer point, for visual orbit track display.
     */
    function _computeSatArc(lat, lon, riseAz, setAz, maxEl) {
        var points = [];
        var R = 6371;
        // Distance proportional to elevation (higher passes appear further out)
        var dist = 150 + (90 - Math.min(maxEl, 89)) * 3; // ~150-420km
        var lat1 = (lat * Math.PI) / 180;
        var lon1 = (lon * Math.PI) / 180;

        // Sweep from rise to set azimuth
        var startAz = riseAz;
        var endAz = setAz;
        // Handle wrap-around
        if (endAz < startAz) endAz += 360;

        var steps = 20;
        for (var i = 0; i <= steps; i++) {
            var az = startAz + (endAz - startAz) * (i / steps);
            var azRad = (az * Math.PI) / 180;
            // Vary distance to create an arc (closer at max elevation midpoint)
            var t = i / steps;
            var d = dist * (0.6 + 0.4 * Math.abs(2 * t - 1));

            var pLat = Math.asin(
                Math.sin(lat1) * Math.cos(d / R) +
                Math.cos(lat1) * Math.sin(d / R) * Math.cos(azRad)
            ) * (180 / Math.PI);
            var pLon = (lon1 + Math.atan2(
                Math.sin(azRad) * Math.sin(d / R) * Math.cos(lat1),
                Math.cos(d / R) - Math.sin(lat1) * Math.sin(pLat * Math.PI / 180)
            )) * (180 / Math.PI);

            points.push([pLat, pLon]);
        }
        return points;
    }

    function _satellitePopup(satName, passes) {
        var lines = [
            '<div class="geo-popup-title">' + _esc(satName) + '</div>',
        ];
        passes.forEach(function (pass, idx) {
            if (idx > 0) lines.push('<div class="geo-popup-divider"></div>');
            lines.push(_popupRow('Pass ' + (idx + 1), ''));
            if (pass.rise_time) lines.push(_popupRow('Rise', new Date(pass.rise_time).toLocaleTimeString()));
            if (pass.max_time) lines.push(_popupRow('Max El', (pass.max_el || '--') + '\u00b0 @ ' + new Date(pass.max_time).toLocaleTimeString()));
            if (pass.set_time) lines.push(_popupRow('Set', new Date(pass.set_time).toLocaleTimeString()));
            if (pass.duration_min != null) lines.push(_popupRow('Duration', pass.duration_min.toFixed(1) + ' min'));
        });
        return lines.join('');
    }

    // --- WebSDR Receivers ---
    function _fetchReceivers() {
        fetch('/websdr/receivers')
            .then(function (r) { return r.json(); })
            .then(function (resp) {
                if (resp.status !== 'success') return;
                var receivers = resp.receivers || [];
                _updateReceiverLayer(receivers);
            })
            .catch(function () { /* WebSDR may not be available */ });
    }

    function _updateReceiverLayer(receivers) {
        layers.receivers.clearLayers();
        data.receivers = [];

        receivers.forEach(function (rx) {
            var lat = rx.gps ? parseFloat(rx.gps[0]) : (rx.lat != null ? parseFloat(rx.lat) : null);
            var lon = rx.gps ? parseFloat(rx.gps[1]) : (rx.lon != null ? parseFloat(rx.lon) : null);
            if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return;

            var marker = L.marker([lat, lon], {
                icon: receiverIcon(),
                zIndexOffset: 100,
            });
            marker.bindPopup(_receiverPopup(rx));
            layers.receivers.addLayer(marker);
            data.receivers.push({ marker: marker, data: rx });
        });

        _updateCounts();
    }

    function _receiverPopup(rx) {
        var name = rx.name || rx.host || 'Unknown Receiver';
        var lines = [
            '<div class="geo-popup-title">' + _esc(name) + '</div>',
        ];
        if (rx.host) lines.push(_popupRow('Host', rx.host));
        if (rx.port) lines.push(_popupRow('Port', rx.port));
        if (rx.users != null) lines.push(_popupRow('Users', rx.users + '/' + (rx.users_max || '?')));
        if (rx.antenna) lines.push(_popupRow('Antenna', rx.antenna));
        if (rx.location) lines.push(_popupRow('Location', rx.location));
        if (rx.freq_lo != null && rx.freq_hi != null) {
            lines.push(_popupRow('Range', rx.freq_lo + ' - ' + rx.freq_hi + ' kHz'));
        }
        if (rx.bands) lines.push(_popupRow('Bands', rx.bands));
        if (rx.available !== undefined) lines.push(_popupRow('Status', rx.available ? 'Online' : 'Offline'));
        return lines.join('');
    }

    // --- Trilaterated Device Locations ---
    function _fetchTrilaterated() {
        fetch('/controller/api/location/all')
            .then(function (r) { return r.json(); })
            .then(function (resp) {
                if (resp.status !== 'success') return;
                var devices = resp.devices || {};
                _updateTrilateratedLayer(devices);
            })
            .catch(function () { /* controller may not be running */ });
    }

    function _updateTrilateratedLayer(devices) {
        // Track seen device IDs
        var seenIds = {};

        Object.keys(devices).forEach(function (deviceId) {
            var est = devices[deviceId];
            var lat = est.latitude;
            var lon = est.longitude;
            if (lat == null || lon == null) return;

            seenIds[deviceId] = true;
            var existing = data.trilaterated[deviceId];

            if (existing) {
                existing.marker.setLatLng([lat, lon]);
                existing.marker.setPopupContent(_trilateratedPopup(deviceId, est));
                if (existing.circle) {
                    existing.circle.setLatLng([lat, lon]);
                    if (est.accuracy_meters) {
                        existing.circle.setRadius(est.accuracy_meters);
                    }
                }
                existing.data = est;
            } else {
                var marker = L.marker([lat, lon], {
                    icon: trilateratedIcon(),
                    zIndexOffset: 600,
                });
                marker.bindPopup(_trilateratedPopup(deviceId, est));
                layers.trilaterated.addLayer(marker);

                // Accuracy circle
                var circle = null;
                if (est.accuracy_meters) {
                    circle = L.circle([lat, lon], {
                        radius: est.accuracy_meters,
                        color: '#f87171',
                        fillColor: '#f87171',
                        fillOpacity: 0.08,
                        weight: 1,
                        opacity: 0.5,
                        className: 'geo-accuracy-circle',
                    });
                    layers.trilaterated.addLayer(circle);
                }

                data.trilaterated[deviceId] = { marker: marker, circle: circle, data: est };
            }
        });

        // Remove stale entries
        Object.keys(data.trilaterated).forEach(function (id) {
            if (!seenIds[id]) {
                layers.trilaterated.removeLayer(data.trilaterated[id].marker);
                if (data.trilaterated[id].circle) {
                    layers.trilaterated.removeLayer(data.trilaterated[id].circle);
                }
                delete data.trilaterated[id];
            }
        });

        _updateCounts();
    }

    function _trilateratedPopup(deviceId, est) {
        var lines = [
            '<div class="geo-popup-title">TRILATERATED DEVICE</div>',
        ];
        lines.push(_popupRow('Device ID', deviceId));
        lines.push(_popupRow('Position', _fmtCoord(est.latitude, est.longitude)));
        if (est.accuracy_meters != null) lines.push(_popupRow('Accuracy', est.accuracy_meters.toFixed(1) + ' m'));
        if (est.confidence != null) lines.push(_popupRow('Confidence', (est.confidence * 100).toFixed(0) + '%'));
        if (est.num_observations != null) lines.push(_popupRow('Observations', est.num_observations));
        if (est.method) lines.push(_popupRow('Method', est.method));
        return lines.join('');
    }

    // --- BT Locate Trail ---
    function _fetchBtTrail() {
        fetch('/bt_locate/trail')
            .then(function (r) { return r.json(); })
            .then(function (resp) {
                _updateBtTrailLayer(resp);
            })
            .catch(function () { /* BT locate may not have an active session */ });
    }

    function _updateBtTrailLayer(resp) {
        // Clear old trail
        layers.btTrail.clearLayers();
        data.btTrail.markers = [];
        data.btTrail.polyline = null;

        var gpsTrail = resp.gps_trail || [];
        if (gpsTrail.length === 0) {
            _updateCounts();
            return;
        }

        var trailCoords = [];

        gpsTrail.forEach(function (point, idx) {
            var lat = point.lat || point.latitude;
            var lon = point.lon || point.longitude;
            if (lat == null || lon == null) return;

            trailCoords.push([lat, lon]);

            var marker = L.marker([lat, lon], {
                icon: btTrailIcon(),
                zIndexOffset: 150,
            });
            marker.bindPopup(_btTrailPopup(point, idx));
            layers.btTrail.addLayer(marker);
            data.btTrail.markers.push(marker);
        });

        // Draw connecting polyline
        if (trailCoords.length > 1) {
            data.btTrail.polyline = L.polyline(trailCoords, {
                color: '#fb923c',
                weight: 2,
                opacity: 0.6,
                dashArray: '8 5',
            });
            layers.btTrail.addLayer(data.btTrail.polyline);
        }

        _updateCounts();
    }

    function _btTrailPopup(point, idx) {
        var lines = [
            '<div class="geo-popup-title">BT TRAIL POINT #' + (idx + 1) + '</div>',
        ];
        var lat = point.lat || point.latitude;
        var lon = point.lon || point.longitude;
        lines.push(_popupRow('Position', _fmtCoord(lat, lon)));
        if (point.rssi != null) lines.push(_popupRow('RSSI', point.rssi + ' dBm'));
        if (point.distance_estimate != null) lines.push(_popupRow('Est. Distance', point.distance_estimate.toFixed(1) + ' m'));
        if (point.timestamp) lines.push(_popupRow('Time', new Date(point.timestamp * 1000).toLocaleTimeString()));
        return lines.join('');
    }

    // ========================================================================
    // POPUP HELPER
    // ========================================================================

    function _popupRow(label, value) {
        return '<div class="geo-popup-row">' +
            '<span class="geo-popup-label">' + _esc(label) + '</span>' +
            '<span class="geo-popup-value">' + _esc(String(value)) + '</span>' +
            '</div>';
    }

    // ========================================================================
    // COUNTS & CLEANUP
    // ========================================================================

    function _updateCounts() {
        var aircraftCount = Object.keys(data.aircraft).length;
        var vesselCount = Object.keys(data.vessels).length;
        var meshCount = Object.keys(data.mesh).length;
        var satCount = data.satellites.length;
        var rxCount = data.receivers.length;
        var triCount = Object.keys(data.trilaterated).length;
        var btCount = data.btTrail.markers.length;
        var total = aircraftCount + vesselCount + meshCount + satCount + rxCount + triCount + btCount;

        // Layer panel counts
        _setText('countAircraft', aircraftCount);
        _setText('countVessels', vesselCount);
        _setText('countMesh', meshCount);
        _setText('countSatellites', satCount);
        _setText('countReceivers', rxCount);
        _setText('countTrilaterated', triCount);
        _setText('countBtTrail', btCount);

        // Info panel counts
        _setText('infoAircraft', aircraftCount);
        _setText('infoVessels', vesselCount);
        _setText('infoMesh', meshCount);
        _setText('infoSatellites', satCount);
        _setText('infoReceivers', rxCount);
        _setText('infoTrilaterated', triCount);
        _setText('infoBtTrail', btCount);
        _setText('infoTotal', total);
    }

    function _startCleanup() {
        cleanupTimer = setInterval(function () {
            var now = Date.now();

            // Remove stale aircraft
            Object.keys(data.aircraft).forEach(function (icao) {
                if (now - data.aircraft[icao].lastSeen > STALE_TIMEOUT) {
                    layers.aircraft.removeLayer(data.aircraft[icao].marker);
                    delete data.aircraft[icao];
                }
            });

            // Remove stale vessels
            Object.keys(data.vessels).forEach(function (mmsi) {
                if (now - data.vessels[mmsi].lastSeen > STALE_TIMEOUT) {
                    layers.vessels.removeLayer(data.vessels[mmsi].marker);
                    delete data.vessels[mmsi];
                }
            });

            _updateCounts();
        }, 30000); // every 30 seconds
    }

    // ========================================================================
    // LAYER TOGGLE
    // ========================================================================

    function toggleLayer(layerName, visible) {
        var group = layers[layerName];
        if (!group) return;

        if (visible) {
            if (!map.hasLayer(group)) map.addLayer(group);
        } else {
            if (map.hasLayer(group)) map.removeLayer(group);
        }
    }

    // ========================================================================
    // PANEL TOGGLES
    // ========================================================================

    function toggleLayerPanel() {
        var panel = document.getElementById('geoLayerPanel');
        if (panel) panel.classList.toggle('collapsed');
    }

    function toggleInfoPanel() {
        var panel = document.getElementById('geoInfoPanel');
        if (panel) panel.classList.toggle('collapsed');
    }

    function toggleLegendPanel() {
        var panel = document.getElementById('geoLegendPanel');
        if (panel) panel.classList.toggle('collapsed');
    }

    // ========================================================================
    // UTC CLOCK
    // ========================================================================

    function _startClock() {
        function tick() {
            var now = new Date();
            var utc = now.toISOString().slice(11, 19);
            _setText('geoUtcTime', utc + ' UTC');
        }
        tick();
        setInterval(tick, 1000);
    }

    // ========================================================================
    // CLEANUP / DESTROY
    // ========================================================================

    function destroy() {
        if (adsbEventSource) { adsbEventSource.close(); adsbEventSource = null; }
        if (aisEventSource) { aisEventSource.close(); aisEventSource = null; }
        if (meshEventSource) { meshEventSource.close(); meshEventSource = null; }
        if (staticRefreshTimer) { clearInterval(staticRefreshTimer); staticRefreshTimer = null; }
        if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
        if (map) { map.remove(); map = null; }
    }

    // ========================================================================
    // PUBLIC API
    // ========================================================================

    return {
        init: init,
        destroy: destroy,
        toggleLayer: toggleLayer,
        toggleLayerPanel: toggleLayerPanel,
        toggleInfoPanel: toggleInfoPanel,
        toggleLegendPanel: toggleLegendPanel,
    };
})();
