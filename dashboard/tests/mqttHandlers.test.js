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

describe('MQTTHandlers USSD classification', () => {
    function buildSubject() {
        const mqttService = new EventEmitter();
        mqttService.clearDeviceStatus = jest.fn();
        mqttService.markDeviceBusy = jest.fn();
        mqttService.clearDeviceBusy = jest.fn();

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
        mqttService.isDeviceOnline = jest.fn().mockReturnValue(false);

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

    test('skips the delayed startup prime once live status arrives first', async () => {
        const { handlers, mqttService, setLiveStatus } = buildPrimeSubject();

        await handlers.primeKnownDeviceStatus();
        await flushAsync();

        setLiveStatus({ online: true, statusFresh: true });
        mqttService.isDeviceOnline.mockReturnValue(true);

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
                null
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
        expect(notificationService.notifySms).toHaveBeenCalledWith('+8801555123456', 'hello from modem');
        expect(pushNotificationService.notifyLinkedDevices).toHaveBeenCalledWith(
            'test-device-1',
            expect.objectContaining({
                title: 'New SMS received'
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

    test('emits sms:sent with stored row metadata for instant dashboard updates', async () => {
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
                    sim_slot: 1
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

        expect(room.emit).toHaveBeenCalledWith(
            'sms:sent',
            expect.objectContaining({
                deviceId: 'test-device-1',
                id: 31,
                conversationId: 9,
                messageId: 'send-sms_123',
                to: '+8801555123456',
                sim_slot: 1,
                status: 'sent'
            })
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

    test('failed firmware delivery report marks latest outgoing SMS failed', async () => {
        const { mqttService, db, room } = buildSmsSubject();

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
            ['failed', 'failed', 'sms_delivery_failed', 'test-device-1', '+8801555123456']
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

        mqttService.emit('sms:delivery', 'test-device-1', {
            to: '+8801555123456',
            status_report_status: 0,
            message_reference: 47,
            raw_report: '+CDS: 49,47,"+8801555123456",145,"26/04/24,12:00:00+24","26/04/24,12:00:03+24",0'
        });

        await flushAsync();

        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms'),
            ['delivered', 'delivered', null, 'test-device-1', '+8801555123456']
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
            handleHeartbeat: jest.fn(),
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

    test('backfills ESP32 identity from status events', async () => {
        const { mqttService, db } = buildStatusSubject();

        mqttService.emit('status', 'device-wifi', {
            type: 'device_status',
            hardware_uid: 'AA:BB:CC:47:61:78',
            model: 'ESP32-S3-A7670E',
            board: 'Waveshare ESP32-S3-A7670E-4G',
            wifi_connected: false
        });
        await flushAsync();

        const profileWrite = db.run.mock.calls.find(([sql, params]) =>
            String(sql).includes('INSERT INTO device_profiles') &&
            String(sql).includes('hardware_uid') &&
            params?.[0] === 'device-wifi' &&
            params?.[1] === 'aabbcc476178' &&
            params?.[2] === 'ESP32-S3-A7670E' &&
            params?.[3] === 'Waveshare ESP32-S3-A7670E-4G'
        );
        expect(profileWrite).toBeTruthy();
    });

    test('persists heartbeat as an online device update', async () => {
        const { mqttService, db, room } = buildStatusSubject();

        mqttService.emit('heartbeat', 'device-wifi', { timestamp: '2026-04-26T08:15:00.000Z' });
        await flushAsync();

        expect(global.modemService.handleHeartbeat).toHaveBeenCalledWith('device-wifi');
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining("SET status = 'online', last_seen = CURRENT_TIMESTAMP"),
            ['device-wifi']
        );
        expect(room.emit).toHaveBeenCalledWith(
            'device:heartbeat',
            expect.objectContaining({
                deviceId: 'device-wifi',
                timestamp: '2026-04-26T08:15:00.000Z'
            })
        );
    });
});
