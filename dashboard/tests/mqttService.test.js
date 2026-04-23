'use strict';

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

describe('mqttService connection status', () => {
    const originalClientId = process.env.MQTT_CLIENT_ID;
    let svc;

    afterEach(() => {
        svc?.disconnect();
        if (originalClientId === undefined) {
            delete process.env.MQTT_CLIENT_ID;
        } else {
            process.env.MQTT_CLIENT_ID = originalClientId;
        }
        delete global.io;
        jest.resetModules();
    });

    test('uses configured MQTT_CLIENT_ID instead of replacing it with a random id', () => {
        jest.resetModules();
        process.env.MQTT_CLIENT_ID = 'dashboard-server';

        svc = require('../services/mqttService');

        expect(svc.getClientId()).toBe('dashboard-server');
        expect(svc.getStatus()).toMatchObject({
            clientId: 'dashboard-server',
            state: 'disconnected',
            connected: false
        });
    });

    test('stores sanitized authentication errors for dashboard status', () => {
        jest.resetModules();
        svc = require('../services/mqttService');
        svc.on('error', () => {});

        svc.handleError(new Error('Connection refused: Not authorized'));

        expect(svc.getStatus()).toMatchObject({
            lastError: 'MQTT auth failed'
        });
        expect(svc.getStatus().lastErrorAt).toEqual(expect.any(String));
    });
});

describe('mqttService firmware compatibility', () => {
    let svc;

    beforeEach(() => {
        jest.resetModules();
        global.app = { locals: {} };
        global.io = {
            emit: jest.fn(),
            to: jest.fn(() => ({ emit: jest.fn() }))
        };

        svc = require('../services/mqttService');
        svc.connected = true;
        svc.connecting = false;
        svc.client = {
            end: jest.fn(),
            publish: jest.fn((topic, payload, options, callback) => callback(null))
        };
        svc.pendingMessages.clear();
        svc.deviceStatus.clear();
        svc.seenMessages.clear();
        svc.removeAllListeners();
    });

    afterEach(() => {
        svc.disconnect();
        delete global.app;
        delete global.io;
    });

    test('publishCommand includes firmware-compatible SMS fields', async () => {
        await svc.publishCommand(
            'device-1',
            'send-sms',
            { to: '+15551234567', message: 'hello from test' },
            false,
            5000,
            { skipPersistentQueue: true }
        );

        expect(svc.client.publish).toHaveBeenCalledTimes(1);
        expect(svc.client.publish.mock.calls[0][0]).toBe('device/device-1/command/send-sms');

        const payload = JSON.parse(svc.client.publish.mock.calls[0][1]);
        expect(payload.number).toBe('+15551234567');
        expect(payload.text).toBe('hello from test');
        expect(payload.action_id).toMatch(/^sms_/);
        expect(payload.timeout).toBe(5000);
        expect(payload.messageId).toBeUndefined();
    });

    test('publishCommand includes firmware-compatible multipart SMS fields', async () => {
        await svc.publishCommand(
            'device-1',
            'send-sms-multipart',
            { to: '+15551234567', message: 'x'.repeat(200) },
            false,
            5000,
            { skipPersistentQueue: true }
        );

        expect(svc.client.publish).toHaveBeenCalledTimes(1);
        expect(svc.client.publish.mock.calls[0][0]).toBe('device/device-1/command/send-sms-multipart');

        const payload = JSON.parse(svc.client.publish.mock.calls[0][1]);
        expect(payload.number).toBe('+15551234567');
        expect(payload.text).toBe('x'.repeat(200));
        expect(payload.command).toBe('send_sms_multipart');
        expect(payload.action_id).toMatch(/^sms_/);
        expect(payload.timeout).toBe(5000);
        expect(payload.messageId).toBeUndefined();
    });

    test('publishCommand normalizes SIM slot to sim_slot only in MQTT payloads', async () => {
        await svc.publishCommand(
            'device-1',
            'send-ussd',
            { code: '*123#', simSlot: 1 },
            false,
            5000,
            { skipPersistentQueue: true }
        );

        const payload = JSON.parse(svc.client.publish.mock.calls[0][1]);
        expect(payload.sim_slot).toBe(1);
        expect(payload.simSlot).toBeUndefined();
    });

    test('publishCommand keeps action correlation IDs within the firmware limit', async () => {
        await svc.publishCommand(
            'device-1',
            'wifi-disconnect',
            {},
            false,
            5000,
            { skipPersistentQueue: true }
        );

        const payload = JSON.parse(svc.client.publish.mock.calls[0][1]);
        expect(payload.action_id.length).toBeLessThanOrEqual(31);
        expect(payload.messageId).toBe(payload.action_id);
        expect(payload.command).toBe('wifi_disconnect');
    });

    test('action/result resolves pending commands and emits storage:list compatibility event', async () => {
        const storageListHandler = jest.fn();
        const timeout = setTimeout(() => {}, 1000);
        timeout.unref?.();
        svc.on('storage:list', storageListHandler);

        const pending = new Promise((resolve, reject) => {
            svc.pendingMessages.set('file-list-1', {
                command: 'storage-list',
                deviceId: 'device-1',
                payload: {},
                timestamp: Date.now(),
                resolve,
                reject,
                timeout
            });
        });

        svc.handleMessage(
            'device/device-1/action/result',
            Buffer.from(JSON.stringify({
                action_id: 'file-list-1',
                command: 'file_list',
                result: 'completed',
                detail: 'file_list_completed',
                payload: {
                    path: '',
                    count: 0,
                    truncated: false,
                    entries: []
                }
            }))
        );

        const response = await pending;
        expect(response.success).toBe(true);
        expect(response.messageId).toBe('file-list-1');
        expect(storageListHandler).toHaveBeenCalledWith(
            'device-1',
            expect.objectContaining({
                count: 0,
                entries: [],
                success: true
            })
        );
    });

    test('action/result emits wifi:scan when firmware payload arrives as JSON text', () => {
        const scanHandler = jest.fn();
        svc.on('wifi:scan', scanHandler);

        svc.handleMessage(
            'device/device-1/action/result',
            Buffer.from(JSON.stringify({
                action_id: 'wifi-scan-1',
                command: 'wifi_scan',
                result: 'completed',
                detail: 'wifi_scan_completed',
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
                        elapsed_ms: 9500
                    }
                })
            }))
        );

        expect(scanHandler).toHaveBeenCalledWith(
            'device-1',
            expect.objectContaining({
                networks: [
                    expect.objectContaining({
                        ssid: 'RiazM',
                        rssi: -80
                    })
                ],
                report: expect.objectContaining({
                    total_visible: 1,
                    elapsed_ms: 9500
                }),
                success: true
            })
        );
    });

    test('call/events emits legacy call compatibility events', () => {
        const callStatusHandler = jest.fn();
        const incomingHandler = jest.fn();
        svc.on('call:status', callStatusHandler);
        svc.on('call:incoming', incomingHandler);

        svc.handleMessage(
            'device/device-1/call/events',
            Buffer.from(JSON.stringify({
                number: '+15550001111',
                state: 'incoming',
                timestamp: 123456
            }))
        );

        expect(callStatusHandler).toHaveBeenCalledWith(
            'device-1',
            expect.objectContaining({
                number: '+15550001111',
                status: 'incoming'
            })
        );
        expect(incomingHandler).toHaveBeenCalledWith(
            'device-1',
            expect.objectContaining({
                number: '+15550001111',
                status: 'incoming'
            })
        );
    });

    test('sms/incoming normalizes firmware text payloads into message events', () => {
        const incomingHandler = jest.fn();
        svc.on('sms:incoming', incomingHandler);

        svc.handleMessage(
            'device/device-1/sms/incoming',
            Buffer.from(JSON.stringify({
                from: '+15550002222',
                text: 'firmware text field'
            }))
        );

        expect(incomingHandler).toHaveBeenCalledWith(
            'device-1',
            expect.objectContaining({
                from: '+15550002222',
                text: 'firmware text field',
                message: 'firmware text field'
            })
        );
    });

    test('sms/incoming preserves a valid device-provided timestamp and records receipt time separately', () => {
        const incomingHandler = jest.fn();
        svc.on('sms:incoming', incomingHandler);

        svc.handleMessage(
            'device/device-1/sms/incoming',
            Buffer.from(JSON.stringify({
                from: '+15550002222',
                text: 'firmware text field',
                timestamp: '2026-04-22T09:45:00.000Z'
            }))
        );

        expect(incomingHandler).toHaveBeenCalledWith(
            'device-1',
            expect.objectContaining({
                from: '+15550002222',
                message: 'firmware text field',
                timestamp: '2026-04-22T09:45:00.000Z',
                receivedAt: expect.any(String)
            })
        );
    });

    test('get-status compatibility re-emits the last known status snapshot', async () => {
        const statusHandler = jest.fn();
        svc.on('status', statusHandler);
        svc.deviceStatus.set('device-1', {
            lastSeen: new Date().toISOString(),
            online: true,
            lastStatus: {
                type: 'device_status',
                wifi_connected: true,
                wifi_ssid: 'LabNet'
            }
        });

        const response = await svc.publishCommand(
            'device-1',
            'get-status',
            {},
            true,
            5000,
            { skipPersistentQueue: true, messageId: 'status-1' }
        );
        await new Promise(resolve => setImmediate(resolve));

        expect(response.success).toBe(true);
        expect(response.messageId).toBe('status-1');
        expect(statusHandler).toHaveBeenCalledWith(
            'device-1',
            expect.objectContaining({
                wifi_connected: true,
                messageId: 'status-1'
            })
        );
        expect(svc.client.publish).not.toHaveBeenCalled();
    });

    test('bypassCompatibility forces get-status to publish a real live command', async () => {
        svc.deviceStatus.set('device-1', {
            lastSeen: new Date().toISOString(),
            online: true,
            lastStatus: {
                type: 'device_status',
                wifi_connected: true
            }
        });

        await svc.publishCommand(
            'device-1',
            'get-status',
            {},
            false,
            5000,
            {
                skipQueue: true,
                messageId: 'status-live-1',
                bypassCompatibility: true,
                source: 'status-test'
            }
        );

        expect(svc.client.publish).toHaveBeenCalledTimes(1);
        expect(svc.client.publish.mock.calls[0][0]).toBe('device/device-1/command/get-status');
        expect(JSON.parse(svc.client.publish.mock.calls[0][1])).toEqual(expect.objectContaining({
            action_id: 'status-live-1',
            messageId: 'status-live-1',
            command: 'get_status',
            source: 'status-test'
        }));
    });

    test('queued device operations can publish nested commands without deadlocking', async () => {
        let timeoutId;
        const deadlockGuard = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('nested queue deadlock')), 1000);
        });
        const result = await Promise.race([
            svc.runDeviceOperation('device-1', () => svc.publishCommand(
                'device-1',
                'wifi-reconnect',
                {},
                false,
                5000,
                { skipPersistentQueue: true, messageId: 'wifi-reconnect-1' }
            )),
            deadlockGuard
        ]);
        clearTimeout(timeoutId);

        expect(result.topic).toBe('device/device-1/command/wifi-reconnect');
        expect(svc.client.publish).toHaveBeenCalledTimes(1);
        expect(JSON.parse(svc.client.publish.mock.calls[0][1])).toEqual(expect.objectContaining({
            action_id: 'wifi-reconnect-1',
            command: 'wifi_reconnect'
        }));
    });

    test('action/result get_status re-emits a status snapshot from payload', () => {
        const statusHandler = jest.fn();
        svc.on('status', statusHandler);

        svc.handleMessage(
            'device/device-1/action/result',
            Buffer.from(JSON.stringify({
                action_id: 'status-fw-1',
                command: 'get_status',
                result: 'completed',
                payload: {
                    type: 'device_status',
                    active_path: 'wifi',
                    wifi_connected: true,
                    wifi_ssid: 'BenchNet',
                    mqtt_connected: true,
                    mqtt_subscribed: true
                }
            }))
        );

        expect(statusHandler).toHaveBeenCalledWith(
            'device-1',
            expect.objectContaining({
                active_path: 'wifi',
                wifi_connected: true,
                wifi_ssid: 'BenchNet',
                messageId: 'status-fw-1'
            })
        );
        expect(svc.deviceStatus.get('device-1')?.lastStatus).toEqual(
            expect.objectContaining({
                active_path: 'wifi',
                wifi_connected: true,
                wifi_ssid: 'BenchNet'
            })
        );
    });

    test('action/result wifi_disconnect merges modem snapshot and suppression state into status', () => {
        const statusHandler = jest.fn();
        svc.on('status', statusHandler);
        svc.deviceStatus.set('device-1', {
            lastSeen: new Date().toISOString(),
            online: true,
            lastStatus: {
                type: 'device_status',
                active_path: 'modem',
                modem_registered: true,
                mqtt_connected: true,
                wifi_configured: true,
                wifi_started: true,
                wifi_connected: false,
                wifi_ssid: 'RiazM'
            }
        });

        svc.handleMessage(
            'device/device-1/action/result',
            Buffer.from(JSON.stringify({
                action_id: 'wifi-disconnect-fw-1',
                command: 'wifi_disconnect',
                result: 'completed',
                payload: {
                    ssid: 'RiazM',
                    configured: true,
                    started: true,
                    connected: false,
                    reconnect_suppressed: true
                }
            }))
        );

        expect(statusHandler).toHaveBeenCalledWith(
            'device-1',
            expect.objectContaining({
                active_path: 'modem',
                wifi_connected: false,
                wifi_reconnect_suppressed: true,
                wifi_ssid: 'RiazM',
                messageId: 'wifi-disconnect-fw-1'
            })
        );
        expect(svc.deviceStatus.get('device-1')?.lastStatus).toEqual(
            expect.objectContaining({
                active_path: 'modem',
                modem_registered: true,
                mqtt_connected: true,
                wifi_reconnect_suppressed: true
            })
        );
    });

    test('action/result wifi_reconnect clears suppression without discarding prior status fields', () => {
        const statusHandler = jest.fn();
        svc.on('status', statusHandler);
        svc.deviceStatus.set('device-1', {
            lastSeen: new Date().toISOString(),
            online: true,
            lastStatus: {
                type: 'device_status',
                active_path: 'modem',
                modem_registered: true,
                mqtt_connected: true,
                wifi_configured: true,
                wifi_started: true,
                wifi_connected: false,
                wifi_reconnect_suppressed: true,
                wifi_ssid: 'RiazM'
            }
        });

        svc.handleMessage(
            'device/device-1/action/result',
            Buffer.from(JSON.stringify({
                action_id: 'wifi-reconnect-fw-1',
                command: 'wifi_reconnect',
                result: 'completed',
                payload: {
                    ssid: 'RiazM',
                    configured: true,
                    started: true,
                    connected: false
                }
            }))
        );

        expect(statusHandler).toHaveBeenCalledWith(
            'device-1',
            expect.objectContaining({
                active_path: 'modem',
                wifi_connected: false,
                wifi_reconnect_suppressed: false,
                wifi_ssid: 'RiazM',
                messageId: 'wifi-reconnect-fw-1'
            })
        );
        expect(svc.deviceStatus.get('device-1')?.lastStatus).toEqual(
            expect.objectContaining({
                active_path: 'modem',
                modem_registered: true,
                mqtt_connected: true,
                wifi_reconnect_suppressed: false
            })
        );
    });

    test('getDeviceQueueState returns domain-aware summaries and recent item domains', async () => {
        global.app.locals.db = {
            all: jest.fn()
                .mockResolvedValueOnce([
                    { command: 'send-sms', status: 'pending', count: 2 },
                    { command: 'get-status', status: 'dispatching', count: 1 },
                    { command: 'storage-delete', status: 'failed', count: 1 },
                    { command: 'restart', status: 'ambiguous', count: 1 }
                ])
                .mockResolvedValueOnce([
                    {
                        id: 'q1',
                        command: 'get-status',
                        status: 'dispatching',
                        messageId: 'status-1',
                        attemptCount: 1,
                        maxAttempts: 3,
                        lastError: null,
                        createdAt: '2026-04-12 10:00:00',
                        updatedAt: '2026-04-12 10:00:01',
                        completedAt: null
                    },
                    {
                        id: 'q2',
                        command: 'send-sms',
                        status: 'pending',
                        messageId: 'sms-1',
                        attemptCount: 0,
                        maxAttempts: 6,
                        lastError: null,
                        createdAt: '2026-04-12 10:00:00',
                        updatedAt: '2026-04-12 10:00:00',
                        completedAt: null
                    }
                ])
        };

        svc.deviceCommandQueues.set('device-1', {
            active: true,
            draining: false,
            sequence: 0,
            pending: []
        });
        svc.markDeviceBusy('device-1', 'send-sms', 5000);

        const state = await svc.getDeviceQueueState('device-1');

        expect(state.summary).toEqual(expect.objectContaining({
            pending: 2,
            active: 1,
            failed: 1,
            ambiguous: 1,
            totalOpen: 5
        }));
        expect(state.domains).toEqual(expect.objectContaining({
            telephony: expect.objectContaining({ pending: 2, totalOpen: 2 }),
            status: expect.objectContaining({ active: 1, totalOpen: 1 }),
            storage: expect.objectContaining({ failed: 1, totalOpen: 1 }),
            system: expect.objectContaining({ ambiguous: 1, totalOpen: 1 })
        }));
        expect(state.runtime).toEqual(expect.objectContaining({
            queued: true,
            busy: true
        }));
        expect(state.recent).toEqual(expect.arrayContaining([
            expect.objectContaining({ command: 'get-status', domain: 'status' }),
            expect.objectContaining({ command: 'send-sms', domain: 'telephony' })
        ]));

        svc.deviceCommandQueues.delete('device-1');
        svc.clearDeviceBusy('device-1');
    });

    test('classifies high-value commands into stable domains and priorities', () => {
        expect(svc._commandDomain('send-sms')).toBe('telephony');
        expect(svc._commandDomain('make-call')).toBe('telephony');
        expect(svc._commandDomain('end-call')).toBe('telephony');
        expect(svc._commandDomain('answer-call')).toBe('telephony');
        expect(svc._commandDomain('send-ussd')).toBe('telephony');
        expect(svc._commandDomain('wifi-reconnect')).toBe('network');
        expect(svc._commandDomain('config-set', { domain: 'network' })).toBe('network');
        expect(svc._commandDomain('storage-delete')).toBe('storage');
        expect(svc._commandDomain('get-status')).toBe('status');
        expect(svc._commandDomain('wifi-scan')).toBe('network');

        expect(svc._defaultPriority('send-sms')).toBe(40);
        expect(svc._defaultPriority('make-call')).toBe(40);
        expect(svc._defaultPriority('end-call')).toBe(40);
        expect(svc._defaultPriority('get-status')).toBe(60);
        expect(svc._defaultPriority('gpio-read')).toBe(60);
        expect(svc._defaultPriority('wifi-reconnect')).toBe(80);
        expect(svc._defaultPriority('config-set', { domain: 'network' })).toBe(80);
        expect(svc._defaultPriority('storage-delete')).toBe(140);
        expect(svc._defaultPriority('wifi-scan')).toBe(80);
    });

    test('requestStatus skips automatic refresh when the device already has queued work', async () => {
        svc.deviceCommandQueues.set('device-1', {
            active: true,
            draining: false,
            sequence: 0,
            pending: []
        });

        const result = await svc.requestStatus('device-1', { force: false });

        expect(result).toEqual({
            skipped: true,
            reason: 'device busy'
        });
        expect(svc.client.publish).not.toHaveBeenCalled();

        svc.deviceCommandQueues.delete('device-1');
    });

    test('keeps interactive telephony runtime-only while SMS remains durable', () => {
        expect(svc._isDurableCommand('send-sms')).toBe(true);
        expect(svc._isDurableCommand('send-ussd')).toBe(false);
        expect(svc._isDurableCommand('make-call')).toBe(false);
        expect(svc._isDurableCommand('end-call')).toBe(false);
        expect(svc._isDurableCommand('send-ussd', { persistent: true })).toBe(true);
        expect(svc._isReplaySafeCommand('send-sms')).toBe(false);
        expect(svc._isReplaySafeCommand('send-ussd', { persistent: true })).toBe(false);
        expect(svc._isReplaySafeCommand('storage-delete')).toBe(true);
    });

    test('device queue prioritizes foreground actions ahead of pending background work', async () => {
        const order = [];
        let releaseActive;
        let signalActiveStarted;
        const activeStarted = new Promise((resolve) => { signalActiveStarted = resolve; });

        const active = svc.enqueueDeviceCommand(
            'device-1',
            () => new Promise((resolve) => {
                releaseActive = resolve;
                signalActiveStarted();
            }),
            { command: 'wifi-reconnect', priority: 80, background: false }
        );
        const background = svc.enqueueDeviceCommand(
            'device-1',
            async () => { order.push('background'); return 'background'; },
            { command: 'get-status', background: true }
        );
        background.catch(() => {});
        const foreground = svc.enqueueDeviceCommand(
            'device-1',
            async () => { order.push('foreground'); return 'foreground'; },
            { command: 'send-sms', priority: 50, background: false }
        );

        await activeStarted;
        releaseActive('active');
        await expect(background).rejects.toMatchObject({ code: 'COMMAND_SUPERSEDED' });
        await expect(foreground).resolves.toBe('foreground');
        await expect(active).resolves.toBe('active');
        expect(order).toEqual(['foreground']);
    });

    test('device queue coalesces duplicate background status commands', async () => {
        let releaseActive;
        let signalStarted;
        let executions = 0;
        const started = new Promise((resolve) => { signalStarted = resolve; });

        const first = svc.enqueueDeviceCommand(
            'device-1',
            () => {
                executions += 1;
                signalStarted();
                return new Promise((resolve) => {
                    releaseActive = () => resolve({ ok: true, from: 'first' });
                });
            },
            { command: 'get-status', background: true, source: 'status-watch' }
        );

        await started;

        const second = svc.enqueueDeviceCommand(
            'device-1',
            () => {
                executions += 1;
                return Promise.resolve({ ok: true, from: 'second' });
            },
            { command: 'get-status', background: true, source: 'status-watch' }
        );

        releaseActive();

        await expect(first).resolves.toEqual({ ok: true, from: 'first' });
        await expect(second).resolves.toEqual({ ok: true, from: 'first' });
        expect(executions).toBe(1);
    });

    test('interactive telephony helpers bypass the persistent queue', async () => {
        svc.publishCommand = jest.fn().mockResolvedValue({ messageId: 'msg-1' });

        await svc.makeCall('device-1', '+15551234567', { source: 'test:calls' });
        await svc.answerCall('device-1', { source: 'test:calls' });
        await svc.endCall('device-1', { source: 'test:calls' });
        await svc.sendUssd('device-1', '*121#', { source: 'test:ussd' });

        expect(svc.publishCommand).toHaveBeenNthCalledWith(
            1,
            'device-1',
            'make-call',
            { number: '+15551234567' },
            false,
            60000,
            expect.objectContaining({
                source: 'test:calls',
                domain: 'telephony',
                skipPersistentQueue: true
            })
        );
        expect(svc.publishCommand).toHaveBeenNthCalledWith(
            2,
            'device-1',
            'answer-call',
            {},
            false,
            10000,
            expect.objectContaining({
                source: 'test:calls',
                domain: 'telephony',
                skipPersistentQueue: true
            })
        );
        expect(svc.publishCommand).toHaveBeenNthCalledWith(
            3,
            'device-1',
            'end-call',
            {},
            false,
            10000,
            expect.objectContaining({
                source: 'test:calls',
                domain: 'telephony',
                skipPersistentQueue: true
            })
        );
        expect(svc.publishCommand).toHaveBeenNthCalledWith(
            4,
            'device-1',
            'send-ussd',
            { code: '*121#' },
            false,
            60000,
            expect.objectContaining({
                source: 'test:ussd',
                domain: 'telephony',
                skipPersistentQueue: true
            })
        );
    });
});

describe('mqttService durable SMS queue', () => {
    let svc;

    beforeEach(() => {
        jest.resetModules();
        global.app = { locals: {} };
        global.io = {
            emit: jest.fn(),
            to: jest.fn(() => ({ emit: jest.fn() }))
        };

        svc = require('../services/mqttService');
        svc.connected = true;
        svc.connecting = false;
        svc.client = {
            end: jest.fn(),
            publish: jest.fn((topic, payload, options, callback) => callback(null))
        };
        svc.pendingMessages.clear();
        svc.deviceStatus.clear();
        svc.seenMessages.clear();
        svc.removeAllListeners();
    });

    afterEach(() => {
        svc.disconnect();
        delete global.app;
        delete global.io;
        delete global.modemService;
    });

    test('durable send-sms waits for the immediate firmware action result and completes the queue row', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([])
        };
        global.app.locals.db = db;

        svc.enqueueDeviceCommand = jest.fn((_deviceId, task) => task());
        svc._updatePersistentQueueRow = jest.fn().mockResolvedValue();
        svc._syncSmsStatusFromQueueRow = jest.fn().mockResolvedValue();
        svc._emitDeviceQueueState = jest.fn().mockResolvedValue();
        svc._markPersistentQueueCompleted = jest.fn().mockResolvedValue();
        svc._markPersistentQueueRetry = jest.fn().mockResolvedValue();
        svc._publishCommandNow = jest.fn().mockResolvedValue({
            topic: 'device/device-1/command/send-sms',
            messageId: 'send-sms_test'
        });

        svc._processPersistentQueueRow({
            id: 'queue-1',
            device_id: 'device-1',
            command: 'send-sms',
            payload: JSON.stringify({ to: '+8801628301525', message: 'hello', smsId: 41 }),
            message_id: 'send-sms_test',
            requires_response: 1,
            attempt_count: 0,
            timeout_ms: 60000,
            source: 'dashboard-sms'
        });

        await new Promise(resolve => setImmediate(resolve));

        expect(svc._updatePersistentQueueRow).toHaveBeenCalledWith(
            'queue-1',
            expect.objectContaining({
                status: 'waiting_response',
                attempt_count: 1,
                next_attempt_at: null
            })
        );
        expect(svc._publishCommandNow).toHaveBeenCalledWith(
            'device-1',
            'send-sms',
            expect.objectContaining({
                to: '+8801628301525',
                message: 'hello',
                smsId: 41
            }),
            true,
            60000,
            expect.objectContaining({
                messageId: 'send-sms_test',
                source: 'dashboard-sms'
            })
        );
        expect(svc._markPersistentQueueCompleted).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'queue-1',
                command: 'send-sms',
                message_id: 'send-sms_test'
            }),
            expect.objectContaining({
                topic: 'device/device-1/command/send-sms',
                messageId: 'send-sms_test'
            })
        );
        expect(svc._markPersistentQueueRetry).not.toHaveBeenCalled();
    });

    test('durable queued SMS stays pending until device command subscription is ready', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([])
        };
        global.app.locals.db = db;

        svc.deviceStatus.set('device-1', {
            lastSeen: new Date().toISOString(),
            online: true,
            lastStatus: {
                mqtt_connected: true,
                mqtt_subscribed: false
            }
        });

        svc.enqueueDeviceCommand = jest.fn((_deviceId, task) => task());
        svc._updatePersistentQueueRow = jest.fn().mockResolvedValue();
        svc._syncSmsStatusFromQueueRow = jest.fn().mockResolvedValue();
        svc._emitDeviceQueueState = jest.fn().mockResolvedValue();
        svc._markPersistentQueueCompleted = jest.fn().mockResolvedValue();
        svc._markPersistentQueueRetry = jest.fn().mockResolvedValue();
        svc._publishCommandNow = jest.fn().mockResolvedValue({
            topic: 'device/device-1/command/send-sms',
            messageId: 'send-sms_wait_subscribed'
        });

        await svc._processPersistentQueueRow({
            id: 'queue-pending-subscribe',
            device_id: 'device-1',
            command: 'send-sms',
            payload: JSON.stringify({ to: '+8801628301525', message: 'hello', smsId: 75 }),
            message_id: 'send-sms_wait_subscribed',
            requires_response: 1,
            attempt_count: 0,
            timeout_ms: 60000,
            source: 'dashboard-sms'
        });

        expect(svc._updatePersistentQueueRow).toHaveBeenCalledWith(
            'queue-pending-subscribe',
            expect.objectContaining({
                status: 'pending',
                last_error: 'Device MQTT connected but command subscription is not ready'
            })
        );
        expect(svc._publishCommandNow).not.toHaveBeenCalled();
        expect(svc._markPersistentQueueCompleted).not.toHaveBeenCalled();
        expect(svc._markPersistentQueueRetry).not.toHaveBeenCalled();
    });

    test('durable queued SMS dispatch prefers fresh modemService command readiness over stale raw snapshot', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([])
        };
        global.app.locals.db = db;
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(true),
            getDeviceStatus: jest.fn().mockReturnValue({
                online: true,
                mqtt: {
                    connected: true,
                    subscribed: true
                },
                transport: {
                    mqttCommandAccepting: true
                }
            })
        };

        svc.deviceStatus.set('device-1', {
            lastSeen: new Date().toISOString(),
            online: true,
            lastStatus: {
                mqtt_connected: true,
                mqtt_subscribed: false
            }
        });

        svc.enqueueDeviceCommand = jest.fn((_deviceId, task) => task());
        svc._updatePersistentQueueRow = jest.fn().mockResolvedValue();
        svc._syncSmsStatusFromQueueRow = jest.fn().mockResolvedValue();
        svc._emitDeviceQueueState = jest.fn().mockResolvedValue();
        svc._markPersistentQueueCompleted = jest.fn().mockResolvedValue();
        svc._markPersistentQueueRetry = jest.fn().mockResolvedValue();
        svc._publishCommandNow = jest.fn().mockResolvedValue({
            topic: 'device/device-1/command/send-sms',
            messageId: 'send-sms_fresh_live_status'
        });

        await svc._processPersistentQueueRow({
            id: 'queue-fresh-live-status',
            device_id: 'device-1',
            command: 'send-sms',
            payload: JSON.stringify({ to: '+8801628301525', message: 'hello', smsId: 76 }),
            message_id: 'send-sms_fresh_live_status',
            requires_response: 1,
            attempt_count: 0,
            timeout_ms: 60000,
            source: 'dashboard-sms'
        });

        await new Promise(resolve => setImmediate(resolve));

        expect(svc._publishCommandNow).toHaveBeenCalledWith(
            'device-1',
            'send-sms',
            expect.objectContaining({
                to: '+8801628301525',
                message: 'hello',
                smsId: 76
            }),
            true,
            60000,
            expect.objectContaining({
                messageId: 'send-sms_fresh_live_status'
            })
        );
    });

    test('send-sms publish injects the command timeout into the firmware payload', async () => {
        await svc._publishCommandNow(
            'device-1',
            'send-sms',
            {
                to: '+8801628301525',
                message: 'hello'
            },
            false,
            60000,
            {
                messageId: 'send-sms_timeout_payload',
                source: 'dashboard-sms'
            }
        );

        const published = JSON.parse(svc.client.publish.mock.calls[0][1]);
        expect(published).toEqual(expect.objectContaining({
            action_id: 'send-sms_timeout_payload',
            command: 'send_sms',
            number: '+8801628301525',
            text: 'hello',
            timeout: 60000
        }));
    });

    test('non-replay-safe SMS command timeouts become ambiguous instead of being retried', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue({ id: 'queue-timeout', status: 'ambiguous' }),
            all: jest.fn().mockResolvedValue([])
        };
        global.app.locals.db = db;

        svc.enqueueDeviceCommand = jest.fn((_deviceId, task) => task());
        svc._updatePersistentQueueRow = jest.fn().mockResolvedValue();
        svc._syncSmsStatusFromQueueRow = jest.fn().mockResolvedValue();
        svc._emitDeviceQueueState = jest.fn().mockResolvedValue();
        svc._markPersistentQueueCompleted = jest.fn().mockResolvedValue();
        svc._markPersistentQueueAmbiguous = jest.fn().mockResolvedValue();
        svc._publishCommandNow = jest.fn().mockRejectedValue(new Error('Command timeout after 60000ms'));

        await svc._processPersistentQueueRow({
            id: 'queue-timeout',
            device_id: 'device-1',
            command: 'send-sms',
            payload: JSON.stringify({ to: '+8801628301525', message: 'hello', smsId: 70 }),
            message_id: 'send-sms_timeout_test',
            requires_response: 1,
            replay_safe: 0,
            attempt_count: 0,
            timeout_ms: 60000,
            source: 'dashboard-sms'
        });

        await new Promise(resolve => setImmediate(resolve));

        expect(svc._markPersistentQueueAmbiguous).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'queue-timeout',
                command: 'send-sms',
                replay_safe: 0
            }),
            expect.objectContaining({
                message: 'Command timeout after 60000ms'
            })
        );
        expect(svc._markPersistentQueueCompleted).not.toHaveBeenCalled();
    });

    test('action/result settles a queued SMS row as sent by message id', async () => {
        global.app.locals.db = {
            get: jest.fn().mockResolvedValue({
                id: 'queue-1b',
                device_id: 'device-1',
                command: 'send-sms',
                message_id: 'send-sms_action_1',
                status: 'waiting_response',
                payload: JSON.stringify({ to: '+8801628301525', smsId: 67 })
            }),
            all: jest.fn().mockResolvedValue([])
        };

        svc._markPersistentQueueCompleted = jest.fn().mockResolvedValue();

        svc.handleMessage(
            'device/device-1/action/result',
            Buffer.from(JSON.stringify({
                action_id: 'send-sms_action_1',
                command: 'send_sms',
                result: 'completed',
                detail: 'sms_send_completed',
                success: true,
                payload: {
                    sms_id: 67,
                    to: '+8801628301525'
                }
            }))
        );

        await new Promise(resolve => setImmediate(resolve));

        expect(svc._markPersistentQueueCompleted).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'queue-1b',
                command: 'send-sms',
                message_id: 'send-sms_action_1'
            }),
            expect.objectContaining({
                action_id: 'send-sms_action_1',
                command: 'send_sms',
                result: 'completed',
                success: true
            })
        );
    });

    test('late action/result can settle an ambiguous SMS row by message id', async () => {
        global.app.locals.db = {
            get: jest.fn().mockResolvedValue({
                id: 'queue-1c',
                device_id: 'device-1',
                command: 'send-sms',
                message_id: 'send-sms_action_2',
                status: 'ambiguous',
                payload: JSON.stringify({ to: '+8801628301525', smsId: 68 })
            }),
            all: jest.fn().mockResolvedValue([])
        };

        svc._markPersistentQueueCompleted = jest.fn().mockResolvedValue();

        svc.handleMessage(
            'device/device-1/action/result',
            Buffer.from(JSON.stringify({
                action_id: 'send-sms_action_2',
                command: 'send_sms',
                result: 'completed',
                detail: 'sms_send_completed',
                success: true
            }))
        );

        await new Promise(resolve => setImmediate(resolve));

        expect(svc._markPersistentQueueCompleted).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'queue-1c',
                command: 'send-sms',
                status: 'ambiguous'
            }),
            expect.objectContaining({
                action_id: 'send-sms_action_2',
                result: 'completed',
                success: true
            })
        );
    });

    test('expired published SMS rows become ambiguous instead of being replayed', async () => {
        global.app.locals.db = {
            all: jest.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{
                    id: 'queue-2',
                    device_id: 'device-1',
                    command: 'send-sms',
                    status: 'waiting_response',
                    replay_safe: 0,
                    timeout_ms: 60000
                }]),
            get: jest.fn().mockResolvedValue({
                id: 'queue-2',
                device_id: 'device-1',
                command: 'send-sms',
                status: 'ambiguous'
            })
        };

        svc._recoverPersistentQueue = jest.fn().mockResolvedValue();
        svc._markPersistentQueueRetry = jest.fn().mockResolvedValue();
        svc._markPersistentQueueAmbiguous = jest.fn().mockResolvedValue();

        await svc.processPersistentQueue();

        expect(svc._markPersistentQueueAmbiguous).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'queue-2',
                command: 'send-sms',
                status: 'waiting_response'
            }),
            expect.objectContaining({
                message: 'Command timeout after 60000ms'
            })
        );
        expect(svc._markPersistentQueueRetry).not.toHaveBeenCalled();
    });

    test('expired replay-safe waiting-response rows are retried from queue timeout', async () => {
        global.app.locals.db = {
            all: jest.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{
                    id: 'queue-2b',
                    device_id: 'device-1',
                    command: 'storage-delete',
                    status: 'waiting_response',
                    replay_safe: 1,
                    timeout_ms: 60000
                }])
        };

        svc._recoverPersistentQueue = jest.fn().mockResolvedValue();
        svc._markPersistentQueueRetry = jest.fn().mockResolvedValue();
        svc._markPersistentQueueAmbiguous = jest.fn().mockResolvedValue();

        await svc.processPersistentQueue();

        expect(svc._markPersistentQueueRetry).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'queue-2b',
                command: 'storage-delete',
                status: 'waiting_response'
            }),
            expect.objectContaining({
                message: 'Command timeout after 60000ms'
            })
        );
        expect(svc._markPersistentQueueAmbiguous).not.toHaveBeenCalled();
    });

    test('sms/delivered settles a waiting queue row by message id', async () => {
        global.app.locals.db = {
            get: jest.fn().mockResolvedValue({
                id: 'queue-3',
                device_id: 'device-1',
                command: 'send-sms',
                message_id: 'send-sms_delivery_1',
                status: 'waiting_response',
                payload: JSON.stringify({ to: '+8801628301525', smsId: 41 })
            }),
            all: jest.fn().mockResolvedValue([])
        };

        svc._markPersistentQueueCompleted = jest.fn().mockResolvedValue();

        svc.handleMessage(
            'device/device-1/sms/delivered',
            Buffer.from(JSON.stringify({
                action_id: 'send-sms_delivery_1',
                to: '+8801628301525'
            }))
        );

        await new Promise(resolve => setImmediate(resolve));

        expect(svc._markPersistentQueueCompleted).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'queue-3',
                status: 'waiting_response'
            }),
            expect.objectContaining({
                success: true,
                detail: 'sms_delivered'
            })
        );
    });

    test('sms/delivered can settle the latest waiting queue row by destination number', async () => {
        global.app.locals.db = {
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([{
                id: 'queue-4',
                device_id: 'device-1',
                command: 'send-sms',
                message_id: 'send-sms_delivery_2',
                status: 'waiting_response',
                payload: JSON.stringify({ to: '+8801628301525', smsId: 42 })
            }])
        };

        svc._markPersistentQueueCompleted = jest.fn().mockResolvedValue();

        svc.handleMessage(
            'device/device-1/sms/delivered',
            Buffer.from(JSON.stringify({
                to: '+8801628301525'
            }))
        );

        await new Promise(resolve => setImmediate(resolve));

        expect(svc._markPersistentQueueCompleted).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'queue-4',
                message_id: 'send-sms_delivery_2'
            }),
            expect.objectContaining({
                success: true,
                detail: 'sms_delivered'
            })
        );
    });
});
