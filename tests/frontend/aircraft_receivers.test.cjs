const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const AircraftReceivers = require('../../static/js/core/aircraft-receivers.js');

const template = fs.readFileSync(path.join(__dirname, '../../templates/adsb_dashboard.html'), 'utf8');
const devices = [
    { index: 0, sdr_type: 'hackrf', name: 'HackRF One' },
    { index: 0, sdr_type: 'rtlsdr', name: 'Nooelec A' },
    { index: 1, sdr_type: 'rtlsdr', name: 'Nooelec B' },
];

class Element {
    constructor(id = '', ownerDocument = null) {
        this.id = id;
        this.ownerDocument = ownerDocument;
        this.dataset = {};
        this.style = {};
        this.children = [];
        this.disabled = false;
        this.listeners = {};
        this._value = '';
        this.textContent = '';
        this.classList = { add() {}, remove() {}, toggle() {} };
    }
    set innerHTML(value) { this.children = []; this._value = ''; }
    get innerHTML() { return ''; }
    set value(value) { this._value = String(value); }
    get value() { return this._value; }
    appendChild(option) { this.children.push(option); if (!this._value) this._value = option.value; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    change(value) { this.value = value; this.listeners.change?.(); }
    pause() {}
    play() { return Promise.resolve(); }
    load() {}
    removeAttribute() {}
}

function declaration(name) {
    const header = new RegExp(`^( +)(?:async )?function ${name}\\(`, 'm').exec(template);
    assert.ok(header, `actual template function ${name} exists`);
    const end = template.indexOf('\n' + header[1] + '}', header.index);
    assert.ok(end > header.index, `actual template function ${name} closes`);
    return template.slice(header.index, end + header[1].length + 2);
}

function harness() {
    const elements = new Map();
    const document = {
        createElement() { return new Element('', document); },
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new Element(id, document));
            return elements.get(id);
        },
        querySelectorAll() { return []; },
    };
    const calls = [];
    const alerts = [];
    const context = {
        AircraftReceivers, document, console: { log() {}, warn() {}, debug() {}, error() {} },
        isTracking: false, adsbCurrentAgent: 'local', currentAgent: 'local', adsbTrackingSource: null,
        adsbActiveDevice: null, isAcarsRunning: false, acarsCurrentAgent: null, acarsEventSource: null,
        acarsPollTimer: null, uatTracking: false, isAirbandPlaying: false, stats: {},
        getRemoteDump1090Config: () => null, getBiasTEnabled: () => false,
        getAcarsRegionFreqs: () => ['131.550'], getAirbandFrequency: () => 121.5,
        startEventStream() {}, stopEventStream() {}, drawRangeRings() {}, startSessionTimer() {},
        updateTrackingStatusDisplay() {}, updateSourceIndicator() {}, updateAgentStatus() {},
        initAirbandVisualizer() {}, startAcarsStream() {}, setInterval() {}, clearInterval() {},
        setTimeout(fn) { fn(); return 1; },
        alert(message) { alerts.push(message); },
        confirm() { throw new Error('A different receiver must not trigger a same-receiver warning'); },
        fetch: async (url, options = {}) => {
            calls.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
            const data = url === '/devices' ? devices : { status: 'started', running: false };
            return { ok: true, json: async () => data, text: async () => JSON.stringify(data) };
        },
    };
    context.window = context;
    const names = [
        'populateAdsbDeviceSelects', 'restoreAdsbReceiver', 'toggleTracking', 'tryAutoStartLocal',
        'startAirband', 'startAcars', 'setAcarsRunning', 'syncAcarsReceiverStatus',
        'toggleUat', 'setUatEnabled', 'syncUatReceiverStatus', 'syncLocalTrackingStatus',
        'setADSBRunning', 'refreshAgentDevicesForAdsb', 'syncRemoteAdsbReceiverStatus',
        'initDeviceSelectors', 'populateUatDevices',
    ];
    vm.createContext(context);
    vm.runInContext(names.map(declaration).join('\n'), context);
    document.getElementById('airbandSquelch').value = '0';
    document.getElementById('airbandVolume').value = '80';
    document.getElementById('uatGain').value = '40';
    return { context, document, calls, alerts };
}

test('all inline dashboard scripts parse after template expansion', () => {
    for (const match of template.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
        const code = match[1].replace(/\{\{[\s\S]*?\}\}/g, 'null').replace(/\{%[\s\S]*?%\}/g, '');
        new vm.Script(code);
    }
    assert.ok(template.includes("filename='js/core/aircraft-receivers.js'"));
    assert.ok(template.includes('window.selectAgent = selectAdsbAgent'));
    assert.ok(!template.includes('d.index || i'));
    assert.ok(!template.includes('loadDevices()'));
});

test('mixed families get distinct values and correctly label actual zero indices', () => {
    const { context, document } = harness();
    context.populateAdsbDeviceSelects(devices, 'local');
    const adsb = document.getElementById('adsbDeviceSelect');
    assert.deepEqual(adsb.children.map(option => option.value), ['hackrf:0', 'rtlsdr:0', 'rtlsdr:1']);
    assert.match(adsb.children[1].textContent, /^RTL-SDR 0:/);
    assert.equal(adsb.value, 'rtlsdr:0');
    for (const id of ['acarsDeviceSelect', 'uatDeviceSelect']) {
        const select = document.getElementById(id);
        assert.deepEqual(select.children.map(option => option.value), ['rtlsdr:0', 'rtlsdr:1']);
        assert.equal(select.value, 'rtlsdr:1');
    }
});

test('refresh and local/remote source round trips preserve independent selections', () => {
    const { context, document } = harness();
    const select = document.getElementById('adsbDeviceSelect');
    context.populateAdsbDeviceSelects(devices, 'local');
    select.change('hackrf:0');
    context.populateAdsbDeviceSelects([...devices].reverse(), 'local');
    assert.equal(select.value, 'hackrf:0');
    context.populateAdsbDeviceSelects(devices, 'agent-7');
    select.change('rtlsdr:1');
    context.populateAdsbDeviceSelects(devices, 'local');
    assert.equal(select.value, 'hackrf:0');
    context.populateAdsbDeviceSelects(devices, 'agent-7');
    assert.equal(select.value, 'rtlsdr:1');
});

test('no compatible RTL receiver disables ACARS/UAT instead of inventing device zero', () => {
    const { context, document } = harness();
    context.populateAdsbDeviceSelects([devices[0]], 'local');
    for (const id of ['acarsDeviceSelect', 'uatDeviceSelect']) {
        assert.equal(document.getElementById(id).disabled, true);
        assert.equal(AircraftReceivers.read(document.getElementById(id), true), null);
    }
});

for (const source of ['local', 'agent-7']) {
    test(`ADS-B ${source} request emits selected HackRF family and native index zero`, async () => {
        const { context, document, calls } = harness();
        context.adsbCurrentAgent = source;
        context.populateAdsbDeviceSelects(devices, source);
        document.getElementById('adsbDeviceSelect').value = 'hackrf:0';
        await context.toggleTracking();
        const call = calls[0];
        assert.equal(call.url, source === 'local' ? '/adsb/start' : '/controller/agents/agent-7/adsb/start');
        assert.equal(call.body.device, 0);
        assert.equal(call.body.sdr_type, 'hackrf');
        assert.equal(AircraftReceivers.key(context.adsbActiveDevice), 'hackrf:0');
    });

    test(`ACARS ${source} selection sends actual RTL-SDR 1`, async () => {
        const { context, document, calls } = harness();
        context.adsbCurrentAgent = source;
        context.populateAdsbDeviceSelects(devices, source);
        document.getElementById('acarsDeviceSelect').value = 'rtlsdr:1';
        await context.startAcars();
        const call = calls[0];
        assert.equal(call.url, source === 'local' ? '/acars/start' : '/controller/agents/agent-7/acars/start');
        assert.equal(call.body.device, 1);
        assert.equal(call.body.sdr_type, 'rtlsdr');
    });
}

test('airband recognizes different physical family at same index and sends its family', async () => {
    const { context, document, calls } = harness();
    context.populateAdsbDeviceSelects(devices, 'local');
    context.isTracking = true;
    context.adsbTrackingSource = 'local';
    context.adsbActiveDevice = { device: 0, sdr_type: 'hackrf' };
    document.getElementById('airbandDeviceSelect').value = 'rtlsdr:0';
    await context.startAirband();
    assert.equal(calls[0].url, '/listening/audio/start');
    assert.equal(calls[0].body.device, 0);
    assert.equal(calls[0].body.sdr_type, 'rtlsdr');
});

test('UAT preserves valid device zero and gain zero in its start payload', async () => {
    const { context, document, calls } = harness();
    context.populateAdsbDeviceSelects(devices, 'local');
    document.getElementById('uatDeviceSelect').value = 'rtlsdr:0';
    document.getElementById('uatGain').value = '0';
    await context.toggleUat();
    assert.equal(calls[0].url, '/uat/start');
    assert.equal(calls[0].body.device, 0);
    assert.equal(calls[0].body.sdr_type, 'rtlsdr');
    assert.equal(calls[0].body.gain, 0);
});

test('local auto-start preserves selected receiver family instead of taking array element zero', async () => {
    const { context, document, calls } = harness();
    context.populateAdsbDeviceSelects(devices, 'local');
    document.getElementById('adsbDeviceSelect').value = 'rtlsdr:1';
    await context.tryAutoStartLocal();
    const call = calls.find(call => call.url === '/adsb/start');
    assert.equal(call.body.device, 1);
    assert.equal(call.body.sdr_type, 'rtlsdr');
});

test('status restores running ACARS device zero and disables the selector', async () => {
    const { context, document } = harness();
    context.populateAdsbDeviceSelects(devices, 'local');
    context.fetch = async () => ({ ok: true, json: async () => ({ running: true, receiver: { device: 0, sdr_type: 'rtlsdr' } }) });
    await context.syncAcarsReceiverStatus('local');
    assert.equal(document.getElementById('acarsDeviceSelect').value, 'rtlsdr:0');
    assert.equal(document.getElementById('acarsDeviceSelect').disabled, true);
    assert.equal(context.isAcarsRunning, true);
});

test('session restoration distinguishes HackRF zero from RTL zero', () => {
    const { context, document } = harness();
    context.populateAdsbDeviceSelects(devices, 'local');
    context.restoreAdsbReceiver({ tracking_active: true, session: { device_index: 0, sdr_type: 'hackrf' } });
    assert.equal(document.getElementById('adsbDeviceSelect').value, 'hackrf:0');
    assert.equal(AircraftReceivers.key(context.adsbActiveDevice), 'hackrf:0');
});

test('local inactive status clears a previous remote running state', async () => {
    const { context } = harness();
    context.isTracking = true;
    context.adsbTrackingSource = 'agent-7';
    context.adsbActiveDevice = { device: 1, sdr_type: 'rtlsdr' };
    context.fetch = async () => ({ ok: true, json: async () => ({ tracking_active: false }) });
    await context.syncLocalTrackingStatus();
    assert.equal(context.isTracking, false);
    assert.equal(context.adsbActiveDevice, null);
});

test('a delayed remote device refresh cannot overwrite a newer local selection', async () => {
    const { context, document } = harness();
    context.populateAdsbDeviceSelects(devices, 'local');
    document.getElementById('adsbDeviceSelect').value = 'hackrf:0';
    let resolve;
    context.fetch = () => new Promise(done => { resolve = done; });
    context.adsbCurrentAgent = 'agent-7';
    const pending = context.refreshAgentDevicesForAdsb('agent-7');
    context.adsbCurrentAgent = 'local';
    resolve({ json: async () => ({ agent: { interfaces: { sdr_devices: [devices[2]] } } }) });
    await pending;
    assert.equal(document.getElementById('adsbDeviceSelect').value, 'hackrf:0');
});

test('remote-source controls never start local UAT or airband reception', async () => {
    const { context, calls } = harness();
    context.adsbCurrentAgent = 'agent-7';
    await context.toggleUat();
    await context.startAirband();
    assert.equal(calls.length, 0);
});

test('a delayed auto-start device fetch cannot start local reception after switching remote', async () => {
    const { context, calls } = harness();
    let resolve;
    context.fetch = (url, options) => {
        calls.push({ url, options });
        return new Promise(done => { resolve = done; });
    };
    const pending = context.tryAutoStartLocal();
    context.adsbCurrentAgent = 'agent-7';
    resolve({ ok: true, json: async () => devices });
    await pending;
    assert.deepEqual(calls.map(call => call.url), ['/devices']);
    assert.equal(context.isTracking, false);
});

test('user receiver selections survive a browser reload through local storage', () => {
    const saved = new Map();
    global.localStorage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) };
    try {
        const first = harness();
        first.context.populateAdsbDeviceSelects(devices, 'local');
        first.document.getElementById('adsbDeviceSelect').change('hackrf:0');
        first.document.getElementById('acarsDeviceSelect').change('rtlsdr:0');
        const reloaded = harness();
        reloaded.context.populateAdsbDeviceSelects([...devices].reverse(), 'local');
        assert.equal(reloaded.document.getElementById('adsbDeviceSelect').value, 'hackrf:0');
        assert.equal(reloaded.document.getElementById('acarsDeviceSelect').value, 'rtlsdr:0');
    } finally {
        delete global.localStorage;
    }
});
