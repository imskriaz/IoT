'use strict';

const fs = require('fs');
const path = require('path');

describe('common.js HTTP bridge fetch notices', () => {
    test('suppresses stale live-connection warnings for healthy HTTP bridge devices', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'common.js'), 'utf8');

        expect(source).toContain("const httpDeviceHealthy = isDeviceAction");
        expect(source).toContain("typeof window.deviceHttpOnline === 'function'");
        expect(source).toContain('&& window.deviceHttpOnline() === true;');
        expect(source).toContain("if (isDeviceAction && !httpDeviceHealthy && window._serverConnected === false)");
        expect(source).toContain("if (isDeviceAction && !httpDeviceHealthy && window._serverConnected !== false && window._mqttConnected === false)");
    });
});
