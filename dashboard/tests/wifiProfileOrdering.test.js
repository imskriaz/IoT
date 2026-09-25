'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/modem.js'), 'utf8');
const start = source.indexOf('function getWifiDisplayEntries(');
const end = source.indexOf('function updateWifiNetworksSummary(', start);

function getEntries(view, fresh = true) {
    const context = vm.createContext({
        wifiNetworkView: view,
        currentStatus: { networkTelemetryFresh: fresh, wifiClient: { ssid: 'Active', connected: true } },
        getKnownWifiNetworks: () => [
            { ssid: 'Active', priority: 90 },
            { ssid: 'Preferred', priority: 1 },
            { ssid: 'Default' },
            { ssid: 'Second', priority: 2 }
        ],
        isOpenWifiSecurityValue: () => false
    });
    vm.runInContext(source.slice(start, end), context);
    return context.getWifiDisplayEntries([{ ssid: 'Active', signal: 99 }]);
}

function entries(view) {
    return getEntries(view).map(entry => entry.ssid);
}

test('known networks use saved order even if a lower-ranked network is connected', () => {
    expect(Array.from(entries('saved'))).toEqual(['Preferred', 'Second', 'Default', 'Active']);
});

test('all networks still place the connected network first', () => {
    expect(entries('all')[0]).toBe('Active');
    expect(getEntries('all')[0].connected).toBe(true);
});

test('a stale status cannot leave a saved network marked connected', () => {
    expect(getEntries('all', false).some(entry => entry.connected)).toBe(false);
});
