'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/gpio.js'), 'utf8');

function harness() {
    const elements = new Map();
    const callbacks = {};
    const socketCallbacks = {};
    const element = id => {
        if (id === 'inputDisplay') return null; // Not present in the actual template.
        if (!elements.has(id)) elements.set(id, {
            textContent: '', innerHTML: '', value: '', style: {},
            classList: { toggle: jest.fn() },
            addEventListener: jest.fn(),
            querySelector: () => null
        });
        return elements.get(id);
    };
    const fetch = jest.fn(async url => ({ json: async () => url.includes('/status?') ? {
        success: true, data: { online: true, cached: false, rules: [], groups: [], pins: [{
            pin: 2, value: 1, config: { mode: 'input_output' }, capabilities: { digital: true }
        }] }
    } : { success: true, data: { history: [] } } }));
    const window = {
        getActiveDeviceId: () => 'device-a',
        addEventListener: (event, callback) => { callbacks[event] = callback; },
        socket: { on: (event, callback) => { socketCallbacks[event] = callback; } }
    };
    const document = {
        readyState: 'loading', visibilityState: 'visible',
        getElementById: element,
        addEventListener: (event, callback) => { callbacks[event] = callback; },
        querySelector: () => null
    };
    class Modal { show() {} static getInstance() { return { hide() {} }; } }
    const ctx = vm.createContext({ window, document, fetch, console: { log() {}, error() {} },
        setTimeout: jest.fn(), clearTimeout: jest.fn(), setInterval: jest.fn(), clearInterval: jest.fn(),
        bootstrap: { Modal }, showToast: jest.fn(), escapeHtml: String });
    vm.runInContext(source, ctx);
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    return { window, callbacks, socketCallbacks, element, fetch, flush };
}

test('initial GPIO load coalesces concurrent refreshes and modal works with actual absent DOM fields', async () => {
    const h = harness();
    h.callbacks.DOMContentLoaded();
    h.window.refreshGPIO();
    h.window.refreshGPIO();
    await h.flush();
    expect(h.fetch.mock.calls.filter(([url]) => url.includes('/status?'))).toHaveLength(1);
    expect(() => h.window.openPinModal(2)).not.toThrow();
    expect(h.element('modalPinNumber').textContent).toBe(2);
});

test('sensor updates must match the selected device and offline status clears live readings', async () => {
    const h = harness();
    h.callbacks.DOMContentLoaded();
    await h.flush();
    h.socketCallbacks['device:status']({ deviceId: 'device-b', online: true, lastSeen: new Date().toISOString(), battery: 99 });
    expect(h.element('sBattery').textContent).toBe('');
    h.socketCallbacks['device:status']({ deviceId: 'device-a', online: true, lastSeen: new Date().toISOString(), battery: 80 });
    expect(h.element('sBattery').textContent).toBe('80%');
    h.socketCallbacks['device:status']({ deviceId: 'device-a', online: false, battery: 80 });
    expect(h.element('sBattery').textContent).toBe('—');
    expect(h.element('sensorAge').textContent).toBe('Offline');
});

test('late GPIO response from previous device cannot overwrite selected device', async () => {
    const h = harness();
    let resolveOld;
    h.fetch.mockImplementation(url => url.includes('status?deviceId=device-a')
        ? new Promise(resolve => { resolveOld = resolve; })
        : Promise.resolve({ json: async () => ({ success: true, data: {
            online: false, cached: true, pins: [], rules: [], groups: []
        } }) }));
    h.callbacks.DOMContentLoaded();
    h.callbacks['device:changed']({ detail: { deviceId: 'device-b' } });
    await h.flush();
    resolveOld({ json: async () => ({ success: true, data: {
        online: true, cached: false, pins: [{ pin: 2, value: 1 }], rules: [], groups: []
    } }) });
    await h.flush();
    expect(h.element('pinsGrid').innerHTML).toBe('');
    expect(h.element('deviceStatus').innerHTML).toContain('Cached / unavailable');
});

test('pulse seconds are converted once to milliseconds', async () => {
    const h = harness();
    h.fetch.mockResolvedValue({ json: async () => ({ success: false, message: 'fixture' }) });
    await h.window.writePin(2, 1, 'digital', 0, null, 0.5);
    const [, request] = h.fetch.mock.calls[0];
    expect(JSON.parse(request.body).duration).toBe(500);
});
