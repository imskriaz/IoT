const { getDeviceModuleHealth } = require('../utils/moduleHealth');
const { buildDashboardDeviceStatus } = require('../utils/dashboardStatus');

describe('moduleHealth offline handling', () => {
    test('downgrades stored ok modules when the live device is offline', async () => {
        const db = {
            all: jest.fn().mockResolvedValue([
                {
                    device_id: 'dev-1',
                    module_key: 'wifi',
                    supported: 1,
                    state: 'ok',
                    last_success_at: '2026-04-04T12:00:00.000Z',
                    last_failure_at: null,
                    last_message: 'Wi-Fi connected',
                    details: JSON.stringify({ ssid: 'RiazM' }),
                    updated_at: '2026-04-04T12:00:00.000Z'
                },
                {
                    device_id: 'dev-1',
                    module_key: 'storage',
                    supported: 1,
                    state: 'ok',
                    last_success_at: '2026-04-04T12:00:00.000Z',
                    last_failure_at: null,
                    last_message: 'Storage info refreshed',
                    details: JSON.stringify({ mounted: true }),
                    updated_at: '2026-04-04T12:00:00.000Z'
                }
            ])
        };

        const moduleHealth = await getDeviceModuleHealth(db, 'dev-1', { wifi: true, storage: true }, {
            mqttConnected: true,
            live: {
                online: false,
                lastSeen: '2026-04-04T12:05:00.000Z',
                wifi: { connected: false }
            }
        });

        const mqtt = moduleHealth.find(entry => entry.moduleKey === 'mqtt');
        const modem = moduleHealth.find(entry => entry.moduleKey === 'modem');
        const wifi = moduleHealth.find(entry => entry.moduleKey === 'wifi');
        const storage = moduleHealth.find(entry => entry.moduleKey === 'storage');

        expect(mqtt.state).toBe('error');
        expect(mqtt.message).toBe('No recent device MQTT telemetry');
        expect(modem.state).toBe('error');
        expect(modem.message).toBe('No recent heartbeat');
        expect(wifi.state).toBe('warning');
        expect(wifi.message).toBe('Stale while device offline');
        expect(storage.state).toBe('warning');
        expect(storage.message).toBe('Stale while device offline');
    });
});

describe('moduleHealth live snapshot preference', () => {
    test('uses device MQTT state instead of dashboard broker state', async () => {
        const moduleHealth = await getDeviceModuleHealth(null, 'dev-1', {}, {
            mqttConnected: true,
            live: {
                online: true,
                lastSeen: '2026-04-13T10:00:00.000Z',
                mqtt: {
                    connected: false,
                    subscribed: false,
                    reconnectCount: 3,
                    publishFailures: 2
                }
            }
        });

        const mqtt = moduleHealth.find(entry => entry.moduleKey === 'mqtt');

        expect(mqtt.state).toBe('error');
        expect(mqtt.message).toBe('Device MQTT disconnected');
        expect(mqtt.details).toEqual(expect.objectContaining({
            connected: false,
            subscribed: false,
            reconnectCount: 3,
            publishFailures: 2
        }));
    });

    test('keeps MQTT unknown when the device is online but has not reported MQTT telemetry yet', async () => {
        const moduleHealth = await getDeviceModuleHealth(null, 'dev-1', {}, {
            mqttConnected: true,
            live: {
                online: true,
                lastSeen: '2026-04-13T10:02:00.000Z'
            }
        });

        const mqtt = moduleHealth.find(entry => entry.moduleKey === 'mqtt');

        expect(mqtt.state).toBe('unknown');
        expect(mqtt.message).toBe('Waiting for device MQTT telemetry');
        expect(mqtt.details).toBeNull();
    });

    test('marks device MQTT as warning when connected but not subscribed yet', async () => {
        const moduleHealth = await getDeviceModuleHealth(null, 'dev-1', {}, {
            mqttConnected: false,
            live: {
                online: true,
                lastSeen: '2026-04-13T10:05:00.000Z',
                mqtt: {
                    connected: true,
                    subscribed: false,
                    reconnectCount: 1
                }
            }
        });

        const mqtt = moduleHealth.find(entry => entry.moduleKey === 'mqtt');

        expect(mqtt.state).toBe('warning');
        expect(mqtt.message).toBe('Device MQTT connected, subscription pending');
        expect(mqtt.details).toEqual(expect.objectContaining({
            connected: true,
            subscribed: false,
            reconnectCount: 1
        }));
    });

    test('suppresses MQTT health errors for HTTP bridge devices', async () => {
        const moduleHealth = await getDeviceModuleHealth(null, 'dev-1', {
            transport_mode: 'http',
            http: true,
            mqtt: false
        }, {
            mqttConnected: true,
            live: {
                online: true,
                activePath: 'http',
                lastSeen: '2026-04-23T16:38:17.278Z',
                mqtt: {
                    connected: false,
                    subscribed: true,
                    publishedCount: 33
                }
            }
        });

        const mqtt = moduleHealth.find(entry => entry.moduleKey === 'mqtt');

        expect(mqtt.supported).toBe(false);
        expect(mqtt.state).toBe('unsupported');
        expect(mqtt.message).toBe('HTTP bridge active on this device');
    });

    test('prefers live modem, wifi, and storage state over stale stored success rows', async () => {
        const db = {
            all: jest.fn().mockResolvedValue([
                {
                    device_id: 'dev-1',
                    module_key: 'modem',
                    supported: 1,
                    state: 'ok',
                    last_success_at: '2026-04-04T12:00:00.000Z',
                    last_failure_at: null,
                    last_message: 'Status heartbeat received',
                    details: JSON.stringify({ operator: 'OldNet', signal: 80 }),
                    updated_at: '2026-04-04T12:00:00.000Z'
                },
                {
                    device_id: 'dev-1',
                    module_key: 'wifi',
                    supported: 1,
                    state: 'ok',
                    last_success_at: '2026-04-04T12:00:00.000Z',
                    last_failure_at: null,
                    last_message: 'Wi-Fi connected',
                    details: JSON.stringify({ ssid: 'OldWifi', ipAddress: '10.0.0.8' }),
                    updated_at: '2026-04-04T12:00:00.000Z'
                },
                {
                    device_id: 'dev-1',
                    module_key: 'storage',
                    supported: 1,
                    state: 'ok',
                    last_success_at: '2026-04-04T12:00:00.000Z',
                    last_failure_at: null,
                    last_message: 'Storage info refreshed',
                    details: JSON.stringify({ mounted: true, queueDepth: 5 }),
                    updated_at: '2026-04-04T12:00:00.000Z'
                }
            ])
        };

        const moduleHealth = await getDeviceModuleHealth(db, 'dev-1', { wifi: true, storage: true }, {
            mqttConnected: true,
            live: {
                online: true,
                lastSeen: '2026-04-04T12:05:00.000Z',
                network: 'Cellular standby',
                operator: 'Grameenphone',
                signal: 0,
                sim: { ready: false, registered: false },
                wifi: {
                    connected: false,
                    ssid: 'RiazM',
                    lastDisconnectReason: 201,
                    lastDisconnectReasonText: 'no_ap_found'
                },
                storage: {
                    mounted: true,
                    mediaAvailable: true,
                    bufferedOnly: false,
                    queueDepth: 0
                }
            }
        });

        const modem = moduleHealth.find(entry => entry.moduleKey === 'modem');
        const wifi = moduleHealth.find(entry => entry.moduleKey === 'wifi');
        const storage = moduleHealth.find(entry => entry.moduleKey === 'storage');

        expect(modem.state).toBe('warning');
        expect(modem.message).toBe('Modem not registered');
        expect(modem.details).toEqual(expect.objectContaining({
            operator: 'Grameenphone',
            registered: false
        }));

        expect(wifi.state).toBe('warning');
        expect(wifi.message).toBe('Configured for RiazM, access point not visible');
        expect(wifi.details).toEqual(expect.objectContaining({
            ssid: 'RiazM',
            lastDisconnectReason: 201
        }));

        expect(storage.state).toBe('ok');
        expect(storage.message).toBe('Storage mounted');
        expect(storage.details).toEqual(expect.objectContaining({
            mounted: true,
            queueDepth: 0
        }));
    });

    test('does not fall back to Wi-Fi SSID as the modem operator name', async () => {
        const moduleHealth = await getDeviceModuleHealth(null, 'dev-1', { wifi: true }, {
            mqttConnected: true,
            live: {
                online: true,
                lastSeen: '2026-04-07T17:45:08.365Z',
                network: 'Cellular',
                operator: null,
                signal: null,
                wifiSsid: 'RiazM',
                sim: { registered: true, operatorName: null, operator: null }
            }
        });

        const modem = moduleHealth.find(entry => entry.moduleKey === 'modem');
        expect(modem.state).toBe('ok');
        expect(modem.message).toBe('Registered');
        expect(modem.details).toEqual(expect.objectContaining({
            operator: null,
            registered: true
        }));
    });

    test('surfaces Wi-Fi authentication failures as credential or security issues', async () => {
        const moduleHealth = await getDeviceModuleHealth(null, 'dev-1', { wifi: true }, {
            mqttConnected: true,
            live: {
                online: true,
                lastSeen: '2026-04-22T09:19:03.404Z',
                wifi: {
                    connected: false,
                    ssid: 'RiazM',
                    lastDisconnectReason: 2,
                    lastDisconnectReasonText: 'auth_expire',
                    lastScanTargetVisible: true
                }
            }
        });

        const wifi = moduleHealth.find(entry => entry.moduleKey === 'wifi');

        expect(wifi.state).toBe('warning');
        expect(wifi.message).toBe('Authentication failed for RiazM; check hotspot password or security');
        expect(wifi.details).toEqual(expect.objectContaining({
            ssid: 'RiazM',
            lastDisconnectReasonText: 'auth_expire',
            lastScanTargetVisible: true
        }));
    });

    test('does not claim the access point is invisible when the latest scan saw it', async () => {
        const moduleHealth = await getDeviceModuleHealth(null, 'dev-1', { wifi: true }, {
            mqttConnected: true,
            live: {
                online: true,
                lastSeen: '2026-04-22T09:22:13.677Z',
                wifi: {
                    connected: false,
                    ssid: 'RiazM',
                    lastDisconnectReason: 201,
                    lastDisconnectReasonText: 'no_ap_found',
                    lastScanTargetVisible: true
                }
            }
        });

        const wifi = moduleHealth.find(entry => entry.moduleKey === 'wifi');

        expect(wifi.state).toBe('warning');
        expect(wifi.message).toBe('Hotspot RiazM was seen in scan, but the device still could not join it');
        expect(wifi.details).toEqual(expect.objectContaining({
            ssid: 'RiazM',
            lastDisconnectReasonText: 'no_ap_found',
            lastScanTargetVisible: true
        }));
    });

    test('treats live wifi and storage snapshots as supported even when capability metadata is stale', async () => {
        const moduleHealth = await getDeviceModuleHealth(null, 'dev-1', { wifi: false, storage: false }, {
            mqttConnected: true,
            live: {
                online: true,
                lastSeen: '2026-04-04T12:05:00.000Z',
                wifi: {
                    connected: false,
                    ssid: 'RiazM',
                    lastDisconnectReason: 201,
                    lastDisconnectReasonText: 'no_ap_found'
                },
                storage: {
                    mounted: true,
                    mediaAvailable: true,
                    bufferedOnly: false,
                    queueDepth: 0
                }
            }
        });

        const wifi = moduleHealth.find(entry => entry.moduleKey === 'wifi');
        const storage = moduleHealth.find(entry => entry.moduleKey === 'storage');

        expect(wifi.supported).toBe(true);
        expect(wifi.state).toBe('warning');
        expect(storage.supported).toBe(true);
        expect(storage.state).toBe('ok');
    });

    test('recognizes flat firmware device_status telemetry as live module health', async () => {
        const live = buildDashboardDeviceStatus({
            online: true,
            active_path: 'wifi',
            wifi_connected: true,
            wifi_ssid: 'RiazM',
            wifi_ip_address: '10.147.48.235',
            wifi_rssi: -71,
            mqtt_connected: true,
            mqtt_subscribed: true,
            mqtt_published_count: 16,
            modem_registered: true,
            modem_signal: 20,
            modem_operator_name: 'robi axiata',
            sd_mounted: true,
            storage_media_available: true,
            storage_queue_depth: 1,
            storage_total_bytes: 62519640064,
            storage_used_bytes: 458752,
            storage_free_bytes: 62519181312
        }, true);

        const moduleHealth = await getDeviceModuleHealth(null, 'dev-1', { wifi: true, storage: true }, {
            mqttConnected: true,
            live
        });

        const mqtt = moduleHealth.find(entry => entry.moduleKey === 'mqtt');
        const modem = moduleHealth.find(entry => entry.moduleKey === 'modem');
        const wifi = moduleHealth.find(entry => entry.moduleKey === 'wifi');
        const storage = moduleHealth.find(entry => entry.moduleKey === 'storage');

        expect(mqtt.state).toBe('ok');
        expect(mqtt.message).toBe('Device MQTT connected');
        expect(modem.state).toBe('ok');
        expect(modem.message).toBe('Registered on robi axiata (20%)');
        expect(modem.details).toEqual(expect.objectContaining({
            signal: 20
        }));
        expect(wifi.state).toBe('ok');
        expect(wifi.message).toContain('Connected to RiazM');
        expect(storage.state).toBe('ok');
        expect(storage.message).toBe('Storage mounted');
    });
});
