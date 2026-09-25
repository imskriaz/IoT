jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

describe('modemService status normalization', () => {
    let modemService;

    beforeEach(() => {
        jest.resetModules();
        modemService = require('../services/modemService');
        modemService.resetDevices();
    });

    test('heartbeats renew online state but not the age of the last status snapshot', () => {
        jest.useFakeTimers();
        try {
            jest.setSystemTime(new Date('2026-09-21T12:00:00Z'));
            modemService.handleHeartbeat('heartbeat-only');
            expect(modemService.getDeviceStatus('heartbeat-only')).toMatchObject({
                online: true, statusFresh: false, statusAgeMs: null, staleReason: 'no_recent_status'
            });
            modemService.updateDeviceStatus('heartbeat-only', { type: 'device_status', mqtt_connected: true });
            const lastStatusAt = new Date().toISOString();
            expect(modemService.getDeviceStatus('heartbeat-only')).toMatchObject({ statusFresh: true, lastStatusAt });
            jest.advanceTimersByTime(121000);
            modemService.handleHeartbeat('heartbeat-only');
            const status = modemService.getDeviceStatus('heartbeat-only');
            expect(status).toMatchObject({
                online: true, statusFresh: false, statusAgeMs: 121000, lastStatusAt, staleReason: 'no_recent_status'
            });
            const { buildDashboardDeviceStatus } = require('../utils/dashboardStatus');
            expect(buildDashboardDeviceStatus(status, true)).toMatchObject({
                online: true, statusFresh: false, statusAgeMs: 121000, lastStatusAt, staleReason: 'no_recent_status'
            });
            modemService.updateDeviceStatus('heartbeat-only', { type: 'device_status', mqtt_connected: true });
            expect(modemService.getDeviceStatus('heartbeat-only')).toMatchObject({
                online: true, statusFresh: true, statusAgeMs: 0, staleReason: null
            });
        } finally {
            jest.useRealTimers();
        }
    });

    test('cache hydration retains status observation age independently from a newer heartbeat', () => {
        jest.useFakeTimers();
        try {
            jest.setSystemTime(new Date('2026-09-21T12:00:00Z'));
            modemService.handleHeartbeat('cached-heartbeat');
            const observedAt = new Date(Date.now() - 110000).toISOString();
            modemService.updateDeviceStatus('cached-heartbeat', { wifi_connected: true }, { fromCache: true, observedAt });
            expect(modemService.getDeviceStatus('cached-heartbeat')).toMatchObject({
                online: true, statusFresh: true, statusAgeMs: 110000, lastStatusAt: observedAt
            });
            jest.advanceTimersByTime(11000);
            expect(modemService.getDeviceStatus('cached-heartbeat')).toMatchObject({
                online: true, statusFresh: false, statusAgeMs: 121000, lastStatusAt: observedAt
            });
        } finally {
            jest.useRealTimers();
        }
    });

    test('new sensor measurements replace old values while partial packets preserve other measurements', () => {
        modemService.updateDeviceStatus('sensor-updates', {
            system: { power_source: 'USB-C' },
            sensors: { batterySoc: 80, batteryVoltage_mV: 4100, charging: true, temperature_C: 30 }
        });
        modemService.updateDeviceStatus('sensor-updates', {
            sensors: { battery_soc: 65, battery_voltage_mV: 3900, charging: false, temperature_c: 35 }
        });
        expect(modemService.getDeviceStatus('sensor-updates')).toMatchObject({
            battery: 65, voltageMv: 3900, charging: false, powerSource: 'USB-C', temperature: 35
        });
        modemService.updateDeviceStatus('sensor-updates', { sensors: { temperature_C: 0 } });
        expect(modemService.getDeviceStatus('sensor-updates')).toMatchObject({
            battery: 65, voltageMv: 3900, charging: false, temperature: 0
        });
        modemService.updateDeviceStatus('sensor-updates', { uptime: 42 });
        expect(modemService.getDeviceStatus('sensor-updates')).toMatchObject({
            battery: 65, voltageMv: 3900, charging: false, temperature: 0
        });
        modemService.updateDeviceStatus('sensor-updates', { temperature: 31 });
        expect(modemService.getDeviceStatus('sensor-updates')).toMatchObject({
            battery: 65, voltageMv: 3900, charging: false, temperature: 31
        });
    });

    test('does not turn the firmware Wi-Fi RSSI zero sentinel into 100 percent', () => {
        modemService.updateDeviceStatus('wifi-awaiting-sample', {
            active_path: 'wifi',
            wifi_connected: true,
            wifi_ssid: 'BenchNet',
            wifi_ip_address: '192.168.1.20',
            wifi_rssi: 0
        });

        expect(modemService.getDeviceStatus('wifi-awaiting-sample')).toMatchObject({
            signal: null,
            signalDbm: null,
            wifiSignal: null,
            wifiSignalDbm: null,
            wifi: { rssi: 0 }
        });
    });

    test('partial Wi-Fi samples preserve association and accept explicit clears', () => {
        modemService.updateDeviceStatus('wifi-partial', {
            wifi_connected: true, wifi_started: true, wifi_configured: true,
            wifi_ssid: 'Network', wifi_ip_address: '192.168.1.2',
            wifi_security: 'WPA2', wifi_last_disconnect_reason: 202
        });
        modemService.updateDeviceStatus('wifi-partial', { wifi_rssi: -60 });
        modemService.updateDeviceStatus('wifi-partial', { wifi_last_scan_visible_count: 3 });
        expect(modemService.getDeviceStatus('wifi-partial').wifi).toMatchObject({
            connected: true, started: true, configured: true, mode: 'sta',
            ssid: 'Network', ipAddress: '192.168.1.2', security: 'WPA2',
            rssi: -60, lastDisconnectReason: 202, lastScanVisibleCount: 3
        });
        modemService.updateDeviceStatus('wifi-partial', {
            wifi_connected: false, wifi_ssid: '', wifi_ip_address: '',
            wifi_security: '', wifi_last_disconnect_reason: 0
        });
        expect(modemService.getDeviceStatus('wifi-partial').wifi).toMatchObject({
            connected: false, ssid: '', ipAddress: '', security: '', lastDisconnectReason: 0
        });
    });

    test('current system telemetry retains precedence over sensors in the same packet', () => {
        modemService.updateDeviceStatus('system-precedence', {
            system: { battery: 72, temperature: 28 },
            sensors: { batterySoc: 80, temperature_C: 30 }
        });
        expect(modemService.getDeviceStatus('system-precedence')).toMatchObject({ battery: 72, temperature: 28 });
    });

    test('profile metadata survives normalization without changing Wi-Fi association on partial updates', () => {
        const { buildDashboardDeviceStatus } = require('../utils/dashboardStatus');
        modemService.updateDeviceStatus('profiles', {
            wifi_connected: true, wifi_ssid: 'SavedNetwork',
            wifi_last_disconnect_reason: 202,
            wifi_profiles_revision: 7, wifi_profiles_count: 2
        });
        modemService.updateDeviceStatus('profiles', { wifi_profiles_revision: 8, wifi_profiles_count: 0 });
        modemService.updateDeviceStatus('profiles', { uptime_ms: 1000 });
        const status = modemService.getDeviceStatus('profiles');
        expect(status.wifi).toMatchObject({
            connected: true, ssid: 'SavedNetwork', lastDisconnectReason: 202,
            profilesRevision: 8, profilesCount: 0
        });
        expect(buildDashboardDeviceStatus(status, true).wifi).toMatchObject({
            profilesRevision: 8, profilesCount: 0
        });
        modemService.updateDeviceStatus('unreported-profiles', { wifi_connected: false });
        expect(modemService.getDeviceStatus('unreported-profiles').wifi.profilesRevision).toBeUndefined();
    });

    test('partial runtime packets preserve unrelated sensor and memory measurements', () => {
        modemService.updateDeviceStatus('partial-runtime', {
            system: { battery: 75, voltageMv: 4070, uptime: 100, temperature: 29 },
            heap_total_bytes: 100000, heap_free_bytes: 60000, runtime_ram_free_bytes: 50000,
            psram_free_bytes: 8000000, reboot_reason: 'power_on'
        });
        modemService.updateDeviceStatus('partial-runtime', { temperature: 0 });
        modemService.updateDeviceStatus('partial-runtime', { runtime_ram_free_bytes: 49000 });
        expect(modemService.getDeviceStatus('partial-runtime')).toMatchObject({
            battery: 75, voltageMv: 4070, temperature: 0, uptime: '1m',
            systemRuntime: { heapTotal: 100000, heapFree: 60000, runtimeRamFree: 49000,
                psramFree: 8000000, rebootReason: 'power_on' }
        });
        modemService.updateDeviceStatus('partial-runtime', { uptime_ms: 0 });
        expect(modemService.getDeviceStatus('partial-runtime').uptime).toBe('0s');
    });

    test('ESP32 hardware identity and reported diagnostics survive the service-to-dashboard pipeline', () => {
        const { buildDashboardDeviceStatus } = require('../utils/dashboardStatus');
        modemService.updateDeviceStatus('esp-status-diagnostics', {
            type: 'status', board_name: 'Waveshare ESP32-S3-A7670E-4G', board_chip: 'ESP32-S3R8',
            mqtt_configured: true, mqtt_connected: true, mqtt_subscribed: true,
            mqtt_reconnect_count: 0, mqtt_published_count: 2, mqtt_publish_failures: 0,
            mqtt_command_messages: 3, mqtt_command_rejects: 1,
            mqtt_action_results_published: 2, mqtt_action_result_failures: 0,
            task_count: 14, missing_task_count: 0, stack_tracked_task_count: 12,
            low_stack_task_count: 1, min_stack_high_water_bytes: 1424, min_stack_task_name: 'modem_task',
            health_degraded: false, health_module_count: 9, degraded_module_count: 0,
            failed_module_count: 0, stub_module_count: 0, health_last_reason: 'ok'
        });
        const build = () => buildDashboardDeviceStatus(modemService.getDeviceStatus('esp-status-diagnostics'), true);
        expect(build()).toMatchObject({
            platform: 'firmware', model: 'Waveshare ESP32-S3-A7670E-4G', taskCount: 14,
            missingTaskCount: 0, healthDegraded: false,
            mqtt: { configured: true, connected: true, subscribed: true, reconnectCount: 0,
                commandMessages: 3, commandRejects: 1, actionResultsPublished: 2, actionResultFailures: 0 },
            tasks: { stackTrackedCount: 12, lowStackCount: 1, minStackHighWaterBytes: 1424, minStackTaskName: 'modem_task' },
            health: { moduleCount: 9, degradedModuleCount: 0, failedModuleCount: 0, stubModuleCount: 0 }
        });
        modemService.updateDeviceStatus('esp-status-diagnostics', { mqtt_command_messages: 4, temperature: 31 });
        expect(build()).toMatchObject({ platform: 'firmware', taskCount: 14,
            mqtt: { configured: true, connected: true, commandMessages: 4, commandRejects: 1 } });
        modemService.updateDeviceStatus('esp-status-diagnostics', { mqtt: { connected: false } });
        expect(modemService.getDeviceStatus('esp-status-diagnostics').mqtt).toMatchObject({
            configured: true, connected: false, commandMessages: 4, commandRejects: 1
        });
    });

    test('does not invent a platform for unknown hardware and retains actual Android identity', () => {
        modemService.updateDeviceStatus('unknown-device', { system: { battery: 50 } });
        expect(modemService.getDeviceStatus('unknown-device').device.platform).toBeNull();
        modemService.updateDeviceStatus('android-device', { device: { platform: 'android', model: 'Pixel' } });
        expect(modemService.getDeviceStatus('android-device').device).toMatchObject({ platform: 'android', model: 'Pixel' });
        modemService.updateDeviceStatus('android-inferred', { android_id: 'test-android-id' });
        expect(modemService.getDeviceStatus('android-inferred').device.platform).toBe('android');
    });

    test('prefers Arduino nested status fields for operator, sim, and battery telemetry', () => {
        modemService.updateDeviceStatus('device-arduino', {
            active_path: 'modem',
            mobile: {
                signalStrength: 22,
                signalDbm: -69,
                networkType: 'LTE',
                operator: 'Grameenphone',
                ipAddress: '10.0.0.5',
                registered: true
            },
            system: {
                battery: 81,
                voltage_mV: 4098,
                charging: true,
                uptime: 3210,
                temperature: 33.2
            },
            sim: {
                number: '+8801628301525',
                mcc: '47001'
            },
            imei: '123456789012345'
        });

        const status = modemService.getDeviceStatus('device-arduino');

        expect(status).toMatchObject({
            online: true,
            operator: 'Grameenphone',
            simNumber: '+8801628301525',
            battery: 81,
            voltageMv: 4098,
            charging: true,
            imei: '123456789012345'
        });
        expect(status.sim).toMatchObject({
            number: '+8801628301525'
        });
    });

    test('preserves the modem operator code when the device does not report a carrier name', () => {
        modemService.updateDeviceStatus('device-espidf', {
            active_path: 'modem',
            modem_registered: true,
            modem_signal: 19,
            modem_operator: '47002',
            modem_operator_name: '47002',
            modem_subscriber_number: '+8801700000000',
            modem_data_ip: '100.64.1.23',
            sensors: {
                batterySoc: 67,
                batteryVoltage_mV: 3920,
                charging: false,
                temperature_C: 29
            },
            imei: '867530900000001'
        });

        const status = modemService.getDeviceStatus('device-espidf');

        expect(status).toMatchObject({
            online: true,
            operator: '47002',
            simNumber: '+8801700000000',
            battery: 67,
            voltageMv: 3920,
            charging: false,
            ip: '100.64.1.23',
            imei: '867530900000001'
        });
        expect(status.sim).toMatchObject({
            number: '+8801700000000',
            operatorName: '47002'
        });
    });

    test('shows an assigned PDP address without claiming the cellular socket bearer is connected', () => {
        modemService.updateDeviceStatus('device-pdp-only', {
            active_path: 'wifi',
            wifi_connected: true,
            wifi_ip_address: '192.168.0.102',
            modem_registered: true,
            data_mode_enabled: true,
            modem_data_session_open: false,
            modem_ip_bearer_ready: false,
            modem_data_ip: '',
            modem_ip_address: '',
            modem_pdp_ip_address: '10.175.163.107',
            modem_operator_name: 'robi axiata',
            modem_network_type: 'LTE',
            mqtt_connected: true,
            mqtt_subscribed: true
        });

        const status = modemService.getDeviceStatus('device-pdp-only');

        expect(status.mobile).toMatchObject({
            connected: false,
            ipAddress: '10.175.163.107',
            dataIp: null,
            pdpIpAddress: '10.175.163.107',
            ipBearerReady: false,
            dataSession: false
        });
        expect(status.sim).toMatchObject({
            registered: true,
            dataIp: null,
            pdpIp: '10.175.163.107',
            ipBearer: false,
            dataSession: false
        });
        expect(status.activePath).toBe('wifi');
    });

    test('does not let active_path override an explicit failed modem session contract', () => {
        modemService.updateDeviceStatus('device-failed-bearer', {
            active_path: 'modem',
            modem_registered: true,
            data_mode_enabled: true,
            modem_data_session_open: false,
            modem_ip_bearer_ready: true,
            modem_data_ip: '10.175.163.107'
        });

        const status = modemService.getDeviceStatus('device-failed-bearer');
        expect(status.mobile).toMatchObject({
            connected: false,
            dataSession: false,
            ipBearerReady: true,
            dataIp: '10.175.163.107'
        });
    });

    test('preserves the last known SIM number when a later status omits it', () => {
        modemService.updateDeviceStatus('device-sim-cache', {
            active_path: 'modem',
            modem_registered: true,
            modem_operator_name: 'robi axiata',
            modem_subscriber_number: '+8801887300993',
            mqtt_connected: true,
            mqtt_subscribed: true
        });

        modemService.updateDeviceStatus('device-sim-cache', {
            active_path: 'modem',
            modem_registered: true,
            modem_operator_name: 'robi axiata',
            mobile: {
                simNumber: '',
                subscriberNumber: ''
            },
            sim: {
                number: '',
                subscriberNumber: ''
            },
            mqtt_connected: true,
            mqtt_subscribed: true
        });

        const status = modemService.getDeviceStatus('device-sim-cache');

        expect(status.simNumber).toBe('+8801887300993');
        expect(status.sim).toMatchObject({
            number: '+8801887300993',
            subscriberNumber: '+8801887300993'
        });
    });
});
