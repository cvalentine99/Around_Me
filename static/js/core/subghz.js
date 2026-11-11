/**
 * Sub-GHz page: HackRF receive (IQ capture), rtl_433 decoding, spectrum sweep,
 * capture library and replay. Talks to the /subghz/* API.
 */
var SubGhz = (function () {
    'use strict';

    var config = window.SUBGHZ_CONFIG || {};
    var state = {
        mode: 'idle',
        lastMode: 'idle',
        captures: [],
        sweep: {},
        decodeCount: 0,
        eventSource: null,
        statusTimer: null,
        spectrumTitle: 'Spectrum'
    };
    var MAX_LOG_LINES = 300;
    var MAX_DECODE_ROWS = 200;

    function $(id) { return document.getElementById(id); }

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ------------------------------------------------------------------ API

    function api(path, options) {
        options = options || {};
        var init = { method: options.method || 'GET', headers: {} };
        if (options.body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(options.body);
        }
        return fetch(path, init).then(function (response) {
            return response.text().then(function (text) {
                var data;
                try {
                    data = text ? JSON.parse(text) : {};
                } catch (err) {
                    // An expired session redirects to the HTML login page
                    throw new Error(response.redirected || response.status === 401
                        ? 'Session expired - reload the page and log in'
                        : 'Unexpected response from server (' + response.status + ')');
                }
                if (!response.ok || data.status === 'error') {
                    throw new Error(data.message || data.error || ('Request failed (' + response.status + ')'));
                }
                return data;
            });
        });
    }

    function setMessage(text, kind) {
        var el = $('controlMessage');
        el.textContent = text || '';
        el.className = 'sg-message' + (kind ? ' ' + kind : '');
    }

    function log(text, kind) {
        var el = $('eventLog');
        var line = document.createElement('div');
        if (kind) line.className = kind;
        var time = new Date().toISOString().substring(11, 19);
        line.innerHTML = '<span class="time">' + time + '</span>' + escapeHtml(text);
        el.appendChild(line);
        while (el.childNodes.length > MAX_LOG_LINES) el.removeChild(el.firstChild);
        el.scrollTop = el.scrollHeight;
    }

    // ------------------------------------------------------------------ Tuning

    function frequencyHz() {
        var mhz = parseFloat($('freqInput').value);
        if (isNaN(mhz) || mhz < config.freq_min_mhz || mhz > config.freq_max_mhz) {
            throw new Error('Frequency must be between ' + config.freq_min_mhz + ' and ' + config.freq_max_mhz + ' MHz');
        }
        return Math.round(mhz * 1e6);
    }

    function tuning() {
        return {
            frequency_hz: frequencyHz(),
            sample_rate: parseInt($('sampleRateSelect').value, 10) || 2000000,
            lna_gain: parseInt($('lnaGain').value, 10) || 0,
            vga_gain: parseInt($('vgaGain').value, 10) || 0
        };
    }

    function loadPresets() {
        return api('/subghz/presets').then(function (data) {
            var presetSelect = $('presetSelect');
            Object.keys(data.presets || {}).forEach(function (freq) {
                var option = document.createElement('option');
                option.value = freq;
                option.textContent = freq + ' MHz - ' + data.presets[freq];
                presetSelect.appendChild(option);
            });
            var rateSelect = $('sampleRateSelect');
            (data.sample_rates || [2000000]).forEach(function (rate) {
                var option = document.createElement('option');
                option.value = rate;
                option.textContent = (rate / 1e6) + ' MS/s';
                rateSelect.appendChild(option);
            });
        }).catch(function (err) {
            setMessage('Could not load presets: ' + err.message, 'error');
        });
    }

    // ------------------------------------------------------------------ Start / stop

    function run(label, path, body) {
        setMessage(label + '...');
        return api(path, { method: 'POST', body: body }).then(function (data) {
            setMessage(label + ' started', 'ok');
            log(label + ' started');
            refreshStatus();
            return data;
        }).catch(function (err) {
            setMessage(err.message, 'error');
            log(label + ' failed: ' + err.message, 'error');
            refreshStatus();
        });
    }

    function startCapture() {
        var body;
        try { body = tuning(); } catch (err) { setMessage(err.message, 'error'); return; }
        body.trigger_enabled = $('triggerEnabled').checked;
        body.trigger_pre_ms = parseInt($('triggerPre').value, 10) || 350;
        body.trigger_post_ms = parseInt($('triggerPost').value, 10) || 700;
        state.spectrumTitle = 'Spectrum - capture at ' + (body.frequency_hz / 1e6).toFixed(3) + ' MHz';
        run('Capture', '/subghz/receive/start', body);
    }

    function startDecode() {
        var body;
        try { body = tuning(); } catch (err) { setMessage(err.message, 'error'); return; }
        body.decode_profile = $('decodeProfile').value;
        state.spectrumTitle = 'Spectrum - decoding at ' + (body.frequency_hz / 1e6).toFixed(3) + ' MHz';
        run('Decoding', '/subghz/decode/start', body);
    }

    function startSweep() {
        var start = parseFloat($('sweepStart').value);
        var end = parseFloat($('sweepEnd').value);
        var bin = parseInt($('sweepBin').value, 10);
        if (isNaN(start) || isNaN(end) || start >= end) {
            setMessage('Sweep start must be below sweep end', 'error');
            return;
        }
        state.sweep = {};
        state.spectrumTitle = 'Sweep ' + start + '-' + end + ' MHz';
        run('Sweep', '/subghz/sweep/start', {
            freq_start_mhz: start,
            freq_end_mhz: end,
            bin_width: (isNaN(bin) ? 100 : bin) * 1000
        });
    }

    var STOP_PATHS = {
        rx: '/subghz/receive/stop',
        decode: '/subghz/decode/stop',
        sweep: '/subghz/sweep/stop',
        tx: '/subghz/transmit/stop'
    };

    function stopActive() {
        var path = STOP_PATHS[state.mode];
        if (!path) {
            refreshStatus();
            return;
        }
        var wasCapture = state.mode === 'rx';
        setMessage('Stopping...');
        api(path, { method: 'POST' }).then(function (data) {
            setMessage('Stopped', 'ok');
            log('Stopped' + (data.duration_seconds ? ' after ' + data.duration_seconds + ' s' : ''));
            if (wasCapture) loadCaptures();
        }).catch(function (err) {
            setMessage(err.message, 'error');
        }).then(refreshStatus);
    }

    // ------------------------------------------------------------------ Status

    function refreshStatus() {
        return api('/subghz/status').then(function (status) {
            state.lastMode = state.mode;
            state.mode = status.mode || 'idle';
            var busy = state.mode !== 'idle';
            $('modeText').textContent = {
                idle: 'IDLE', rx: 'CAPTURING', decode: 'DECODING', sweep: 'SWEEPING', tx: 'TRANSMITTING'
            }[state.mode] || state.mode.toUpperCase();
            $('modeDot').className = 'sg-dot ' + state.mode;
            var hackrf = status.hackrf_connected;
            $('hackrfState').textContent = !status.hackrf_available ? 'TOOLS MISSING'
                : (hackrf === true ? 'CONNECTED' : (hackrf === false ? 'NOT FOUND' : (busy ? 'IN USE' : '--')));
            var active = status[state.mode] || {};
            $('elapsedText').textContent = active.elapsed_seconds !== undefined
                ? Math.round(active.elapsed_seconds) + ' s' : '--';
            ['btnCapture', 'btnDecode', 'btnSweep'].forEach(function (id) { $(id).disabled = busy; });
            $('btnStop').disabled = !busy;
            $('btnSweep').title = status.sweep_available === false ? 'hackrf_sweep is not installed' : '';
            if (status.sweep_available === false) $('btnSweep').disabled = true;
            if (state.lastMode === 'rx' && state.mode === 'idle') loadCaptures();
            renderCaptures();
        }).catch(function (err) {
            $('modeText').textContent = 'OFFLINE';
            $('modeDot').className = 'sg-dot';
            setMessage(err.message, 'error');
        });
    }

    // ------------------------------------------------------------------ Live events

    function connectStream() {
        if (state.eventSource) state.eventSource.close();
        state.eventSource = new EventSource('/subghz/stream');
        state.eventSource.onmessage = function (e) {
            var event;
            try { event = JSON.parse(e.data); } catch (err) { return; }
            handleEvent(event);
        };
        // EventSource reconnects by itself after an error
    }

    function handleEvent(event) {
        switch (event.type) {
            case 'keepalive':
                return;
            case 'status':
                if (event.status) log((event.mode || '') + ' ' + event.status);
                refreshStatus();
                return;
            case 'info':
                log(event.text || '');
                return;
            case 'error':
                log(event.message || event.text || 'Error', 'error');
                setMessage(event.message || event.text || 'Error', 'error');
                return;
            case 'rx_level':
            case 'decode_level':
                setLevel(event.level);
                return;
            case 'rx_spectrum':
            case 'decode_spectrum':
                drawSpectrum(event.bins || []);
                return;
            case 'rx_stats':
                $('statsLine').textContent = 'Recorded ' + Math.round(event.elapsed_seconds || 0) + ' s, ' +
                    formatBytes(event.file_size || 0) + (event.rate_kb ? ' (' + event.rate_kb + ' kB/s)' : '');
                return;
            case 'rx_hint':
                $('hintLine').textContent = 'Modulation: ' + (event.modulation_hint || '?') +
                    (event.protocol_hint ? ' | Protocol: ' + event.protocol_hint : '') +
                    (event.confidence !== undefined ? ' | confidence ' + Math.round(event.confidence * 100) + '%' : '');
                return;
            case 'rx_burst':
                log('Burst ' + (event.event || '') + (event.level !== undefined ? ' level ' + event.level : '') +
                    (event.start_offset_s !== undefined ? ' at ' + event.start_offset_s + ' s' : ''));
                return;
            case 'decode':
                addDecoded(event);
                return;
            case 'decode_raw':
                log(event.text || '', 'raw');
                return;
            case 'sweep':
                addSweepPoints(event.points || []);
                return;
            case 'tx_status':
                log('Transmit ' + (event.status || '') + (event.frequency_hz ? ' at ' + (event.frequency_hz / 1e6).toFixed(3) + ' MHz' : ''), 'tx');
                refreshStatus();
                return;
            default:
                return; // waveform frames and other high-rate data are not shown
        }
    }

    function setLevel(level) {
        var value = Number(level);
        if (isNaN(value)) return;
        $('levelFill').style.width = Math.max(0, Math.min(100, value)) + '%';
    }

    // ------------------------------------------------------------------ Spectrum

    function prepareCanvas() {
        var canvas = $('spectrumCanvas');
        var ratio = window.devicePixelRatio || 1;
        var width = canvas.clientWidth;
        var height = canvas.clientHeight;
        if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
        }
        var ctx = canvas.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, width, height);
        return { ctx: ctx, width: width, height: height };
    }

    function drawSeries(values, leftLabel, rightLabel) {
        $('spectrumTitle').textContent = state.spectrumTitle;
        var c = prepareCanvas();
        if (!values.length) return;
        var min = Infinity, max = -Infinity;
        values.forEach(function (v) { if (v < min) min = v; if (v > max) max = v; });
        if (max - min < 1e-9) { max = min + 1; }
        var pad = 18;
        var ctx = c.ctx;
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        for (var g = 1; g < 4; g++) {
            var gy = pad + (c.height - 2 * pad) * g / 4;
            ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(c.width, gy); ctx.stroke();
        }
        ctx.strokeStyle = '#00d4ff';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        values.forEach(function (v, i) {
            var x = values.length === 1 ? c.width / 2 : (i / (values.length - 1)) * c.width;
            var y = c.height - pad - ((v - min) / (max - min)) * (c.height - 2 * pad);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.fillStyle = '#8b98a5';
        ctx.font = '10px monospace';
        ctx.fillText(max.toFixed(1), 4, 12);
        ctx.fillText(min.toFixed(1), 4, c.height - 4);
        if (leftLabel) ctx.fillText(leftLabel, 4, c.height / 2);
        if (rightLabel) {
            var w = ctx.measureText(rightLabel).width;
            ctx.fillText(rightLabel, c.width - w - 4, c.height / 2);
        }
    }

    function drawSpectrum(bins) {
        var values = bins.map(Number).filter(function (v) { return !isNaN(v); });
        drawSeries(values);
    }

    function addSweepPoints(points) {
        points.forEach(function (p) {
            var freq = Number(p.freq), power = Number(p.power);
            if (!isNaN(freq) && !isNaN(power)) state.sweep[freq.toFixed(3)] = power;
        });
        var freqs = Object.keys(state.sweep).map(Number).sort(function (a, b) { return a - b; });
        if (!freqs.length) return;
        drawSeries(freqs.map(function (f) { return state.sweep[f.toFixed(3)]; }),
            freqs[0].toFixed(1) + ' MHz', freqs[freqs.length - 1].toFixed(1) + ' MHz');
    }

    // ------------------------------------------------------------------ Decoded messages

    var DECODE_SKIP = { type: 1, time: 1, model: 1, id: 1, mod: 1, freq: 1, freq1: 1, freq2: 1, rssi: 1, snr: 1, noise: 1 };

    function addDecoded(message) {
        var body = $('decodeRows');
        var empty = body.querySelector('.sg-empty');
        if (empty) empty.remove();
        state.decodeCount += 1;
        $('decodeCount').textContent = state.decodeCount;
        var fields = Object.keys(message).filter(function (k) { return !DECODE_SKIP[k]; })
            .map(function (k) { return k + '=' + (typeof message[k] === 'object' ? JSON.stringify(message[k]) : message[k]); });
        var row = document.createElement('tr');
        row.innerHTML = '<td>' + escapeHtml(message.time || new Date().toISOString().substring(11, 19)) + '</td>' +
            '<td>' + escapeHtml(message.model || '?') + '</td>' +
            '<td>' + escapeHtml(message.id !== undefined ? message.id : '') + '</td>' +
            '<td>' + escapeHtml(fields.join('  ')) + '</td>';
        body.insertBefore(row, body.firstChild);
        while (body.rows.length > MAX_DECODE_ROWS) body.deleteRow(body.rows.length - 1);
    }

    function clearDecoded() {
        state.decodeCount = 0;
        $('decodeCount').textContent = '0';
        $('decodeRows').innerHTML = '<tr class="sg-empty"><td colspan="4">No decoded messages</td></tr>';
    }

    function clearLog() {
        $('eventLog').innerHTML = '';
    }

    // ------------------------------------------------------------------ Captures

    function formatBytes(size) {
        if (size >= 1048576) return (size / 1048576).toFixed(1) + ' MB';
        if (size >= 1024) return (size / 1024).toFixed(0) + ' kB';
        return size + ' B';
    }

    function txAllowed(frequencyHz) {
        var mhz = frequencyHz / 1e6;
        return (config.tx_bands || []).some(function (band) { return mhz >= band[0] && mhz <= band[1]; });
    }

    function loadCaptures() {
        return api('/subghz/captures').then(function (data) {
            state.captures = data.captures || [];
            renderCaptures();
        }).catch(function (err) {
            $('captureList').innerHTML = '<div class="sg-empty-state">' + escapeHtml(err.message) + '</div>';
        });
    }

    function renderCaptures() {
        var list = $('captureList');
        $('captureCount').textContent = state.captures.length;
        if (!state.captures.length) {
            list.innerHTML = '<div class="sg-empty-state">No captures yet. Start a capture to record one.</div>';
            return;
        }
        var busy = state.mode !== 'idle';
        list.innerHTML = state.captures.map(function (c) {
            var title = c.label || ('Capture ' + c.id);
            var hints = [c.protocol_hint, c.modulation_hint].filter(Boolean).join(' / ');
            var protocols = (c.decoded_protocols || []).join(', ');
            var canTx = txAllowed(c.frequency_hz);
            return '<div class="sg-capture">' +
                '<div class="sg-capture-title">' + escapeHtml(title) + '</div>' +
                '<div class="sg-capture-meta">' + (c.frequency_hz / 1e6).toFixed(3) + ' MHz | ' +
                    (c.duration_seconds ? Number(c.duration_seconds).toFixed(1) + ' s | ' : '') +
                    formatBytes(c.size_bytes || 0) + ' | ' + escapeHtml((c.timestamp || '').replace('T', ' ').substring(0, 19)) + '</div>' +
                (hints ? '<div class="sg-capture-meta">' + escapeHtml(hints) + '</div>' : '') +
                (protocols ? '<div class="sg-capture-meta">Decoded: ' + escapeHtml(protocols) + '</div>' : '') +
                '<div class="sg-capture-actions">' +
                    '<a href="/subghz/captures/' + encodeURIComponent(c.id) + '/download">Download</a>' +
                    '<button onclick="SubGhz.renameCapture(\'' + escapeHtml(c.id) + '\')">Rename</button>' +
                    '<button class="replay" onclick="SubGhz.replayCapture(\'' + escapeHtml(c.id) + '\')"' +
                        (canTx && !busy ? '' : ' disabled') +
                        ' title="' + (canTx ? 'Transmit this capture' : 'Outside the allowed transmit bands') + '">Replay</button>' +
                    '<button class="delete" onclick="SubGhz.deleteCapture(\'' + escapeHtml(c.id) + '\')"' + (busy ? ' disabled' : '') + '>Delete</button>' +
                '</div>' +
            '</div>';
        }).join('');
    }

    function findCapture(id) {
        for (var i = 0; i < state.captures.length; i++) if (state.captures[i].id === id) return state.captures[i];
        return null;
    }

    function renameCapture(id) {
        var capture = findCapture(id);
        var label = window.prompt('Label for this capture (max 100 characters):', capture ? (capture.label || '') : '');
        if (label === null) return;
        api('/subghz/captures/' + encodeURIComponent(id), { method: 'PATCH', body: { label: label.substring(0, 100) } })
            .then(loadCaptures)
            .catch(function (err) { setMessage(err.message, 'error'); });
    }

    function deleteCapture(id) {
        if (!window.confirm('Delete this capture? This cannot be undone.')) return;
        api('/subghz/captures/' + encodeURIComponent(id), { method: 'DELETE' })
            .then(function () { log('Deleted capture ' + id); return loadCaptures(); })
            .catch(function (err) { setMessage(err.message, 'error'); });
    }

    function replayCapture(id) {
        var capture = findCapture(id);
        if (!capture) return;
        var mhz = (capture.frequency_hz / 1e6).toFixed(3);
        var seconds = parseInt($('txDuration').value, 10) || config.tx_max_duration;
        if (!window.confirm('Transmit "' + (capture.label || capture.id) + '" on ' + mhz + ' MHz for up to ' +
                seconds + ' s?\n\nOnly transmit where you are permitted to.')) return;
        run('Transmit', '/subghz/transmit', {
            capture_id: id,
            tx_gain: parseInt($('txGain').value, 10) || 0,
            max_duration: seconds
        });
    }

    // ------------------------------------------------------------------ Init

    function describeTxBands() {
        var bands = (config.tx_bands || []).map(function (b) { return b[0] + '-' + b[1] + ' MHz'; }).join(', ');
        $('txNote').textContent = 'Replay sends a capture back out through the HackRF. Allowed bands: ' +
            (bands || 'none') + '. Each transmission stops after at most ' + config.tx_max_duration +
            ' s. You are responsible for transmitting legally.';
    }

    function startClock() {
        function tick() { $('utcTime').textContent = new Date().toISOString().substring(11, 19) + ' UTC'; }
        tick();
        setInterval(tick, 1000);
    }

    function init() {
        describeTxBands();
        startClock();
        $('presetSelect').addEventListener('change', function () {
            if (this.value) $('freqInput').value = this.value;
        });
        window.addEventListener('resize', function () {
            if (Object.keys(state.sweep).length) addSweepPoints([]);
        });
        loadPresets();
        loadCaptures();
        refreshStatus();
        connectStream();
        // Status polling also lets the server release the HackRF once a
        // capture or transmission ends on its own.
        state.statusTimer = setInterval(refreshStatus, 3000);
    }

    document.addEventListener('DOMContentLoaded', init);

    return {
        startCapture: startCapture,
        startDecode: startDecode,
        startSweep: startSweep,
        stopActive: stopActive,
        loadCaptures: loadCaptures,
        renameCapture: renameCapture,
        deleteCapture: deleteCapture,
        replayCapture: replayCapture,
        clearDecoded: clearDecoded,
        clearLog: clearLog,
        _handleEvent: handleEvent,
        _txAllowed: txAllowed
    };
})();
