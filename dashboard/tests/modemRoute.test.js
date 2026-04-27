'use strict';

const EventEmitter = require('events');
const express = require('express');
const request = require('supertest');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

function buildApp(router) {
    const app = express();
    app.use(express.json());
    app.use('/api/modem', router);
    return app;
}

describe('modem route MQTT event flows', () => {
    afterEach(() => {
        delete global.mqttService;
        delete global.io;
        delete global.modemService;
        jest.resetModules();
    });

    test('wifi scan waits for the wifi:scan event without requiring a command ACK', async () => {
        jest.resetModules();
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command) => {
            setImmediate(() => {
                mqttService.emit('wifi:scan', deviceId, {
                    networks: [
                        {
                            ssid: 'RIAZ-GAP',
                            bssid: 'AA:BB:CC:DD:EE:FF',
                            rssi: -58,
                            encryption: 'WPA2-PSK',
                            channel: 6,
                            frequency: 2437
                        }
                    ]
                });
            });
            return { success: true, queued: false, command };
        });

        global.mqttService = mqttService;

        const router = require('../routes/modem');
        const app = buildApp(router);

        const res = await request(app).get('/api/modem/wifi/client/scan?deviceId=device-1');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            data: [
                {
                    ssid: 'RIAZ-GAP',
                    bssid: 'AA:BB:CC:DD:EE:FF',
                    signal: 84,
                    security: 'WPA2-PSK',
                    channel: 6,
                    band: '2.4GHz',
                    encrypted: true
                }
            ]
        });
        expect(mqttService.publishCommand).toHaveBeenCalledWith(
            'device-1',
            'wifi-scan',
            { timeout: 65000 },
            false,
            75000,
            expect.objectContaining({
                skipQueue: true,
                source: 'dashboard-modem',
                domain: 'network'
            })
        );
    });

    test('wifi scan also accepts direct action result payloads', async () => {
        jest.resetModules();
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command) => {
            setImmediate(() => {
                mqttService.emit('action:result', deviceId, {
                    action_id: 'wifi-scan-1',
                    command: 'wifi_scan',
                    result: 'completed',
                    success: true,
                    payload: JSON.stringify({
                        networks: [
                            {
                                ssid: 'RiazM',
                                rssi: -80,
                                encryption: 'wpa2_psk',
                                channel: 1
                            }
                        ],
                        report: {
                            total_visible: 1,
                            elapsed_ms: 9500,
                            mode: 'passive_fallback',
                            channel: 0
                        }
                    })
                });
            });
            return { success: true, queued: false, command };
        });

        global.mqttService = mqttService;

        const router = require('../routes/modem');
        const app = buildApp(router);

        const res = await request(app).get('/api/modem/wifi/client/scan?deviceId=device-1');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            data: [
                {
                    ssid: 'RiazM',
                    bssid: '',
                    signal: 40,
                    security: 'wpa2_psk',
                    channel: 1,
                    band: '2.4GHz',
                    encrypted: true
                }
            ]
        });
    });

    test('wifi scan does not hang when the MQTT publish ACK stalls but result arrives', async () => {
        jest.resetModules();
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockImplementation((deviceId) => {
            setTimeout(() => {
                mqttService.emit('wifi:scan', deviceId, {
                    networks: [
                        {
                            ssid: 'RiazM',
                            rssi: -79,
                            encryption: 'wpa2_psk',
                            channel: 1
                        }
                    ]
                });
            }, 5500).unref?.();
            return new Promise(() => {});
        });

        global.mqttService = mqttService;

        const router = require('../routes/modem');
        const app = buildApp(router);

        const res = await request(app).get('/api/modem/wifi/client/scan?deviceId=device-1');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual([
            expect.objectContaining({
                ssid: 'RiazM',
                signal: 42,
                security: 'wpa2_psk'
            })
        ]);
    }, 10000);

    test('hotspot clients returns an empty snapshot without MQTT churn when firmware has no hotspot telemetry lane', async () => {
        jest.resetModules();
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn();

        global.mqttService = mqttService;

        const router = require('../routes/modem');
        const app = buildApp(router);

        const res = await request(app).get('/api/modem/wifi/hotspot/clients?deviceId=device-2');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            data: [],
            count: 0
        });
        expect(mqttService.publishCommand).not.toHaveBeenCalled();
    });

    test('wifi scan timeout returns fallback host networks as a degraded successful scan', async () => {
        jest.resetModules();
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockRejectedValue(new Error('Timed out waiting for wifi:scan'));

        global.mqttService = mqttService;
        global.modemService = {
            getDeviceStatus: jest.fn().mockReturnValue({
                wifi: {
                    configured: true,
                    started: false,
                    connected: false,
                    ssid: 'RIAZ-GAP',
                    lastDisconnectReason: 201,
                    lastDisconnectReasonText: 'no_ap_found'
                }
            })
        };

        const hostHotspotService = require('../services/hostHotspotService');
        jest.spyOn(hostHotspotService, 'scanVisibleNetworks').mockResolvedValue({
            interfaceState: {
                name: 'Wi-Fi',
                state: 'disconnected'
            },
            networks: [
                {
                    ssid: 'Guest',
                    signal: 91,
                    band: '2.4 GHz',
                    channel: 6,
                    bssids: ['AA:BB:CC:DD:EE:FF']
                }
            ]
        });

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            get: jest.fn().mockResolvedValue({
                wifi_ssid: 'RIAZ-GAP',
                wifi_pass: '12345678'
            })
        };

        const res = await request(app).get('/api/modem/wifi/client/scan?deviceId=device-3');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toContain('Selected network RIAZ-GAP was not visible');
        expect(res.body.scanSource).toBe('dashboard_host');
        expect(res.body.degraded).toBe(true);
        expect(res.body.data).toEqual([
            {
                ssid: 'Guest',
                bssid: 'AA:BB:CC:DD:EE:FF',
                signal: 91,
                security: 'open',
                channel: 6,
                band: '2.4 GHz',
                encrypted: false,
                scanSource: 'dashboard_host'
            }
        ]);
        expect(res.body.diagnostic).toEqual(expect.objectContaining({
            selectedSsid: 'RIAZ-GAP',
            desiredSsid: 'RIAZ-GAP',
            selectedPasswordSet: true,
            likelyCause: 'target_ssid_not_visible_from_dashboard_host',
            deviceWifi: expect.objectContaining({
                lastDisconnectReasonText: 'no_ap_found'
            }),
            hostScan: expect.objectContaining({
                available: true,
                networks: expect.arrayContaining([
                    expect.objectContaining({
                        ssid: 'Guest',
                        signal: 91
                    })
                ]),
                desiredVisible: false,
                visibleNetworkCount: 1
            })
        }));
    });

    test('modem status prefers the cleaned live source-of-truth when Wi-Fi is the active path', async () => {
        jest.resetModules();

        global.modemService = {
            getStatus: jest.fn().mockReturnValue({
                online: true,
                activePath: 'wifi',
                network: 'Wi-Fi',
                operator: 'Grameenphone',
                signal: 88,
                signalDbm: -58,
                cellularSignal: 41,
                cellularSignalDbm: -91,
                wifiSignal: 88,
                ip: '192.168.1.50',
                imei: '862596081929782',
                wifi: {
                    mode: 'sta',
                    configured: true,
                    started: true,
                    connected: true,
                    ssid: 'BenchNet',
                    ipAddress: '192.168.1.50',
                    apEnabled: false,
                    clients: 0
                },
                sim: {
                    registered: true
                },
                dataModeEnabled: true,
                battery: 77,
                charging: false,
                voltageMv: 4018,
                temperature: 29,
                uptime: '6m'
            }),
            devices: new Map([
                ['device-wifi', {
                    mobile: {
                        networkType: 'LTE',
                        signalDbm: -91
                    },
                    wifi: {
                        connected: true,
                        ssid: 'BenchNet',
                        rssi: -56
                    }
                }]
            ])
        };

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([]),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        const res = await request(app).get('/api/modem/status?deviceId=device-wifi');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.capabilities).toEqual(expect.objectContaining({
            mobile: expect.objectContaining({
                remoteToggle: true,
                remoteApn: true
            }),
            wifiClient: expect.objectContaining({
                scan: true,
                remoteToggle: true,
                remoteConnect: true,
                remoteDisconnect: true,
                retrySaved: true,
                configPath: 'device-settings'
            }),
            hotspot: expect.objectContaining({
                remoteToggle: false,
                remoteConfigure: false,
                remoteClientBlock: false,
                remoteClientLimit: false
            }),
            usb: expect.objectContaining({
                remoteToggle: false
            }),
            routing: expect.objectContaining({
                remoteConfigure: true,
                remoteFailover: true,
                remoteLoadBalancing: false,
                remoteNat: false,
                remoteFirewall: false,
                preferModemData: true
            }),
            dataUsage: expect.objectContaining({
                remoteReset: false
            })
        }));
        expect(res.body.data.routing.primarySource).toBe('wifi');
        expect(res.body.data.internet.sources).toEqual(expect.objectContaining({
            wifi: true,
            mobile: false
        }));
        expect(res.body.data.wifiClient).toEqual(expect.objectContaining({
            connected: true,
            ssid: 'BenchNet',
            ipAddress: '192.168.1.50',
            signalStrength: 88
        }));
        expect(res.body.data.mobile).toEqual(expect.objectContaining({
            enabled: true,
            connected: false,
            operator: 'Grameenphone',
            networkType: 'LTE',
            signalStrength: 41,
            signalDbm: -91,
            ipAddress: ''
        }));
    });

    test('modem status keeps Wi-Fi as the current path when both Wi-Fi and modem are connected', async () => {
        jest.resetModules();

        global.modemService = {
            getStatus: jest.fn().mockReturnValue({
                online: true,
                activePath: 'wifi',
                network: 'Wi-Fi',
                operator: 'Robi',
                cellularSignal: 53,
                cellularSignalDbm: -85,
                wifiSignal: 84,
                ip: '192.168.0.24',
                mobile: {
                    networkType: 'LTE',
                    dataUsage: {
                        sent: 4096,
                        received: 8192
                    }
                },
                wifi: {
                    mode: 'sta',
                    configured: true,
                    started: true,
                    connected: true,
                    ssid: 'BenchNet',
                    ipAddress: '192.168.0.24',
                    dataUsage: {
                        sent: 1024,
                        received: 2048
                    },
                    apEnabled: false,
                    clients: 0
                },
                sim: {
                    registered: true
                },
                dataModeEnabled: true
            }),
            devices: new Map([[
                'device-dual-wifi-path',
                {
                    mobile: {
                        connected: true,
                        operatorName: 'Robi',
                        networkType: 'LTE',
                        signalStrength: 53,
                        dataUsage: {
                            sent: 4096,
                            received: 8192
                        }
                    },
                    wifi: {
                        connected: true,
                        ssid: 'BenchNet',
                        rssi: -58,
                        dataUsage: {
                            sent: 1024,
                            received: 2048
                        }
                    }
                }
            ]])
        };

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([]),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        const res = await request(app).get('/api/modem/status?deviceId=device-dual-wifi-path');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.routing.primarySource).toBe('wifi');
        expect(res.body.data.internet.activeSource).toBe('wifi');
        expect(res.body.data.internet.sources).toEqual(expect.objectContaining({
            wifi: true
        }));
    });

    test('modem status does not revive stale raw Wi-Fi data when the device is offline', async () => {
        jest.resetModules();

        global.modemService = {
            getStatus: jest.fn().mockReturnValue({
                online: false,
                activePath: 'offline',
                network: 'Offline',
                operator: null,
                signal: null,
                signalDbm: null,
                cellularSignal: null,
                cellularSignalDbm: null,
                wifiSignal: null,
                ip: null,
                imei: '862596081929782',
                wifi: {
                    mode: 'sta',
                    configured: true,
                    started: true,
                    connected: false,
                    ssid: 'StaleNet',
                    ipAddress: '',
                    apEnabled: false,
                    clients: 0
                },
                sim: {
                    registered: false
                },
                dataModeEnabled: false
            }),
            devices: new Map([
                ['device-offline', {
                    mobile: {
                        networkType: 'LTE',
                        signalDbm: -88
                    },
                    wifi: {
                        mode: 'sta',
                        connected: true,
                        ssid: 'StaleNet',
                        rssi: -54,
                        ipAddress: '192.168.1.77'
                    }
                }]
            ])
        };

        const router = require('../routes/modem');
        const app = buildApp(router);

        const res = await request(app).get('/api/modem/status?deviceId=device-offline');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.routing.primarySource).toBe('none');
        expect(res.body.data.internet.available).toBe(false);
        expect(res.body.data.internet.sources).toEqual(expect.objectContaining({
            wifi: false,
            mobile: false
        }));
        expect(res.body.data.wifiClient).toEqual(expect.objectContaining({
            enabled: false,
            connected: false,
            ssid: 'StaleNet',
            ipAddress: '',
            signalStrength: 0
        }));
        expect(res.body.data.mobile).toEqual(expect.objectContaining({
            enabled: false,
            connected: false,
            signalStrength: 0,
            ipAddress: ''
        }));
    });

    test('modem status hydration trusts explicit connection flags instead of guessing from SSID or signal', async () => {
        jest.resetModules();

        global.mqttService = {
            connected: true,
            publishCommand: jest.fn().mockResolvedValue({
                success: true,
                data: {
                    active_path: 'modem',
                    mobile: {
                        enabled: true,
                        connected: true,
                        operator: 'robi axiata',
                        networkType: 'LTE',
                        signalStrength: 0,
                        ipAddress: '10.12.0.8'
                    },
                    wifi: {
                        enabled: true,
                        connected: false,
                        ssid: 'StaleNet',
                        signalStrength: 61,
                        ipAddress: ''
                    }
                }
            })
        };

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([]),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        const res = await request(app).get('/api/modem/status?deviceId=device-hydrated');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'device-hydrated',
            'internet-status',
            {},
            true,
            5000
        );
        expect(res.body.data.routing.primarySource).toBe('mobile');
        expect(res.body.data.internet.sources).toEqual(expect.objectContaining({
            mobile: true,
            wifi: false
        }));
        expect(res.body.data.mobile).toEqual(expect.objectContaining({
            enabled: true,
            connected: true,
            signalStrength: 0,
            ipAddress: '10.12.0.8'
        }));
        expect(res.body.data.wifiClient).toEqual(expect.objectContaining({
            enabled: true,
            connected: false,
            ssid: 'StaleNet'
        }));
    });

    test('modem status hydration preserves Wi-Fi as the current path when both links report connected', async () => {
        jest.resetModules();

        global.mqttService = {
            connected: true,
            publishCommand: jest.fn().mockResolvedValue({
                success: true,
                data: {
                    active_path: 'wifi',
                    data_mode_enabled: true,
                    modem_ip_bearer_ready: true,
                    modem_data_ip: '10.12.0.8',
                    mobile: {
                        enabled: true,
                        connected: true,
                        operator: 'robi axiata',
                        networkType: 'LTE',
                        signalStrength: 47,
                        ipAddress: '10.12.0.8'
                    },
                    wifi: {
                        enabled: true,
                        connected: true,
                        ssid: 'BenchNet',
                        signalStrength: 79,
                        ipAddress: '192.168.1.40'
                    }
                }
            })
        };

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([]),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        const res = await request(app).get('/api/modem/status?deviceId=device-hydrated-dual');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.routing.primarySource).toBe('wifi');
        expect(res.body.data.internet.activeSource).toBe('wifi');
        expect(res.body.data.internet.sources).toEqual(expect.objectContaining({
            mobile: true,
            wifi: true
        }));
        expect(res.body.data.mobile).toEqual(expect.objectContaining({
            connected: true,
            ipAddress: '10.12.0.8'
        }));
        expect(res.body.data.wifiClient).toEqual(expect.objectContaining({
            connected: true,
            ssid: 'BenchNet',
            ipAddress: '192.168.1.40'
        }));
    });

    test('modem status treats activePath mobile as a live modem connection and carries live usage counters', async () => {
        jest.resetModules();

        global.modemService = {
            getStatus: jest.fn().mockReturnValue({
                online: true,
                activePath: 'mobile',
                network: 'LTE',
                operator: 'Robi',
                cellularSignal: 53,
                cellularSignalDbm: -85,
                ip: '10.0.0.5',
                mobile: {
                    networkType: 'LTE',
                    dataUsage: {
                        sent: 4096,
                        received: 8192
                    }
                },
                wifi: {
                    connected: true,
                    ssid: 'FallbackNet',
                    ipAddress: '192.168.8.10',
                    dataUsage: {
                        sent: 1024,
                        received: 2048
                    }
                },
                sim: {
                    registered: true,
                    dataSession: true,
                    dataIp: '10.0.0.5'
                },
                dataModeEnabled: true
            }),
            devices: new Map([[
                'device-mobile-path',
                {
                    mobile: {
                        operatorName: 'Robi',
                        signalStrength: 53
                    },
                    wifi: {
                        rssi: -62
                    }
                }
            ]])
        };

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([]),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        const res = await request(app).get('/api/modem/status?deviceId=device-mobile-path');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.routing.primarySource).toBe('mobile');
        expect(res.body.data.internet.activeSource).toBe('mobile');
        expect(res.body.data.internet.sources).toEqual(expect.objectContaining({
            mobile: true,
            wifi: true
        }));
        expect(res.body.data.mobile).toEqual(expect.objectContaining({
            enabled: true,
            connected: true,
            ipAddress: '10.0.0.5',
            dataUsage: expect.objectContaining({
                sent: 4096,
                received: 8192
            })
        }));
        expect(res.body.data.wifiClient).toEqual(expect.objectContaining({
            connected: true,
            signalStrength: 76,
            dataUsage: expect.objectContaining({
                sent: 1024,
                received: 2048
            })
        }));
    });

    test('modem status exposes operator name and SIM number when live status provides them', async () => {
        jest.resetModules();

        global.modemService = {
            getStatus: jest.fn().mockReturnValue({
                online: true,
                activePath: 'modem',
                network: 'Cellular',
                operator: 'Grameenphone',
                signal: 62,
                signalDbm: -89,
                cellularSignal: 62,
                cellularSignalDbm: -89,
                ip: '10.98.14.22',
                imei: '862596081929782',
                sim: {
                    ready: true,
                    registered: true,
                    operator: '47001',
                    operatorName: 'Grameenphone',
                    number: '+8801628301525'
                },
                wifi: {
                    mode: 'off',
                    configured: false,
                    started: false,
                    connected: false,
                    ipAddress: '',
                    apEnabled: false,
                    clients: 0
                },
                dataModeEnabled: true
            }),
            devices: new Map([
                ['device-sim', {
                    mobile: {
                        operator: '47001',
                        operatorName: 'Grameenphone'
                    },
                    sim: {
                        number: '+8801628301525'
                    }
                }]
            ])
        };

        const router = require('../routes/modem');
        const app = buildApp(router);

        const res = await request(app).get('/api/modem/status?deviceId=device-sim');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.mobile).toEqual(expect.objectContaining({
            enabled: true,
            connected: true,
            operator: 'Grameenphone',
            operatorName: 'Grameenphone',
            simNumber: '+8801628301525',
            simStatus: 'ready'
        }));
    });

    test('modem status falls back to flat subscriber fields and stored Wi-Fi profile metadata', async () => {
        jest.resetModules();

        global.modemService = {
            getStatus: jest.fn().mockReturnValue({
                online: true,
                activePath: 'modem',
                network: 'Cellular',
                operator: '47002',
                simNumber: '+8801711111111',
                wifi: {
                    mode: 'sta',
                    configured: true,
                    started: true,
                    connected: false,
                    ssid: 'RiazM',
                    ipAddress: '',
                    apEnabled: false,
                    clients: 0
                },
                sim: {
                    ready: true,
                    registered: true,
                    dataSession: true,
                    dataIp: '10.195.184.98'
                },
                dataModeEnabled: true
            }),
            devices: new Map([
                ['device-flat-sim', {
                    status: {
                        modem_subscriber_number: '+8801711111111'
                    }
                }]
            ])
        };

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            get: jest.fn()
                .mockResolvedValueOnce({
                    wifi_ssid: 'RiazM',
                    wifi_pass: '12345678'
                })
                .mockResolvedValueOnce({
                    ssid: 'RiazM',
                    security: 'WPA2-PSK',
                    password: '12345678',
                    password_set: 1
                }),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        const res = await request(app).get('/api/modem/status?deviceId=device-flat-sim');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.mobile.simNumber).toBe('+8801711111111');
        expect(res.body.data.mobile.number).toBe('+8801711111111');
        expect(res.body.data.wifiClient).toEqual(expect.objectContaining({
            selectedSsid: 'RiazM',
            selectedPasswordSet: true,
            desiredSsid: 'RiazM',
            desiredPasswordSet: true,
            configured: true,
            started: true
        }));
        expect(res.body.data.capabilities).toEqual(expect.objectContaining({
            mobile: expect.objectContaining({
                remoteToggle: true,
                remoteApn: true
            }),
            wifiClient: expect.objectContaining({
                remoteToggle: true,
                retrySaved: true
            }),
            hotspot: expect.objectContaining({
                remoteToggle: false,
                remoteConfigure: false
            }),
            usb: expect.objectContaining({
                remoteToggle: false
            }),
            dataUsage: expect.objectContaining({
                remoteReset: false
            })
        }));
    });

    test('modem status uses stored SIM number fallback when live status is blank', async () => {
        jest.resetModules();

        global.modemService = {
            getStatus: jest.fn().mockReturnValue({
                online: true,
                activePath: 'modem',
                network: 'Cellular',
                operator: 'robi axiata',
                wifi: {
                    mode: 'sta',
                    configured: true,
                    started: true,
                    connected: false,
                    ssid: 'RiazM',
                    ipAddress: '',
                    apEnabled: false,
                    clients: 0
                },
                sim: {
                    ready: true,
                    registered: true
                },
                dataModeEnabled: true
            }),
            devices: new Map([
                ['device-stored-sim', {
                    status: {}
                }]
            ])
        };

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            get: jest.fn().mockResolvedValue({
                wifi_ssid: 'RiazM',
                wifi_pass: '12345678',
                last_sim_number: '+8801628301525'
            })
        };

        const res = await request(app).get('/api/modem/status?deviceId=device-stored-sim');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.mobile.simNumber).toBe('+8801628301525');
        expect(res.body.data.mobile.number).toBe('+8801628301525');
        expect(res.body.data.capabilities.routing).toEqual(expect.objectContaining({
            remoteConfigure: true,
            remoteFailover: true,
            remoteLoadBalancing: false,
            remoteNat: false,
            remoteFirewall: false,
            preferModemData: true
        }));
    });

    test('routing configure updates failover through the live firmware command path', async () => {
        jest.resetModules();

        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockResolvedValue({
            success: true,
            payload: {
                failover: true,
                load_balancing: false,
                nat: false,
                firewall: false,
                restart_required: false
            }
        });

        global.mqttService = mqttService;

        const router = require('../routes/modem');
        const app = buildApp(router);

        const res = await request(app)
            .post('/api/modem/routing/configure')
            .send({
                deviceId: 'device-routing-1',
                failover: true
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: 'Routing failover configured',
            data: {
                failover: true,
                loadBalancing: false,
                nat: false,
                firewall: false,
                activePath: 'none'
            }
        });
        expect(mqttService.publishCommand).toHaveBeenCalledWith(
            'device-routing-1',
            'routing-configure',
            { failover: true },
            true,
            15000,
            expect.objectContaining({
                skipPersistentQueue: true,
                source: 'dashboard-modem',
                domain: 'network'
            })
        );
    });

    test('routing configure rejects unsupported advanced routing flags', async () => {
        jest.resetModules();

        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn();

        global.mqttService = mqttService;

        const router = require('../routes/modem');
        const app = buildApp(router);

        const res = await request(app)
            .post('/api/modem/routing/configure')
            .send({
                deviceId: 'device-routing-2',
                loadBalancing: true
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            success: false,
            message: 'Only failover routing is available at runtime on this device'
        });
        expect(mqttService.publishCommand).not.toHaveBeenCalled();
    });

    test('mobile toggle rejects disabling modem data before Wi-Fi is connected', async () => {
        jest.resetModules();

        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn();
        mqttService.publishRuntimeCommand = jest.fn();

        global.mqttService = mqttService;
        global.modemService = {
            getStatus: jest.fn().mockReturnValue({
                online: true,
                activePath: 'modem',
                network: 'Cellular',
                operator: 'robi axiata',
                signal: 51,
                signalDbm: -89,
                cellularSignal: 51,
                cellularSignalDbm: -89,
                ip: '10.64.32.8',
                wifi: {
                    mode: 'sta',
                    configured: true,
                    started: true,
                    connected: false,
                    ssid: 'RiazM',
                    ipAddress: '',
                    apEnabled: false,
                    clients: 0
                },
                sim: {
                    ready: true,
                    registered: true
                },
                dataModeEnabled: true
            }),
            devices: new Map()
        };

        const router = require('../routes/modem');
        const app = buildApp(router);

        const res = await request(app)
            .post('/api/modem/mobile/toggle')
            .send({ deviceId: 'device-cutover', enabled: false });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({
            success: false,
            message: 'Connect Wi-Fi first before turning mobile data off'
        });
        expect(mqttService.publishRuntimeCommand).not.toHaveBeenCalled();
    });

    test('wifi toggle disables Wi-Fi only when mobile data is already connected', async () => {
        jest.resetModules();

        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command) => {
            if (command === 'internet-status') {
                return {
                    success: true,
                    data: {
                        active_path: 'wifi',
                        data_mode_enabled: true,
                        modem_ip_bearer_ready: true,
                        modem_data_ip: '10.195.184.98',
                        wifi_started: true,
                        wifi_connected: true,
                        wifi_ip_address: '192.168.10.20',
                        wifi_ssid: 'RiazM'
                    }
                };
            }
            setImmediate(() => {
                mqttService.emit('status', deviceId, {
                    active_path: 'modem',
                    wifi_started: false,
                    wifi_connected: false
                });
            });
            return {
                success: true,
                payload: {
                    started: false,
                    connected: false
                }
            };
        });

        global.mqttService = mqttService;
        global.modemService = {
            getStatus: jest.fn().mockReturnValue({
                online: true,
                activePath: 'wifi',
                network: 'Wi-Fi',
                operator: 'robi axiata',
                signal: 54,
                signalDbm: -84,
                cellularSignal: 54,
                cellularSignalDbm: -84,
                ip: '192.168.10.20',
                wifi: {
                    mode: 'sta',
                    configured: true,
                    started: true,
                    connected: true,
                    ssid: 'RiazM',
                    ipAddress: '192.168.10.20',
                    apEnabled: false,
                    clients: 0
                },
                sim: {
                    ready: true,
                    registered: true
                },
                dataModeEnabled: true
            }),
            devices: new Map([
                ['device-wifi-toggle', {
                    mobile: {
                        connected: true,
                        operatorName: 'robi axiata',
                        networkType: 'LTE',
                        signalStrength: 54
                    }
                }]
            ])
        };

        const router = require('../routes/modem');
        const app = buildApp(router);

        const res = await request(app)
            .post('/api/modem/wifi/client/toggle')
            .send({ deviceId: 'device-wifi-toggle', enabled: false });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: 'Wi-Fi disabled. Device stayed online on mobile data.',
            data: {
                enabled: false,
                started: false,
                connected: false,
                activePath: 'modem',
                cutoverSensitive: true
            }
        });
        expect(mqttService.publishCommand).toHaveBeenCalledWith(
            'device-wifi-toggle',
            'wifi-toggle',
            { enabled: false },
            false,
            12000,
            expect.objectContaining({
                source: 'dashboard-modem',
                domain: 'network',
                skipPersistentQueue: true,
                skipQueue: true
            })
        );
    });

    test('wifi toggle rejects disabling Wi-Fi before mobile data is connected', async () => {
        jest.resetModules();

        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn();

        global.mqttService = mqttService;
        global.modemService = {
            getStatus: jest.fn().mockReturnValue({
                online: true,
                activePath: 'wifi',
                network: 'Wi-Fi',
                wifi: {
                    mode: 'sta',
                    configured: true,
                    started: true,
                    connected: true,
                    ssid: 'RiazM',
                    ipAddress: '192.168.10.20',
                    apEnabled: false,
                    clients: 0
                },
                sim: {
                    ready: true,
                    registered: true
                },
                dataModeEnabled: false
            }),
            devices: new Map()
        };

        const router = require('../routes/modem');
        const app = buildApp(router);

        const res = await request(app)
            .post('/api/modem/wifi/client/toggle')
            .send({ deviceId: 'device-wifi-toggle-2', enabled: false });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({
            success: false,
            message: 'Turn on mobile data and wait for it to connect before turning Wi-Fi off'
        });
        expect(mqttService.publishCommand).not.toHaveBeenCalledWith(
            'device-wifi-toggle-2',
            'wifi-toggle',
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything()
        );
    });

    test('mobile APN route persists the dashboard APN after a live runtime apply request', async () => {
        jest.resetModules();

        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockResolvedValue({ success: false });
        mqttService.publishRuntimeCommand = jest.fn().mockResolvedValue({
            messageId: 'msg-mobile-apn',
            topic: 'device/device-apn/command/mobile-apn'
        });

        global.mqttService = mqttService;
        global.modemService = {
            getStatus: jest.fn().mockReturnValue({
                online: true,
                activePath: 'modem',
                network: 'Cellular',
                operator: 'robi axiata',
                signal: 48,
                signalDbm: -92,
                cellularSignal: 48,
                cellularSignalDbm: -92,
                ip: '10.64.32.9',
                wifi: {
                    mode: 'sta',
                    configured: true,
                    started: true,
                    connected: false,
                    ssid: 'RiazM',
                    ipAddress: '',
                    apEnabled: false,
                    clients: 0
                },
                sim: {
                    ready: true,
                    registered: true
                },
                dataModeEnabled: true
            }),
            devices: new Map()
        };

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        const res = await request(app)
            .post('/api/modem/mobile/apn')
            .send({
                deviceId: 'device-apn',
                apn: 'internet',
                username: 'user1',
                password: 'secret1',
                auth: 'pap'
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: 'APN update requested. The modem bearer may restart while applying it.',
            data: {
                apn: 'internet',
                username: 'user1',
                password: 'secret1',
                auth: 'pap',
                appliedUsername: '',
                appliedPasswordSet: false,
                cutoverSensitive: true
            }
        });
        expect(mqttService.publishRuntimeCommand).toHaveBeenCalledWith(
            'device-apn',
            'mobile-apn',
            {
                apn: 'internet',
                username: 'user1',
                password: 'secret1',
                auth: 'pap'
            },
            false,
            20000,
            expect.objectContaining({
                source: 'dashboard-modem',
                domain: 'network',
                skipPersistentQueue: true,
                skipQueue: true
            })
        );
        expect(app.locals.db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO device_profiles'),
            ['device-apn', 'internet']
        );
    });

    test('wifi retry reapplies the stored profile and requests reconnect over MQTT', async () => {
        jest.resetModules();

        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command, payload) => {
            if (command === 'wifi-reconnect') {
                setImmediate(() => {
                    mqttService.emit('status', deviceId, {
                        active_path: 'wifi',
                        wifi_connected: true,
                        wifi_ssid: 'RiazM'
                    });
                });
            }

            return { success: true, command, payload };
        });

        global.mqttService = mqttService;

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            get: jest.fn().mockResolvedValue({
                wifi_ssid: 'RiazM',
                wifi_pass: '12345678'
            })
        };

        const res = await request(app)
            .post('/api/modem/wifi/client/retry')
            .send({ deviceId: 'device-retry', ssid: 'RiazM' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual(expect.objectContaining({
            selectedSsid: 'RiazM',
            selectedPasswordSet: true,
            desiredSsid: 'RiazM',
            desiredPasswordSet: true,
            observedWifiConnected: true,
            activePath: 'wifi'
        }));
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            1,
            'device-retry',
            'config-set',
            { key: 'wifi_ssid', value: 'RiazM' },
            true,
            10000,
            expect.objectContaining({
                source: 'dashboard-modem',
                skipPersistentQueue: true
            })
        );
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            2,
            'device-retry',
            'config-set',
            { key: 'wifi_password', value: '12345678' },
            true,
            10000,
            expect.objectContaining({
                source: 'dashboard-modem',
                skipPersistentQueue: true
            })
        );
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            3,
            'device-retry',
            'wifi-reconnect',
            {},
            true,
            10000,
            expect.objectContaining({
                source: 'dashboard-modem',
                skipPersistentQueue: true
            })
        );
    });

    test('wifi retry allows an open saved network without a password when the known network is open', async () => {
        jest.resetModules();

        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command) => {
            if (command === 'wifi-reconnect') {
                setImmediate(() => {
                    mqttService.emit('status', deviceId, {
                        active_path: 'wifi',
                        wifi_connected: true,
                        wifi_ssid: 'GuestNet'
                    });
                });
            }

            return { success: true, command };
        });

        global.mqttService = mqttService;

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            get: jest.fn()
                .mockResolvedValueOnce({
                    wifi_ssid: 'GuestNet',
                    wifi_pass: ''
                })
                .mockResolvedValueOnce({
                    ssid: 'GuestNet',
                    security: 'open',
                    password: '',
                    password_set: 0,
                    connection_count: 2
                })
                .mockResolvedValueOnce({
                    ssid: 'GuestNet',
                    security: 'open',
                    password: '',
                    password_set: 0,
                    connection_count: 2
                }),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        const res = await request(app)
            .post('/api/modem/wifi/client/retry')
            .send({ deviceId: 'device-retry-open', ssid: 'GuestNet' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual(expect.objectContaining({
            selectedSsid: 'GuestNet',
            selectedPasswordSet: false,
            desiredSsid: 'GuestNet',
            desiredPasswordSet: false,
            openNetwork: true,
            observedWifiConnected: true,
            activePath: 'wifi'
        }));
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            2,
            'device-retry-open',
            'config-set',
            { key: 'wifi_password', value: '' },
            true,
            10000,
            expect.objectContaining({
                source: 'dashboard-modem',
                skipPersistentQueue: true
            })
        );
        expect(app.locals.db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO device_wifi_networks'),
            expect.arrayContaining(['device-retry-open', 'GuestNet', 'open', ''])
        );
    });

    test('wifi connect stores the chosen network and switches over MQTT', async () => {
        jest.resetModules();

        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command) => {
            if (command === 'wifi-reconnect') {
                setImmediate(() => {
                    mqttService.emit('status', deviceId, {
                        active_path: 'wifi',
                        wifi_connected: true,
                        wifi_ssid: 'BenchNet'
                    });
                });
            }
            return { success: true, command };
        });

        global.mqttService = mqttService;

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            get: jest.fn().mockResolvedValue(null),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        const res = await request(app)
            .post('/api/modem/wifi/client/connect')
            .send({
                deviceId: 'device-connect',
                ssid: 'BenchNet',
                password: 'bench-pass',
                security: 'WPA2-PSK'
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual(expect.objectContaining({
            ssid: 'BenchNet',
            selectedSsid: 'BenchNet',
            selectedPasswordSet: true,
            desiredPasswordSet: true,
            observedWifiConnected: true,
            activePath: 'wifi'
        }));
        expect(app.locals.db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO device_wifi_networks'),
            expect.arrayContaining(['device-connect', 'BenchNet', 'WPA2-PSK', 'bench-pass'])
        );
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            1,
            'device-connect',
            'config-set',
            { key: 'wifi_ssid', value: 'BenchNet' },
            true,
            10000,
            expect.objectContaining({
                source: 'dashboard-modem',
                skipPersistentQueue: true
            })
        );
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            2,
            'device-connect',
            'config-set',
            { key: 'wifi_password', value: 'bench-pass' },
            true,
            10000,
            expect.objectContaining({
                source: 'dashboard-modem',
                skipPersistentQueue: true
            })
        );
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            3,
            'device-connect',
            'wifi-reconnect',
            {},
            true,
            15000,
            expect.objectContaining({
                source: 'dashboard-modem',
                skipPersistentQueue: true
            })
        );
    });

    test('wifi connect reuses the dashboard device profile password when the SSID matches', async () => {
        jest.resetModules();

        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command) => {
            if (command === 'wifi-reconnect') {
                setImmediate(() => {
                    mqttService.emit('status', deviceId, {
                        active_path: 'wifi',
                        wifi_connected: true,
                        wifi_ssid: 'RiazM'
                    });
                });
            }
            return { success: true, command };
        });

        global.mqttService = mqttService;

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            get: jest.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({
                    wifi_ssid: 'RiazM',
                    wifi_pass: '12345678'
                }),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        const res = await request(app)
            .post('/api/modem/wifi/client/connect')
            .send({
                deviceId: 'device-connect-profile',
                ssid: 'RiazM'
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual(expect.objectContaining({
            ssid: 'RiazM',
            selectedSsid: 'RiazM',
            selectedPasswordSet: true,
            desiredPasswordSet: true,
            observedWifiConnected: true,
            activePath: 'wifi'
        }));
        expect(app.locals.db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO device_wifi_networks'),
            expect.arrayContaining(['device-connect-profile', 'RiazM', '12345678'])
        );
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            2,
            'device-connect-profile',
            'config-set',
            { key: 'wifi_password', value: '12345678' },
            true,
            10000,
            expect.objectContaining({
                source: 'dashboard-modem',
                skipPersistentQueue: true
            })
        );
    });

    test('wifi connect treats a blank submitted password as reuse-saved-password', async () => {
        jest.resetModules();

        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command) => {
            if (command === 'wifi-reconnect') {
                setImmediate(() => {
                    mqttService.emit('status', deviceId, {
                        active_path: 'wifi',
                        wifi_connected: true,
                        wifi_ssid: 'RiazM'
                    });
                });
            }
            return { success: true, command };
        });

        global.mqttService = mqttService;

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            get: jest.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({
                    wifi_ssid: 'RiazM',
                    wifi_pass: '12345678'
                }),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        const res = await request(app)
            .post('/api/modem/wifi/client/connect')
            .send({
                deviceId: 'device-connect-blank',
                ssid: 'RiazM',
                password: ''
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(app.locals.db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO device_wifi_networks'),
            expect.arrayContaining(['device-connect-blank', 'RiazM', '12345678'])
        );
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            2,
            'device-connect-blank',
            'config-set',
            { key: 'wifi_password', value: '12345678' },
            true,
            10000,
            expect.objectContaining({
                source: 'dashboard-modem',
                skipPersistentQueue: true
            })
        );
    });

    test('wifi retry allows switching to a different saved SSID from dashboard known networks', async () => {
        jest.resetModules();

        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command) => {
            if (command === 'wifi-reconnect') {
                setImmediate(() => {
                    mqttService.emit('status', deviceId, {
                        active_path: 'wifi',
                        wifi_connected: true,
                        wifi_ssid: 'OtherNet'
                    });
                });
            }

            return { success: true, command };
        });
        global.mqttService = mqttService;

        const router = require('../routes/modem');
        const app = buildApp(router);
        app.locals.db = {
            get: jest.fn()
                .mockResolvedValueOnce({
                    wifi_ssid: 'RiazM',
                    wifi_pass: '12345678'
                })
                .mockResolvedValueOnce({
                    ssid: 'RiazM',
                    security: 'WPA2-PSK',
                    password: '12345678',
                    password_set: 1
                })
                .mockResolvedValueOnce({
                    ssid: 'OtherNet',
                    security: 'WPA2-PSK',
                    password: 'other-pass',
                    password_set: 1
                }),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        const res = await request(app)
            .post('/api/modem/wifi/client/retry')
            .send({ deviceId: 'device-retry', ssid: 'OtherNet' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual(expect.objectContaining({
            selectedSsid: 'OtherNet',
            selectedPasswordSet: true,
            desiredSsid: 'OtherNet',
            desiredPasswordSet: true,
            observedWifiConnected: true,
            activePath: 'wifi'
        }));
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            1,
            'device-retry',
            'config-set',
            { key: 'wifi_ssid', value: 'OtherNet' },
            true,
            10000,
            expect.objectContaining({
                source: 'dashboard-modem',
                skipPersistentQueue: true
            })
        );
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            2,
            'device-retry',
            'config-set',
            { key: 'wifi_password', value: 'other-pass' },
            true,
            10000,
            expect.objectContaining({
                source: 'dashboard-modem',
                skipPersistentQueue: true
            })
        );
    });

    test('prefer modem data publishes wifi-disconnect and reflects modem routing', async () => {
        jest.resetModules();

        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command) => {
            if (command === 'wifi-disconnect') {
                setImmediate(() => {
                    mqttService.emit('status', deviceId, {
                        active_path: 'modem',
                        wifi_connected: false,
                        wifi_reconnect_suppressed: true
                    });
                });
            }

            return { success: true, command };
        });

        global.mqttService = mqttService;

        const router = require('../routes/modem');
        const app = buildApp(router);

        const res = await request(app)
            .post('/api/modem/routing/prefer-modem')
            .send({ deviceId: 'device-prefer-modem', enabled: true });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual(expect.objectContaining({
            preferModemData: true,
            reconnectSuppressed: true,
            activePath: 'modem'
        }));
        expect(mqttService.publishCommand).toHaveBeenCalledWith(
            'device-prefer-modem',
            'wifi-disconnect',
            {},
            false,
            10000,
            expect.objectContaining({
                source: 'dashboard-modem',
                skipPersistentQueue: true,
                domain: 'network'
            })
        );
    });

    test('resuming wifi preference publishes wifi-reconnect', async () => {
        jest.resetModules();

        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId, command) => {
            if (command === 'wifi-reconnect') {
                setImmediate(() => {
                    mqttService.emit('status', deviceId, {
                        active_path: 'wifi',
                        wifi_connected: true,
                        wifi_reconnect_suppressed: false
                    });
                });
            }

            return { success: true, command };
        });

        global.mqttService = mqttService;

        const router = require('../routes/modem');
        const app = buildApp(router);

        const res = await request(app)
            .post('/api/modem/routing/prefer-modem')
            .send({ deviceId: 'device-resume-wifi', enabled: false });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual(expect.objectContaining({
            preferModemData: false,
            reconnectSuppressed: false,
            activePath: 'wifi'
        }));
        expect(mqttService.publishCommand).toHaveBeenCalledWith(
            'device-resume-wifi',
            'wifi-reconnect',
            {},
            false,
            15000,
            expect.objectContaining({
                source: 'dashboard-modem',
                skipPersistentQueue: true,
                domain: 'network'
            })
        );
    });
});
