'use strict';

const EventEmitter = require('events');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../services/smsCache', () => ({
    get: jest.fn(),
    set: jest.fn(),
    increment: jest.fn()
}));

jest.mock('../services/notificationService', () => ({
    capture: jest.fn().mockResolvedValue(undefined),
    notifySms: jest.fn().mockResolvedValue(undefined),
    notifyMissedCall: jest.fn().mockResolvedValue(undefined),
    notifyLowBattery: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../services/pushNotificationService', () => ({
    notifyLinkedDevices: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../services/webcamCaptureService', () => ({
    saveCapture: jest.fn()
}));

jest.mock('../utils/moduleHealth', () => ({
    markModuleFailure: jest.fn(),
    markModuleSuccess: jest.fn(),
    upsertModuleHealth: jest.fn()
}));

describe('MQTTHandlers capability boundary', () => {
    test('forwards canonical action results without the removed command response event', async () => {
        const mqttService = new EventEmitter();
        const room = { emit: jest.fn() };
        const io = { to: jest.fn(() => room) };
        const db = {
            get: jest.fn().mockResolvedValue({ id: 'test-device-1' }),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };
        const MQTTHandlers = require('../services/mqttHandlers');
        const handlers = new MQTTHandlers(mqttService, io, { locals: { db } });
        handlers.setupActionResultHandlers();
        const legacy = jest.fn();
        mqttService.on('command:response', legacy);

        mqttService.emit('action:result', 'test-device-1', {
            device_id: 'test-device-1',
            action_id: 'native-result-1',
            command: 'get_status',
            result: 'completed',
            result_code: 0
        });
        await new Promise(resolve => setImmediate(resolve));

        expect(room.emit).toHaveBeenCalledWith('action:result', expect.objectContaining({
            deviceId: 'test-device-1', action_id: 'native-result-1'
        }));
        expect(legacy).not.toHaveBeenCalled();
    });

    test('module health changes only on terminal device outcomes', async () => {
        const moduleHealth = require('../utils/moduleHealth');
        moduleHealth.markModuleSuccess.mockResolvedValue(undefined);
        moduleHealth.markModuleFailure.mockResolvedValue(undefined);
        moduleHealth.markModuleSuccess.mockClear();
        moduleHealth.markModuleFailure.mockClear();
        const mqttService = new EventEmitter();
        const room = { emit: jest.fn() };
        const io = { to: jest.fn(() => room) };
        const db = { get: jest.fn().mockResolvedValue({ id: 'test-device-1' }) };
        const MQTTHandlers = require('../services/mqttHandlers');
        const handlers = new MQTTHandlers(mqttService, io, { locals: { db } });
        handlers.setupActionResultHandlers();

        mqttService.emit('action:result', 'test-device-1', {
            action_id: 'camera-1', command: 'camera_capture', result: 'accepted', success: true
        });
        expect(moduleHealth.markModuleSuccess).not.toHaveBeenCalled();
        expect(moduleHealth.markModuleFailure).not.toHaveBeenCalled();

        mqttService.emit('action:result', 'test-device-1', {
            action_id: 'camera-1', command: 'camera_capture', result: 'failed', success: true
        });
        expect(moduleHealth.markModuleFailure).toHaveBeenCalledWith(
            db, 'test-device-1', 'camera', 'Command failed', expect.objectContaining({ result: 'failed' })
        );
        mqttService.emit('action:result', 'test-device-1', {
            action_id: 'camera-2', command: 'camera_capture', result: 'completed', success: false
        });
        expect(moduleHealth.markModuleSuccess).toHaveBeenCalledWith(
            db, 'test-device-1', 'camera', 'Command completed', expect.objectContaining({ result: 'completed' })
        );
    });

    test('persists and emits only strict module flags, respecting explicit storage false', async () => {
        const mqttService = new EventEmitter();
        const room = { emit: jest.fn() };
        const io = { to: jest.fn(() => room) };
        const db = { get: jest.fn().mockResolvedValue({ id: 'test-device-1' }),
            run: jest.fn().mockResolvedValue({ changes: 1 }) };
        const { upsertModuleHealth } = require('../utils/moduleHealth');
        upsertModuleHealth.mockResolvedValue(undefined);
        const MQTTHandlers = require('../services/mqttHandlers');
        const handlers = new MQTTHandlers(mqttService, io, { locals: { db } });
        handlers.setupCapabilitiesHandlers();
        await mqttService.listeners('capabilities')[0]('test-device-1', {
            caps: { camera: { supported: false }, audio: 'false', gps: 1,
                wifi: true, storage: false, sd: true, mqtt_connected: true },
            board: 'esp32-s3', specs: { chip: 'esp32-s3' }
        });
        const [, params] = db.run.mock.calls.find(([sql]) => sql.includes('INSERT INTO device_profiles'));
        const stored = JSON.parse(params[2]);
        expect(stored).toEqual({ camera: false, audio: false, gps: false,
            wifi: true, storage: false, sd: true, board: 'esp32-s3',
            specs: { chip: 'esp32-s3' } });
        expect(params.slice(4, 9)).toEqual([0, 0, 1, 0, 0]);
        for (const moduleKey of ['storage', 'camera', 'audio', 'gps']) {
            expect(upsertModuleHealth).toHaveBeenCalledWith(db, expect.objectContaining({
                moduleKey, supported: false, state: 'unsupported'
            }));
        }
        expect(room.emit).toHaveBeenCalledWith('device:capabilities', expect.objectContaining({
            deviceId: 'test-device-1', caps: stored
        }));
    });
});

describe('MQTTHandlers USSD classification', () => {
    function buildSubject() {
        const mqttService = new EventEmitter();
        mqttService.clearDeviceStatus = jest.fn();
        mqttService.markDeviceBusy = jest.fn();
        mqttService.clearDeviceBusy = jest.fn();
        mqttService.publishCommand = jest.fn().mockResolvedValue({
            queued: true,
            queueId: 'history-ack-1'
        });

        const room = { emit: jest.fn() };
        const io = {
            to: jest.fn(() => room),
            emit: jest.fn()
        };

        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn(),
            all: jest.fn().mockResolvedValue([])
        };

        const app = { locals: { db } };
        global.modemService = {
            updateDeviceStatus: jest.fn()
        };
        const MQTTHandlers = require('../services/mqttHandlers');
        const handlers = new MQTTHandlers(mqttService, io, app);
        handlers.setupUSSDHandlers();

        return { mqttService, db, io, room };
    }

    async function flushAsync() {
        await new Promise(resolve => setImmediate(resolve));
    }

    test('marks terminated-only USSD responses as cancelled', async () => {
        const { mqttService, db } = buildSubject();
        db.get
            .mockResolvedValueOnce({ id: 5, session_id: null, menu_level: 0 })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        mqttService.emit('ussd:response', 'test-device-1', {
            code: '*222#',
            status: 'terminated',
            response: 'USSD session terminated'
        });

        await flushAsync();

        expect(db.run).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('UPDATE ussd'),
            [
            'USSD session terminated',
            'cancelled',
            '5',
            5
            ]
        );
    });

    test('marks real USSD text responses as success', async () => {
        const { mqttService, db } = buildSubject();
        db.get
            .mockResolvedValueOnce({ id: 7, session_id: null, menu_level: 0 })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        mqttService.emit('ussd:response', 'test-device-1', {
            code: '*222#',
            status: 'terminated',
            response: 'Bal:TK 397.91 Val:24/03/2027'
        });

        await flushAsync();

        expect(db.run).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('UPDATE ussd'),
            [
            'Bal:TK 397.91 Val:24/03/2027',
            'success',
            '7',
            7
            ]
        );
    });

    test('keeps interactive USSD responses active and emits parsed menu options', async () => {
        const { mqttService, db, room } = buildSubject();
        db.get
            .mockResolvedValueOnce({ id: 8, session_id: null, menu_level: 0 })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        mqttService.emit('ussd:response', 'test-device-1', {
            code: '*123#',
            response: '1. Balance\n2. Offers',
            session_active: true
        });

        await flushAsync();

        expect(db.run).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('UPDATE ussd'),
            ['1. Balance\n2. Offers', 'active', '8', 8]
        );
        expect(room.emit).toHaveBeenCalledWith(
            'ussd:response',
            expect.objectContaining({
                deviceId: 'test-device-1',
                response: '1. Balance\n2. Offers',
                menuOptions: [
                    { option: '1', label: 'Balance' },
                    { option: '2', label: 'Offers' }
                ]
            })
        );
    });

    test('keeps interactive USSD rows active after an empty termination follow-up', async () => {
        const { mqttService, db, room } = buildSubject();
        db.get
            .mockResolvedValueOnce({ id: 12, session_id: null, menu_level: 0, response: '', status: 'pending' })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 12, session_id: '12', menu_level: 0, response: '1) Balance\n2) Offers', status: 'active' })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        mqttService.emit('ussd:response', 'test-device-1', {
            code: '*123#',
            response: '1) Balance\n2) Offers',
            session_active: true
        });

        await flushAsync();

        mqttService.emit('ussd:response', 'test-device-1', {
            code: '*123#',
            response: '',
            session_active: false,
            status: 'terminated'
        });

        await flushAsync();

        expect(db.run).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('UPDATE ussd'),
            ['1) Balance\n2) Offers', 'active', '12', 12]
        );
        expect(db.run).toHaveBeenNthCalledWith(
            3,
            expect.stringContaining('UPDATE ussd'),
            ['1) Balance\n2) Offers', 'active', '12', 12]
        );
        expect(room.emit).toHaveBeenLastCalledWith(
            'ussd:response',
            expect.objectContaining({
                deviceId: 'test-device-1',
                response: '1) Balance\n2) Offers',
                session_active: true,
                sessionId: '12',
                menuLevel: 0,
                menuOptions: [
                    { option: '1', label: 'Balance' },
                    { option: '2', label: 'Offers' }
                ]
            })
        );
    });

    test('keeps pending USSD busy on an empty non-terminal update', async () => {
        const { mqttService, db, room } = buildSubject();
        db.get
            .mockResolvedValueOnce({ id: 13, session_id: null, menu_level: 0, response: '', status: 'pending' })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        mqttService.emit('ussd:response', 'test-device-1', {
            code: '*123#',
            response: ''
        });

        await flushAsync();

        expect(db.run).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('UPDATE ussd'),
            ['', 'pending', '13', 13]
        );
        expect(mqttService.markDeviceBusy).toHaveBeenCalledWith('test-device-1', 'send-ussd', 120000);
        expect(mqttService.clearDeviceBusy).not.toHaveBeenCalled();
        expect(room.emit).toHaveBeenLastCalledWith(
            'ussd:response',
            expect.objectContaining({
                deviceId: 'test-device-1',
                response: '',
                status: 'pending',
                session_active: false,
                menuOptions: []
            })
        );
    });

    test('marks USSD result failed when firmware reports a failed status without payload', async () => {
        const { mqttService, db, room } = buildSubject();
        db.get
            .mockResolvedValueOnce({ id: 14, session_id: null, menu_level: 0, response: '', status: 'pending' })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        mqttService.emit('ussd:response', 'test-device-1', {
            code: '*123#',
            status: 'failed',
            response: 'ussd_response_timeout',
            session_active: false
        });

        await flushAsync();

        expect(db.run).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('UPDATE ussd'),
            ['ussd_response_timeout', 'failed', '14', 14]
        );
        expect(mqttService.clearDeviceBusy).toHaveBeenCalledWith('test-device-1');
        expect(room.emit).toHaveBeenLastCalledWith(
            'ussd:response',
            expect.objectContaining({
                deviceId: 'test-device-1',
                response: 'ussd_response_timeout',
                status: 'failed',
                session_active: false,
                menuOptions: []
            })
        );
    });

    test('persists SIM number from configured own-number USSD response', async () => {
        const { mqttService, db } = buildSubject();
        db.get
            .mockResolvedValueOnce({ id: 9, session_id: null, menu_level: 0 })
            .mockResolvedValueOnce({ ussd_code: '*140*2#' })
            .mockResolvedValueOnce({ description: 'SIM Number Check' });

        mqttService.emit('ussd:response', 'test-device-1', {
            code: '*140*2#',
            status: 'terminated',
            response: 'Your number is +8801628301525'
        });

        await flushAsync();

        expect(db.run).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('UPDATE ussd'),
            ['Your number is +8801628301525', 'success', '9', 9]
        );
        expect(db.run).toHaveBeenNthCalledWith(
            3,
            expect.stringContaining('INSERT INTO device_profiles (device_id, last_sim_number, updated_at)'),
            ['test-device-1', '+8801628301525']
        );
        expect(global.modemService.updateDeviceStatus).toHaveBeenCalledWith(
            'test-device-1',
            expect.objectContaining({
                modem_subscriber_number: '+8801628301525'
            })
        );
    });

    test('does not append the next-line carrier menu index to the SIM phone number', async () => {
        const { mqttService, db } = buildSubject();
        db.get
            .mockResolvedValueOnce({ id: 10, session_id: null, menu_level: 0 })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ description: 'SIM Number Check' });
        mqttService.emit('ussd:response', 'test-device-1', {
            code: '*2#', status: 'active', session_active: true,
            response: 'My Number 8801628301525\n1) For Data Offers Reply 1\n2) My Offer'
        });
        await flushAsync();
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO device_profiles'),
            ['test-device-1', '+8801628301525']
        );
    });

    test('persists SIM number from a SIM Number Check request even without configured own-number code', async () => {
        const { mqttService, db } = buildSubject();
        db.get
            .mockResolvedValueOnce({ id: 10, session_id: null, menu_level: 0 })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ description: 'SIM Number Check' });

        mqttService.emit('ussd:response', 'test-device-1', {
            code: '*2#',
            status: 'terminated',
            response: 'Your number is +8801628301525'
        });

        await flushAsync();

        expect(db.run).toHaveBeenNthCalledWith(
            3,
            expect.stringContaining('INSERT INTO device_profiles (device_id, last_sim_number, updated_at)'),
            ['test-device-1', '+8801628301525']
        );
        expect(global.modemService.updateDeviceStatus).toHaveBeenCalledWith(
            'test-device-1',
            expect.objectContaining({
                modem_subscriber_number: '+8801628301525'
            })
        );
    });

    test('decodes UCS-2 USSD responses before extracting the SIM number', async () => {
        const { mqttService, db } = buildSubject();
        db.get
            .mockResolvedValueOnce({ id: 11, session_id: null, menu_level: 0 })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ description: 'SIM Number Check' });

        mqttService.emit('ussd:response', 'test-device-1', {
            code: '*2#',
            status: 'terminated',
            response: '004D00790020006E0075006D0062006500720020006900730020002B0038003800300031003600320038003300300031003500320035'
        });

        await flushAsync();

        expect(db.run).toHaveBeenNthCalledWith(
            3,
            expect.stringContaining('INSERT INTO device_profiles (device_id, last_sim_number, updated_at)'),
            ['test-device-1', '+8801628301525']
        );
    });
});

describe('MQTTHandlers startup status prime', () => {
    function buildPrimeSubject() {
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.requestStatus = jest.fn().mockResolvedValue({ success: true });
        mqttService.hasFreshStatusSnapshot = jest.fn().mockReturnValue(false);

        const io = {
            to: jest.fn(() => ({ emit: jest.fn() })),
            emit: jest.fn()
        };

        const db = {
            all: jest.fn().mockResolvedValue([
                {
                    device_id: 'device-prime',
                    last_seen: '2026-04-21T13:00:00.000Z'
                }
            ])
        };

        const app = { locals: { db } };
        let liveStatus = { online: false, statusFresh: false };
        global.modemService = {
            getDeviceStatus: jest.fn(() => liveStatus)
        };

        const MQTTHandlers = require('../services/mqttHandlers');
        const handlers = new MQTTHandlers(mqttService, io, app);

        return {
            handlers,
            mqttService,
            setLiveStatus(nextStatus) {
                liveStatus = nextStatus;
            }
        };
    }

    async function flushAsync() {
        await Promise.resolve();
        await Promise.resolve();
    }

    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        delete global.modemService;
    });

    test('defers startup status prime until the device stays unseen', async () => {
        const { handlers, mqttService } = buildPrimeSubject();

        await handlers.primeKnownDeviceStatus();
        await flushAsync();

        jest.advanceTimersByTime(19999);
        await flushAsync();

        expect(mqttService.requestStatus).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        await flushAsync();

        expect(mqttService.requestStatus).toHaveBeenCalledWith(
            'device-prime',
            expect.objectContaining({
                force: false,
                allowCompatibilitySnapshot: true,
                source: 'startup-prime'
            })
        );
    });

    test('cached online status does not suppress a new broker-session prime', async () => {
        const { handlers, mqttService, setLiveStatus } = buildPrimeSubject();
        setLiveStatus({ online: true, statusFresh: true });

        await handlers.primeKnownDeviceStatus();
        await flushAsync();
        jest.advanceTimersByTime(20000);
        await flushAsync();

        expect(mqttService.hasFreshStatusSnapshot).toHaveBeenCalledWith('device-prime');
        expect(mqttService.requestStatus).toHaveBeenCalledWith(
            'device-prime',
            expect.objectContaining({ source: 'startup-prime' })
        );
    });

    test('skips the delayed startup prime once live status arrives first', async () => {
        const { handlers, mqttService, setLiveStatus } = buildPrimeSubject();

        await handlers.primeKnownDeviceStatus();
        await flushAsync();

        setLiveStatus({ online: true, statusFresh: true });
        mqttService.hasFreshStatusSnapshot.mockReturnValue(true);

        jest.advanceTimersByTime(25000);
        await flushAsync();

        expect(mqttService.requestStatus).not.toHaveBeenCalled();
    });
});

describe('MQTTHandlers SMS storage', () => {
    function buildSmsSubject() {
        const mqttService = new EventEmitter();
        mqttService.clearDeviceStatus = jest.fn();
        mqttService.markDeviceBusy = jest.fn();
        mqttService.clearDeviceBusy = jest.fn();
        mqttService.publishCommand = jest.fn().mockResolvedValue({
            queued: true,
            queueId: 'history-ack-1'
        });

        const room = { emit: jest.fn() };
        const io = {
            to: jest.fn(() => room),
            emit: jest.fn()
        };

        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1, lastID: 17 }),
            get: jest.fn().mockResolvedValue({ id: 'test-device-1' }),
            all: jest.fn().mockResolvedValue([])
        };

        const app = { locals: { db } };
        const MQTTHandlers = require('../services/mqttHandlers');
        const handlers = new MQTTHandlers(mqttService, io, app);
        handlers.setupSMSHandlers();

        return { mqttService, db, io, room, handlers };
    }

    async function flushAsync() {
        await new Promise(resolve => setImmediate(resolve));
    }

    beforeEach(() => {
        const smsCache = require('../services/smsCache');
        smsCache.get.mockReturnValue(4);
    });

    test('persists incoming SMS rows and emits sms:received', async () => {
        const smsCache = require('../services/smsCache');
        const notificationService = require('../services/notificationService');
        const pushNotificationService = require('../services/pushNotificationService');
        const { mqttService, db, room } = buildSmsSubject();

        mqttService.emit('sms:incoming', 'test-device-1', {
            from: '+8801555123456',
            message: 'hello from modem',
            timestamp: '2026-04-03T10:00:00.000Z'
        });

        await flushAsync();

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT OR IGNORE INTO sms'),
            [
                '+8801555123456',
                null,
                'hello from modem',
                'incoming',
                'received',
                'test-device-1',
                '2026-04-03T10:00:00.000Z',
                0,
                'android-mqtt',
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                0
            ]
        );
        expect(smsCache.increment).toHaveBeenCalledWith('test-device-1');
        expect(room.emit).toHaveBeenCalledWith(
            'sms:received',
            expect.objectContaining({
                deviceId: 'test-device-1',
                from_number: '+8801555123456',
                message: 'hello from modem',
                id: 17,
                unreadCount: 4
            })
        );
        expect(notificationService.notifySms).toHaveBeenCalledWith(
            '+8801555123456',
            'hello from modem',
            expect.objectContaining({
                deviceId: 'test-device-1',
                actionUrl: '/sms'
            })
        );
        expect(pushNotificationService.notifyLinkedDevices).toHaveBeenCalledWith(
            'test-device-1',
            expect.objectContaining({
                title: 'New SMS received'
            })
        );
    });

    test.each([
        ['missing body', { from: '+8801555123456' }],
        ['missing sender', { message: 'body without sender' }],
        ['blank fields', { from: '   ', message: '   ' }],
        ['non-object payload', null]
    ])('ignores malformed incoming SMS payload with %s', async (_label, payload) => {
        const smsCache = require('../services/smsCache');
        const notificationService = require('../services/notificationService');
        const pushNotificationService = require('../services/pushNotificationService');
        const { mqttService, db, room } = buildSmsSubject();
        smsCache.increment.mockClear();
        notificationService.notifySms.mockClear();
        pushNotificationService.notifyLinkedDevices.mockClear();

        mqttService.emit('sms:incoming', 'test-device-1', payload);
        await flushAsync();

        expect(db.run).not.toHaveBeenCalled();
        expect(smsCache.increment).not.toHaveBeenCalled();
        expect(notificationService.notifySms).not.toHaveBeenCalled();
        expect(pushNotificationService.notifyLinkedDevices).not.toHaveBeenCalled();
        expect(room.emit).not.toHaveBeenCalledWith('sms:received', expect.anything());
    });

    test('stores synced read SMS without unread bump or notification', async () => {
        const smsCache = require('../services/smsCache');
        const notificationService = require('../services/notificationService');
        const pushNotificationService = require('../services/pushNotificationService');
        const { mqttService, db, room } = buildSmsSubject();
        smsCache.increment.mockClear();
        notificationService.notifySms.mockClear();
        pushNotificationService.notifyLinkedDevices.mockClear();

        mqttService.emit('sms:incoming', 'test-device-1', {
            type: 'sms_sync',
            sync: true,
            from: '+8801555000000',
            message: 'historical message',
            timestamp: '2026-04-03T09:00:00.000Z',
            read: 1,
            external_id: 'android-sms-42'
        });

        await flushAsync();

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT OR IGNORE INTO sms'),
            expect.arrayContaining([
                '2026-04-03T09:00:00.000Z',
                1,
                'android-mqtt-sync',
                null,
                'android-sms-42'
            ])
        );
        expect(smsCache.increment).not.toHaveBeenCalled();
        expect(notificationService.notifySms).not.toHaveBeenCalled();
        expect(pushNotificationService.notifyLinkedDevices).not.toHaveBeenCalled();
        expect(room.emit).toHaveBeenCalledWith(
            'sms:received',
            expect.objectContaining({
                sync: true,
                read: 1,
                external_id: 'android-sms-42'
            })
        );
    });

    test('treats ESP32 pull detail as sync and suppresses unread notification side effects', async () => {
        const smsCache = require('../services/smsCache');
        const notificationService = require('../services/notificationService');
        const pushNotificationService = require('../services/pushNotificationService');
        const { mqttService, db, room } = buildSmsSubject();
        smsCache.increment.mockClear();
        notificationService.notifySms.mockClear();
        pushNotificationService.notifyLinkedDevices.mockClear();

        mqttService.emit('sms:incoming', 'test-device-1', {
            type: 'sms_incoming',
            detail: 'incoming_sms_pull',
            storage_id: 77,
            from: '+8801555000777',
            text: 'pulled from sim',
            timestamp: '2026-05-08T09:00:00.000Z'
        });

        await flushAsync();

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT OR IGNORE INTO sms'),
            expect.arrayContaining([
                '2026-05-08T09:00:00.000Z',
                1,
                'esp32-mqtt-sync',
                null,
                null,
                null,
                77
            ])
        );
        expect(smsCache.increment).not.toHaveBeenCalled();
        expect(notificationService.notifySms).not.toHaveBeenCalled();
        expect(pushNotificationService.notifyLinkedDevices).not.toHaveBeenCalled();
        expect(room.emit).toHaveBeenCalledWith(
            'sms:received',
            expect.objectContaining({
                sync: true,
                read: 1,
                firmware_storage_id: 77
            })
        );
        expect(mqttService.publishCommand).toHaveBeenCalledWith(
            'test-device-1',
            'delete-sms',
            { storage_id: 77 },
            false,
            30000,
            expect.objectContaining({
                source: 'dashboard-sms-history-ack',
                persistent: true,
                replaySafe: true
            })
        );
    });

    test.each(['1234', '00410042', 'বাংলা বার্তা'])('preserves firmware UTF-8 body %s and its source', async (text) => {
        const { mqttService, db, room } = buildSmsSubject();
        mqttService.emit('sms:incoming', 'test-device-1', {
            type: 'sms_incoming', storage_id: 123, from: '+15550002222', text,
            timestamp: '2026-09-13T03:00:00Z'
        });
        await flushAsync();
        const insert = db.run.mock.calls.find(([sql]) => sql.includes('INSERT OR IGNORE INTO sms'));
        expect(insert[1][2]).toBe(text);
        expect(insert[1][8]).toBe('esp32-mqtt');
        expect(insert[1][12]).toBe(123);
        expect(room.emit).toHaveBeenCalledWith('sms:received', expect.objectContaining({ message: text }));
        const { decodeSmsRecord } = require('../utils/smsUnicode');
        expect(decodeSmsRecord({ source: insert[1][8], message: insert[1][2] }).message).toBe(text);
    });

    test('stores multipart metadata for incoming Android MQTT SMS', async () => {
        const { mqttService, db, room } = buildSmsSubject();

        mqttService.emit('sms:incoming', 'test-device-1', {
            from: '3=:24;82=8<3=86<2:41',
            message: ', second part',
            timestamp: '2026-05-06T11:02:09.420Z',
            multipart_ref: '44',
            multipart_part_index: 2,
            multipart_part_count: 3,
            sim_slot: 0
        });

        await flushAsync();

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('multipart_group_key'),
            [
                '3=:24;82=8<3=86<2:41',
                null,
                ', second part',
                'incoming',
                'received',
                'test-device-1',
                '2026-05-06T11:02:09.421Z',
                0,
                'android-mqtt',
                0,
                null,
                null,
                null,
                '44',
                2,
                3,
                'multipart:test-device-1:incoming:3=:24;82=8<3=86<2:41:0:44:3',
                0
            ]
        );
        expect(room.emit).toHaveBeenCalledWith(
            'sms:received',
            expect.objectContaining({
                multipart_ref: '44',
                multipart_part_index: 2,
                multipart_part_count: 3,
                timestamp: '2026-05-06T11:02:09.421Z'
            })
        );
    });

    test('emits sms:received before outgoing reconciliation finishes', async () => {
        const { mqttService, room, handlers } = buildSmsSubject();

        let releaseReconcile;
        handlers.reconcileOutgoingSmsFromIncoming = jest.fn().mockImplementation(() => new Promise((resolve) => {
            releaseReconcile = resolve;
        }));

        mqttService.emit('sms:incoming', 'test-device-1', {
            from: '+8801555123456',
            message: 'latency-sensitive inbound',
            timestamp: '2026-04-23T10:00:00.000Z'
        });

        await flushAsync();

        expect(room.emit).toHaveBeenCalledWith(
            'sms:received',
            expect.objectContaining({
                deviceId: 'test-device-1',
                message: 'latency-sensitive inbound'
            })
        );

        releaseReconcile(null);
        await flushAsync();
    });

    test('AND-01: accepted result keeps the row sending and emits sms:accepted, never sms:sent', async () => {
        const { mqttService, db, room } = buildSmsSubject();

        db.get.mockImplementation(async (sql) => {
            const query = String(sql);
            if (query.includes('SELECT id FROM devices')) {
                return { id: 'test-device-1' };
            }
            if (query.includes('FROM sms') && query.includes('external_id')) {
                return {
                    id: 41,
                    conversation_id: 12,
                    to_number: '+8801555123456',
                    external_id: 'send-sms_acc1',
                    sim_slot: 0,
                    status: 'sending'
                };
            }
            return null;
        });

        mqttService.emit('action:result', 'test-device-1', {
            command: 'send-sms',
            messageId: 'send-sms_acc1',
            result: 'accepted',
            success: true,
            terminal: false
        });

        await flushAsync();

        // The row is settled as `sending` — NOT `sent`.
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms'),
            expect.arrayContaining(['sending'])
        );
        // The UI receives a non-terminal acknowledgement event.
        expect(room.emit).toHaveBeenCalledWith(
            'sms:accepted',
            expect.objectContaining({
                deviceId: 'test-device-1',
                messageId: 'send-sms_acc1',
                status: 'sending',
                terminal: false
            })
        );
        // It must NOT claim success.
        expect(room.emit).not.toHaveBeenCalledWith(
            'sms:sent',
            expect.anything()
        );
    });

    test('AND-01: terminal completed result settles the row as sent and emits sms:sent', async () => {
        const { mqttService, db, room } = buildSmsSubject();

        db.get.mockImplementation(async (sql) => {
            const query = String(sql);
            if (query.includes('SELECT id FROM devices')) {
                return { id: 'test-device-1' };
            }
            if (query.includes('FROM sms') && query.includes('external_id')) {
                return {
                    id: 42,
                    conversation_id: 13,
                    to_number: '+8801555123456',
                    external_id: 'send-sms_done1',
                    sim_slot: 0,
                    status: 'sent'
                };
            }
            return null;
        });

        mqttService.emit('action:result', 'test-device-1', {
            command: 'send-sms',
            messageId: 'send-sms_done1',
            result: 'completed',
            success: true,
            terminal: true
        });

        await flushAsync();

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms'),
            expect.arrayContaining(['sent'])
        );
        expect(room.emit).toHaveBeenCalledWith(
            'sms:sent',
            expect.objectContaining({
                deviceId: 'test-device-1',
                messageId: 'send-sms_done1',
                status: 'sent'
            })
        );
    });

    test('success true without a terminal result keeps the SMS unresolved', async () => {
        const { mqttService, db, room } = buildSmsSubject();

        db.get.mockImplementation(async (sql) => {
            const query = String(sql);
            if (query.includes('SELECT id FROM devices')) {
                return { id: 'test-device-1' };
            }
            if (query.includes('FROM sms') && query.includes('external_id')) {
                return {
                    id: 31,
                    conversation_id: 9,
                    to_number: '+8801555123456',
                    external_id: 'send-sms_123',
                    sim_slot: 1,
                    status: 'sending'
                };
            }
            return null;
        });

        mqttService.emit('action:result', 'test-device-1', {
            command: 'send-sms',
            messageId: 'send-sms_123',
            success: true,
            payload: {
                to: '+8801555123456'
            }
        });

        await flushAsync();

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms'),
            ['sending', 'sending', 'sending', null, 'test-device-1', 'send-sms_123']
        );
        expect(room.emit).toHaveBeenCalledWith(
            'sms:accepted',
            expect.objectContaining({
                deviceId: 'test-device-1',
                id: 31,
                conversationId: 9,
                messageId: 'send-sms_123',
                to: '+8801555123456',
                sim_slot: 1,
                status: 'sending',
                terminal: false
            })
        );
        expect(room.emit).not.toHaveBeenCalledWith('sms:sent', expect.anything());
    });

    test('maps multipart action part ids back to the base outgoing SMS row', async () => {
        const { mqttService, db, room } = buildSmsSubject();

        db.get.mockImplementation(async (sql) => {
            const query = String(sql);
            if (query.includes('SELECT id FROM devices')) {
                return { id: 'test-device-1' };
            }
            if (query.includes('FROM sms') && query.includes('external_id')) {
                return {
                    id: 32,
                    conversation_id: 10,
                    to_number: '+8801555123456',
                    external_id: 'sms_base123',
                    sim_slot: 0,
                    status: 'sending'
                };
            }
            return null;
        });

        mqttService.emit('action:result', 'test-device-1', {
            command: 'send-sms',
            messageId: 'sms_base123_p1',
            success: true,
            payload: {
                to: '+8801555123456'
            }
        });

        await flushAsync();

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('external_id = ?'),
            ['sending', 'sending', 'sending', null, 'test-device-1', 'sms_base123']
        );
        expect(room.emit).toHaveBeenCalledWith(
            'sms:accepted',
            expect.objectContaining({
                deviceId: 'test-device-1',
                id: 32,
                conversationId: 10,
                messageId: 'sms_base123',
                to: '+8801555123456',
                sim_slot: 0,
                status: 'sending'
            })
        );
        expect(room.emit).not.toHaveBeenCalledWith('sms:sent', expect.anything());
    });

    test.each([
        ['completed overrides success false', { result: 'completed', success: false }, 'sent', 'sms:sent'],
        ['failed overrides success true', { result: 'failed', success: true }, 'failed', 'sms:send-failed']
    ])('%s', async (_label, response, expectedStatus, expectedEvent) => {
        const { mqttService, db, room } = buildSmsSubject();
        db.get.mockImplementation(async (sql) => {
            const query = String(sql);
            if (query.includes('SELECT id FROM devices')) return { id: 'test-device-1' };
            if (query.includes('FROM sms') && query.includes('external_id')) {
                return {
                    id: 33,
                    conversation_id: 11,
                    to_number: '+8801555123456',
                    external_id: 'send-sms_conflict',
                    sim_slot: 0,
                    status: expectedStatus
                };
            }
            return null;
        });

        mqttService.emit('action:result', 'test-device-1', {
            command: 'send-sms',
            messageId: 'send-sms_conflict',
            ...response
        });
        await flushAsync();

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms'),
            expect.arrayContaining([expectedStatus])
        );
        expect(room.emit).toHaveBeenCalledWith(
            expectedEvent,
            expect.objectContaining({ status: expectedStatus, terminal: true })
        );
    });

    test('reconciles a timed-out outgoing SMS when matching incoming loopback evidence arrives', async () => {
        const { mqttService, db, room } = buildSmsSubject();
        mqttService._markPersistentQueueCompleted = jest.fn().mockResolvedValue(undefined);

        db.get.mockImplementation(async (sql, params) => {
            const query = String(sql);
            if (query.includes('SELECT id FROM devices')) {
                return { id: 'test-device-1' };
            }
            if (query.includes('FROM device_command_queue')) {
                return {
                    id: 'queue-1',
                    device_id: 'test-device-1',
                    command: 'send-sms',
                    status: 'failed',
                    message_id: 'send-sms_123',
                    payload: JSON.stringify({
                        to: '+8801555123456',
                        message: 'loopback token'
                    })
                };
            }
            return null;
        });
        db.all.mockImplementation(async (sql) => {
            const query = String(sql);
            if (query.includes("FROM sms") && query.includes("type = 'outgoing'")) {
                return [{
                    id: 42,
                    external_id: 'send-sms_123',
                    status: 'failed',
                    timestamp: '2026-04-21T11:54:18.298Z',
                    sim_slot: 0
                }];
            }
            return [];
        });

        mqttService.emit('sms:incoming', 'test-device-1', {
            from: '+8801555123456',
            message: 'loopback token',
            timestamp: '2026-04-21T11:55:42.392Z',
            sim_slot: 0
        });

        await flushAsync();

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining("SET status = 'delivered'"),
            ['2026-04-21T11:55:42.392Z', 42]
        );
        expect(mqttService._markPersistentQueueCompleted).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'queue-1',
                message_id: 'send-sms_123'
            }),
            expect.objectContaining({
                success: true,
                detail: 'sms_delivered_via_incoming_match',
                messageId: 'send-sms_123'
            })
        );
        expect(room.emit).toHaveBeenCalledWith(
            'sms:delivered',
            expect.objectContaining({
                deviceId: 'test-device-1',
                id: 42,
                messageId: 'send-sms_123',
                evidence: 'incoming_sms_match'
            })
        );
    });

    test('reconciles a sent outgoing SMS when dashboard timestamp has no timezone', async () => {
        const { mqttService, db, room } = buildSmsSubject();

        db.get.mockImplementation(async (sql) => {
            const query = String(sql);
            if (query.includes('SELECT id FROM devices')) {
                return { id: 'test-device-1' };
            }
            return null;
        });
        db.all.mockImplementation(async (sql) => {
            const query = String(sql);
            if (query.includes("FROM sms") && query.includes("type = 'outgoing'")) {
                return [{
                    id: 272,
                    conversation_id: 20,
                    external_id: null,
                    status: 'sent',
                    timestamp: '2026-04-24T11:43:41.444',
                    sim_slot: 0
                }];
            }
            return [];
        });

        mqttService.emit('sms:incoming', 'test-device-1', {
            from: '+8801555123456',
            message: 'regular loopback token',
            timestamp: '2026-04-24T11:45:15.229Z',
            sim_slot: 0
        });

        await flushAsync();

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining("SET status = 'delivered'"),
            ['2026-04-24T11:45:15.229Z', 272]
        );
        expect(room.emit).toHaveBeenCalledWith(
            'sms:delivered',
            expect.objectContaining({
                deviceId: 'test-device-1',
                id: 272,
                conversationId: 20,
                evidence: 'incoming_sms_match',
                status: 'delivered'
            })
        );
    });

    test('failed firmware delivery report marks the reference-correlated outgoing SMS failed', async () => {
        const { mqttService, db, room } = buildSmsSubject();
        mqttService._findPersistentSmsQueueRow = jest.fn().mockResolvedValue({
            device_id: 'test-device-1', message_id: 'send-46',
            payload: JSON.stringify({ smsId: 46 }),
            response_payload: JSON.stringify({ message_reference: 46 })
        });

        mqttService.emit('sms:delivery', 'test-device-1', {
            to: '+8801555123456',
            delivered: false,
            status: 'failed',
            detail: 'sms_delivery_failed',
            message_reference: 46
        });

        await flushAsync();

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms'),
            ['failed', 'failed', 'sms_delivery_failed', 'test-device-1', 46]
        );
        expect(room.emit).toHaveBeenCalledWith(
            'sms:send-failed',
            expect.objectContaining({
                deviceId: 'test-device-1',
                to: '+8801555123456',
                status: 'failed',
                error: 'sms_delivery_failed',
                message_reference: 46
            })
        );
    });

    test('dashboard classifies raw firmware delivery report as delivered', async () => {
        const { mqttService, db, room } = buildSmsSubject();
        mqttService._findPersistentSmsQueueRow = jest.fn().mockResolvedValue({
            device_id: 'test-device-1', message_id: 'send-47',
            payload: JSON.stringify({ smsId: 47 }),
            response_payload: JSON.stringify({ message_reference: 47 })
        });

        mqttService.emit('sms:delivery', 'test-device-1', {
            to: '+8801555123456',
            status_report_status: 0,
            message_reference: 47,
            raw_report: '+CDS: 49,47,"+8801555123456",145,"26/04/24,12:00:00+24","26/04/24,12:00:03+24",0'
        });

        await flushAsync();

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms'),
            ['delivered', 'delivered', null, 'test-device-1', 47]
        );
        expect(room.emit).toHaveBeenCalledWith(
            'sms:delivered',
            expect.objectContaining({
                deviceId: 'test-device-1',
                to: '+8801555123456',
                status: 'delivered',
                error: null,
                message_reference: 47
            })
        );
    });
    test('out-of-order reports for one recipient update their respective SMS rows', async () => {
        const { mqttService, db, room } = buildSmsSubject();
        mqttService._findPersistentSmsQueueRow = jest.fn(async (_, report) => ({
            device_id: 'test-device-1', message_id: `send-${report.message_reference}`,
            payload: JSON.stringify({ smsId: report.message_reference + 100 }),
            response_payload: JSON.stringify({ message_reference: report.message_reference })
        }));
        for (const reference of [52, 51]) {
            mqttService.emit('sms:delivery', 'test-device-1', {
                to: '+8801555123456', message_reference: reference, status_report_status: 0
            });
            await flushAsync();
        }
        expect(db.run.mock.calls.map(([, args]) => args)).toEqual([
            ['delivered', 'delivered', null, 'test-device-1', 152],
            ['delivered', 'delivered', null, 'test-device-1', 151]
        ]);
        expect(room.emit).toHaveBeenCalledWith('sms:delivered', expect.objectContaining({ id: 151, messageId: 'send-51' }));
    });

    test('unknown modem reference cannot use queue destination fallback or emit row delivery', async () => {
        const { mqttService, db, room } = buildSmsSubject();
        mqttService._findPersistentSmsQueueRow = jest.fn().mockResolvedValue({
            device_id: 'test-device-1', message_id: 'unrelated-send',
            payload: JSON.stringify({ smsId: 91, to: '+8801555123456' }),
            response_payload: JSON.stringify({ message_reference: 90 })
        });
        mqttService.emit('sms:delivery', 'test-device-1', {
            to: '+8801555123456', message_reference: 99, status_report_status: 0
        });
        await flushAsync();
        expect(db.run).not.toHaveBeenCalled();
        expect(room.emit).toHaveBeenCalledWith('sms:delivery', expect.objectContaining({ correlation: 'unmatched' }));
        expect(room.emit).not.toHaveBeenCalledWith('sms:delivered', expect.anything());
    });

    test('legacy report without a modem reference retains destination matching', async () => {
        const { mqttService, db } = buildSmsSubject();
        mqttService.emit('sms:delivery', 'test-device-1', { to: '+8801555123456', status: 'delivered' });
        await flushAsync();
        expect(db.run).toHaveBeenCalledWith(expect.stringContaining('WHERE rowid'),
            ['delivered', 'delivered', null, 'test-device-1', '+8801555123456']);
    });
});

describe('MQTTHandlers Wi-Fi history persistence', () => {
    function buildStatusSubject() {
        const moduleHealth = require('../utils/moduleHealth');
        moduleHealth.markModuleSuccess.mockResolvedValue(undefined);
        moduleHealth.upsertModuleHealth.mockResolvedValue(undefined);
        moduleHealth.markModuleFailure.mockResolvedValue(undefined);

        const mqttService = new EventEmitter();
        mqttService.clearDeviceStatus = jest.fn();
        mqttService.getStatus = jest.fn().mockReturnValue({ connected: true });

        const room = { emit: jest.fn() };
        const io = {
            to: jest.fn(() => room),
            emit: jest.fn()
        };

        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockImplementation(async (sql) => {
                if (String(sql).includes('SELECT id FROM devices')) {
                    return { id: 'device-wifi' };
                }
                if (String(sql).includes('FROM device_profiles')) {
                    return {
                        wifi_ssid: 'BenchNet',
                        wifi_pass: 'bench-pass'
                    };
                }
                return null;
            }),
            all: jest.fn().mockResolvedValue([])
        };

        const app = { locals: { db } };
        const currentStatus = {
            wifi: {
                connected: true,
                ssid: 'BenchNet',
                security: 'WPA2-PSK',
                ipAddress: '192.168.1.50',
                rssi: -55,
                channel: 6,
                bssid: 'AA:BB:CC:DD:EE:FF'
            },
            mobile: {
                signalStrength: 41,
                networkType: 'LTE',
                operator: 'robi axiata'
            },
            system: {}
        };
        global.modemService = {
            updateDeviceStatus: jest.fn().mockReturnValue(currentStatus),
            getDeviceStatus: jest.fn().mockReturnValue(currentStatus),
            devices: new Map()
        };

        const MQTTHandlers = require('../services/mqttHandlers');
        const handlers = new MQTTHandlers(mqttService, io, app);
        handlers.setupEventHandlers();

        return { mqttService, db, io, room, handlers };
    }

    async function flushAsync() {
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
    }

    test('persists connected Wi-Fi history from status events and does not increment twice for the same live session', async () => {
        const { mqttService, db } = buildStatusSubject();

        const payload = {
            active_path: 'wifi',
            wifi_connected: true,
            wifi_ssid: 'BenchNet',
            wifi_security: 'WPA2-PSK',
            wifi_rssi: -55,
            mqtt_connected: true,
            mqtt_subscribed: true
        };

        mqttService.emit('status', 'device-wifi', payload);
        await flushAsync();
        mqttService.emit('status', 'device-wifi', payload);
        await flushAsync();

        const wifiWrites = db.run.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO device_wifi_networks'));
        expect(wifiWrites).toHaveLength(2);
        expect(wifiWrites[0][1]).toEqual(expect.arrayContaining(['device-wifi', 'BenchNet', 'WPA2-PSK', 'bench-pass']));
        expect(wifiWrites[0][1][5]).toBe(1);
        expect(wifiWrites[0][1][11]).toBe(1);
        expect(wifiWrites[1][1]).toEqual(expect.arrayContaining(['device-wifi', 'BenchNet', 'WPA2-PSK', 'bench-pass']));
        expect(wifiWrites[1][1][5]).toBe(0);
        expect(wifiWrites[1][1][11]).toBe(0);
    });
});
