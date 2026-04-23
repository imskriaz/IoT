'use strict';

const fs = require('fs');
const path = require('path');

describe('main.js device HTTP helper export', () => {
    test('exports window.deviceHttpOnline without recursive self-calls', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');

        expect(source).toContain('function inferDeviceHttpOnline(status = latestDeviceStatus)');
        expect(source).toContain('window.deviceHttpOnline = function () {');
        expect(source).toContain('return inferDeviceHttpOnline(latestDeviceStatus);');
        expect(source).not.toContain('return deviceHttpOnline(latestDeviceStatus);');
    });
});
