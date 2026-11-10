/* Receiver identity shared by the Aircraft Radar controls. */
(function(root) {
    'use strict';

    const choices = new WeakMap();
    const watched = new WeakSet();
    const storageKey = 'aircraftReceiverSelections';
    const families = {
        rtlsdr: 'RTL-SDR', hackrf: 'HackRF', limesdr: 'LimeSDR',
        airspy: 'Airspy', sdrplay: 'SDRplay'
    };

    function family(value = 'rtlsdr') {
        const normalized = String(value).toLowerCase();
        const canonical = { rtl_sdr: 'rtlsdr', 'rtl-sdr': 'rtlsdr', rtl: 'rtlsdr',
            lime: 'limesdr', lime_sdr: 'limesdr' }[normalized] || normalized;
        return Object.hasOwn(families, canonical) ? canonical : null;
    }

    function receiver(device, fallbackIndex = 0) {
        if (!device) return null;
        const rawIndex = device.index ?? device.device ?? device.device_index ?? fallbackIndex;
        const index = Number(rawIndex);
        const sdrType = family(device.sdr_type ?? device.driver ?? device.type ?? 'rtlsdr');
        if (!sdrType || rawIndex === '' || !Number.isInteger(index) || index < 0) return null;
        return { device: index, sdr_type: sdrType };
    }

    function key(value) {
        const parsed = receiver(value);
        return parsed ? `${parsed.sdr_type}:${parsed.device}` : '';
    }

    function parse(value) {
        const match = /^([a-z_]+):(\d+)$/.exec(String(value));
        return match ? receiver({ sdr_type: match[1], device: match[2] }) : null;
    }

    function read(select, rtlOnly = false) {
        const selected = select ? parse(select.value) : null;
        return selected && (!rtlOnly || selected.sdr_type === 'rtlsdr') ? selected : null;
    }

    function same(left, right) {
        return Boolean(left && right && key(left) && key(left) === key(right));
    }

    function savedChoice(select, source) {
        try {
            const saved = JSON.parse(root.localStorage?.getItem(storageKey) || '{}');
            return saved[String(source)]?.[select.id];
        } catch (error) { return undefined; }
    }

    function saveChoice(select) {
        const source = select.dataset.receiverSource;
        if (source === undefined || !parse(select.value)) return;
        const selections = choices.get(select) || new Map();
        selections.set(source, select.value);
        choices.set(select, selections);
        try {
            const saved = JSON.parse(root.localStorage?.getItem(storageKey) || '{}');
            saved[source] = { ...(saved[source] || {}), [select.id]: select.value };
            root.localStorage?.setItem(storageKey, JSON.stringify(saved));
        } catch (error) { /* Receiver selection still works when storage is unavailable. */ }
    }

    function populate(select, devices, { source = 'local', rtlOnly = false, preferred = '', avoid = '' } = {}) {
        if (!select) return;
        const selections = choices.get(select) || new Map();
        const previousSource = select.dataset.receiverSource;
        if (previousSource !== undefined && parse(select.value)) {
            selections.set(previousSource, select.value);
        }
        choices.set(select, selections);
        const remembered = selections.get(String(source)) || savedChoice(select, source);
        const wasUnavailable = select.dataset.receiverUnavailable === 'true';
        const locked = select.disabled && !wasUnavailable;
        select.innerHTML = '';
        const seen = new Set();
        const available = [];
        (devices || []).forEach((device, index) => {
            const parsed = receiver(device, index);
            if (!parsed || (rtlOnly && parsed.sdr_type !== 'rtlsdr')) return;
            const identity = key(parsed);
            if (seen.has(identity)) return;
            seen.add(identity);
            const option = (select.ownerDocument || document).createElement('option');
            option.value = identity;
            option.dataset.sdrType = parsed.sdr_type;
            option.dataset.deviceIndex = String(parsed.device);
            const name = device.name || device.label || '';
            option.textContent = `${families[parsed.sdr_type]} ${parsed.device}${name ? ': ' + name : ''}`;
            select.appendChild(option);
            available.push(identity);
        });
        if (!available.length) {
            const option = (select.ownerDocument || document).createElement('option');
            option.value = '';
            option.textContent = rtlOnly ? 'No RTL-SDR found' : 'No SDR found';
            select.appendChild(option);
        }
        select.value = available.includes(remembered) ? remembered
            : available.includes(preferred) ? preferred
            : available.find(identity => identity !== avoid) || available[0] || '';
        select.dataset.receiverSource = String(source);
        select.dataset.receiverUnavailable = String(!available.length);
        select.disabled = !available.length || locked;
        if (!watched.has(select)) {
            select.addEventListener('change', () => saveChoice(select));
            watched.add(select);
        }
    }

    function fromStatus(status) {
        if (status.receiver) return receiver(status.receiver);
        const session = status.session || {};
        const index = status.active_device ?? session.device_index ?? status.device ?? status.params?.device;
        if (index === undefined || index === null) return null;
        return receiver({ device: index, sdr_type: status.active_sdr_type ?? session.sdr_type ?? status.sdr_type ?? status.params?.sdr_type ?? 'rtlsdr' });
    }

    const api = { receiver, key, parse, read, same, populate, fromStatus };
    root.AircraftReceivers = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
