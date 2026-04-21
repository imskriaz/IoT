'use strict';

const express = require('express');
const EventEmitter = require('events');
const request = require('supertest');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

function buildApp(router, locals = {}) {
    const app = express();
    app.use(express.json());
    app.locals.db = null;
    Object.assign(app.locals, locals);
    app.use('/api/status', router);
    return app;
}

describe('status route live refresh', () => {
    let modemService;

    beforeEach(() => {
        jest.resetModules();
        modemService = require('../services/modemService');
        modemService.resetDevices();
    });

    afterEach(() => {
        delete global.mqttService;
        delete global.modemService;
    });

    test('requests fresh status and returns normalized live Wi-Fi state', async () => {
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.isDeviceOnline = jest.fn((deviceId) => modemService.isDeviceOnline(deviceId));
        mqttService.getDeviceQueueState = jest.fn().mockResolvedValue({
            summary: {
                pending: 0,
                active: 0,
                failed: 0,
                ambiguous: 0,
                totalOpen: 0
            },
            recent: []
        });
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command, payload, waitForResponse, timeoutMs, options = {}) => {
            process.nextTick(() => {
                mqttService.emit('status', deviceId, {
                    type: 'device_status',
                    messageId: options.messageId,
                    active_path: 'wifi',
                    uptime_ms: 120000,
                    wifi_configured: true,
                    wifi_started: true,
                    wifi_connected: true,
                    wifi_ip_assigned: true,
                    wifi_ssid: 'BenchNet',
                    wifi_ip_address: '192.168.1.50',
                    wifi_rssi: -58,
                    wifi_last_disconnect_reason: 201,
                    wifi_last_disconnect_reason_text: 'no_ap_found',
                    modem_operator_name: 'Grameenphone',
                    modem_subscriber_number: '+8801628301525',
                    mqtt_connected: true,
                    mqtt_subscribed: true,
                    mqtt_reconnect_count: 4,
                    mqtt_published_count: 12,
                    mqtt_publish_failures: 1,
                    storage_queue_depth: 2,
                    storage_media_available: true,
                    storage_buffered_only: false,
                    dashboard_ack_age_ms: 1500,
                    in_sync: true,
                    desired_version: 8,
                    applied_version: 8,
                    free_heap_bytes: 245760,
                    free_psram_bytes: 4194304,
                    largest_free_block_bytes: 131072,
                    reboot_reason: 'power_on'
                });
            });

            return {
                success: true,
                deviceId,
                command,
                payload,
                waitForResponse,
                timeoutMs
            };
        });

        mqttService.on('status', (deviceId, data) => {
            modemService.updateDeviceStatus(deviceId, data);
        });

        global.mqttService = mqttService;
        global.modemService = modemService;
        modemService.handleHeartbeat('device-1');

        const router = require('../routes/status');
        const app = buildApp(router);

        const res = await request(app).get('/api/status?deviceId=device-1&refresh=1');

        expect(res.status).toBe(200);
        expect(mqttService.publishCommand).toHaveBeenCalledWith(
            'device-1',
            'get-status',
            {},
            false,
            8000,
            expect.objectContaining({
                source: 'dashboard-status',
                domain: 'status',
                bypassCompatibility: true,
                messageId: expect.stringMatching(/^status_/)
            })
        );
        expect(res.body.success).toBe(true);
        expect(res.body.deviceId).toBe('device-1');
        expect(res.body.caps).toEqual(expect.objectContaining({
            wifi: true,
            internet: true,
            storage: true,
            sd: true
        }));
        expect(Array.isArray(res.body.moduleHealth)).toBe(true);
        expect(res.body.moduleHealth).toEqual(expect.arrayContaining([
            expect.objectContaining({
                moduleKey: 'wifi',
                supported: true
            }),
            expect.objectContaining({
                moduleKey: 'storage',
                supported: true
            })
        ]));
        expect(res.body.data).toEqual(expect.objectContaining({
            online: true,
            network: 'Wi-Fi',
            uptime: '2m',
            activePath: 'wifi',
            wifi: expect.objectContaining({
                connected: true,
                ssid: 'BenchNet',
                ipAddress: '192.168.1.50',
                rssi: -58,
                lastDisconnectReason: 201,
                lastDisconnectReasonText: 'no_ap_found'
            }),
            mqtt: expect.objectContaining({
                connected: true,
                subscribed: true,
                reconnectCount: 4,
                publishedCount: 12,
                publishFailures: 1
            }),
            sync: expect.objectContaining({
                inSync: true,
                dashboardAckAgeMs: 1500,
                desiredVersion: 8,
                appliedVersion: 8
            }),
            storage: expect.objectContaining({
                mediaAvailable: true,
                bufferedOnly: false,
                queueDepth: 2
            }),
            systemRuntime: expect.objectContaining({
                freeHeap: 245760,
                freePsram: 4194304,
                largestFreeBlock: 131072,
                rebootReason: 'power_on'
            }),
            operator: 'Grameenphone',
            simNumber: '+8801628301525',
            queueState: expect.objectContaining({
                dashboard: expect.objectContaining({
                    summary: expect.objectContaining({
                        totalOpen: 0
                    })
                }),
                device: expect.objectContaining({
                    storagePending: 2
                })
            })
        }));
    });

    test('keeps modem internet available while hiding SMS when firmware says telephony is unsupported', async () => {
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.isDeviceOnline = jest.fn((deviceId) => modemService.isDeviceOnline(deviceId));
        mqttService.isDeviceBusy = jest.fn().mockReturnValue(false);
        mqttService.getDeviceQueueState = jest.fn().mockResolvedValue({
            summary: {
                pending: 0,
                active: 0,
                failed: 0,
                ambiguous: 0,
                totalOpen: 0
            },
            recent: []
        });
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command, payload, waitForResponse, timeoutMs, options = {}) => {
            process.nextTick(() => {
                mqttService.emit('status', deviceId, {
                    type: 'device_status',
                    messageId: options.messageId,
                    active_path: 'modem',
                    modem_registered: true,
                    telephony_supported: false,
                    telephony_enabled: false,
                    data_mode_enabled: true,
                    modem_operator: 'Grameenphone',
                    modem_signal: 18,
                    modem_ip_address: '10.172.126.118',
                    mqtt_connected: true,
                    mqtt_subscribed: true
                });
            });

            return {
                success: true,
                deviceId,
                command,
                payload,
                waitForResponse,
                timeoutMs
            };
        });

        mqttService.on('status', (deviceId, data) => {
            modemService.updateDeviceStatus(deviceId, data);
        });

        global.mqttService = mqttService;
        global.modemService = modemService;
        modemService.handleHeartbeat('device-2');

        const router = require('../routes/status');
        const app = buildApp(router);

        const res = await request(app).get('/api/status?deviceId=device-2&refresh=1');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.caps).toEqual(expect.objectContaining({
            modem: true,
            internet: true,
            sms: false,
            calls: false,
            ussd: false
        }));
        expect(res.body.data).toEqual(expect.objectContaining({
            activePath: 'modem',
            telephonySupported: false,
            telephonyEnabled: false,
            dataModeEnabled: true,
            ip: '10.172.126.118'
        }));
    });

    test('reports module-health MQTT from device telemetry instead of dashboard broker state', async () => {
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.isDeviceOnline = jest.fn((deviceId) => modemService.isDeviceOnline(deviceId));
        mqttService.isDeviceBusy = jest.fn().mockReturnValue(false);
        mqttService.getDeviceQueueState = jest.fn().mockResolvedValue({
            summary: {
                pending: 0,
                active: 0,
                failed: 0,
                ambiguous: 0,
                totalOpen: 0
            },
            recent: []
        });
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command, payload, waitForResponse, timeoutMs, options = {}) => {
            process.nextTick(() => {
                mqttService.emit('status', deviceId, {
                    type: 'device_status',
                    messageId: options.messageId,
                    active_path: 'modem',
                    modem_registered: true,
                    data_mode_enabled: true,
                    modem_operator_name: 'robi axiata',
                    mqtt_connected: false,
                    mqtt_subscribed: false
                });
            });

            return { success: true, deviceId, command, payload, waitForResponse, timeoutMs };
        });

        mqttService.on('status', (deviceId, data) => {
            modemService.updateDeviceStatus(deviceId, data);
        });

        global.mqttService = mqttService;
        global.modemService = modemService;
        modemService.handleHeartbeat('device-2b');

        const router = require('../routes/status');
        const app = buildApp(router);

        const res = await request(app).get('/api/status?deviceId=device-2b&refresh=1');

        expect(res.status).toBe(200);
        const mqttEntry = res.body.moduleHealth.find((entry) => entry.moduleKey === 'mqtt');
        expect(mqttEntry).toEqual(expect.objectContaining({
            moduleKey: 'mqtt',
            state: 'error',
            message: 'Device MQTT disconnected'
        }));
        expect(res.body.data.mqtt).toEqual(expect.objectContaining({
            connected: false,
            subscribed: false
        }));
    });

    test('returns cached status without forcing a live refresh by default', async () => {
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.isDeviceOnline = jest.fn(() => true);
        mqttService.isDeviceBusy = jest.fn().mockReturnValue(false);
        mqttService.getDeviceQueueState = jest.fn().mockResolvedValue({
            summary: {
                pending: 0,
                active: 0,
                failed: 0,
                ambiguous: 0,
                totalOpen: 0
            },
            recent: []
        });
        mqttService.publishCommand = jest.fn();

        global.mqttService = mqttService;
        global.modemService = modemService;
        modemService.updateDeviceStatus('device-cached', {
            type: 'device_status',
            active_path: 'wifi',
            wifi_connected: true,
            wifi_ssid: 'CachedNet',
            wifi_ip_address: '192.168.0.10',
            mqtt_connected: true,
            mqtt_subscribed: true
        });
        modemService.handleHeartbeat('device-cached');

        const router = require('../routes/status');
        const app = buildApp(router);

        const res = await request(app).get('/api/status?deviceId=device-cached');

        expect(res.status).toBe(200);
        expect(mqttService.publishCommand).not.toHaveBeenCalled();
        expect(res.body.data.wifi).toEqual(expect.objectContaining({
            connected: true,
            ssid: 'CachedNet',
            ipAddress: '192.168.0.10'
        }));
    });

    test('returns correct module health from cached flat firmware status payloads', async () => {
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.isDeviceOnline = jest.fn(() => true);
        mqttService.isDeviceBusy = jest.fn().mockReturnValue(false);
        mqttService.getDeviceQueueState = jest.fn().mockResolvedValue({
            summary: {
                pending: 0,
                active: 0,
                failed: 0,
                ambiguous: 0,
                totalOpen: 0
            },
            recent: []
        });
        mqttService.publishCommand = jest.fn();

        global.mqttService = mqttService;
        global.modemService = modemService;
        modemService.updateDeviceStatus('device-flat', {
            type: 'device_status',
            active_path: 'wifi',
            wifi_configured: true,
            wifi_started: true,
            wifi_connected: true,
            wifi_ip_assigned: true,
            wifi_ssid: 'RiazM',
            wifi_ip_address: '10.147.48.235',
            wifi_rssi: -71,
            mqtt_configured: true,
            mqtt_connected: true,
            mqtt_subscribed: true,
            mqtt_reconnect_count: 0,
            mqtt_published_count: 16,
            mqtt_publish_failures: 0,
            modem_registered: true,
            modem_signal: 20,
            modem_operator_name: 'robi axiata',
            telephony_supported: true,
            telephony_enabled: true,
            data_mode_enabled: true,
            sd_mounted: true,
            storage_media_available: true,
            storage_buffered_only: false,
            storage_queue_depth: 1,
            storage_total_bytes: 62519640064,
            storage_used_bytes: 458752,
            storage_free_bytes: 62519181312
        });
        modemService.handleHeartbeat('device-flat');

        const router = require('../routes/status');
        const app = buildApp(router);

        const res = await request(app).get('/api/status?deviceId=device-flat');

        expect(res.status).toBe(200);
        const mqttEntry = res.body.moduleHealth.find((entry) => entry.moduleKey === 'mqtt');
        const modemEntry = res.body.moduleHealth.find((entry) => entry.moduleKey === 'modem');
        const wifiEntry = res.body.moduleHealth.find((entry) => entry.moduleKey === 'wifi');
        const storageEntry = res.body.moduleHealth.find((entry) => entry.moduleKey === 'storage');

        expect(mqttEntry).toEqual(expect.objectContaining({
            state: 'ok',
            message: 'Device MQTT connected'
        }));
        expect(modemEntry).toEqual(expect.objectContaining({
            state: 'ok'
        }));
        expect(modemEntry.message).toContain('Registered on robi axiata');
        expect(modemEntry.details).toEqual(expect.objectContaining({
            signal: 65
        }));
        expect(wifiEntry).toEqual(expect.objectContaining({
            state: 'ok',
            message: 'Connected to RiazM (10.147.48.235)'
        }));
        expect(storageEntry).toEqual(expect.objectContaining({
            state: 'ok',
            message: 'Storage mounted'
        }));
    });

    test('coalesces concurrent live status refreshes for the same device', async () => {
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.isDeviceOnline = jest.fn((deviceId) => modemService.isDeviceOnline(deviceId));
        mqttService.isDeviceBusy = jest.fn().mockReturnValue(false);
        mqttService.getDeviceQueueState = jest.fn().mockResolvedValue({
            summary: {
                pending: 0,
                active: 0,
                failed: 0,
                ambiguous: 0,
                totalOpen: 0
            },
            recent: []
        });
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command, payload, waitForResponse, timeoutMs, options = {}) => {
            setTimeout(() => {
                mqttService.emit('status', deviceId, {
                    type: 'device_status',
                    messageId: options.messageId,
                    active_path: 'modem',
                    modem_registered: true,
                    modem_operator: '47002',
                    modem_signal: 22,
                    mqtt_connected: true,
                    mqtt_subscribed: true
                });
            }, 20);

            return { success: true, deviceId, command, payload, waitForResponse, timeoutMs };
        });

        mqttService.on('status', (deviceId, data) => {
            modemService.updateDeviceStatus(deviceId, data);
        });

        global.mqttService = mqttService;
        global.modemService = modemService;
        modemService.handleHeartbeat('device-3');

        const router = require('../routes/status');
        const app = buildApp(router);

        const [resA, resB] = await Promise.all([
            request(app).get('/api/status?deviceId=device-3&refresh=1'),
            request(app).get('/api/status?deviceId=device-3&refresh=1')
        ]);

        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);
        expect(mqttService.publishCommand).toHaveBeenCalledTimes(1);
    });

    test('uses stored SIM number fallback when live modem status omits subscriber number', async () => {
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.isDeviceOnline = jest.fn((deviceId) => modemService.isDeviceOnline(deviceId));
        mqttService.isDeviceBusy = jest.fn().mockReturnValue(false);
        mqttService.getDeviceQueueState = jest.fn().mockResolvedValue({
            summary: {
                pending: 0,
                active: 0,
                failed: 0,
                ambiguous: 0,
                totalOpen: 0
            },
            recent: []
        });
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command, payload, waitForResponse, timeoutMs, options = {}) => {
            process.nextTick(() => {
                mqttService.emit('status', deviceId, {
                    type: 'device_status',
                    messageId: options.messageId,
                    active_path: 'modem',
                    modem_registered: true,
                    telephony_supported: true,
                    telephony_enabled: true,
                    data_mode_enabled: true,
                    modem_operator_name: 'robi axiata',
                    modem_signal: 22,
                    mqtt_connected: true,
                    mqtt_subscribed: true
                });
            });

            return { success: true, deviceId, command, payload, waitForResponse, timeoutMs };
        });

        mqttService.on('status', (deviceId, data) => {
            modemService.updateDeviceStatus(deviceId, data);
        });

        global.mqttService = mqttService;
        global.modemService = modemService;
        modemService.handleHeartbeat('device-3b');

        const router = require('../routes/status');
        const db = {
            get: jest.fn().mockImplementation(async (sql) => {
                if (String(sql).includes('SELECT last_sim_number')) {
                    return { last_sim_number: '+8801628301525' };
                }
                return null;
            }),
            all: jest.fn().mockResolvedValue([]),
            run: jest.fn()
        };
        const app = buildApp(router, { db });

        const res = await request(app).get('/api/status?deviceId=device-3b&refresh=1');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.simNumber).toBe('+8801628301525');
        expect(res.body.data.sim).toEqual(expect.objectContaining({
            number: '+8801628301525',
            subscriberNumber: '+8801628301525'
        }));
    });

    test('uses stored SIM slot fallback when live modem status omits slot details', async () => {
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.isDeviceOnline = jest.fn((deviceId) => modemService.isDeviceOnline(deviceId));
        mqttService.getDeviceQueueState = jest.fn().mockResolvedValue({
            summary: {
                pending: 0,
                active: 0,
                failed: 0,
                ambiguous: 0,
                totalOpen: 0
            },
            recent: []
        });
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command, payload, waitForResponse, timeoutMs, options = {}) => {
            process.nextTick(() => {
                mqttService.emit('status', deviceId, {
                    type: 'device_status',
                    messageId: options.messageId,
                    active_path: 'modem',
                    modem_registered: true,
                    telephony_supported: true,
                    telephony_enabled: true,
                    data_mode_enabled: true,
                    mqtt_connected: true,
                    mqtt_subscribed: true
                });
            });

            return { success: true, deviceId, command, payload, waitForResponse, timeoutMs };
        });

        mqttService.on('status', (deviceId, data) => {
            modemService.updateDeviceStatus(deviceId, data);
        });

        global.mqttService = mqttService;
        global.modemService = modemService;
        modemService.handleHeartbeat('device-3c');

        const router = require('../routes/status');
        const db = {
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockImplementation(async (sql) => {
                if (String(sql).includes('FROM sims')) {
                    return [
                        { slot_index: 0, sim_number: '+8801000000000', operator_name: 'Robi', carrier_name: 'robi axiata', network_type: 'LTE', is_ready: 1, is_registered: 1 },
                        { slot_index: 1, sim_number: '+8801000000001', operator_name: 'Grameenphone', carrier_name: 'GP', network_type: 'LTE', is_ready: 1, is_registered: 0 }
                    ];
                }
                return [];
            }),
            run: jest.fn()
        };
        const app = buildApp(router, { db });

        const res = await request(app).get('/api/status?deviceId=device-3c&refresh=1');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.simSlots).toHaveLength(2);
        expect(res.body.data.simSlots[0]).toEqual(expect.objectContaining({
            slotIndex: 0,
            number: '+8801000000000',
            operatorName: 'Robi'
        }));
        expect(res.body.data.simSlots[1]).toEqual(expect.objectContaining({
            slotIndex: 1,
            number: '+8801000000001',
            operatorName: 'Grameenphone'
        }));
    });

    test('skips forced live refresh while the device is busy with another command', async () => {
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.isDeviceOnline = jest.fn((deviceId) => modemService.isDeviceOnline(deviceId));
        mqttService.isDeviceBusy = jest.fn().mockReturnValue(true);
        mqttService.getDeviceQueueState = jest.fn().mockResolvedValue({
            summary: {
                pending: 0,
                active: 1,
                failed: 0,
                ambiguous: 0,
                totalOpen: 1
            },
            recent: []
        });
        mqttService.publishCommand = jest.fn();

        global.mqttService = mqttService;
        global.modemService = modemService;
        modemService.updateDeviceStatus('device-4', {
            type: 'device_status',
            active_path: 'modem',
            modem_registered: true,
            modem_operator: '47002',
            modem_signal: 21,
            mqtt_connected: true,
            mqtt_subscribed: true
        });
        modemService.handleHeartbeat('device-4');

        const router = require('../routes/status');
        const app = buildApp(router);

        const res = await request(app).get('/api/status?deviceId=device-4&refresh=1');

        expect(res.status).toBe(200);
        expect(mqttService.publishCommand).not.toHaveBeenCalled();
        expect(res.body.data.activePath).toBe('modem');
    });

    test('does not fall back to serial refresh when MQTT cannot provide a live update', async () => {
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.isDeviceOnline = jest.fn().mockReturnValue(false);
        mqttService.isDeviceBusy = jest.fn().mockReturnValue(false);
        mqttService.getDeviceQueueState = jest.fn().mockResolvedValue({
            summary: {
                pending: 0,
                active: 0,
                failed: 0,
                ambiguous: 0,
                totalOpen: 0
            },
            recent: []
        });
        mqttService.publishCommand = jest.fn();

        const serialBridge = {
            isStatusFallbackEnabled: jest.fn().mockReturnValue(true),
            refreshStatusSnapshot: jest.fn().mockImplementation(async ({ deviceId }) => {
                modemService.updateDeviceStatus(deviceId, {
                    type: 'device_status',
                    active_path: 'offline',
                    uptime_ms: 15000,
                    wifi_configured: true,
                    wifi_started: true,
                    wifi_connected: false,
                    wifi_ip_assigned: false,
                    wifi_ssid: 'GM-GAP',
                    wifi_last_scan_target_visible: false,
                    wifi_last_scan_visible_count: 0,
                    wifi_last_scan_elapsed_ms: 5099,
                    wifi_last_scan_summary: 'active:none_visible -> passive:none_visible',
                    wifi_last_disconnect_reason: 201,
                    wifi_last_disconnect_reason_text: 'no_ap_found',
                    modem_registered: true,
                    modem_operator: '47002',
                    modem_signal: 22,
                    temperature: 28,
                    sd_mounted: true,
                    storage_media_available: true,
                    storage_buffered_only: false,
                    storage_queue_depth: 0,
                    storage_total_bytes: 62519640064,
                    storage_used_bytes: 393216,
                    storage_free_bytes: 62519246848,
                    reboot_reason: 'power_on',
                    imei: '862596081929782'
                });
                modemService.handleHeartbeat(deviceId);
                return modemService.getDeviceStatus(deviceId);
            })
        };

        global.mqttService = mqttService;
        global.modemService = modemService;

        const router = require('../routes/status');
        const app = buildApp(router, { serialBridge });

        const res = await request(app).get('/api/status?deviceId=device-serial&refresh=1');

        expect(res.status).toBe(200);
        expect(mqttService.publishCommand).not.toHaveBeenCalled();
        expect(serialBridge.refreshStatusSnapshot).not.toHaveBeenCalled();
        expect(res.body.data).toEqual(expect.objectContaining({
            online: false,
            activePath: 'offline',
            imei: null,
            uptime: null,
            network: 'Offline',
            currentNetworkName: 'Offline',
            currentNetworkDetails: 'Waiting for live data',
            wifi: expect.objectContaining({
                ssid: '',
                configured: false,
                started: false,
                connected: false
            }),
            storage: null
        }));
    });

    test('does not call serial refresh when serial status fallback is disabled', async () => {
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.isDeviceOnline = jest.fn().mockReturnValue(false);
        mqttService.isDeviceBusy = jest.fn().mockReturnValue(false);
        mqttService.getDeviceQueueState = jest.fn().mockResolvedValue({
            summary: {
                pending: 0,
                active: 0,
                failed: 0,
                ambiguous: 0,
                totalOpen: 0
            },
            recent: []
        });
        mqttService.publishCommand = jest.fn();

        const serialBridge = {
            isStatusFallbackEnabled: jest.fn().mockReturnValue(false),
            refreshStatusSnapshot: jest.fn()
        };

        global.mqttService = mqttService;
        global.modemService = modemService;

        const router = require('../routes/status');
        const app = buildApp(router, { serialBridge });

        const res = await request(app).get('/api/status?deviceId=device-no-serial&refresh=1');

        expect(res.status).toBe(200);
        expect(serialBridge.refreshStatusSnapshot).not.toHaveBeenCalled();
    });

    test('module-action wifi retries the saved profile and returns a refreshed envelope', async () => {
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.isDeviceOnline = jest.fn((deviceId) => modemService.isDeviceOnline(deviceId));
        mqttService.isDeviceBusy = jest.fn().mockReturnValue(false);
        mqttService.getDeviceQueueState = jest.fn().mockResolvedValue({
            summary: {
                pending: 0,
                active: 0,
                failed: 0,
                ambiguous: 0,
                totalOpen: 0
            },
            recent: []
        });
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command, payload) => {
            if (command === 'wifi-reconnect') {
                process.nextTick(() => {
                    const statusPayload = {
                        type: 'device_status',
                        active_path: 'wifi',
                        wifi_configured: true,
                        wifi_started: true,
                        wifi_connected: true,
                        wifi_ssid: 'RiazM',
                        wifi_ip_address: '192.168.10.20',
                        mqtt_connected: true,
                        mqtt_subscribed: true
                    };
                    mqttService.emit('status', deviceId, statusPayload);
                });
            }

            return {
                success: true,
                deviceId,
                command,
                payload
            };
        });

        mqttService.on('status', (deviceId, data) => {
            modemService.updateDeviceStatus(deviceId, data);
            modemService.handleHeartbeat(deviceId);
        });

        global.mqttService = mqttService;
        global.modemService = modemService;
        modemService.handleHeartbeat('device-wifi-action');

        const router = require('../routes/status');
        const db = {
            get: jest.fn().mockResolvedValue({
                wifi_ssid: 'RiazM',
                wifi_pass: '12345678'
            }),
            all: jest.fn().mockResolvedValue([])
        };
        const app = buildApp(router, { db });

        const res = await request(app)
            .post('/api/status/module-action')
            .send({ deviceId: 'device-wifi-action', moduleKey: 'wifi' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toMatch(/RiazM/);
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            1,
            'device-wifi-action',
            'config-set',
            { key: 'wifi_ssid', value: 'RiazM' },
            true,
            10000,
            expect.objectContaining({
                source: 'dashboard-status-panel',
                domain: 'network',
                skipPersistentQueue: true
            })
        );
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            2,
            'device-wifi-action',
            'config-set',
            { key: 'wifi_password', value: '12345678' },
            true,
            10000,
            expect.objectContaining({
                source: 'dashboard-status-panel',
                domain: 'network',
                skipPersistentQueue: true
            })
        );
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            3,
            'device-wifi-action',
            'wifi-reconnect',
            {},
            true,
            10000,
            expect.objectContaining({
                source: 'dashboard-status-panel',
                domain: 'network',
                skipPersistentQueue: true
            })
        );
        expect(res.body.envelope.data).toEqual(expect.objectContaining({
            activePath: 'wifi',
            wifi: expect.objectContaining({
                connected: true,
                ssid: 'RiazM'
            })
        }));
    });
});
