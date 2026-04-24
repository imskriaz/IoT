const { buildDashboardDeviceStatus, computeHealthScore, wifiRssiToPercent } = require('../utils/dashboardStatus');

describe('dashboardStatus', () => {
    test('uses Wi-Fi RSSI and SSID consistently when Wi-Fi is active', () => {
        const status = buildDashboardDeviceStatus({
            online: true,
            activePath: 'wifi',
            wifi: {
                connected: true,
                ssid: 'RiazM',
                security: 'wpa2_wpa3_psk',
                rssi: -66,
                ipAddress: '10.0.0.23'
            },
            operator: 'Grameenphone',
            signal: 68
        }, true);

        expect(status.signal).toBe(wifiRssiToPercent(-66));
        expect(status.displayName).toBe('RiazM');
        expect(status.network).toBe('Wi-Fi');
        expect(status.currentNetworkName).toBe('RiazM');
        expect(status.ip).toBe('10.0.0.23');
        expect(status.wifiSecurity).toBe('WPA2/WPA3');
        expect(status.activePathLabel).toBe('Wi-Fi (WPA2/WPA3)');
        expect(status.wifiStatus).toContain('RiazM (WPA2/WPA3)');
        expect(status.wifiStatusLabel).toBe('Connected');
        expect(status.wifiRoleLabel).toBe('Primary');
    });

    test('marks modem path as cellular standby while PPP is pending', () => {
        const status = buildDashboardDeviceStatus({
            online: true,
            activePath: 'modem',
            operator: 'Grameenphone',
            signal: 68,
            ip: '10.86.38.133',
            sim: {
                registered: true
            },
            mqtt: {
                lastErrorText: 'modem_data_ready_ppp_missing'
            }
        }, true);

        expect(status.network).toBe('Cellular standby');
        expect(status.currentNetworkName).toBe('Grameenphone');
        expect(status.cellularStatus).toContain('PPP pending');
        expect(status.ip).toBe('10.86.38.133');
    });

    test('drops stale Wi-Fi strength when Wi-Fi is disconnected', () => {
        const status = buildDashboardDeviceStatus({
            online: true,
            activePath: 'modem',
            operator: 'Grameenphone',
            signal: 55,
            wifi: {
                connected: false,
                ssid: 'RiazM',
                rssi: -52,
                lastDisconnectReasonText: 'no_ap_found'
            }
        }, true);

        expect(status.wifiSignal).toBeNull();
        expect(status.wifiStatus).toBe('RiazM - (no_ap_found)');
        expect(status.cellularSignal).toBe(55);
    });

    test('keeps modem path primary when saved Wi-Fi is disconnected', () => {
        const status = buildDashboardDeviceStatus({
            online: true,
            activePath: 'modem',
            operator: 'Robi Axiata',
            mobile: {
                networkType: 'LTE'
            },
            signal: 74,
            ip: '10.86.38.133',
            wifi: {
                connected: false,
                ssid: 'RiazM',
                configured: true,
                started: true,
                lastDisconnectReasonText: 'auth_expire'
            }
        }, true);

        expect(status.network).toBe('Cellular');
        expect(status.cellularNetworkType).toBe('4G/LTE');
        expect(status.activePathLabel).toBe('Modem (4G/LTE)');
        expect(status.currentNetworkName).toBe('Robi Axiata');
        expect(status.currentNetworkDetails).toContain('active');
        expect(status.displayName).toBe('Robi Axiata');
        expect(status.wifiStatus).toBe('RiazM - disconnected (auth_expire)');
        expect(status.wifiStatusLabel).toBe('Not connected');
        expect(status.wifiRoleLabel).toBe('Not connected');
        expect(status.modemRoleLabel).toBe('Fallback');
    });

    test('clears stale connectivity when the last heartbeat is too old', () => {
        const staleLastSeen = new Date(Date.now() - (3 * 60 * 1000)).toISOString();
        const status = buildDashboardDeviceStatus({
            online: true,
            lastSeen: staleLastSeen,
            activePath: 'wifi',
            operator: 'Grameenphone',
            signal: 72,
            ip: '192.168.1.50',
            wifi: {
                connected: true,
                ssid: 'BenchNet',
                ipAddress: '192.168.1.50',
                rssi: -58
            },
            mqtt: {
                connected: true,
                subscribed: true
            }
        }, true);

        expect(status.online).toBe(false);
        expect(status.statusFresh).toBe(false);
        expect(status.activePath).toBe('offline');
        expect(status.signal).toBeNull();
        expect(status.wifiSignal).toBeNull();
        expect(status.network).toBe('Offline');
        expect(status.currentNetworkDetails).toBe('No recent heartbeat');
        expect(status.wifiStatusLabel).toBe('Disconnected');
        expect(status.wifiRoleLabel).toBe('Offline');
        expect(status.modemRoleLabel).toBe('Offline');
        expect(status.wifi).toEqual(expect.objectContaining({
            connected: false,
            ipAddress: '',
            rssi: null
        }));
        expect(status.mqtt).toEqual(expect.objectContaining({
            connected: false,
            subscribed: false
        }));
    });

    test('keeps PPP pending visible before modem becomes the active path', () => {
        const status = buildDashboardDeviceStatus({
            online: true,
            activePath: null,
            operator: 'Grameenphone',
            signal: 61,
            ip: '10.86.38.133',
            sim: {
                registered: true
            },
            mqtt: {
                lastErrorText: 'modem_data_ready_ppp_missing'
            }
        }, true);

        expect(status.network).toBe('Cellular standby');
        expect(status.cellularStatus).toContain('PPP pending');
        expect(status.currentNetworkName).toBe('Grameenphone');
    });

    test('labels active PPP links with unavailable RSSI explicitly when signal is unknown', () => {
        const status = buildDashboardDeviceStatus({
            online: true,
            activePath: 'modem',
            operator: 'Grameenphone',
            signal: null,
            ip: '10.172.126.118',
            sim: {
                registered: true
            }
        }, true);

        expect(status.cellularSignal).toBeNull();
        expect(status.cellularStatus).toContain('signal unavailable');
        expect(status.cellularStatus).toContain('active');
    });

    test('computes health score from available real values only', () => {
        const score = computeHealthScore({
            online: true,
            signal: 80,
            battery: null,
            uptime: '2d 1h'
        });

        expect(score).toBeGreaterThanOrEqual(40);
        expect(score).toBeLessThanOrEqual(100);
    });

    test('does not show 0 percent health when only very short uptime is available', () => {
        const score = computeHealthScore({
            online: true,
            signal: null,
            battery: null,
            uptime: '6m',
            mqtt: null
        });

        expect(score).toBeNull();
    });

    test('hydrates dashboard fields from nested runtime and storage snapshots', () => {
        const status = buildDashboardDeviceStatus({
            online: true,
            active_path: 'modem',
            mobile: {
                networkType: 'Cellular',
                ipAddress: '10.172.126.118'
            },
            sim: {
                registered: true,
                operatorName: 'Grameenphone',
                number: '+8801628301525'
            },
            status: {
                modem: {
                    operator: '47001',
                    signal: 64,
                    dataIp: '10.172.126.118'
                },
                storage: {
                    mounted: true,
                    mediaAvailable: true,
                    totalBytes: 62505500672,
                    usedBytes: 0,
                    freeBytes: 62505500672,
                    queueDepth: 0
                }
            },
            system: {
                battery: 76,
                charging: false,
                voltage_mV: 4018,
                temperature: 29,
                uptime: '6m'
            },
            task_count: 5,
            missing_task_count: 1,
            health_degraded: true,
            health_module_count: 4,
            degraded_module_count: 1,
            failed_module_count: 0,
            stub_module_count: 1,
            health_last_reason: 'storage_backlog'
        }, true);

        expect(status.operator).toBe('Grameenphone');
        expect(status.simNumber).toBe('+8801628301525');
        expect(status.currentNetworkName).toBe('Grameenphone');
        expect(status.ip).toBe('10.172.126.118');
        expect(status.battery).toBe(76);
        expect(status.voltageMv).toBe(4018);
        expect(status.charging).toBe(false);
        expect(status.temperature).toBe(29);
        expect(status.storage).toEqual(expect.objectContaining({
            mounted: true,
            mediaAvailable: true,
            totalBytes: 62505500672
        }));
        expect(status.taskCount).toBe(5);
        expect(status.missingTaskCount).toBe(1);
        expect(status.healthDegraded).toBe(true);
        expect(status.health).toEqual(expect.objectContaining({
            degraded: true,
            moduleCount: 4,
            degradedModuleCount: 1,
            failedModuleCount: 0,
            stubModuleCount: 1,
            lastReason: 'storage_backlog'
        }));
    });

    test('preserves explicit telephony and data-mode flags in the normalized dashboard status', () => {
        const status = buildDashboardDeviceStatus({
            online: true,
            active_path: 'modem',
            telephony_supported: false,
            telephony_enabled: false,
            data_mode_enabled: true,
            sim: {
                registered: true
            },
            status: {
                modem: {
                    dataSession: true
                }
            }
        }, true);

        expect(status.telephonySupported).toBe(false);
        expect(status.telephonyEnabled).toBe(false);
        expect(status.dataModeEnabled).toBe(true);
    });

    test('hydrates nested module snapshots from flat firmware status payloads', () => {
        const status = buildDashboardDeviceStatus({
            online: true,
            active_path: 'wifi',
            wifi_configured: true,
            wifi_started: true,
            wifi_connected: true,
            wifi_ip_assigned: true,
            wifi_ssid: 'RiazM',
            wifi_ip_address: '10.147.48.235',
            wifi_rssi: -71,
            wifi_last_scan_target_visible: true,
            wifi_last_scan_visible_count: 1,
            wifi_last_scan_elapsed_ms: 2600,
            wifi_last_scan_summary: 'RiazM@ch1/-85dBm',
            mqtt_configured: true,
            mqtt_connected: true,
            mqtt_subscribed: true,
            mqtt_reconnect_count: 0,
            mqtt_published_count: 16,
            mqtt_publish_failures: 0,
            modem_registered: true,
            modem_signal: 58,
            modem_operator: 'robi axiata',
            modem_operator_name: 'robi axiata',
            modem_ip_bearer_ready: true,
            modem_data_ip: '10.189.112.220',
            telephony_supported: true,
            telephony_enabled: true,
            data_mode_enabled: true,
            battery: 84,
            charging: true,
            voltage_mV: 4016,
            sd_mounted: true,
            storage_media_available: true,
            storage_buffered_only: false,
            storage_queue_depth: 1,
            storage_total_bytes: 62519640064,
            storage_used_bytes: 458752,
            storage_free_bytes: 62519181312
        }, true);

        expect(status.network).toBe('Wi-Fi');
        expect(status.activePath).toBe('wifi');
        expect(status.wifi).toEqual(expect.objectContaining({
            connected: true,
            ssid: 'RiazM',
            ipAddress: '10.147.48.235',
            rssi: -71
        }));
        expect(status.mqtt).toEqual(expect.objectContaining({
            connected: true,
            subscribed: true,
            publishedCount: 16
        }));
        expect(status.sim).toEqual(expect.objectContaining({
            registered: true,
            operator: 'robi axiata',
            operatorName: 'robi axiata',
            telephonySupported: true,
            telephonyEnabled: true,
            dataModeEnabled: true,
            dataIp: '10.189.112.220'
        }));
        expect(status.battery).toBe(84);
        expect(status.charging).toBe(true);
        expect(status.voltageMv).toBe(4016);
        expect(status.storage).toEqual(expect.objectContaining({
            mounted: true,
            mediaAvailable: true,
            queueDepth: 1,
            totalBytes: 62519640064
        }));
        expect(status.platform).toBe('firmware');
        expect(status.androidId).toBeFalsy();
    });

    test('defaults unreported ESP32 firmware model to ESP32', () => {
        const status = buildDashboardDeviceStatus({
            online: true,
            type: 'esp32',
            active_path: 'wifi',
            wifi_connected: true,
            wifi_ssid: 'BenchNet',
            wifi_ip_address: '10.0.0.32'
        }, true);

        expect(status.model).toBe('ESP32');
    });

    test('clears stale mqtt_not_connected reasons when mqtt is already connected', () => {
        const status = buildDashboardDeviceStatus({
            online: true,
            mqtt: {
                connected: true,
                subscribed: true
            },
            systemRuntime: {
                degradedReason: 'mqtt_not_connected'
            },
            transport: {
                mqttCommandAccepting: true,
                reason: 'mqtt_not_connected'
            }
        }, true);

        expect(status.mqtt).toEqual(expect.objectContaining({
            connected: true,
            subscribed: true
        }));
        expect(status.systemRuntime).toEqual(expect.objectContaining({
            degradedReason: null
        }));
        expect(status.transport).toEqual(expect.objectContaining({
            reason: null
        }));
    });

    test('treats mqtt command acceptance as subscribed when the command path is already live', () => {
        const status = buildDashboardDeviceStatus({
            online: true,
            mqtt: {
                connected: true,
                subscribed: false,
                publishedCount: 13
            },
            transport: {
                mqttCommandAccepting: true
            }
        }, true);

        expect(status.mqtt).toEqual(expect.objectContaining({
            connected: true,
            subscribed: true,
            publishedCount: 13
        }));
    });
});
