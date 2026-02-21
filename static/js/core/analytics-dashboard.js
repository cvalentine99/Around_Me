/**
 * Analytics Dashboard - Cross-Mode Intelligence
 * IIFE pattern - exposes AnalyticsDashboard global
 */
var AnalyticsDashboard = (function () {
    'use strict';

    // =========================================================================
    // State
    // =========================================================================
    var sparklineCharts = {};     // mode -> Chart instance
    var refreshTimer = null;
    var REFRESH_INTERVAL = 30000; // 30 seconds
    var previousCounts = {};

    // Mode labels for display
    var MODE_LABELS = {
        adsb: 'ADS-B',
        ais: 'AIS',
        wifi: 'WiFi',
        bluetooth: 'Bluetooth',
        dsc: 'DSC',
        acars: 'ACARS',
        vdl2: 'VDL2',
        aprs: 'APRS',
        meshtastic: 'Meshtastic'
    };

    // Mode colors for sparkline charts
    var MODE_COLORS = {
        adsb:       { line: '#34d399', fill: 'rgba(52, 211, 153, 0.12)' },
        ais:        { line: '#06b6d4', fill: 'rgba(6, 182, 212, 0.12)' },
        wifi:       { line: '#a78bfa', fill: 'rgba(167, 139, 250, 0.12)' },
        bluetooth:  { line: '#3b82f6', fill: 'rgba(59, 130, 246, 0.12)' },
        dsc:        { line: '#ef4444', fill: 'rgba(239, 68, 68, 0.12)' },
        acars:      { line: '#f59e0b', fill: 'rgba(245, 158, 11, 0.12)' },
        vdl2:       { line: '#fbbf24', fill: 'rgba(251, 191, 36, 0.12)' },
        aprs:       { line: '#ec4899', fill: 'rgba(236, 72, 153, 0.12)' },
        meshtastic: { line: '#10b981', fill: 'rgba(16, 185, 129, 0.12)' }
    };

    // Squawk code descriptions
    var SQUAWK_DESCRIPTIONS = {
        '7500': 'HIJACK',
        '7600': 'COMMS FAILURE',
        '7700': 'EMERGENCY'
    };

    var SQUAWK_CSS = {
        '7500': 'hijack',
        '7600': 'comms-failure',
        '7700': 'emergency'
    };

    // =========================================================================
    // Helpers
    // =========================================================================
    function safeJSON(response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
    }

    function formatTimestamp() {
        return new Date().toISOString().slice(11, 19) + 'Z';
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str || ''));
        return div.innerHTML;
    }

    // =========================================================================
    // Summary
    // =========================================================================
    function fetchSummary() {
        fetch('/analytics/summary')
            .then(safeJSON)
            .then(function (data) {
                if (data.status !== 'success') return;
                updateSummaryCounts(data.counts || {});
                updateSquawkTable(data.squawks || []);
                var ts = document.getElementById('summaryTimestamp');
                if (ts) ts.textContent = formatTimestamp();
            })
            .catch(function (err) {
                console.warn('[Analytics] summary fetch error:', err);
            });
    }

    function updateSummaryCounts(counts) {
        var mapping = {
            wifi: 'countWifi',
            bluetooth: 'countBluetooth',
            adsb: 'countAdsb',
            ais: 'countAis',
            acars: 'countAcars',
            aprs: 'countAprs',
            dsc: 'countDsc',
            meshtastic: 'countMeshtastic'
        };

        for (var mode in mapping) {
            var el = document.getElementById(mapping[mode]);
            if (!el) continue;
            var newVal = parseInt(counts[mode]) || 0;
            var oldVal = previousCounts[mode] || 0;
            el.textContent = newVal;
            if (newVal !== oldVal) {
                el.classList.remove('changed');
                // Force reflow for re-trigger
                void el.offsetWidth;
                el.classList.add('changed');
            }
            previousCounts[mode] = newVal;
        }
    }

    // =========================================================================
    // Squawks
    // =========================================================================
    function updateSquawkTable(squawks) {
        var tbody = document.getElementById('squawkTableBody');
        if (!tbody) return;

        if (!squawks || squawks.length === 0) {
            tbody.innerHTML = '<tr class="squawk-empty-row"><td colspan="3">No active emergency squawks</td></tr>';
            return;
        }

        var html = '';
        squawks.forEach(function (sq) {
            var code = String(sq.squawk || sq.code || '----');
            var icao = escapeHtml(String(sq.icao || sq.hex || '--'));
            var desc = escapeHtml(SQUAWK_DESCRIPTIONS[code] || sq.description || sq.emergency || 'UNKNOWN');
            var cssClass = SQUAWK_CSS[code] || 'emergency';
            html += '<tr>';
            html += '<td>' + icao + '</td>';
            html += '<td><span class="squawk-code ' + cssClass + '">' + escapeHtml(code) + '</span></td>';
            html += '<td>' + desc + '</td>';
            html += '</tr>';
        });
        tbody.innerHTML = html;
    }

    // =========================================================================
    // Insights
    // =========================================================================
    function fetchInsights() {
        fetch('/analytics/insights')
            .then(safeJSON)
            .then(function (data) {
                if (data.status !== 'success') return;
                renderInsightCards(data.cards || []);
            })
            .catch(function (err) {
                console.warn('[Analytics] insights fetch error:', err);
            });
    }

    function renderInsightCards(cards) {
        var idMap = {
            fastest_change:    { value: 'insightFastestChange',    label: 'insightFastestChangeLabel' },
            busiest_mode:      { value: 'insightBusiestMode',      label: 'insightBusiestModeLabel' },
            critical_alerts:   { value: 'insightCriticalAlerts',   label: 'insightCriticalAlertsLabel' },
            emergency_squawks: { value: 'insightEmergencySquawks', label: 'insightEmergencySquawksLabel' },
            recurring_emitters:{ value: 'insightRecurringEmitters', label: 'insightRecurringEmittersLabel' }
        };

        cards.forEach(function (card) {
            var targets = idMap[card.id];
            if (!targets) return;

            var valEl = document.getElementById(targets.value);
            var labelEl = document.getElementById(targets.label);
            if (valEl) valEl.textContent = card.value || '--';
            if (labelEl) labelEl.textContent = card.label || '';

            // Update severity indicator
            var insightCard = document.querySelector('.insight-card[data-insight="' + card.id + '"]');
            if (insightCard) {
                var sevEl = insightCard.querySelector('.insight-severity');
                if (sevEl) {
                    sevEl.className = 'insight-severity ' + (card.severity || 'low');
                }
            }
        });
    }

    // =========================================================================
    // Activity Sparklines
    // =========================================================================
    function fetchActivity() {
        fetch('/analytics/activity')
            .then(safeJSON)
            .then(function (data) {
                if (data.status !== 'success') return;
                renderSparklines(data.sparklines || {});
            })
            .catch(function (err) {
                console.warn('[Analytics] activity fetch error:', err);
            });
    }

    function renderSparklines(sparklines) {
        var grid = document.getElementById('sparklineGrid');
        var empty = document.getElementById('sparklineEmpty');
        if (!grid) return;

        var modes = Object.keys(sparklines).filter(function (m) {
            var arr = sparklines[m];
            return Array.isArray(arr) && arr.length > 0;
        });

        if (modes.length === 0) {
            if (empty) empty.style.display = '';
            return;
        }
        if (empty) empty.style.display = 'none';

        modes.forEach(function (mode) {
            var samples = sparklines[mode];
            var cardId = 'sparkline-' + mode;
            var existing = document.getElementById(cardId);

            if (!existing) {
                // Create card DOM
                var card = document.createElement('div');
                card.className = 'sparkline-card';
                card.id = cardId;

                var header = document.createElement('div');
                header.className = 'sparkline-card-header';

                var nameSpan = document.createElement('span');
                nameSpan.className = 'sparkline-mode-name';
                nameSpan.textContent = MODE_LABELS[mode] || mode.toUpperCase();

                var countSpan = document.createElement('span');
                countSpan.className = 'sparkline-mode-count';
                countSpan.id = 'sparkCount-' + mode;
                countSpan.textContent = samples.length + ' samples';

                header.appendChild(nameSpan);
                header.appendChild(countSpan);

                var canvasWrap = document.createElement('div');
                canvasWrap.className = 'sparkline-canvas-wrap';

                var canvas = document.createElement('canvas');
                canvas.id = 'sparkCanvas-' + mode;
                canvasWrap.appendChild(canvas);

                card.appendChild(header);
                card.appendChild(canvasWrap);
                grid.appendChild(card);

                createSparklineChart(mode, canvas, samples);
            } else {
                // Update existing chart
                var cntEl = document.getElementById('sparkCount-' + mode);
                if (cntEl) cntEl.textContent = samples.length + ' samples';
                updateSparklineChart(mode, samples);
            }
        });
    }

    function createSparklineChart(mode, canvas, data) {
        var colors = MODE_COLORS[mode] || { line: '#a78bfa', fill: 'rgba(167, 139, 250, 0.12)' };
        var labels = data.map(function (_, i) { return i; });

        var chart = new Chart(canvas, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    borderColor: colors.line,
                    backgroundColor: colors.fill,
                    borderWidth: 1.5,
                    fill: true,
                    tension: 0.35,
                    pointRadius: 0,
                    pointHoverRadius: 3,
                    pointHoverBackgroundColor: colors.line
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 300 },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: true,
                        backgroundColor: 'rgba(15, 12, 26, 0.9)',
                        titleColor: '#a78bfa',
                        bodyColor: '#e8e0f0',
                        borderColor: 'rgba(139, 92, 246, 0.3)',
                        borderWidth: 1,
                        cornerRadius: 4,
                        padding: 6,
                        displayColors: false,
                        titleFont: { family: "'IBM Plex Mono', monospace", size: 10 },
                        bodyFont: { family: "'IBM Plex Mono', monospace", size: 11 },
                        callbacks: {
                            title: function () { return (MODE_LABELS[mode] || mode).toUpperCase(); },
                            label: function (ctx) { return 'Count: ' + ctx.parsed.y; }
                        }
                    }
                },
                scales: {
                    x: { display: false },
                    y: {
                        display: false,
                        beginAtZero: true
                    }
                },
                interaction: {
                    mode: 'index',
                    intersect: false
                }
            }
        });

        sparklineCharts[mode] = chart;
    }

    function updateSparklineChart(mode, data) {
        var chart = sparklineCharts[mode];
        if (!chart) return;

        chart.data.labels = data.map(function (_, i) { return i; });
        chart.data.datasets[0].data = data;
        chart.update('none');
    }

    // =========================================================================
    // Patterns
    // =========================================================================
    function fetchPatterns() {
        fetch('/analytics/patterns')
            .then(safeJSON)
            .then(function (data) {
                if (data.status !== 'success') return;
                renderPatterns(data.patterns || []);
            })
            .catch(function (err) {
                console.warn('[Analytics] patterns fetch error:', err);
            });
    }

    function renderPatterns(patterns) {
        var container = document.getElementById('patternCards');
        var empty = document.getElementById('patternEmpty');
        var badge = document.getElementById('patternCount');
        if (!container) return;

        if (badge) badge.textContent = patterns.length;

        if (patterns.length === 0) {
            if (empty) empty.style.display = '';
            return;
        }
        if (empty) empty.style.display = 'none';

        // Remove old pattern cards (keep the empty placeholder)
        var oldCards = container.querySelectorAll('.pattern-card');
        oldCards.forEach(function (c) { c.remove(); });

        patterns.forEach(function (p) {
            var card = document.createElement('div');
            card.className = 'pattern-card';

            var confidence = parseFloat(p.confidence) || 0;
            var confClass = confidence >= 0.7 ? 'pattern-confidence-high' :
                           confidence >= 0.4 ? 'pattern-confidence-medium' : 'pattern-confidence-low';

            var header = document.createElement('div');
            header.className = 'pattern-card-header';
            header.innerHTML =
                '<span class="pattern-mode-tag">' + escapeHtml(MODE_LABELS[p.mode] || p.mode || 'UNKNOWN') + '</span>' +
                '<span class="pattern-confidence ' + confClass + '">' + (confidence * 100).toFixed(0) + '% conf</span>';

            var desc = document.createElement('div');
            desc.className = 'pattern-description';
            desc.textContent = p.description || p.pattern_type || 'Detected temporal pattern';

            var entity = document.createElement('div');
            entity.className = 'pattern-entity';
            entity.textContent = p.entity_id || p.identifier || '';

            card.appendChild(header);
            card.appendChild(desc);
            if (entity.textContent) card.appendChild(entity);
            container.appendChild(card);
        });
    }

    // =========================================================================
    // Geofences
    // =========================================================================
    function fetchGeofences() {
        fetch('/analytics/geofences')
            .then(safeJSON)
            .then(function (data) {
                if (data.status !== 'success') return;
                renderGeofences(data.zones || []);
            })
            .catch(function (err) {
                console.warn('[Analytics] geofences fetch error:', err);
            });
    }

    function renderGeofences(zones) {
        var list = document.getElementById('geofenceList');
        var empty = document.getElementById('geofenceEmpty');
        var badge = document.getElementById('geofenceCount');
        if (!list) return;

        if (badge) badge.textContent = zones.length;

        if (zones.length === 0) {
            list.innerHTML = '';
            if (empty) {
                empty.style.display = '';
                list.appendChild(empty);
            }
            return;
        }
        if (empty) empty.style.display = 'none';

        var html = '';
        zones.forEach(function (z) {
            html += '<div class="geofence-item" data-zone-id="' + z.id + '">';
            html += '  <div class="geofence-item-info">';
            html += '    <div class="geofence-item-name">' + escapeHtml(z.name) + '</div>';
            html += '    <div class="geofence-item-detail">' +
                            escapeHtml(String(z.lat)) + ', ' + escapeHtml(String(z.lon)) +
                            ' | R=' + escapeHtml(String(z.radius_m)) + 'm</div>';
            html += '  </div>';
            html += '  <div style="display:flex;align-items:center;gap:8px;">';
            html += '    <span class="geofence-item-alert">' + escapeHtml(z.alert_on || 'enter_exit') + '</span>';
            html += '    <button class="geofence-delete-btn" onclick="AnalyticsDashboard.deleteGeofence(' + z.id + ')">DEL</button>';
            html += '  </div>';
            html += '</div>';
        });
        list.innerHTML = html;
    }

    function createGeofence(e) {
        if (e) e.preventDefault();

        var name = document.getElementById('geoName').value.trim();
        var lat = parseFloat(document.getElementById('geoLat').value);
        var lon = parseFloat(document.getElementById('geoLon').value);
        var radius_m = parseFloat(document.getElementById('geoRadius').value);
        var alert_on = document.getElementById('geoAlertOn').value;

        if (!name || isNaN(lat) || isNaN(lon) || isNaN(radius_m)) {
            return false;
        }

        fetch('/analytics/geofences', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name,
                lat: lat,
                lon: lon,
                radius_m: radius_m,
                alert_on: alert_on
            })
        })
        .then(safeJSON)
        .then(function (data) {
            if (data.status === 'success') {
                // Reset form
                document.getElementById('geoName').value = '';
                document.getElementById('geoLat').value = '';
                document.getElementById('geoLon').value = '';
                document.getElementById('geoRadius').value = '';
                document.getElementById('geoAlertOn').value = 'enter_exit';
                fetchGeofences();
            } else {
                console.warn('[Analytics] create geofence error:', data.message);
            }
        })
        .catch(function (err) {
            console.warn('[Analytics] create geofence failed:', err);
        });

        return false;
    }

    function deleteGeofence(zoneId) {
        if (!confirm('Delete this geofence zone?')) return;

        fetch('/analytics/geofences/' + zoneId, { method: 'DELETE' })
            .then(safeJSON)
            .then(function (data) {
                if (data.status === 'success') {
                    fetchGeofences();
                }
            })
            .catch(function (err) {
                console.warn('[Analytics] delete geofence failed:', err);
            });
    }

    // =========================================================================
    // Data Export
    // =========================================================================
    function exportData(mode, format) {
        var url = '/analytics/export/' + encodeURIComponent(mode) + '?format=' + encodeURIComponent(format);

        if (format === 'csv') {
            // Direct download for CSV
            var link = document.createElement('a');
            link.href = url;
            link.download = mode + '_export.csv';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } else {
            // JSON: fetch and trigger download
            fetch(url)
                .then(function (response) {
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return response.blob();
                })
                .then(function (blob) {
                    var objUrl = URL.createObjectURL(blob);
                    var link = document.createElement('a');
                    link.href = objUrl;
                    link.download = mode + '_export.json';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    URL.revokeObjectURL(objUrl);
                })
                .catch(function (err) {
                    console.warn('[Analytics] export failed:', err);
                });
        }
    }

    // =========================================================================
    // Target Search
    // =========================================================================
    function searchTarget() {
        var input = document.getElementById('targetSearchInput');
        var container = document.getElementById('targetResults');
        if (!input || !container) return;

        var query = input.value.trim();
        if (!query) {
            container.innerHTML = '';
            return;
        }

        fetch('/analytics/target?q=' + encodeURIComponent(query) + '&limit=50')
            .then(safeJSON)
            .then(function (data) {
                if (data.status !== 'success') return;
                renderTargetResults(data.results || [], data.mode_counts || {}, query);
            })
            .catch(function (err) {
                console.warn('[Analytics] target search error:', err);
                container.innerHTML = '<div class="target-result-empty">Search failed</div>';
            });
    }

    function renderTargetResults(results, modeCounts, query) {
        var container = document.getElementById('targetResults');
        if (!container) return;

        if (results.length === 0) {
            container.innerHTML = '<div class="target-result-empty">No results for "' + escapeHtml(query) + '"</div>';
            return;
        }

        var countParts = [];
        for (var m in modeCounts) {
            countParts.push((MODE_LABELS[m] || m.toUpperCase()) + ': ' + modeCounts[m]);
        }

        var html = '<div class="target-result-count">' + results.length + ' results | ' + escapeHtml(countParts.join(', ')) + '</div>';

        results.forEach(function (r) {
            html += '<div class="target-result-item">';
            html += '<span class="target-result-mode">' + escapeHtml(MODE_LABELS[r.mode] || r.mode) + '</span>';
            html += '<div class="target-result-info">';
            html += '<div class="target-result-title">' + escapeHtml(r.title) + '</div>';
            html += '<div class="target-result-subtitle">' + escapeHtml(r.subtitle) + '</div>';
            html += '</div>';
            html += '</div>';
        });

        container.innerHTML = html;
    }

    // =========================================================================
    // Periodic Refresh
    // =========================================================================
    function refreshAll() {
        fetchSummary();
        fetchInsights();
        fetchActivity();
        fetchPatterns();
        fetchGeofences();
    }

    function startAutoRefresh() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(function () {
            fetchSummary();
            fetchInsights();
        }, REFRESH_INTERVAL);
    }

    // =========================================================================
    // Init
    // =========================================================================
    function init() {
        // Load all data on page load
        refreshAll();

        // Start periodic refresh for summary and insights
        startAutoRefresh();

        // Bind enter key on target search
        var searchInput = document.getElementById('targetSearchInput');
        if (searchInput) {
            searchInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    searchTarget();
                }
            });
        }

        // Visibility change: refresh when tab regains focus
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) {
                refreshAll();
            }
        });
    }

    // Auto-init when DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // =========================================================================
    // Public API
    // =========================================================================
    return {
        createGeofence: createGeofence,
        deleteGeofence: deleteGeofence,
        exportData: exportData,
        searchTarget: searchTarget,
        refreshAll: refreshAll
    };

})();
