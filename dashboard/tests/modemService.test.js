'use strict';

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../config/device', () => ({ DEFAULT_DEVICE_ID: 'test-device' }));

let svc;
beforeEach(() => {
    jest.resetModules();
    svc = require('../services/modemService');
    svc.resetDevices();
});

describe('modemService.getStatus', () => {
    test('returns offline status when device not registered', () => {
        const status = svc.getStatus('unknown-device');
        expect(status.online).toBe(false);
        expect(status.signal).toBeNull();
        expect(status.battery).toBeNull();
        expect(status.uptime).toBeNull();
    });

    test('returns online after updateDeviceStatus with recent timestamp', () => {
        // signalStrength is RSSI (0-31); 20 → ~55% signal
        svc.updateDeviceStatus('test-device', {
            mobile: { signalStrength: 20, networkType: 'LTE', operator: 'GP', ipAddress: '10.0.0.1' },
            system: { battery: 85, charging: false, temperature: 35, uptime: '1h' }
        });
        const status = svc.getStatus('test-device');
        expect(status.online).toBe(true);
        // signalStrength is converted to percent by parseRssi
        expect(typeof status.signal).toBe('number');
        expect(status.signal).toBeGreaterThan(0);
        expect(status.battery).toBe(85);
        expect(status.operator).toBe('GP');
    });

    test('device goes offline when lastSeen > 2 minutes ago', () => {
        svc.updateDeviceStatus('test-device', { mobile: {}, system: {} });
        const dev = svc.devices.get('test-device');
        dev.lastSeen = new Date(Date.now() - 3 * 60 * 1000).toISOString();
        const status = svc.getStatus('test-device');
        expect(status.online).toBe(false);
        expect(status.signal).toBeNull();
        expect(status.network).toBe('Offline');
        expect(status.activePath).toBe('offline');
        expect(status.statusFresh).toBe(false);
    });

    test('normalizes flat firmware status payloads into wifi and runtime fields', () => {
        svc.updateDeviceStatus('test-device', {
            type: 'device_status',
            model: 'ESP32-S3-A7670E',
            active_path: 'wifi',
            uptime_ms: 120000,
            wifi_configured: true,
            wifi_started: true,
            wifi_connected: true,
            wifi_ip_assigned: true,
            wifi_ssid: 'BenchNet',
            wifi_ip_address: '192.168.1.50',
            wifi_rssi: -58,
            wifi_connect_attempt_count: 4,
            wifi_reconnect_count: 1,
            mqtt_connected: true,
            mqtt_subscribed: true,
            storage_queue_depth: 3,
            storage_media_available: true,
            storage_buffered_only: false
        });

        const status = svc.getStatus('test-device');
        expect(status.online).toBe(true);
        expect(status.signal).toBeGreaterThan(0);
        expect(status.network).toBe('Wi-Fi');
        expect(status.operator).toBe('Unknown');
        expect(status.wifiSsid).toBe('BenchNet');
        expect(status.wifiSignal).toBeGreaterThan(0);
        expect(status.cellularSignal).toBeNull();
        expect(status.ip).toBe('192.168.1.50');
        expect(status.wifi.connected).toBe(true);
        expect(status.wifi.ssid).toBe('BenchNet');
        expect(status.wifi.ipAddress).toBe('192.168.1.50');
        expect(status.wifi.rssi).toBe(-58);
        expect(status.wifi.connectAttemptCount).toBe(4);
        expect(status.wifi.reconnectCount).toBe(1);
        expect(status.wifi.lastDisconnectReason).toBe(0);
        expect(status.wifi.lastDisconnectReasonText).toBe('');
        expect(status.uptime).toBe('2m');
        expect(status.queues).toEqual(expect.objectContaining({
            storagePending: 3
        }));
        expect(status.activePath).toBe('wifi');
        expect(status.model).toBe('ESP32-S3-A7670E');
        expect(status.mqtt).toEqual(expect.objectContaining({
            connected: true,
            subscribed: true
        }));
        expect(status.storage).toEqual(expect.objectContaining({
            mediaAvailable: true,
            bufferedOnly: false,
            queueDepth: 3
        }));
        expect(status.systemRuntime).toEqual(expect.objectContaining({
            freeHeap: null,
            rebootReason: null
        }));
    });

    test('maps Wi-Fi disconnect reason codes into readable text', () => {
        svc.updateDeviceStatus('test-device', {
            type: 'device_status',
            wifi_configured: true,
            wifi_started: true,
            wifi_connected: false,
            wifi_last_disconnect_reason: 201
        });

        const status = svc.getStatus('test-device');
        expect(status.wifi.lastDisconnectReason).toBe(201);
        expect(status.wifi.lastDisconnectReasonText).toBe('no_ap_found');
    });

    test('preserves the cellular radio type when Wi-Fi is the active path', () => {
        svc.updateDeviceStatus('test-device', {
            active_path: 'wifi',
            network: 'Wi-Fi',
            networkType: 'LTE',
            mobile: {
                networkType: 'LTE',
                operator: 'Robi'
            },
            wifi: {
                connected: true,
                ssid: 'RiazM',
                ipAddress: '192.168.1.50'
            },
            system: {}
        });

        const device = svc.devices.get('test-device');
        const status = svc.getStatus('test-device');

        expect(device.mobile.networkType).toBe('LTE');
        expect(status.mobile).toEqual(expect.objectContaining({
            networkType: 'LTE'
        }));
        expect(status.network).toBe('Wi-Fi');
        expect(status.activePath).toBe('wifi');
    });

    test('treats charging as unknown when battery telemetry is missing', () => {
        svc.updateDeviceStatus('test-device', {
            mobile: { signalStrength: 20, networkType: 'LTE', operator: 'GP', ipAddress: '10.0.0.1' },
            system: { battery: null, voltage_mV: null, charging: false, temperature: null, uptime: '1h' }
        });

        const status = svc.getStatus('test-device');
        expect(status.battery).toBeNull();
        expect(status.voltageMv).toBeNull();
        expect(status.charging).toBeNull();
    });

    test('preserves formatted uptime strings instead of collapsing them to zero', () => {
        svc.updateDeviceStatus('test-device', {
            mobile: { signalStrength: 20, networkType: 'LTE', operator: 'GP', ipAddress: '10.0.0.1' },
            system: { battery: 85, charging: false, temperature: 35, uptime: '1h 2m' }
        });

        const status = svc.getStatus('test-device');
        expect(status.uptime).toBe('1h 2m');
    });

    test('uses live operatorName when available and otherwise preserves the modem operator code', () => {
        svc.updateDeviceStatus('test-device', {
            mobile: { operator: '47002', operatorName: 'Robi', networkType: 'LTE', ipAddress: '10.0.0.1' },
            system: {}
        });

        let status = svc.getStatus('test-device');
        expect(status.operator).toBe('Robi');

        svc.updateDeviceStatus('test-device', {
            mobile: { operator: '47002', operatorName: null, networkType: 'LTE', ipAddress: '10.0.0.1' },
            system: {}
        });

        status = svc.getStatus('test-device');
        expect(status.operator).toBe('47002');
    });

    test('keeps unknown cellular RSSI as null instead of coercing it to 0%', () => {
        svc.updateDeviceStatus('test-device', {
            mobile: { signalStrength: 99, operator: null, operatorName: null, networkType: 'LTE', ipAddress: '10.0.0.1' },
            system: {}
        });

        const status = svc.getStatus('test-device');
        expect(status.signal).toBeNull();
        expect(status.cellularSignal).toBeNull();
    });

    test('reads nested modem and system snapshots when top-level runtime fields are absent', () => {
        svc.updateDeviceStatus('test-device', {
            active_path: 'modem',
            status: {
                modem: {
                    registered: true,
                    operator: '47001',
                    dataIp: '10.172.126.118',
                    signal: 19
                },
                system: {
                    battery: 77,
                    charging: true,
                    voltage_mV: 4025,
                    temperature: 31,
                    uptime: 360
                }
            },
            sim: {
                registered: true
            }
        });

        const status = svc.getStatus('test-device');
        expect(status.operator).toBe('47001');
        expect(status.ip).toBe('10.172.126.118');
        expect(status.battery).toBe(77);
        expect(status.charging).toBe(true);
        expect(status.voltageMv).toBe(4025);
        expect(status.temperature).toBe(31);
        expect(status.uptime).toBe('6m');
    });

    test('persists storage:info compatibility payloads that arrive as sd snapshots', () => {
        svc.updateDeviceStatus('test-device', {
            mobile: { operator: 'GP', networkType: 'LTE', ipAddress: '10.0.0.1' },
            system: {}
        });

        svc.updateDeviceStatus('test-device', {
            sd: {
                mounted: true,
                total: 62505500672,
                used: 1048576,
                free: 62504452096,
                queueDepth: 2,
                pendingUploads: 1,
                type: 'SD Card'
            }
        });

        const status = svc.getStatus('test-device');
        expect(status.storage).toEqual(expect.objectContaining({
            mounted: true,
            mediaAvailable: true,
            queueDepth: 2,
            pendingUploads: 1,
            totalBytes: 62505500672,
            usedBytes: 1048576,
            freeBytes: 62504452096
        }));
    });

    test('normalizes the top-level firmware telemetry payload for PPP devices', () => {
        svc.updateDeviceStatus('test-device', {
            type: 'device_status',
            active_path: 'modem',
            uptime_ms: 3723000,
            modem_registered: true,
            telephony_supported: false,
            telephony_enabled: false,
            data_mode_enabled: true,
            modem_signal: 20,
            modem_operator: 'Grameenphone',
            modem_ip_address: '10.172.126.118',
            battery: 84,
            voltage_mV: 3921,
            temperature: 30.4,
            imei: '351602000330570',
            storage_media_available: true,
            sd_mounted: true,
            storage_media_type: 'SSD',
            storage_total_bytes: 62505500672,
            storage_used_bytes: 1048576,
            storage_free_bytes: 62504452096,
            storage_queue_depth: 2
        });

        const status = svc.getStatus('test-device');
        expect(status.online).toBe(true);
        expect(status.activePath).toBe('modem');
        expect(status.operator).toBe('Grameenphone');
        expect(status.ip).toBe('10.172.126.118');
        expect(status.cellularSignal).toBeGreaterThan(0);
        expect(status.cellularSignal).toBeLessThanOrEqual(100);
        expect(status.telephonySupported).toBe(false);
        expect(status.telephonyEnabled).toBe(false);
        expect(status.dataModeEnabled).toBe(true);
        expect(status.sim).toEqual(expect.objectContaining({
            telephonySupported: false,
            telephonyEnabled: false,
            dataModeEnabled: true
        }));
        expect(status.storage).toEqual(expect.objectContaining({
            type: 'SSD'
        }));
        expect(status.battery).toBe(84);
        expect(status.voltageMv).toBe(3921);
        expect(status.temperature).toBe(30.4);
        expect(status.imei).toBe('351602000330570');
        expect(status.uptime).toBe('1h 2m');
        expect(status.storage).toEqual(expect.objectContaining({
            mounted: true,
            mediaAvailable: true,
            queueDepth: 2,
            totalBytes: 62505500672,
            usedBytes: 1048576
        }));
    });
});

describe('modemService.getAllDevices', () => {
    test('returns empty array when no devices registered', () => {
        expect(svc.getAllDevices()).toEqual([]);
    });

    test('returns all registered devices', () => {
        svc.updateDeviceStatus('dev-1', { mobile: { operator: 'GP' }, system: {} });
        svc.updateDeviceStatus('dev-2', { mobile: { operator: 'Robi' }, system: {} });
        const devices = svc.getAllDevices();
        expect(devices.length).toBe(2);
        expect(devices.map(d => d.id)).toEqual(expect.arrayContaining(['dev-1', 'dev-2']));
    });
});
