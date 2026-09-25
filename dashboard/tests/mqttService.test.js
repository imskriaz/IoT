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

    test.each([
        ['sync-sms', 'get_sms_history'],
        ['pull_messages', 'get_sms_history'],
        ['gpio-read', 'gpio_status'],
        ['sms-delete', 'delete_sms'],
        ['raw-at', 'modem_at'],
        ['reject-call', 'reject_call']
    ])('settles %s only for its correlated canonical terminal result', (command, canonical) => {
        const resolve = jest.fn();
        const timer = setTimeout(() => {}, 10000);
        svc.pendingMessages.set('alias-test', {
            command, deviceId: 'esp-test', timeout: timer, resolve
        });
        const response = { action_id: 'alias-test', command: canonical, result: 'completed' };
        expect(svc._resolvePendingMessage('another-device', response)).toBe(false);
        expect(svc._resolvePendingMessage('esp-test', { ...response, command: 'send_sms' })).toBe(false);
        expect(svc._resolvePendingMessage('esp-test', { ...response, result: 'accepted' })).toBe(false);
        expect(resolve).not.toHaveBeenCalled();
        expect(svc._resolvePendingMessage('esp-test', response)).toBe(true);
        expect(resolve).toHaveBeenCalledWith(response);
        expect(svc.pendingMessages.has('alias-test')).toBe(false);
    });

    beforeEach(() => {
        jest.resetModules();
        global.app = { locals: {} };
        global.io = {
            emit: jest.fn(),
            to: jest.fn(() => ({ emit: jest.fn() }))
        };

        svc = require('../services/mqttService');
        svc.connected = true;
        svc.subscriptionsReady = true;
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

    test('keeps Android reject distinct from end-call on the command wire', async () => {
        await svc.publishRuntimeCommand('device-android', 'reject-call', {}, false, 10000, {
            skipQueue: true, messageId: 'reject-1'
        });
        await svc.publishRuntimeCommand('device-android', 'end-call', {}, false, 10000, {
            skipQueue: true, messageId: 'end-1'
        });

        const calls = svc.client.publish.mock.calls;
        expect(calls.map(([topic]) => topic)).toEqual([
            'device/device-android/command/reject_call',
            'device/device-android/command/hangup_call'
        ]);
        expect(JSON.parse(calls[0][1])).toEqual(expect.objectContaining({
            schema: 1, device_id: 'device-android', action_id: 'reject-1',
            command: 'reject_call', payload: {}
        }));
        expect(JSON.parse(calls[1][1])).toEqual(expect.objectContaining({
            schema: 1, device_id: 'device-android', action_id: 'end-1',
            command: 'hangup_call', payload: {}
        }));
    });

    afterEach(() => {
        svc.disconnect();
        delete global.app;
        delete global.io;
    });

    test('subscribes to firmware delivery reports and the legacy delivered alias', async () => {
        svc.client.subscribe = jest.fn((topic, options, callback) => callback(null, [{ topic, qos: 1 }]));
        await svc.subscribeToDefaultTopics();
        for (const topic of ['device/+/sms/delivery', 'device/+/sms/delivered']) {
            expect(svc.client.subscribe).toHaveBeenCalledWith(topic, { qos: 1 }, expect.any(Function));
        }
        svc.client.subscribe.mockClear();
        await svc.resubscribe();
        for (const topic of ['device/+/sms/delivery', 'device/+/sms/delivered']) {
            expect(svc.client.subscribe).toHaveBeenCalledWith(topic, { qos: 1 }, expect.any(Function));
        }
    });

    test('uses only the canonical native action result topic', async () => {
        svc.client.subscribe = jest.fn((topic, options, callback) => callback(null, [{ topic, qos: 1 }]));
        await svc.subscribeToDefaultTopics();

        expect(svc.client.subscribe).toHaveBeenCalledWith(
            'device/+/action/result', { qos: 1 }, expect.any(Function)
        );
        expect(svc.client.subscribe).not.toHaveBeenCalledWith(
            'device/+/command/response', { qos: 1 }, expect.any(Function)
        );
    });

    test('holds command dispatch until required dashboard subscriptions receive SUBACK', async () => {
        svc.processPersistentQueue = jest.fn().mockResolvedValue(undefined);
        svc._retryUnpublishedActionResultAcks = jest.fn().mockResolvedValue(undefined);
        svc.client.subscribe = jest.fn((topic, options, callback) =>
            callback(null, [{ topic, qos: 1 }]));
        svc.connected = false;
        svc.handleConnect();
        expect(svc.subscriptionsReady).toBe(false);
        expect(svc.processPersistentQueue).not.toHaveBeenCalled();
        await new Promise(resolve => setImmediate(resolve));
        expect(svc.subscriptionsReady).toBe(true);
        expect(svc.getStatus().subscriptionsReady).toBe(true);
        expect(svc.processPersistentQueue).toHaveBeenCalledTimes(1);
    });

    test('optional-topic SUBACK cannot delay command readiness', async () => {
        const optionalCallbacks = [];
        svc.processPersistentQueue = jest.fn().mockResolvedValue(undefined);
        svc._retryUnpublishedActionResultAcks = jest.fn().mockResolvedValue(undefined);
        svc.client.subscribe = jest.fn((topic, options, callback) => {
            if (['device/+/status', 'device/+/heartbeat', 'device/+/action/result'].includes(topic)) {
                callback(null, [{ topic, qos: 1 }]);
            } else {
                optionalCallbacks.push({ topic, callback });
            }
        });
        svc.connected = false;
        svc.handleConnect();
        await new Promise(resolve => setImmediate(resolve));
        expect(optionalCallbacks.length).toBeGreaterThan(0);
        expect(svc.subscriptionsReady).toBe(true);
        expect(svc.processPersistentQueue).toHaveBeenCalledTimes(1);
        for (const { topic, callback } of optionalCallbacks) {
            callback(null, [{ topic, qos: 1 }]);
        }
        await new Promise(resolve => setImmediate(resolve));
    });

    test('missing SUBACK times out and a late grant cannot restore readiness', async () => {
        jest.useFakeTimers();
        try {
            let lateCallback;
            svc.client.subscribe = jest.fn((topic, options, callback) => {
                lateCallback = callback;
            });
            const pending = svc.subscribe('device/+/action/result');
            jest.advanceTimersByTime(5000);
            await expect(pending).resolves.toBe(false);
            lateCallback(null, [{ topic: 'device/+/action/result', qos: 1 }]);
            expect(svc.subscribedTopics.has('device/+/action/result')).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    test('old-session SUBACK timeout cannot remove a new-session grant', async () => {
        jest.useFakeTimers();
        try {
            svc.client.subscribe = jest.fn();
            const pending = svc.subscribe('device/+/action/result');
            svc._subscriptionEpoch++;
            svc.subscribedTopics.add('device/+/action/result');
            jest.advanceTimersByTime(5000);
            await expect(pending).resolves.toBe(false);
            expect(svc.subscribedTopics.has('device/+/action/result')).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    test('rejects direct commands when result-topic SUBACK is denied', async () => {
        svc.processPersistentQueue = jest.fn().mockResolvedValue(undefined);
        svc.client.subscribe = jest.fn((topic, options, callback) =>
            callback(null, [{ topic, qos: topic === 'device/+/action/result' ? 128 : 1 }]));
        svc.connected = false;
        svc.handleConnect();
        await new Promise(resolve => setImmediate(resolve));
        expect(svc.subscriptionsReady).toBe(false);
        expect(svc.subscribedTopics.has('device/+/action/result')).toBe(false);
        expect(svc.processPersistentQueue).not.toHaveBeenCalled();
        await expect(svc.publishCommand('device-1', 'get-status', {}, false, 5000,
            { skipPersistentQueue: true, skipQueue: true })).rejects.toMatchObject({
            code: 'MQTT_SUBSCRIPTION_NOT_READY'
        });
        expect(svc.client.publish).not.toHaveBeenCalled();

        svc.client.subscribe.mockImplementation((topic, options, callback) =>
            callback(null, [{ topic, qos: 1 }]));
        await svc._confirmDefaultSubscriptions(svc._subscriptionEpoch);
        expect(svc.subscriptionsReady).toBe(true);
        expect(svc.processPersistentQueue).toHaveBeenCalledTimes(1);
    });

    test('late SUBACK from a closed broker session cannot restore readiness', async () => {
        const callbacks = [];
        svc.client.subscribe = jest.fn((topic, options, callback) =>
            callbacks.push({ topic, callback }));
        svc.connected = false;
        svc.handleConnect();
        expect(callbacks.length).toBeGreaterThan(0);
        svc.manualDisconnect = true;
        svc.handleClose();
        for (const { topic, callback } of callbacks) {
            callback(null, [{ topic, qos: 1 }]);
        }
        await new Promise(resolve => setImmediate(resolve));
        expect(svc.subscriptionsReady).toBe(false);
        expect(svc.subscribedTopics.size).toBe(0);
    });

    test('offline clears readiness and ignores a late SUBACK before close', async () => {
        const callbacks = [];
        svc.client.subscribe = jest.fn((topic, options, callback) =>
            callbacks.push({ topic, callback }));
        svc.connected = false;
        svc.handleConnect();
        expect(callbacks.length).toBeGreaterThan(0);
        svc.manualDisconnect = true;
        svc.handleOffline();
        for (const { topic, callback } of callbacks) {
            callback(null, [{ topic, qos: 1 }]);
        }
        await new Promise(resolve => setImmediate(resolve));
        expect(svc.getStatus()).toMatchObject({
            connected: false,
            subscriptionsReady: false
        });
        expect(svc.subscribedTopics.size).toBe(0);
    });

    test('does not emit the removed command response alias for native action results', () => {
        const compatibility = jest.fn();
        svc.on('command:response', compatibility);
        svc.handleMessage('device/device-1/action/result', Buffer.from(JSON.stringify({
            schema_version: 1,
            device_id: 'device-1',
            action_id: 'native-result-1',
            command: 'get_status',
            result: 'completed',
            result_code: 0
        })));
        expect(compatibility).not.toHaveBeenCalled();
    });

    test('canonical status emits one snapshot and heartbeat even on a broker repeat', () => {
        const status = jest.fn();
        const heartbeat = jest.fn();
        svc.on('status', status);
        svc.on('heartbeat', heartbeat);
        const payload = Buffer.from(JSON.stringify({ type: 'device_status', messageId: 'status-one', wifi_connected: true }));

        svc.handleMessage('device/device-1/status', payload);
        svc.handleMessage('device/device-1/status', payload);

        expect(status).toHaveBeenCalledTimes(1);
        expect(heartbeat).toHaveBeenCalledTimes(1);
        expect(status).toHaveBeenCalledWith('device-1', expect.objectContaining({ wifi_connected: true }));
    });

    test('rejects delayed and duplicate snapshots from the same boot before freshness changes', () => {
        const status = jest.fn();
        const heartbeat = jest.fn();
        svc.on('status', status);
        svc.on('heartbeat', heartbeat);

        svc.handleMessage('device/device-1/status', Buffer.from(JSON.stringify({
            type: 'device_status', boot_id: 'boot-a', status_sequence: 8, wifi_connected: true
        })));
        const acceptedAt = svc.deviceStatus.get('device-1').lastStatusAt;

        svc.handleMessage('device/device-1/status', Buffer.from(JSON.stringify({
            type: 'device_status', boot_id: 'boot-a', status_sequence: 7, wifi_connected: false
        })));
        svc.handleMessage('device/device-1/status', Buffer.from(JSON.stringify({
            type: 'device_status', boot_id: 'boot-a', status_sequence: 8, wifi_connected: false
        })));

        expect(status).toHaveBeenCalledTimes(1);
        expect(heartbeat).toHaveBeenCalledTimes(1);
        expect(svc.deviceStatus.get('device-1').lastStatusAt).toBe(acceptedAt);
        expect(svc.deviceStatus.get('device-1').lastStatus).toMatchObject({
            boot_id: 'boot-a', status_sequence: 8, wifi_connected: true
        });
    });

    test.each(['status', 'heartbeat', 'action/result'])('retained %s cannot renew liveness or suppress an identical live packet', (suffix) => {
        const status = jest.fn();
        const heartbeat = jest.fn();
        svc.on('status', status);
        svc.on('heartbeat', heartbeat);
        const payload = Buffer.from(JSON.stringify({
            type: suffix === 'status' ? 'device_status' : 'heartbeat',
            messageId: 'replayed-observation', mqtt_connected: true
        }));
        svc.handleMessage(`device/device-1/${suffix}`, payload, { retain: true });
        expect(svc.deviceStatus.has('device-1')).toBe(false);
        expect(status).not.toHaveBeenCalled();
        expect(heartbeat).not.toHaveBeenCalled();
        expect(svc.seenMessages.size).toBe(0);
        svc.handleMessage(`device/device-1/${suffix}`, payload, { retain: false });
        expect(heartbeat).toHaveBeenCalledTimes(suffix === 'action/result' ? 0 : 1);
        expect(svc.isDeviceOnline('device-1')).toBe(suffix !== 'action/result');
    });

    test.each(['sms/incoming', 'call/events', 'capabilities', 'action/result'])(
        'non-retained %s does not renew an expired heartbeat', (suffix) => {
            const lastSeen = new Date(Date.now() - 300000).toISOString();
            svc.deviceStatus.set('device-1', { lastSeen, online: true });
            const heartbeat = jest.fn();
            svc.on('heartbeat', heartbeat);
            svc.handleMessage(`device/device-1/${suffix}`, Buffer.from(JSON.stringify({
                messageId: 'late-event', command: 'gpio_write', result: 'completed'
            })));
            expect(svc.deviceStatus.get('device-1').lastSeen).toBe(lastSeen);
            expect(svc.isDeviceOnline('device-1')).toBe(false);
            expect(heartbeat).not.toHaveBeenCalled();
        }
    );

    test('retained capabilities restore discovery without creating a heartbeat', () => {
        const capabilities = jest.fn();
        const heartbeat = jest.fn();
        svc.on('capabilities', capabilities);
        svc.on('heartbeat', heartbeat);
        svc.handleMessage('device/device-1/capabilities', Buffer.from('{"caps":{"sms":true}}'), { retain: true });
        expect(capabilities).toHaveBeenCalledWith('device-1', { caps: { sms: true } });
        expect(heartbeat).not.toHaveBeenCalled();
        expect(svc.deviceStatus.has('device-1')).toBe(false);
    });

    test('command channel liveness ignores stored online flags after heartbeat expiry', () => {
        svc.deviceStatus.set('device-1', {
            online: true,
            lastSeen: new Date(Date.now() - 300000).toISOString(),
            lastStatus: { online: true, mqtt_connected: true, mqtt_subscribed: true }
        });
        expect(svc._deviceCommandChannelState('device-1').online).toBe(false);
    });

    test.each(['status', 'device_status'])('delayed get_status %s result settles its command without replacing a newer snapshot', (type) => {
        const status = jest.fn();
        const resolve = jest.fn();
        svc.on('status', status);
        svc._persistTerminalActionResultAndAck = jest.fn().mockResolvedValue(null);
        svc._settlePersistentQueueFromResponse = jest.fn().mockResolvedValue(null);
        svc.handleMessage('device/device-1/status', Buffer.from(JSON.stringify({
            type: 'device_status', boot_id: 'boot-a', status_sequence: 10, wifi_connected: true
        })));
        const acceptedAt = svc.deviceStatus.get('device-1').lastStatusAt;
        svc.pendingMessages.set('old-query', {
            command: 'get-status', deviceId: 'device-1', resolve, timeout: setTimeout(() => {}, 10000)
        });
        svc.handleMessage('device/device-1/action/result', Buffer.from(JSON.stringify({
            action_id: 'old-query', command: 'get_status', result: 'completed',
            payload: { type, boot_id: 'boot-a', status_sequence: 9, wifi_connected: false }
        })));
        expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ action_id: 'old-query', result: 'completed' }));
        expect(svc._persistTerminalActionResultAndAck).toHaveBeenCalledTimes(1);
        expect(status).toHaveBeenCalledTimes(1);
        expect(svc.deviceStatus.get('device-1').lastStatusAt).toBe(acceptedAt);
        expect(svc.deviceStatus.get('device-1').lastStatus).toMatchObject({ status_sequence: 10, wifi_connected: true });
    });

    test('get-status always publishes a native command instead of returning cached compatibility data', async () => {
        const observedAt = new Date(Date.now() - 180000).toISOString();
        svc.deviceStatus.set('device-1', {
            lastSeen: observedAt, lastStatusAt: observedAt, online: false,
            lastStatus: { type: 'device_status', mqtt_connected: true }
        });
        await svc.publishCommand('device-1', 'get-status', {}, false, 5000, {
            skipPersistentQueue: true,
            messageId: 'native-status-query'
        });
        const message = JSON.parse(svc.client.publish.mock.calls.at(-1)[1]);
        expect(message).toMatchObject({
            schema: 1,
            device_id: 'device-1',
            action_id: 'native-status-query',
            command: 'get_status',
            payload: {}
        });
        expect(message.cached_status).toBeUndefined();
        expect(svc.deviceStatus.get('device-1').lastSeen).toBe(observedAt);
        expect(svc.deviceStatus.get('device-1').lastStatusAt).toBe(observedAt);
        expect(svc.isDeviceOnline('device-1')).toBe(false);
        expect(svc.hasFreshStatusSnapshot('device-1')).toBe(false);
    });

    test('accepts a low sequence after the firmware boot id changes', () => {
        const status = jest.fn();
        svc.on('status', status);

        svc.handleMessage('device/device-1/status', Buffer.from(JSON.stringify({
            type: 'device_status', boot_id: 'boot-a', status_sequence: 500, uptime_ms: 900000
        })));
        svc.handleMessage('device/device-1/status', Buffer.from(JSON.stringify({
            type: 'device_status', boot_id: 'boot-b', status_sequence: 1, uptime_ms: 2000
        })));

        expect(status).toHaveBeenCalledTimes(2);
        expect(svc.deviceStatus.get('device-1').lastStatus).toMatchObject({
            boot_id: 'boot-b', status_sequence: 1, uptime_ms: 2000
        });
    });

    test('tracks fresh primary status separately from ordinary heartbeat traffic', () => {
        expect(svc.hasFreshStatusSnapshot('device-1')).toBe(false);

        svc.handleMessage(
            'device/device-1/status',
            Buffer.from(JSON.stringify({ type: 'device_status', mqtt_connected: true, mqtt_subscribed: true }))
        );

        const statusAt = svc.deviceStatus.get('device-1').lastStatusAt;
        expect(statusAt).toEqual(expect.any(String));
        expect(svc.hasFreshStatusSnapshot('device-1')).toBe(true);

        svc.handleMessage(
            'device/device-1/heartbeat',
            Buffer.from(JSON.stringify({ type: 'heartbeat' }))
        );
        expect(svc.deviceStatus.get('device-1').lastStatusAt).toBe(statusAt);

        svc.deviceStatus.get('device-1').lastStatusAt = new Date(Date.now() - 120001).toISOString();
        expect(svc.hasFreshStatusSnapshot('device-1')).toBe(false);
    });

    test('a durable status result from a previous boot cannot roll status back after reboot', () => {
        const status = jest.fn();
        svc.on('status', status);
        svc._persistTerminalActionResultAndAck = jest.fn().mockResolvedValue(null);
        svc._settlePersistentQueueFromResponse = jest.fn().mockResolvedValue(null);
        for (const [boot_id, status_sequence] of [['boot-a', 400], ['boot-b', 1]]) {
            svc.handleMessage('device/device-1/status', Buffer.from(JSON.stringify({
                type: 'device_status', boot_id, status_sequence
            })));
        }
        svc.handleMessage('device/device-1/action/result', Buffer.from(JSON.stringify({
            action_id: 'previous-boot-query', command: 'get_status', result: 'completed',
            payload: { boot_id: 'boot-a', status_sequence: 401 }
        })));
        expect(status).toHaveBeenCalledTimes(2);
        expect(svc.deviceStatus.get('device-1').lastStatus).toMatchObject({ boot_id: 'boot-b', status_sequence: 1 });
        expect(svc._persistTerminalActionResultAndAck).toHaveBeenCalledTimes(1);
    });

    test('status payload on a noncanonical topic retains its topic event', () => {
        const status = jest.fn();
        const telemetry = jest.fn();
        svc.on('status', status);
        svc.on('telemetry', telemetry);

        svc.handleMessage('device/device-1/telemetry', Buffer.from(JSON.stringify({ type: 'device_status' })));

        expect(status).toHaveBeenCalledTimes(1);
        expect(telemetry).toHaveBeenCalledTimes(1);
    });

    test('status payload on a scoped status topic keeps specific event without repeating generic status', () => {
        const status = jest.fn();
        const scopedStatus = jest.fn();
        svc.on('status', status);
        svc.on('modem:status', scopedStatus);

        svc.handleMessage('device/device-1/modem/status', Buffer.from(JSON.stringify({ type: 'device_status' })));

        expect(status).toHaveBeenCalledTimes(1);
        expect(scopedStatus).toHaveBeenCalledTimes(1);
    });

    test('publishCommand sends compact dashboard-built GSM PDU payloads to firmware', async () => {
        await svc.publishCommand(
            'device-1',
            'send-sms',
            { to: '+15551234567', message: 'hello from test' },
            false,
            5000,
            { skipPersistentQueue: true }
        );

        expect(svc.client.publish).toHaveBeenCalledTimes(1);
        expect(svc.client.publish.mock.calls[0][0]).toBe('device/device-1/command/send_sms');

        const payload = JSON.parse(svc.client.publish.mock.calls[0][1]);
        expect(payload).toMatchObject({ schema: 1, device_id: 'device-1', command: 'send_sms' });
        expect(payload.action_id).toMatch(/^sms_/);
        expect(payload.payload.sms_pdu).toMatch(/^00[0-9A-F]+$/);
        expect(payload.payload.number).toBeUndefined();
        expect(payload.payload.text).toBeUndefined();
        expect(payload.payload.sms_transport_encoding).toBeUndefined();
        expect(payload.payload.sms_parts).toBeUndefined();
        expect(payload.messageId).toBeUndefined();
    });

    test('publishCommand trims dashboard-built Unicode PDU SMS payloads for firmware', async () => {
        await svc.publishCommand(
            'device-1',
            'send-sms',
            { to: '+8801887300993', message: '\u09AC\u09BE\u0982\u09B2\u09BE 123' },
            false,
            45000,
            { skipPersistentQueue: true, messageId: 'send-sms_pdu_test' }
        );

        const payload = JSON.parse(svc.client.publish.mock.calls[0][1]);
        expect(payload).toEqual(expect.objectContaining({
            action_id: 'send-sms_pdu_test',
            payload: expect.objectContaining({ sms_pdu: '0021000D91881088370099F300081209AC09BE098209B209BE0020003100320033' })
        }));
        expect(JSON.stringify(payload.payload).length).toBeLessThanOrEqual(156);
        expect(payload.command).toBe('send_sms');
        expect(payload.payload.sms_pdu_length).toBeUndefined();
        expect(payload.payload.number).toBeUndefined();
        expect(payload.payload.text).toBeUndefined();
    });

    test('publishCommand honors the android-family plain-text SMS contract (SMS-01)', async () => {
        // smsQueue sets sms_plain_text for android-family devices; the MQTT
        // envelope must carry number/text (which the Android app parses)
        // instead of a dashboard-built PDU, and must keep doing so after a
        // durable-queue retry because the flag is part of the payload.
        await svc.publishCommand(
            'device-1',
            'send-sms',
            {
                to: '+8801700000001',
                message: 'hello android',
                smsId: 42,
                sim_slot: 0,
                timeout: 90000,
                sms_plain_text: true
            },
            false,
            90000,
            { skipPersistentQueue: true, messageId: 'send-sms_plain_text' }
        );

        const payload = JSON.parse(svc.client.publish.mock.calls[0][1]);
        expect(payload).toEqual({
            action_id: 'send-sms_plain_text',
            schema: 1,
            device_id: 'device-1',
            command: 'send_sms',
            number: '+8801700000001',
            text: 'hello android',
            timeout: 90000,
            sim_slot: 0
        });
        expect(payload.sms_pdu).toBeUndefined();
    });

    test('publishCommand uses queued dashboard PDU parts without regenerating from empty text', async () => {
        const queuedPdu = '0021000D91881055153254F6000005E8329BFD06';
        await svc.publishCommand(
            'device-1',
            'send-sms',
            {
                to: '+8801555123456',
                message: '',
                sms_pdu: queuedPdu,
                sms_pdu_encoding: 'gsm7'
            },
            false,
            45000,
            { skipPersistentQueue: true, messageId: 'send-sms_queued_pdu' }
        );

        const payload = JSON.parse(svc.client.publish.mock.calls[0][1]);
        expect(payload).toEqual(expect.objectContaining({
            action_id: 'send-sms_queued_pdu',
            payload: expect.objectContaining({ sms_pdu: queuedPdu })
        }));
    });

    test('publishCommand keeps SMS action IDs within the firmware correlation buffer', async () => {
        await svc.publishCommand(
            'device-1',
            'send-sms',
            { to: '+15551234567', message: 'short id test' },
            false,
            5000,
            {
                skipPersistentQueue: true,
                messageId: 'send-sms_REG0424104723_1777027643086'
            }
        );

        const payload = JSON.parse(svc.client.publish.mock.calls[0][1]);
        expect(payload.action_id.length).toBeLessThanOrEqual(31);
        expect(payload.action_id).toMatch(/^sms_[0-9a-f]{12}$/);
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
        expect(svc.client.publish.mock.calls[0][0]).toBe('device/device-1/command/send_sms_multipart');

        const payload = JSON.parse(svc.client.publish.mock.calls[0][1]);
        expect(payload.payload.number).toBe('+15551234567');
        expect(payload.payload.text).toBe('x'.repeat(200));
        expect(payload.command).toBe('send_sms_multipart');
        expect(payload.action_id).toMatch(/^sms_/);
        expect(payload.timeout).toBe(5000);
        expect(payload.payload.sms_transport_encoding).toBe('ira');
        expect(payload.payload.sms_parts).toBe(2);
        expect(payload.messageId).toBeUndefined();
    });

    test('publishCommand avoids generated Unicode multipart PDU bundles on the modem command path', async () => {
        await svc.publishCommand(
            'device-1',
            'send-sms-multipart',
            { to: '+8801887300993', message: '\u0985'.repeat(80) },
            false,
            60000,
            { skipPersistentQueue: true, messageId: 'send-sms_unicode_multi_pdu' }
        );

        const payload = JSON.parse(svc.client.publish.mock.calls[0][1]);
        expect(payload.command).toBe('send_sms_multipart');
        expect(payload.action_id).toBe('send-sms_unicode_multi_pdu');
        expect(payload.payload.sms_pdu).toBeUndefined();
        expect(payload.payload.number).toBe('+8801887300993');
        expect(payload.payload.text).toBe('\u0985'.repeat(80));
        expect(payload.payload.sms_transport_encoding).toBe('ucs2');
        expect(payload.payload.sms_parts).toBe(2);
        expect(payload.timeout).toBe(60000);
        expect(payload.sms_encoding).toBeUndefined();
        expect(payload.sms_multipart).toBeUndefined();
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
        expect(payload.payload.sim_slot).toBe(1);
        expect(payload.payload.simSlot).toBeUndefined();
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
        expect(payload.messageId).toBeUndefined();
        expect(payload.command).toBe('wifi_disconnect');
        expect(payload.schema).toBe(1);
        expect(payload.device_id).toBe('device-1');
    });

    test('publish-only command returns the exact bounded action ID sent on the wire', async () => {
        const published = await svc.publishCommand(
            'device-1', 'wifi-disconnect', {}, false, 5000,
            { skipPersistentQueue: true, messageId: 'bad/id' }
        );

        const [topic, body] = svc.client.publish.mock.calls.at(-1);
        const envelope = JSON.parse(body);
        expect(topic).toBe('device/device-1/command/wifi_disconnect');
        expect(envelope.action_id).toMatch(/^[A-Za-z0-9_.:-]{1,31}$/);
        expect(envelope.action_id).not.toBe('bad/id');
        expect(published).toEqual(expect.objectContaining({ topic, messageId: envelope.action_id }));
    });

    test('direct durable-queue dispatch returns the action ID instead of a publish receipt ID', async () => {
        const published = await svc._publishCommandNow(
            'device-1', 'get-status', {}, false, 5000,
            { messageId: 'durable-1' }
        );
        const [topic, body] = svc.client.publish.mock.calls.at(-1);
        expect(JSON.parse(body).action_id).toBe('durable-1');
        expect(published).toEqual(expect.objectContaining({ topic, messageId: 'durable-1' }));
    });

    test.each([0, -1, 1.5, 2147483648, 4294967296, 'not-a-timeout'])(
        'rejects invalid command timeout %s before publishing', async (timeout) => {
            await expect(svc.publishCommand(
                'device-1', 'wifi-disconnect', {}, false, timeout,
                { skipPersistentQueue: true }
            )).rejects.toMatchObject({ code: 'INVALID_COMMAND_TIMEOUT' });
            expect(svc.client.publish).not.toHaveBeenCalled();
        }
    );

    test('rejects an invalid queued payload timeout before publishing', async () => {
        await expect(svc._publishCommandNow(
            'device-1', 'get-status', { timeout: 1.5 }, false, 5000,
            { messageId: 'timeout-gate' }
        )).rejects.toMatchObject({ code: 'INVALID_COMMAND_TIMEOUT' });
        expect(svc.client.publish).not.toHaveBeenCalled();
    });

    test('rejects an invalid SMS payload timeout instead of silently replacing it', async () => {
        await expect(svc._publishCommandNow(
            'device-1', 'send-sms', { to: '+15551234567', message: 'test', timeout: -1 },
            false, 5000, { messageId: 'sms-timeout-gate' }
        )).rejects.toMatchObject({ code: 'INVALID_COMMAND_TIMEOUT' });
        expect(svc.client.publish).not.toHaveBeenCalled();
    });

    test.each(['direct', 'public'])(
        '%s command rejects a pending action ID collision without publishing or marking busy', async (path) => {
            const pending = { command: 'send-ussd', deviceId: 'device-1', resolve: jest.fn(), reject: jest.fn() };
            svc.pendingMessages.set('same-id', pending);
            const publish = path === 'direct'
                ? svc._publishCommandNow('device-1', 'send-ussd', { code: '*123#' }, true, 5000, { messageId: 'same-id' })
                : svc.publishCommand('device-1', 'send-ussd', { code: '*123#' }, true, 5000,
                    { skipPersistentQueue: true, skipQueue: true, messageId: 'same-id' });
            await expect(publish).rejects.toMatchObject({ code: 'DUPLICATE_ACTION_ID' });
            expect(svc.pendingMessages.get('same-id')).toBe(pending);
            expect(svc.isDeviceBusy('device-1')).toBe(false);
            expect(svc.client.publish).not.toHaveBeenCalled();
        }
    );

    test('pending-capacity rejection does not mark a device busy', async () => {
        for (let index = 0; index < 100; index += 1) {
            svc.pendingMessages.set(`pending-${index}`, { deviceId: 'other-device', reject: jest.fn() });
        }
        await expect(svc._publishCommandNow(
            'device-1', 'send-ussd', { code: '*123#' }, true, 5000,
            { messageId: 'capacity-test' }
        )).rejects.toThrow('Command queue full');
        expect(svc.isDeviceBusy('device-1')).toBe(false);
        expect(svc.client.publish).not.toHaveBeenCalled();
    });

    test.each(['direct', 'public'])(
        '%s late publish failure cannot delete a newer pending request with the same ID', async (path) => {
            let failOldPublish;
            svc.publish = jest.fn()
                .mockImplementationOnce(() => new Promise((_, reject) => { failOldPublish = reject; }))
                .mockResolvedValue({ topic: 'device/device-1/command/send_ussd' });
            const issue = () => path === 'direct'
                ? svc._publishCommandNow('device-1', 'send-ussd', { code: '*123#' }, true, 5000,
                    { messageId: 'reused-action-1' })
                : svc.publishCommand('device-1', 'send-ussd', { code: '*123#' }, true, 5000,
                    { skipPersistentQueue: true, skipQueue: true, messageId: 'reused-action-1' });

            const first = issue();
            expect(svc._resolvePendingMessage('device-1', {
                action_id: 'reused-action-1', command: 'send_ussd', result: 'completed'
            })).toBe(true);
            await expect(first).resolves.toMatchObject({ result: 'completed' });

            const second = issue();
            const newerPending = svc.pendingMessages.get('reused-action-1');
            expect(newerPending).toBeDefined();
            failOldPublish(new Error('late publish callback failure'));
            await new Promise(resolve => setImmediate(resolve));
            expect(svc.pendingMessages.get('reused-action-1')).toBe(newerPending);

            expect(svc._resolvePendingMessage('device-1', {
                action_id: 'reused-action-1', command: 'send_ussd', result: 'completed'
            })).toBe(true);
            await expect(second).resolves.toMatchObject({ result: 'completed' });
        }
    );

    test.each([
        ['direct', false], ['direct', true], ['public', false], ['public', true]
    ])('%s publish failure with wait=%s clears only its own busy mark', async (path, waitForResponse) => {
        svc.publish = jest.fn().mockRejectedValue(new Error('broker rejected publish'));
        const issue = () => path === 'direct'
            ? svc._publishCommandNow('device-1', 'send-ussd', { code: '*123#' },
                waitForResponse, 5000, { messageId: 'publish-failure-1' })
            : svc.publishCommand('device-1', 'send-ussd', { code: '*123#' },
                waitForResponse, 5000,
                { skipPersistentQueue: true, skipQueue: true, messageId: 'publish-failure-1' });

        await expect(issue()).rejects.toThrow('broker rejected publish');
        expect(svc.isDeviceBusy('device-1')).toBe(false);
        expect(svc.pendingMessages.has('publish-failure-1')).toBe(false);

        const priorUntil = Date.now() + 10_000;
        svc.deviceBusyUntil.set('device-1', priorUntil);
        await expect(issue()).rejects.toThrow('broker rejected publish');
        expect(svc.deviceBusyUntil.get('device-1')).toBe(priorUntil);
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

    test('action/result emits storage:info with 64-bit SD fields', async () => {
        const handler = jest.fn();
        svc.on('storage:info', handler);
        svc.handleMessage(
            'device/device-1/action/result',
            Buffer.from(JSON.stringify({
                action_id: 'storage-info-1',
                command: 'storage_info',
                result: 'completed',
                payload: {
                    media_available: true,
                    total_bytes: 62519640064,
                    used_bytes: 458752,
                    free_bytes: 62519181312,
                    sd_detected: true,
                    sd_capacity_bytes: 62519640064
                }
            }))
        );
        expect(handler).toHaveBeenCalledWith('device-1', expect.objectContaining({
            success: true,
            total_bytes: 62519640064,
            sd_detected: true
        }));
    });

    test('accepted action/result does not settle a pending command', async () => {
        const resolve = jest.fn();
        const timeout = setTimeout(() => {}, 1000);
        timeout.unref?.();
        svc.pendingMessages.set('action-accepted-1', {
            command: 'gpio-write', deviceId: 'device-1', payload: {},
            timestamp: Date.now(), resolve, reject: jest.fn(), timeout
        });

        svc.handleMessage(
            'device/device-1/action/result',
            Buffer.from(JSON.stringify({ action_id: 'action-accepted-1', command: 'gpio_write', result: 'accepted' }))
        );

        await new Promise(resolveTick => setImmediate(resolveTick));
        expect(resolve).not.toHaveBeenCalled();
        expect(svc.pendingMessages.has('action-accepted-1')).toBe(true);
        svc.handleMessage(
            'device/device-1/action/result',
            Buffer.from(JSON.stringify({ action_id: 'action-accepted-1', command: 'gpio_write', result: 'completed' }))
        );
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(svc.pendingMessages.has('action-accepted-1')).toBe(false);
    });

    test('accepted action result stays pending and does not emit a storage completion', () => {
        const actionHandler = jest.fn();
        const storageHandler = jest.fn();
        svc.on('action:result', actionHandler);
        svc.on('storage:list', storageHandler);

        svc.handleMessage('device/device-1/action/result', Buffer.from(JSON.stringify({
            action_id: 'file-list-pending-1', command: 'file_list', result: 'accepted',
            success: true, error: 'stale envelope error'
        })));
        const accepted = actionHandler.mock.calls.at(-1)?.[1];
        expect(accepted).toEqual(expect.objectContaining({ result: 'accepted', terminal: false }));
        expect(accepted).not.toHaveProperty('success');
        expect(accepted).not.toHaveProperty('error');
        expect(storageHandler).not.toHaveBeenCalled();

        svc.handleMessage('device/device-1/action/result', Buffer.from(JSON.stringify({
            action_id: 'file-list-pending-1', command: 'file_list', result: 'completed',
            payload: { entries: [], count: 0 }
        })));
        expect(storageHandler).toHaveBeenCalledTimes(1);
        expect(storageHandler).toHaveBeenCalledWith('device-1', expect.objectContaining({
            success: true, count: 0
        }));
    });

    test('only a matching terminal action/result settles a pending command', () => {
        const resolve = jest.fn();
        const timeout = setTimeout(() => {}, 1000);
        timeout.unref?.();
        svc.pendingMessages.set('terminal-only-1', {
            command: 'get-status', deviceId: 'device-1', payload: {},
            timestamp: Date.now(), resolve, reject: jest.fn(), timeout
        });

        svc.handleMessage('device/device-1/status', Buffer.from(JSON.stringify({
            type: 'device_status', action_id: 'terminal-only-1',
            command: 'get_status', result: 'completed'
        })));
        svc.handleMessage('device/device-1/action/result', Buffer.from(JSON.stringify({
            action_id: 'terminal-only-1', command: 'get_status', result: 'success'
        })));
        svc.handleMessage('device/device-1/action/result', Buffer.from(JSON.stringify({
            action_id: 'terminal-only-1', result: 'completed'
        })));
        expect(resolve).not.toHaveBeenCalled();
        expect(svc.pendingMessages.has('terminal-only-1')).toBe(true);

        svc.handleMessage('device/device-1/action/result', Buffer.from(JSON.stringify({
            action_id: 'terminal-only-1', command: 'get_status', result: 'completed'
        })));
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(svc.pendingMessages.has('terminal-only-1')).toBe(false);
    });

    test('same action ID from another device or command cannot settle a pending command', async () => {
        const resolve = jest.fn();
        const timeout = setTimeout(() => {}, 1000);
        timeout.unref?.();
        svc.pendingMessages.set('shared-action', {
            command: 'get-status', deviceId: 'device-1', payload: {},
            timestamp: Date.now(), resolve, reject: jest.fn(), timeout
        });

        svc.handleMessage('device/device-2/action/result', Buffer.from(JSON.stringify({
            action_id: 'shared-action', command: 'get_status', result: 'completed'
        })));
        svc.handleMessage('device/device-1/action/result', Buffer.from(JSON.stringify({
            action_id: 'shared-action', command: 'send_sms', result: 'completed'
        })));
        expect(resolve).not.toHaveBeenCalled();
        expect(svc.pendingMessages.has('shared-action')).toBe(true);

        svc.handleMessage('device/device-1/action/result', Buffer.from(JSON.stringify({
            action_id: 'shared-action', command: 'get_status', result: 'completed'
        })));
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(svc.pendingMessages.has('shared-action')).toBe(false);
    });

    test.each([
        ['send_sms', 'completed', 0],
        ['none', 'rejected', 262]
    ])('persists %s/%s before publishing its exact firmware database acknowledgement', async (command, result, resultCode) => {
        let stored = null;
        const operations = [];
        global.app.locals.db = {
            run: jest.fn(async (sql, args = []) => {
                operations.push(String(sql).includes('INSERT OR IGNORE') ? 'insert' : 'update');
                if (String(sql).includes('INSERT OR IGNORE')) {
                    stored = {
                        device_id: args[0], action_id: args[1], command: args[2],
                        canonical_payload: args[6]
                    };
                    return { changes: 1 };
                }
                return { changes: 1 };
            }),
            get: jest.fn(async () => stored),
            all: jest.fn().mockResolvedValue([])
        };
        svc.publish = jest.fn(async () => {
            operations.push('publish');
            return { topic: 'ack' };
        });

        const acknowledged = await svc._persistTerminalActionResultAndAck('device-1', {
            schema_version: 1,
            device_id: 'device-1',
            action_id: 'durable-action-1',
            command,
            result,
            result_code: resultCode,
            detail: result === 'completed' ? 'sms_send_completed' : 'unsupported_command',
            created_ms: 10,
            timeout_ms: 60000,
            payload: result === 'completed' ? { sms_id: 9 } : null
        });

        expect(acknowledged).toBe(true);
        expect(operations).toEqual(['insert', 'publish', 'update']);
        expect(svc.publish).toHaveBeenCalledWith(
            'device/device-1/command/action-result-ack',
            {
                schema_version: 1,
                device_id: 'device-1',
                action_id: 'durable-action-1',
                command
            },
            { qos: 1, retain: false }
        );
    });

    test('does not ACK an unsupported-command rejection when durable persistence fails', async () => {
        global.app.locals.db = {
            run: jest.fn().mockRejectedValue(new Error('SQLITE_FULL')),
            get: jest.fn(),
            all: jest.fn().mockResolvedValue([])
        };
        svc.publish = jest.fn();
        await expect(svc._persistTerminalActionResultAndAck('device-1', {
            schema_version: 1, device_id: 'device-1', action_id: 'rejected-full',
            command: 'none', result: 'rejected', result_code: 262
        })).rejects.toThrow('SQLITE_FULL');
        expect(svc.publish).not.toHaveBeenCalled();
    });

    test('does not acknowledge a terminal replay with a different outcome', async () => {
        global.app.locals.db = {
            run: jest.fn().mockResolvedValue({ changes: 0 }),
            get: jest.fn().mockResolvedValue({
                device_id: 'device-1', action_id: 'durable-conflict', command: 'send_sms',
                canonical_payload: '{"different":true}'
            }),
            all: jest.fn().mockResolvedValue([])
        };
        svc.publish = jest.fn();

        const acknowledged = await svc._persistTerminalActionResultAndAck('device-1', {
            schema_version: 1, device_id: 'device-1', action_id: 'durable-conflict',
            command: 'send_sms', result: 'failed', result_code: -1
        });

        expect(acknowledged).toBe(false);
        expect(svc.publish).not.toHaveBeenCalled();
        expect(global.app.locals.db.run).toHaveBeenCalledWith(
            expect.stringContaining('conflict_count = conflict_count + 1'),
            ['device-1', 'durable-conflict', 'send_sms']
        );
    });

    test('acknowledges equivalent terminal replays with changed runtime metadata', async () => {
        const previous = {
            schema_version: 1, device_id: 'device-1', action_id: 'durable-replay-meta',
            command: 'send_sms', result: 'completed', result_code: 0, created_ms: 10
        };
        global.app.locals.db = {
            run: jest.fn().mockResolvedValue({ changes: 0 }),
            get: jest.fn().mockResolvedValue({
                device_id: 'device-1', action_id: 'durable-replay-meta', command: 'send_sms',
                canonical_payload: JSON.stringify(previous)
            }),
            all: jest.fn().mockResolvedValue([])
        };
        svc.publish = jest.fn().mockResolvedValue({ topic: 'ack' });

        const acknowledged = await svc._persistTerminalActionResultAndAck('device-1', {
            ...previous, created_ms: 11, detail: 'replayed-with-new-runtime-metadata'
        });

        expect(acknowledged).toBe(true);
        expect(svc.publish).toHaveBeenCalledWith(
            'device/device-1/command/action-result-ack',
            expect.objectContaining({ action_id: 'durable-replay-meta', command: 'send_sms' }),
            { qos: 1, retain: false }
        );
    });

    test('re-acknowledges an exact terminal replay without emitting it twice', async () => {
        const actionHandler = jest.fn();
        svc.on('action:result', actionHandler);
        svc._persistTerminalActionResultAndAck = jest.fn().mockResolvedValue(true);
        const message = Buffer.from(JSON.stringify({
            schema_version: 1,
            device_id: 'device-1',
            action_id: 'durable-replay',
            command: 'send_sms',
            result: 'completed',
            result_code: 0
        }));

        svc.handleMessage('device/device-1/action/result', message);
        await new Promise(resolveTick => setImmediate(resolveTick));
        const firstEmissionCount = actionHandler.mock.calls.length;
        svc.handleMessage('device/device-1/action/result', message);
        await new Promise(resolveTick => setImmediate(resolveTick));

        expect(svc._persistTerminalActionResultAndAck).toHaveBeenCalledTimes(2);
        expect(firstEmissionCount).toBe(1);
        expect(actionHandler).toHaveBeenCalledTimes(firstEmissionCount);
    });

    test('drops an action result whose envelope device differs from its topic', () => {
        const resolve = jest.fn();
        const timeout = setTimeout(() => {}, 1000);
        timeout.unref?.();
        svc.pendingMessages.set('wrong-envelope', {
            command: 'get-status', deviceId: 'device-1', payload: {},
            timestamp: Date.now(), resolve, reject: jest.fn(), timeout
        });
        svc.handleMessage('device/device-1/action/result', Buffer.from(JSON.stringify({
            schema_version: 1, device_id: 'device-2', action_id: 'wrong-envelope',
            command: 'get_status', result: 'completed'
        })));
        expect(resolve).not.toHaveBeenCalled();
        expect(svc.pendingMessages.has('wrong-envelope')).toBe(true);
        clearTimeout(timeout);
        svc.pendingMessages.delete('wrong-envelope');
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

    test('get-status always publishes a real native command', async () => {
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
                source: 'status-test'
            }
        );

        expect(svc.client.publish).toHaveBeenCalledTimes(1);
        expect(svc.client.publish.mock.calls[0][0]).toBe('device/device-1/command/get_status');
        expect(JSON.parse(svc.client.publish.mock.calls[0][1])).toEqual(expect.objectContaining({
            action_id: 'status-live-1',
            command: 'get_status',
            schema: 1,
            device_id: 'device-1',
            timeout: 5000,
            payload: {}
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

        expect(result.topic).toBe('device/device-1/command/wifi_reconnect');
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
            failedHistory: 1,
            ambiguous: 1,
            totalOpen: 4
        }));
        expect(state.domains).toEqual(expect.objectContaining({
            telephony: expect.objectContaining({ pending: 2, totalOpen: 2 }),
            status: expect.objectContaining({ active: 1, totalOpen: 1 }),
            storage: expect.objectContaining({ failed: 1, failedHistory: 1, totalOpen: 0 }),
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

    test('startup recovery syncs interrupted SMS queue state back to SMS rows', async () => {
        const interruptedRow = {
            id: 'q-sms-1',
            device_id: 'device-1',
            command: 'send-sms',
            message_id: 'send-sms_recover_1',
            status: 'waiting_response',
            last_error: null,
            payload: JSON.stringify({ smsId: 55, to: '+8801555123456' })
        };
        const ambiguousRow = {
            ...interruptedRow,
            status: 'ambiguous',
            last_error: 'dashboard restarted during non-replay-safe command'
        };
        global.app.locals.db = {
            all: jest.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([interruptedRow])
                .mockResolvedValueOnce([ambiguousRow])
                .mockResolvedValueOnce([{
                    id: 56,
                    device_id: 'device-1',
                    external_id: 'send-sms_orphan_1'
                }]),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };
        svc._emitDeviceQueueState = jest.fn().mockResolvedValue();

        await svc._recoverPersistentQueue();

        expect(global.app.locals.db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms'),
            ['ambiguous', 'dashboard restarted during non-replay-safe command', 'send-sms_recover_1', 55, 'device-1']
        );
        expect(global.app.locals.db.run).toHaveBeenCalledWith(
            expect.stringContaining('SMS command status was not confirmed before queue tracking ended'),
            [56]
        );
        expect(svc._emitDeviceQueueState).toHaveBeenCalledWith('device-1');
    });

    test('startup recovery corrects completed queue rows that contain failed device responses', async () => {
        const failedCompletedRow = {
            id: 'q-ota-1',
            device_id: 'device-1',
            command: 'ota-update',
            message_id: 'ota_update_1',
            status: 'completed',
            completed_at: '2026-05-08 08:28:10',
            response_payload: JSON.stringify({
                success: false,
                result: 'failed',
                detail: 'ota_update_failed'
            })
        };
        global.app.locals.db = {
            all: jest.fn()
                .mockResolvedValueOnce([failedCompletedRow])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };
        svc._emitDeviceQueueState = jest.fn().mockResolvedValue();

        await svc._recoverPersistentQueue();

        expect(global.app.locals.db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE device_command_queue'),
            expect.arrayContaining(['failed', 'ota_update_failed', 'q-ota-1'])
        );
        expect(svc._emitDeviceQueueState).toHaveBeenCalledWith('device-1');
    });

    test('persistent queue row updates use raw sqlite handle when async run wrapper is missing', async () => {
        const rawRun = jest.fn().mockReturnValue({ changes: 1, lastInsertRowid: 0 });
        const prepare = jest.fn().mockReturnValue({ run: rawRun });
        global.app.locals.db = {
            all: jest.fn().mockResolvedValue([]),
            _raw: { prepare }
        };

        await svc._updatePersistentQueueRow('queue-raw-1', {
            status: 'ambiguous',
            last_error: 'Command timeout after 30000ms',
            completed_at: '2026-04-24 09:00:00'
        });

        expect(prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE device_command_queue'));
        expect(rawRun).toHaveBeenCalledWith(
            'ambiguous',
            'Command timeout after 30000ms',
            '2026-04-24 09:00:00',
            'queue-raw-1'
        );
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
        svc.subscriptionsReady = true;
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

    test('opening cellular bearer preserves Wi-Fi as the active primary path', () => {
        const statusHandler = jest.fn();
        svc.on('status', statusHandler);
        svc.deviceStatus.set('device-1', {
            lastSeen: new Date().toISOString(),
            online: true,
            lastStatus: {
                type: 'device_status',
                active_path: 'wifi',
                wifi_connected: true,
                wifi_ip_assigned: true,
                wifi_ip_address: '192.168.0.109'
            }
        });

        svc.handleMessage(
            'device/device-1/action/result',
            Buffer.from(JSON.stringify({
                action_id: 'mobile-toggle-fw-1',
                command: 'mobile_toggle',
                result: 'completed',
                payload: {
                    enabled: true,
                    connected: true,
                    ip_address: '100.65.171.203'
                }
            }))
        );

        expect(statusHandler).toHaveBeenCalledWith(
            'device-1',
            expect.objectContaining({
                active_path: 'wifi',
                wifi_connected: true,
                modem_ip_bearer_ready: true,
                modem_data_ip: '100.65.171.203'
            })
        );
    });

    test('does not publish a durable command when database tracking is unavailable', async () => {
        svc._publishCommandNow = jest.fn();
        await expect(svc.enqueuePersistentDeviceCommand('device-1', 'send-sms', {
            to: '+8801000000000', message: 'hello'
        })).rejects.toMatchObject({ code: 'DURABLE_QUEUE_UNAVAILABLE' });
        expect(svc._publishCommandNow).not.toHaveBeenCalled();
        expect(svc.client.publish).not.toHaveBeenCalled();
    });

    test('rejects malformed durable timeout metadata before inserting a queue row', async () => {
        global.app.locals.db = { run: jest.fn() };
        await expect(svc.enqueuePersistentDeviceCommand(
            'device-1', 'send-sms', { to: '+15551234567', message: 'test', timeout: 1.5 }
        )).rejects.toMatchObject({ code: 'INVALID_COMMAND_TIMEOUT' });
        expect(global.app.locals.db.run).not.toHaveBeenCalled();
        expect(svc.client.publish).not.toHaveBeenCalled();
    });

    test('maps SQLite admission rejection to a stable durable queue capacity error', async () => {
        const dbError = new Error('device command queue capacity reached');
        global.app.locals.db = { run: jest.fn().mockRejectedValue(dbError) };
        await expect(svc.enqueuePersistentDeviceCommand('device-1', 'send-sms', {
            to: '+8801000000000', message: 'hello'
        })).rejects.toMatchObject({ code: 'DURABLE_QUEUE_FULL' });
        expect(svc.client.publish).not.toHaveBeenCalled();
    });

    test('expires pending commands before execution and settles their durable waiter', async () => {
        const expired = {
            id: 'expired-queue-1', device_id: 'device-1', command: 'send-sms',
            message_id: 'expired-message-1', status: 'pending',
            payload: JSON.stringify({ smsId: 91, sms_base_message_id: 'expired-message-1' })
        };
        global.app.locals.db = {
            all: jest.fn().mockResolvedValue([expired]),
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue({ ...expired, status: 'failed',
                last_error: 'Command expired before device execution' })
        };
        svc._syncSmsStatusFromQueueRow = jest.fn().mockResolvedValue();
        svc._resolvePersistentQueueWaiter = jest.fn().mockResolvedValue();
        svc._emitDeviceQueueState = jest.fn().mockResolvedValue();

        await svc._expirePersistentQueueRows();

        expect(global.app.locals.db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE device_command_queue'),
            expect.arrayContaining(['failed', 'Command expired before device execution', 'expired-queue-1'])
        );
        expect(svc._resolvePersistentQueueWaiter).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'expired-queue-1', status: 'failed' })
        );
        expect(svc._emitDeviceQueueState).toHaveBeenCalledWith('device-1');
    });

    test('durable ESP32 send-sms pre-dispatches and waits for the later firmware action result', async () => {
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
            topic: 'device/device-1/command/send_sms',
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
                next_attempt_at: expect.any(String)
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
            false,
            60000,
            expect.objectContaining({
                messageId: 'send-sms_test',
                source: 'dashboard-sms'
            })
        );
        expect(svc._markPersistentQueueCompleted).not.toHaveBeenCalled();
        expect(svc._markPersistentQueueRetry).not.toHaveBeenCalled();
    });

    test('durable Android send-sms keeps the synchronous bridge path', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue({ type: 'android-sms-bridge' }),
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
            topic: 'device/android-1/command/send_sms',
            messageId: 'send-sms_android'
        });

        svc._processPersistentQueueRow({
            id: 'queue-android',
            device_id: 'android-1',
            command: 'send-sms',
            payload: JSON.stringify({ to: '+8801628301525', message: 'hello', smsId: 42 }),
            message_id: 'send-sms_android',
            requires_response: 1,
            attempt_count: 0,
            timeout_ms: 60000,
            source: 'dashboard-sms'
        });

        await new Promise(resolve => setImmediate(resolve));

        expect(svc._updatePersistentQueueRow).toHaveBeenCalledWith(
            'queue-android',
            expect.objectContaining({
                status: 'waiting_response',
                next_attempt_at: null
            })
        );
        expect(svc._publishCommandNow).toHaveBeenCalledWith(
            'android-1',
            'send-sms',
            expect.objectContaining({
                to: '+8801628301525',
                message: 'hello',
                smsId: 42
            }),
            true,
            60000,
            expect.objectContaining({
                messageId: 'send-sms_android',
                source: 'dashboard-sms'
            })
        );
        expect(svc._markPersistentQueueCompleted).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'queue-android',
                command: 'send-sms',
                message_id: 'send-sms_android'
            }),
            expect.objectContaining({
                topic: 'device/android-1/command/send_sms',
                messageId: 'send-sms_android'
            })
        );
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
            topic: 'device/device-1/command/send_sms',
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
            topic: 'device/device-1/command/send_sms',
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
            false,
            60000,
            expect.objectContaining({
                messageId: 'send-sms_fresh_live_status'
            })
        );
    });

    test('send-sms publish keeps compact PDU payload free of text-mode timeout fields', async () => {
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
            payload: expect.objectContaining({ sms_pdu: expect.stringMatching(/^00[0-9A-F]+$/) })
        }));
        expect(published.command).toBe('send_sms');
        expect(published.payload.number).toBeUndefined();
        expect(published.payload.text).toBeUndefined();
        expect(published.timeout).toBe(60000);
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

    test('success true without a terminal result does not settle the durable queue', async () => {
        global.app.locals.db = {
            get: jest.fn().mockResolvedValue({
                id: 'queue-unresolved', device_id: 'device-1', command: 'send-sms',
                message_id: 'send-sms_unresolved', status: 'waiting_response', payload: '{}'
            })
        };
        svc._markPersistentQueueCompleted = jest.fn().mockResolvedValue();
        svc._updatePersistentQueueRow = jest.fn().mockResolvedValue();

        const settled = await svc._settlePersistentQueueFromResponse('device-1', {
            action_id: 'send-sms_unresolved', command: 'send_sms', success: true
        });

        expect(settled).toBe(false);
        expect(svc._markPersistentQueueCompleted).not.toHaveBeenCalled();
        expect(svc._updatePersistentQueueRow).not.toHaveBeenCalled();
    });

    test.each([
        ['completed overrides success false', { result: 'completed', success: false }, true],
        ['failed overrides success true', { result: 'failed', success: true }, false]
    ])('%s when settling the durable queue', async (_label, response, completes) => {
        global.app.locals.db = {
            get: jest.fn().mockResolvedValue({
                id: 'queue-conflict', device_id: 'device-1', command: 'send-sms',
                message_id: 'send-sms_conflict', status: 'waiting_response', payload: '{}'
            })
        };
        svc._markPersistentQueueCompleted = jest.fn().mockResolvedValue();
        svc._updatePersistentQueueRow = jest.fn().mockResolvedValue();

        const settled = await svc._settlePersistentQueueFromResponse('device-1', {
            action_id: 'send-sms_conflict', command: 'send_sms', ...response
        });

        expect(settled).toBe(true);
        if (completes) {
            expect(svc._markPersistentQueueCompleted).toHaveBeenCalled();
            expect(svc._updatePersistentQueueRow).not.toHaveBeenCalled();
        } else {
            expect(svc._markPersistentQueueCompleted).not.toHaveBeenCalled();
            expect(svc._updatePersistentQueueRow).toHaveBeenCalledWith(
                'queue-conflict', expect.objectContaining({ status: 'failed' })
            );
        }
    });

    test('multipart SMS queue parts keep the logical SMS sending until every part completes', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            all: jest.fn().mockResolvedValue([
                { message_id: 'sms_multi_p1', status: 'completed', payload: JSON.stringify({ smsId: 88, sms_base_message_id: 'sms_multi', sms_part_index: 1, sms_part_count: 2 }) },
                { message_id: 'sms_multi_p2', status: 'waiting_response', payload: JSON.stringify({ smsId: 88, sms_base_message_id: 'sms_multi', sms_part_index: 2, sms_part_count: 2 }) }
            ])
        };
        global.app.locals.db = db;

        await svc._syncSmsStatusFromQueueRow({
            id: 'queue-part-1',
            device_id: 'device-1',
            command: 'send-sms',
            status: 'completed',
            message_id: 'sms_multi_p1',
            payload: JSON.stringify({
                smsId: 88,
                sms_base_message_id: 'sms_multi',
                sms_part_index: 1,
                sms_part_count: 2
            })
        }, 'sent', null);

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms'),
            ['sending', null, 'sms_multi', 88, 'device-1']
        );
    });

    test('multipart SMS queue parts mark the logical SMS sent after all parts complete', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            all: jest.fn().mockResolvedValue([
                { message_id: 'sms_multi_p1', status: 'completed', payload: JSON.stringify({ smsId: 88, sms_base_message_id: 'sms_multi', sms_part_index: 1, sms_part_count: 2 }) },
                { message_id: 'sms_multi_p2', status: 'completed', payload: JSON.stringify({ smsId: 88, sms_base_message_id: 'sms_multi', sms_part_index: 2, sms_part_count: 2 }) }
            ])
        };
        global.app.locals.db = db;

        await svc._syncSmsStatusFromQueueRow({
            id: 'queue-part-2',
            device_id: 'device-1',
            command: 'send-sms',
            status: 'completed',
            message_id: 'sms_multi_p2',
            payload: JSON.stringify({
                smsId: 88,
                sms_base_message_id: 'sms_multi',
                sms_part_index: 2,
                sms_part_count: 2
            })
        }, 'sent', null);

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms'),
            ['sent', null, 'sms_multi', 88, 'device-1']
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

    test('action/result stores modem message reference parsed from firmware detail', async () => {
        global.app.locals.db = {
            get: jest.fn().mockResolvedValue({
                id: 'queue-mr',
                device_id: 'device-1',
                command: 'send-sms',
                message_id: 'send-sms_mr',
                status: 'waiting_response',
                payload: JSON.stringify({ to: '+8801628301525', smsId: 69 })
            }),
            all: jest.fn().mockResolvedValue([])
        };

        svc._markPersistentQueueCompleted = jest.fn().mockResolvedValue();

        svc.handleMessage(
            'device/device-1/action/result',
            Buffer.from(JSON.stringify({
                action_id: 'send-sms_mr',
                command: 'send_sms',
                result: 'completed',
                detail: 'sms_sent_mr_132',
                success: true
            }))
        );

        await new Promise(resolve => setImmediate(resolve));

        expect(svc._markPersistentQueueCompleted).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'queue-mr'
            }),
            expect.objectContaining({
                action_id: 'send-sms_mr',
                message_reference: 132
            })
        );
    });

    test('sms/delivery can match a completed queue row by modem message reference', async () => {
        global.app.locals.db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([{
                id: 'queue-mr-delivery',
                device_id: 'device-1',
                command: 'send-sms',
                message_id: 'send-sms_mr_delivery',
                status: 'completed',
                response_payload: JSON.stringify({
                    action_id: 'send-sms_mr_delivery',
                    message_reference: 132
                }),
                payload: JSON.stringify({ to: '+8801628301525', smsId: 69 })
            }])
        };

        svc._markPersistentQueueCompleted = jest.fn().mockResolvedValue();

        svc.handleMessage(
            'device/device-1/sms/delivery',
            Buffer.from(JSON.stringify({
                status_report_status: 0,
                message_reference: 132,
                raw_report: '+CDS: 49,132,"+8801628301525",145,"26/04/24,12:00:00+24","26/04/24,12:00:03+24",0'
            }))
        );

        await new Promise(resolve => setImmediate(resolve));

        expect(svc._markPersistentQueueCompleted).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'queue-mr-delivery',
                status: 'completed'
            }),
            expect.objectContaining({
                success: true,
                message_reference: 132,
                detail: 'sms_delivered'
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
        svc._expirePersistentQueueRows = jest.fn().mockResolvedValue();
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

    test('durable SMS queue leaves the next SMS pending while one send is still waiting for result', async () => {
        const pendingRow = {
            id: 'queue-next-sms',
            device_id: 'device-1',
            command: 'send-sms',
            status: 'pending',
            message_id: 'send-sms_next',
            payload: JSON.stringify({ to: '+8801628301525', message: 'next', smsId: 71 })
        };
        const activeRow = {
            id: 'queue-active-sms',
            device_id: 'device-1',
            command: 'send-sms',
            status: 'waiting_response',
            message_id: 'send-sms_active',
            payload: JSON.stringify({ to: '+8801628301525', message: 'active', smsId: 70 })
        };
        global.app.locals.db = {
            all: jest.fn()
                .mockResolvedValueOnce([pendingRow])
                .mockResolvedValueOnce([activeRow])
                .mockResolvedValueOnce([]),
            get: jest.fn().mockResolvedValue(null)
        };

        svc._recoverPersistentQueue = jest.fn().mockResolvedValue();
        svc._expirePersistentQueueRows = jest.fn().mockResolvedValue();
        svc._processPersistentQueueRow = jest.fn();
        svc._markPersistentQueueRetry = jest.fn().mockResolvedValue();
        svc._markPersistentQueueAmbiguous = jest.fn().mockResolvedValue();

        await svc.processPersistentQueue();

        expect(svc._processPersistentQueueRow).not.toHaveBeenCalled();
        expect(global.app.locals.db.all).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining("status IN ('dispatching', 'waiting_response')"),
            ['device-1']
        );
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
        svc._expirePersistentQueueRows = jest.fn().mockResolvedValue();
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
            run: jest.fn().mockResolvedValue({ changes: 1 }),
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
            run: jest.fn().mockResolvedValue({ changes: 1 }),
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

    test('failed sms/delivery report fails the waiting queue row immediately', async () => {
        global.app.locals.db = {
            get: jest.fn().mockResolvedValue({
                id: 'queue-5',
                device_id: 'device-1',
                command: 'send-sms',
                message_id: 'send-sms_delivery_failed',
                status: 'failed'
            }),
            all: jest.fn().mockResolvedValue([{
                id: 'queue-5',
                device_id: 'device-1',
                command: 'send-sms',
                message_id: 'send-sms_delivery_failed',
                status: 'waiting_response',
                response_payload: JSON.stringify({ message_reference: 46 }),
                payload: JSON.stringify({ to: '+8801628301525', smsId: 43 })
            }]),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        svc._resolvePersistentQueueWaiter = jest.fn().mockResolvedValue();
        svc._emitDeviceQueueState = jest.fn().mockResolvedValue();

        svc.handleMessage(
            'device/device-1/sms/delivery',
            Buffer.from(JSON.stringify({
                to: '+8801628301525',
                delivered: false,
                status: 'failed',
                detail: 'sms_delivery_failed',
                message_reference: 46
            }))
        );

        await new Promise(resolve => setImmediate(resolve));

        expect(global.app.locals.db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE device_command_queue'),
            expect.arrayContaining(['failed', expect.stringContaining('"message_reference":46'), expect.any(String), 'sms_delivery_failed'])
        );
        expect(global.app.locals.db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms'),
            ['failed', 'sms_delivery_failed', 'send-sms_delivery_failed', 43, 'device-1']
        );
        expect(svc._resolvePersistentQueueWaiter).toHaveBeenCalled();
        expect(svc._emitDeviceQueueState).toHaveBeenCalledWith('device-1');
    });

    test('raw sms/delivery status report settles delivered queue row in dashboard logic', async () => {
        global.app.locals.db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([{
                id: 'queue-6',
                device_id: 'device-1',
                command: 'send-sms',
                message_id: 'send-sms_delivery_raw',
                status: 'waiting_response',
                response_payload: JSON.stringify({ message_reference: 47 }),
                payload: JSON.stringify({ to: '+8801628301525', smsId: 44 })
            }])
        };

        svc._markPersistentQueueCompleted = jest.fn().mockResolvedValue();

        svc.handleMessage(
            'device/device-1/sms/delivery',
            Buffer.from(JSON.stringify({
                to: '+8801628301525',
                status_report_status: 0,
                message_reference: 47,
                raw_report: '+CDS: 49,47,"+8801628301525",145,"26/04/24,12:00:00+24","26/04/24,12:00:03+24",0'
            }))
        );

        await new Promise(resolve => setImmediate(resolve));

        expect(svc._markPersistentQueueCompleted).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'queue-6',
                message_id: 'send-sms_delivery_raw'
            }),
            expect.objectContaining({
                success: true,
                detail: 'sms_delivered',
                status_report_status: 0,
                message_reference: 47
            })
        );
    });

    test('queue sync does not downgrade already delivered SMS rows back to sent', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            all: jest.fn().mockResolvedValue([])
        };
        global.app.locals.db = db;

        await svc._syncSmsStatusFromQueueRow({
            id: 'queue-delivered',
            device_id: 'device-1',
            command: 'send-sms',
            status: 'completed',
            message_id: 'send-sms_delivered',
            payload: JSON.stringify({ smsId: 99 })
        }, 'sent', null);

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining("CASE WHEN status = 'delivered'"),
            ['sent', null, 'send-sms_delivered', 99, 'device-1']
        );
    });

    test('stale SMS cleanup treats multipart part queue rows as active work', async () => {
        const db = {
            all: jest.fn().mockResolvedValue([]),
            run: jest.fn().mockResolvedValue({ changes: 0 })
        };
        global.app.locals.db = db;

        await svc._markStaleSmsWithoutQueue(120000);

        expect(db.all).toHaveBeenCalledWith(
            expect.stringContaining("q.message_id LIKE s.external_id || '_p%'"),
            expect.any(Array)
        );
        expect(db.all).toHaveBeenCalledWith(
            expect.stringContaining("s.external_id LIKE 'sms_%'"),
            expect.any(Array)
        );
        expect(db.run).not.toHaveBeenCalled();
    });

    test('unknown delivery reference does not settle another send to the same number', async () => {
        const db = {
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([{
                id: 'other-send',
                payload: JSON.stringify({ to: '+15551234567' }),
                response_payload: JSON.stringify({ message_reference: 12 })
            }])
        };
        global.app.locals.db = db;
        const row = await svc._findPersistentSmsQueueRow('device-1', {
            to: '+15551234567', message_reference: 13, status_report_status: 0
        });
        expect(row).toBeNull();
        expect(db.all).toHaveBeenCalledTimes(1);
    });

    test('SMS delivery queue lookup normalizes recipient numbers before fallback matching', async () => {
        const originalPhoneCountryCode = process.env.PHONE_COUNTRY_CODE;
        const db = {
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([{
                id: 'queue-phone-normalized',
                device_id: 'device-1',
                command: 'send-sms',
                message_id: 'send-sms_phone',
                status: 'waiting_response',
                payload: JSON.stringify({ to: '+8801555123456', smsId: 45 })
            }])
        };
        global.app.locals.db = db;
        let row;
        try {
            process.env.PHONE_COUNTRY_CODE = '880';
            row = await svc._findPersistentSmsQueueRow('device-1', {
                to: '01555123456',
                status: 'delivered'
            });
        } finally {
            if (originalPhoneCountryCode === undefined) delete process.env.PHONE_COUNTRY_CODE;
            else process.env.PHONE_COUNTRY_CODE = originalPhoneCountryCode;
        }

        expect(row).toEqual(expect.objectContaining({
            id: 'queue-phone-normalized',
            message_id: 'send-sms_phone'
        }));
    });
});
