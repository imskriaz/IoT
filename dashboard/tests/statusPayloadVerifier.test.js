'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

describe('native ESP-IDF 6.1 status payload verifier', () => {
    const workspace = 'esp32-s3-a7670e-idf6.1';
    const verifier = path.resolve(__dirname, '../../firmware/espidf', workspace, 'verify-status-payload.js');
    let directory;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'status-verifier-'));
    });

    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    function verify(payload, ...args) {
        const file = path.join(directory, 'status.json');
        fs.writeFileSync(file, JSON.stringify(payload));
        return spawnSync(process.execPath, [verifier, ...args, file], { encoding: 'utf8' });
    }

    test('accepts the complete release identity contract in strict mode', () => {
        const result = verify({
            device_id: 'device-a', uptime_ms: 1234, status_sequence: 7,
            boot_id: '0123456789abcdef', firmware_elf_sha256: 'a'.repeat(64),
            ota_slot: 'ota_0', ota_state: 'valid', active_path: 'wifi'
        }, '--require-ota-identity');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('VALID PAYLOAD');
    });

    test('keeps legacy validation compatible but strict mode requires boot/image evidence', () => {
        const payload = { device_id: 'device-a', uptime_ms: 1234, active_path: 'wifi' };
        expect(verify(payload).status).toBe(0);
        const strict = verify(payload, '--require-ota-identity');
        expect(strict.status).toBe(1);
        expect(strict.stderr).toMatch(/boot_id/);
    });

    test('accepts legacy modem bearer payloads without the newer session field', () => {
        const result = verify({
            device_id: 'device-a', uptime_ms: 1234, active_path: 'modem',
            modem_ip_bearer_ready: true, modem_ip_address: '100.64.1.2'
        });
        expect(result.status).toBe(0);
    });

    test('requires a session and valid data IP when the new modem contract is present', () => {
        const result = verify({
            device_id: 'device-a', uptime_ms: 1234, active_path: 'offline',
            modem_data_session_open: false, modem_ip_bearer_ready: true,
            modem_data_ip: '100.64.1.2'
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/modem_data_session_open/);
    });

    test('accepts a PDP address without treating it as a bearer', () => {
        const result = verify({
            device_id: 'device-a', uptime_ms: 1234, active_path: 'offline',
            modem_data_session_open: false, modem_ip_bearer_ready: false,
            modem_pdp_ip_address: '10.175.163.107'
        });
        expect(result.status).toBe(0);
    });

    test.each([
            { modem_ip_bearer_ready: true, modem_ip_address: '0.0.0.0' },
            { modem_ip_bearer_ready: true },
            { mqtt_connected: false, mqtt_subscribed: true },
            { mqtt_connected: 'true' },
            { wifi_connected: 'false' }
        ])('rejects misleading native connectivity %j', (mutation) => {
            expect(verify({ device_id: 'device-a', uptime_ms: 1, ...mutation }).status).toBe(1);
        });
    test('strict native contract requires the session field for bearer readiness', () => {
            const result = verify({
                device_id: 'device-a', uptime_ms: 1234, status_sequence: 7,
                boot_id: '0123456789abcdef', firmware_elf_sha256: 'a'.repeat(64),
                ota_slot: 'ota_1', ota_state: 'valid', active_path: 'modem',
                modem_ip_bearer_ready: true, modem_ip_address: '10.1.2.3'
            }, '--require-ota-identity');
            expect(result.status).toBe(1);
            expect(result.stderr).toMatch(/modem_data_session_open/);
    });

    test.each([
        ['bad firmware hash', { firmware_elf_sha256: 'bad' }],
        ['bad OTA slot', { ota_slot: 'factory' }],
        ['negative sequence', { status_sequence: -1 }],
        ['negative uptime', { uptime_ms: -1 }]
    ])('rejects %s', (_name, mutation) => {
        const result = verify({
            device_id: 'device-a', uptime_ms: 1234, status_sequence: 7,
            boot_id: '0123456789abcdef', firmware_elf_sha256: 'a'.repeat(64),
            ota_slot: 'ota_0', ota_state: 'valid', active_path: 'wifi', ...mutation
        });
        expect(result.status).toBe(1);
    });
});
