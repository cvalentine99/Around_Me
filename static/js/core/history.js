/**
 * History Page - Valentine RF
 * Recordings, ADS-B History, TSCM Reports
 * Wired to real backend endpoints.
 */
const HistoryPage = (function () {
    'use strict';

    // ---------- state ----------
    let currentTab = 'recordings';
    let recordings = [];
    let activeRecordings = [];
    let activeRefreshTimer = null;

    // ADS-B
    let adsbMinutes = 60;
    let adsbAircraft = [];
    let altitudeChart = null;
    let speedChart = null;

    // TSCM
    let tscmThreats = [];

    // ---------- helpers ----------
    function esc(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function fmtBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function fmtDuration(startedAt, stoppedAt) {
        if (!startedAt) return '--';
        var start = new Date(startedAt).getTime();
        var end = stoppedAt ? new Date(stoppedAt).getTime() : Date.now();
        var diffSec = Math.floor((end - start) / 1000);
        if (diffSec < 60) return diffSec + 's';
        if (diffSec < 3600) return Math.floor(diffSec / 60) + 'm ' + (diffSec % 60) + 's';
        var h = Math.floor(diffSec / 3600);
        var m = Math.floor((diffSec % 3600) / 60);
        return h + 'h ' + m + 'm';
    }

    function fmtDate(iso) {
        if (!iso) return '--';
        try {
            var d = new Date(iso);
            return d.toLocaleString(undefined, {
                month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
        } catch (e) { return iso; }
    }

    function fmtNumber(n) {
        if (n === undefined || n === null) return '--';
        return Number(n).toLocaleString();
    }

    /** Simple toast notification */
    function toast(msg, type) {
        var existing = document.getElementById('historyToast');
        if (existing) existing.remove();
        var el = document.createElement('div');
        el.id = 'historyToast';
        el.textContent = msg;
        el.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:10px 18px;border-radius:6px;font-size:12px;font-family:var(--font-mono);letter-spacing:0.5px;' +
            (type === 'error'
                ? 'background:var(--accent-red-dim);color:var(--accent-red);border:1px solid var(--accent-red);'
                : 'background:var(--accent-green-dim);color:var(--accent-green);border:1px solid var(--accent-green);');
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 4000);
    }

    // ==========================================================
    //  TAB SWITCHING
    // ==========================================================
    function switchTab(tab) {
        currentTab = tab;
        // Update tab buttons
        document.querySelectorAll('.history-tab').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
        });
        // Update tab content
        document.querySelectorAll('.history-tab-content').forEach(function (sec) {
            sec.classList.toggle('active', sec.id === 'tab-' + tab);
        });

        // Load data for the activated tab
        if (tab === 'recordings') {
            loadRecordings();
        } else if (tab === 'adsb') {
            loadAdsbSummary();
            loadAdsbAircraft();
        } else if (tab === 'tscm') {
            loadTscmSummary();
            loadTscmThreats();
        }
    }

    // ==========================================================
    //  RECORDINGS
    // ==========================================================
    function loadRecordings() {
        fetch('/recordings')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.status !== 'success') {
                    toast('Failed to load recordings', 'error');
                    return;
                }
                recordings = data.recordings || [];
                activeRecordings = data.active || [];
                renderActiveRecordings();
                renderRecordingsTable();
            })
            .catch(function (err) {
                console.error('[History] Load recordings failed', err);
                toast('Failed to load recordings', 'error');
            });
    }

    function renderActiveRecordings() {
        var container = document.getElementById('activeRecordingsList');
        var badge = document.getElementById('activeRecordingCount');
        if (!container) return;
        if (badge) badge.textContent = activeRecordings.length;

        if (!activeRecordings.length) {
            container.innerHTML = '<div class="history-empty-state">No active recordings</div>';
            return;
        }

        container.innerHTML = activeRecordings.map(function (s) {
            return '<div class="active-recording-item">' +
                '<div class="recording-pulse"></div>' +
                '<div class="active-recording-info">' +
                    '<div class="active-recording-mode">' + esc(s.mode) + (s.label ? ' &mdash; ' + esc(s.label) : '') + '</div>' +
                    '<div class="active-recording-meta">Started ' + fmtDate(s.started_at) + ' &bull; ' + fmtDuration(s.started_at, null) + '</div>' +
                '</div>' +
                '<div class="active-recording-events">' + fmtNumber(s.event_count) + '<small>events</small></div>' +
                '<button class="history-btn history-btn-danger history-btn-sm" onclick="HistoryPage.stopRecording(\'' + esc(s.id) + '\')">Stop</button>' +
            '</div>';
        }).join('');
    }

    function renderRecordingsTable() {
        var tbody = document.getElementById('recordingsTableBody');
        if (!tbody) return;
        if (!recordings.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="history-empty-cell">No recordings found</td></tr>';
            return;
        }

        tbody.innerHTML = recordings.map(function (rec) {
            return '<tr onclick="HistoryPage.showRecordingDetail(\'' + esc(rec.id) + '\')">' +
                '<td><span class="mode-badge">' + esc(rec.mode) + '</span></td>' +
                '<td>' + (rec.label ? esc(rec.label) : '<span style="color:var(--text-dim)">--</span>') + '</td>' +
                '<td>' + fmtDate(rec.started_at) + '</td>' +
                '<td>' + fmtDuration(rec.started_at, rec.stopped_at) + '</td>' +
                '<td>' + fmtNumber(rec.event_count) + '</td>' +
                '<td>' + fmtBytes(rec.size_bytes) + '</td>' +
                '<td>' +
                    '<button class="history-btn history-btn-ghost history-btn-sm" onclick="event.stopPropagation(); HistoryPage.downloadRecording(\'' + esc(rec.id) + '\')">' +
                        'Download' +
                    '</button>' +
                '</td>' +
            '</tr>';
        }).join('');
    }

    function startRecording() {
        var modeEl = document.getElementById('recModeSelect');
        var labelEl = document.getElementById('recLabelInput');
        var mode = modeEl ? modeEl.value : '';
        var label = labelEl ? labelEl.value.trim() : '';
        if (!mode) {
            toast('Select a mode first', 'error');
            return;
        }

        var body = { mode: mode };
        if (label) body.label = label;

        fetch('/recordings/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.status === 'success' || data.status === 'ok') {
                    toast('Recording started for ' + mode);
                    if (labelEl) labelEl.value = '';
                    loadRecordings();
                } else {
                    toast(data.error || 'Failed to start recording', 'error');
                }
            })
            .catch(function (err) {
                console.error('[History] Start recording failed', err);
                toast('Failed to start recording', 'error');
            });
    }

    function stopRecording(sessionId) {
        fetch('/recordings/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: sessionId })
        })
            .then(function (r) { return r.json(); })
            .then(function () {
                toast('Recording stopped');
                loadRecordings();
            })
            .catch(function (err) {
                console.error('[History] Stop recording failed', err);
                toast('Failed to stop recording', 'error');
            });
    }

    function downloadRecording(sessionId) {
        window.open('/recordings/' + encodeURIComponent(sessionId) + '/download', '_blank');
    }

    function showRecordingDetail(sessionId) {
        fetch('/recordings/' + encodeURIComponent(sessionId))
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var rec = data.recording || data;
                var panel = document.getElementById('recordingDetailPanel');
                var title = document.getElementById('recordingDetailTitle');
                var content = document.getElementById('recordingDetailContent');
                if (!panel || !content) return;

                title.textContent = (rec.mode || 'Recording').toUpperCase() + ' Detail';
                content.innerHTML =
                    '<div class="recording-detail-grid">' +
                        detailField('Session ID', rec.id || sessionId) +
                        detailField('Mode', rec.mode) +
                        detailField('Label', rec.label || '--') +
                        detailField('Started', fmtDate(rec.started_at)) +
                        detailField('Stopped', rec.stopped_at ? fmtDate(rec.stopped_at) : 'Active') +
                        detailField('Duration', fmtDuration(rec.started_at, rec.stopped_at)) +
                        detailField('Events', fmtNumber(rec.event_count)) +
                        detailField('Size', fmtBytes(rec.size_bytes)) +
                        detailField('File', rec.file_path || '--') +
                    '</div>' +
                    '<div style="padding-top:8px;">' +
                        '<button class="history-btn history-btn-primary" onclick="HistoryPage.downloadRecording(\'' + esc(sessionId) + '\')">Download NDJSON</button>' +
                    '</div>';

                panel.style.display = '';
                panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            })
            .catch(function (err) {
                console.error('[History] Load recording detail failed', err);
                toast('Failed to load recording detail', 'error');
            });
    }

    function detailField(label, value) {
        return '<div class="recording-detail-field">' +
            '<span class="detail-label">' + esc(label) + '</span>' +
            '<span class="detail-value">' + esc(String(value)) + '</span>' +
        '</div>';
    }

    function closeRecordingDetail() {
        var panel = document.getElementById('recordingDetailPanel');
        if (panel) panel.style.display = 'none';
    }

    // Auto-refresh active recordings every 5 seconds
    function startActiveRefresh() {
        stopActiveRefresh();
        activeRefreshTimer = setInterval(function () {
            if (currentTab !== 'recordings') return;
            // Lightweight refresh of active list only
            fetch('/recordings')
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (data.status !== 'success') return;
                    activeRecordings = data.active || [];
                    renderActiveRecordings();
                })
                .catch(function () { /* silent */ });
        }, 5000);
    }

    function stopActiveRefresh() {
        if (activeRefreshTimer) {
            clearInterval(activeRefreshTimer);
            activeRefreshTimer = null;
        }
    }

    // ==========================================================
    //  ADS-B HISTORY
    // ==========================================================
    function setAdsbRange(minutes, btn) {
        adsbMinutes = minutes;
        // Update active button
        document.querySelectorAll('.time-range-btn').forEach(function (b) {
            b.classList.remove('active');
        });
        if (btn) btn.classList.add('active');
        loadAdsbSummary();
        loadAdsbAircraft();
        closeAdsbTimeline();
    }

    function setAdsbCustomRange() {
        var input = document.getElementById('adsbCustomMinutes');
        var val = input ? parseInt(input.value, 10) : 0;
        if (!val || val < 1) {
            toast('Enter a valid number of minutes', 'error');
            return;
        }
        document.querySelectorAll('.time-range-btn').forEach(function (b) {
            b.classList.remove('active');
        });
        adsbMinutes = val;
        loadAdsbSummary();
        loadAdsbAircraft();
        closeAdsbTimeline();
    }

    function loadAdsbSummary() {
        fetch('/adsb/history/summary?since_minutes=' + adsbMinutes)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                setTextById('adsbTotalAircraft', fmtNumber(data.total_aircraft));
                setTextById('adsbTotalMessages', fmtNumber(data.total_messages));
                setTextById('adsbUniqueIcaos', fmtNumber(data.unique_icaos));
                setTextById('adsbTimeRange', adsbMinutes < 60 ? adsbMinutes + ' min' : (adsbMinutes / 60).toFixed(0) + 'h');
            })
            .catch(function (err) {
                console.error('[History] ADS-B summary failed', err);
                setTextById('adsbTotalAircraft', '--');
                setTextById('adsbTotalMessages', '--');
                setTextById('adsbUniqueIcaos', '--');
            });
    }

    function loadAdsbAircraft() {
        var search = '';
        var searchInput = document.getElementById('adsbSearchInput');
        if (searchInput) search = searchInput.value.trim();

        var url = '/adsb/history/aircraft?since_minutes=' + adsbMinutes + '&limit=200';
        if (search) url += '&search=' + encodeURIComponent(search);

        fetch(url)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                adsbAircraft = data.aircraft || data.snapshots || [];
                renderAdsbAircraft();
            })
            .catch(function (err) {
                console.error('[History] ADS-B aircraft failed', err);
                var tbody = document.getElementById('adsbAircraftBody');
                if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="history-empty-cell">Failed to load aircraft data. Is Postgres running?</td></tr>';
            });
    }

    function renderAdsbAircraft() {
        var tbody = document.getElementById('adsbAircraftBody');
        if (!tbody) return;
        if (!adsbAircraft.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="history-empty-cell">No aircraft found for this time range</td></tr>';
            return;
        }

        tbody.innerHTML = adsbAircraft.map(function (ac) {
            var icao = ac.icao || ac.hex || '--';
            var callsign = ac.callsign || ac.flight || '--';
            var firstSeen = ac.first_seen || ac.first_message_time || '';
            var lastSeen = ac.last_seen || ac.last_message_time || '';
            var msgCount = ac.message_count || ac.messages || 0;

            return '<tr onclick="HistoryPage.showAdsbTimeline(\'' + esc(icao) + '\')">' +
                '<td style="font-weight:600;color:var(--accent-cyan);">' + esc(icao) + '</td>' +
                '<td>' + esc(callsign) + '</td>' +
                '<td>' + fmtDate(firstSeen) + '</td>' +
                '<td>' + fmtDate(lastSeen) + '</td>' +
                '<td>' + fmtNumber(msgCount) + '</td>' +
                '<td>' +
                    '<button class="history-btn history-btn-ghost history-btn-sm" onclick="event.stopPropagation(); HistoryPage.showAdsbTimeline(\'' + esc(icao) + '\')">Timeline</button>' +
                '</td>' +
            '</tr>';
        }).join('');
    }

    function searchAdsb() {
        // Debounce search
        if (searchAdsb._timer) clearTimeout(searchAdsb._timer);
        searchAdsb._timer = setTimeout(function () {
            loadAdsbAircraft();
        }, 400);
    }

    function showAdsbTimeline(icao) {
        var panel = document.getElementById('adsbTimelinePanel');
        var title = document.getElementById('adsbTimelineTitle');
        if (!panel) return;
        if (title) title.textContent = 'Timeline: ' + icao;
        panel.style.display = '';

        fetch('/adsb/history/timeline?icao=' + encodeURIComponent(icao) + '&since_minutes=' + adsbMinutes)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var points = data.timeline || data.points || data.snapshots || [];
                renderAdsbCharts(points);
                renderAdsbTimelineEvents(points);
                panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            })
            .catch(function (err) {
                console.error('[History] ADS-B timeline failed', err);
                toast('Failed to load timeline for ' + icao, 'error');
            });
    }

    function renderAdsbCharts(points) {
        // Destroy existing charts
        if (altitudeChart) { altitudeChart.destroy(); altitudeChart = null; }
        if (speedChart) { speedChart.destroy(); speedChart = null; }

        if (!points.length) return;

        var times = points.map(function (p) { return new Date(p.timestamp || p.time || p.seen); });
        var altitudes = points.map(function (p) { return p.altitude || p.alt_baro || p.alt || null; });
        var speeds = points.map(function (p) { return p.speed || p.ground_speed || p.gs || null; });

        var chartDefaults = {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: {
                    type: 'time',
                    grid: { color: 'rgba(139,92,246,0.08)' },
                    ticks: { color: '#9b8fbf', font: { size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(139,92,246,0.08)' },
                    ticks: { color: '#9b8fbf', font: { size: 10 } }
                }
            }
        };

        var altCtx = document.getElementById('adsbAltitudeChart');
        if (altCtx) {
            altitudeChart = new Chart(altCtx, {
                type: 'line',
                data: {
                    labels: times,
                    datasets: [{
                        data: altitudes,
                        borderColor: '#a78bfa',
                        backgroundColor: 'rgba(167,139,250,0.1)',
                        borderWidth: 1.5,
                        pointRadius: 1,
                        fill: true,
                        tension: 0.2
                    }]
                },
                options: Object.assign({}, chartDefaults)
            });
        }

        var spdCtx = document.getElementById('adsbSpeedChart');
        if (spdCtx) {
            speedChart = new Chart(spdCtx, {
                type: 'line',
                data: {
                    labels: times,
                    datasets: [{
                        data: speeds,
                        borderColor: '#34d399',
                        backgroundColor: 'rgba(52,211,153,0.1)',
                        borderWidth: 1.5,
                        pointRadius: 1,
                        fill: true,
                        tension: 0.2
                    }]
                },
                options: Object.assign({}, chartDefaults)
            });
        }
    }

    function renderAdsbTimelineEvents(points) {
        var container = document.getElementById('adsbTimelineEvents');
        if (!container) return;
        if (!points.length) {
            container.innerHTML = '<div class="history-empty-state">No timeline data</div>';
            return;
        }

        // Show last 50 points in reverse chronological order
        var recent = points.slice(-50).reverse();
        container.innerHTML = recent.map(function (p) {
            var time = fmtDate(p.timestamp || p.time || p.seen);
            var alt = p.altitude || p.alt_baro || p.alt || '--';
            var spd = p.speed || p.ground_speed || p.gs || '--';
            var hdg = p.heading || p.track || '--';
            var sq = p.squawk || '--';

            return '<div class="adsb-timeline-row">' +
                '<span class="tl-time">' + esc(time) + '</span>' +
                '<div class="tl-data">' +
                    '<span>ALT ' + esc(String(alt)) + '</span>' +
                    '<span>SPD ' + esc(String(spd)) + '</span>' +
                    '<span>HDG ' + esc(String(hdg)) + '</span>' +
                    '<span>SQ ' + esc(String(sq)) + '</span>' +
                '</div>' +
            '</div>';
        }).join('');
    }

    function closeAdsbTimeline() {
        var panel = document.getElementById('adsbTimelinePanel');
        if (panel) panel.style.display = 'none';
        if (altitudeChart) { altitudeChart.destroy(); altitudeChart = null; }
        if (speedChart) { speedChart.destroy(); speedChart = null; }
    }

    // ==========================================================
    //  TSCM REPORTS
    // ==========================================================
    function loadTscmSummary() {
        fetch('/tscm/threats/summary')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var summary = data.summary || data;
                setTextById('tscmCriticalCount', summary.critical || 0);
                setTextById('tscmHighCount', summary.high || 0);
                setTextById('tscmMediumCount', summary.medium || 0);
                setTextById('tscmLowCount', summary.low || 0);
            })
            .catch(function (err) {
                console.error('[History] TSCM summary failed', err);
            });
    }

    function loadTscmThreats() {
        fetch('/tscm/threats?limit=100')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                tscmThreats = data.threats || data.items || [];
                renderTscmThreats();
            })
            .catch(function (err) {
                console.error('[History] TSCM threats failed', err);
                var list = document.getElementById('tscmThreatList');
                if (list) list.innerHTML = '<div class="history-empty-state">Failed to load threats</div>';
            });
    }

    function renderTscmThreats() {
        var list = document.getElementById('tscmThreatList');
        if (!list) return;
        if (!tscmThreats.length) {
            list.innerHTML = '<div class="history-empty-state">No threats detected</div>';
            return;
        }

        list.innerHTML = tscmThreats.map(function (t, idx) {
            var severity = (t.severity || t.level || 'low').toLowerCase();
            var desc = t.description || t.message || t.detail || 'Unknown threat';
            var time = t.timestamp || t.detected_at || t.time || '';
            var acked = t.acknowledged || false;

            return '<div class="tscm-threat-item">' +
                '<span class="tscm-severity-badge ' + esc(severity) + '">' + esc(severity) + '</span>' +
                '<div class="tscm-threat-body">' +
                    '<div class="tscm-threat-desc">' + esc(desc) + '</div>' +
                    (time ? '<div class="tscm-threat-time">' + fmtDate(time) + '</div>' : '') +
                '</div>' +
                '<div class="tscm-threat-actions">' +
                    (acked
                        ? '<span class="history-btn history-btn-sm" style="opacity:0.5;cursor:default;border:1px solid var(--border-color);color:var(--text-dim);">Acked</span>'
                        : '<button class="history-btn history-btn-success history-btn-sm" onclick="HistoryPage.acknowledgeThreat(' + idx + ', this)">Acknowledge</button>') +
                '</div>' +
            '</div>';
        }).join('');
    }

    function acknowledgeThreat(index, btnEl) {
        // Optimistic UI update
        if (tscmThreats[index]) {
            tscmThreats[index].acknowledged = true;
        }
        if (btnEl) {
            btnEl.outerHTML = '<span class="history-btn history-btn-sm" style="opacity:0.5;cursor:default;border:1px solid var(--border-color);color:var(--text-dim);">Acked</span>';
        }

        // If the threat has an id, POST to acknowledge endpoint (best-effort)
        var threat = tscmThreats[index];
        if (threat && threat.id) {
            fetch('/tscm/threats/' + encodeURIComponent(threat.id) + '/acknowledge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }).catch(function () { /* silent - already updated UI */ });
        }
    }

    function downloadTscmPdf() {
        window.open('/tscm/report/pdf', '_blank');
    }

    function loadTscmReport() {
        var viewer = document.getElementById('tscmReportViewer');
        if (!viewer) return;
        viewer.innerHTML = '<div class="history-empty-state"><span class="history-spinner"></span>Loading report...</div>';

        fetch('/tscm/report')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var json = JSON.stringify(data, null, 2);
                viewer.innerHTML = '<pre class="tscm-report-json">' + esc(json) + '</pre>';
            })
            .catch(function (err) {
                console.error('[History] TSCM report failed', err);
                viewer.innerHTML = '<div class="history-empty-state">Failed to load TSCM report</div>';
            });
    }

    // ==========================================================
    //  UTILITIES
    // ==========================================================
    function setTextById(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    // UTC clock for header
    function startUtcClock() {
        function tick() {
            var now = new Date();
            var utc = now.toISOString().slice(11, 19);
            setTextById('historyUtcTime', utc);
        }
        tick();
        setInterval(tick, 1000);
    }

    // ==========================================================
    //  INITIALIZATION
    // ==========================================================
    function init() {
        startUtcClock();
        loadRecordings();
        startActiveRefresh();
    }

    // Boot on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ==========================================================
    //  PUBLIC API
    // ==========================================================
    return {
        switchTab: switchTab,
        loadRecordings: loadRecordings,
        startRecording: startRecording,
        stopRecording: stopRecording,
        downloadRecording: downloadRecording,
        showRecordingDetail: showRecordingDetail,
        closeRecordingDetail: closeRecordingDetail,
        setAdsbRange: setAdsbRange,
        setAdsbCustomRange: setAdsbCustomRange,
        searchAdsb: searchAdsb,
        showAdsbTimeline: showAdsbTimeline,
        closeAdsbTimeline: closeAdsbTimeline,
        loadTscmThreats: loadTscmThreats,
        loadTscmReport: loadTscmReport,
        acknowledgeThreat: acknowledgeThreat,
        downloadTscmPdf: downloadTscmPdf
    };
})();
