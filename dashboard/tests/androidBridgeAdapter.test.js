'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../services/smsConversations', () => ({
    attachSmsToConversation: jest.fn().mockResolvedValue(0),
    refreshSmsConversationBySmsId: jest.fn().mockResolvedValue()
}));

function makeDbMock(overrides = {}) {
    return {
        get: jest.fn().mockResolvedValue(null),
        all: jest.fn().mockResolvedValue([]),
        run: jest.fn().mockResolvedValue({ lastID: 0, changes: 0 }),
        ...overrides
    };
}

function buildApp(router, dbMock, options = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { user: { id: 1, role: 'admin', username: 'admin' } };
        req.user = req.session.user;
        req.apiKey = {
            id: 11,
            scopes: 'write',
            device_ids: JSON.stringify(options.deviceIds || ['android-http-01'])
        };
        next();
    });
    app.locals.db = dbMock;
    app.use('/v1/android/bridge', router);
    return app;
}

describe('androidBridgeAdapter routes', () => {
    afterEach(() => {
        delete global.modemService;
        delete global.io;
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    test('POST /status stores HTTP Android status and updates runtime device status', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ id: 'android-http-01' })
        });
        global.modemService = {
            updateDeviceStatus: jest.fn()
        };

        const router = require('../routes/androidBridgeAdapter');
        const app = buildApp(router, db, { deviceIds: ['android-http-01', 'android-unknown-01'] });
        const res = await request(app)
            .post('/v1/android/bridge/status')
            .send({
                device_id: 'android-http-01',
                name: 'Android HTTP',
                status: {
                    battery: 81,
                    active_path: 'http',
                    wifi_ssid: 'Office'
                }
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(global.modemService.updateDeviceStatus).toHaveBeenCalledWith(
            'android-http-01',
            expect.objectContaining({
                battery: 81,
                active_path: 'http',
                bridge_transport: 'http',
                transport_mode: 'http'
            })
        );
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE devices'),
            ['android-http-01']
        );
    });

    test('POST /status applies HTTP call status to active call records and emits call updates', async () => {
        const emit = jest.fn();
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ id: 'android-http-01' }),
            run: jest.fn()
                .mockResolvedValueOnce({ lastID: 0, changes: 1 })
                .mockResolvedValueOnce({ lastID: 0, changes: 1 })
        });
        global.modemService = {
            updateDeviceStatus: jest.fn()
        };
        global.io = {
            to: jest.fn().mockReturnValue({ emit })
        };

        const router = require('../routes/androidBridgeAdapter');
        const app = buildApp(router, db, { deviceIds: ['android-http-01'] });
        const res = await request(app)
            .post('/v1/android/bridge/status')
            .send({
                device_id: 'android-http-01',
                status: {
                    active_path: 'http',
                    timestamp: '2026-04-21T00:10:45.000Z',
                    call: {
                        status: 'ended',
                        direction: 'outgoing',
                        number: '+8801628301525',
                        updatedAt: '2026-04-21T00:10:45.000Z'
                    }
                }
            });

        expect(res.status).toBe(200);
        expect(db.run).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('UPDATE calls'),
            ['ended', 0, 'android-http-01', '8801628301525', '1628301525']
        );
        expect(emit).toHaveBeenCalledWith(
            'call:status',
            expect.objectContaining({
                deviceId: 'android-http-01',
                status: 'ended',
                direction: 'outgoing',
                number: '+8801628301525'
            })
        );
        expect(emit).toHaveBeenCalledWith(
            'call:ended',
            expect.objectContaining({
                deviceId: 'android-http-01',
                status: 'ended'
            })
        );
    });

    test('POST /status normalizes Android HTTP call status aliases before updating active call rows', async () => {
        const emit = jest.fn();
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ id: 'android-http-01' }),
            run: jest.fn()
                .mockResolvedValueOnce({ lastID: 0, changes: 1 })
                .mockResolvedValueOnce({ lastID: 0, changes: 1 })
        });
        global.modemService = {
            updateDeviceStatus: jest.fn()
        };
        global.io = {
            to: jest.fn().mockReturnValue({ emit })
        };

        const router = require('../routes/androidBridgeAdapter');
        const app = buildApp(router, db, { deviceIds: ['android-http-01'] });
        const res = await request(app)
            .post('/v1/android/bridge/status')
            .send({
                device_id: 'android-http-01',
                status: {
                    active_path: 'http',
                    timestamp: '2026-04-23T17:42:45.000Z',
                    call: {
                        status: 'online',
                        direction: 'outgoing',
                        number: '+8801313712494',
                        updatedAt: '2026-04-23T17:42:45.000Z'
                    }
                }
            });

        expect(res.status).toBe(200);
        expect(db.run).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('UPDATE calls'),
            ['connected', 0, 'android-http-01', '8801313712494', '1313712494']
        );
        expect(emit).toHaveBeenCalledWith(
            'call:status',
            expect.objectContaining({
                deviceId: 'android-http-01',
                status: 'connected',
                number: '+8801313712494'
            })
        );
    });

    test('POST /status reconciles Android HTTP inactive call payloads into ended events', async () => {
        const emit = jest.fn();
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ id: 'android-http-01' }),
            run: jest.fn()
                .mockResolvedValueOnce({ lastID: 0, changes: 1 })
                .mockResolvedValueOnce({ lastID: 0, changes: 1 })
        });
        global.modemService = {
            updateDeviceStatus: jest.fn()
        };
        global.io = {
            to: jest.fn().mockReturnValue({ emit })
        };

        const router = require('../routes/androidBridgeAdapter');
        const app = buildApp(router, db, { deviceIds: ['android-http-01'] });
        const res = await request(app)
            .post('/v1/android/bridge/status')
            .send({
                device_id: 'android-http-01',
                status: {
                    active_path: 'http',
                    timestamp: '2026-04-23T17:43:09.000Z',
                    call: {
                        active: false,
                        direction: 'outgoing',
                        number: '+8801313712494',
                        updatedAt: '2026-04-23T17:43:09.000Z'
                    }
                }
            });

        expect(res.status).toBe(200);
        expect(db.run).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('UPDATE calls'),
            ['ended', 0, 'android-http-01', '8801313712494', '1313712494']
        );
        expect(emit).toHaveBeenCalledWith(
            'call:status',
            expect.objectContaining({
                deviceId: 'android-http-01',
                status: 'ended',
                number: '+8801313712494'
            })
        );
        expect(emit).toHaveBeenCalledWith(
            'call:ended',
            expect.objectContaining({
                deviceId: 'android-http-01',
                status: 'ended'
            })
        );
    });

    test('GET /messages/outstanding returns queued Android HTTP messages and marks them sending', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ id: 'android-http-01' }),
            all: jest.fn().mockResolvedValue([
                {
                    id: 41,
                    external_id: 'send-sms_abc123',
                    to_number: '+8801700000000',
                    message: 'Queue me',
                    timestamp: '2026-04-18T12:00:00.000Z'
                }
            ])
        });

        const router = require('../routes/androidBridgeAdapter');
        const app = buildApp(router, db);
        const res = await request(app)
            .get('/v1/android/bridge/messages/outstanding')
            .query({ device_id: 'android-http-01' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.messages).toEqual([
            expect.objectContaining({
                id: 'send-sms_abc123',
                to: '+8801700000000',
                content: 'Queue me'
            })
        ]);
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining("SET status = 'sending'"),
            ['android-http-01', 41]
        );
    });

    test('POST /status ignores unknown Android HTTP devices and records them as unregistered', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue(null)
        });
        global.modemService = {
            updateDeviceStatus: jest.fn()
        };

        const router = require('../routes/androidBridgeAdapter');
        const app = buildApp(router, db, { deviceIds: ['android-http-01', 'android-unknown-01'] });
        const res = await request(app)
            .post('/v1/android/bridge/status')
            .send({
                device_id: 'android-unknown-01',
                name: 'Unknown Android',
                status: {
                    battery: 61
                }
            });

        expect(res.status).toBe(202);
        expect(res.body.ignored).toBe(true);
        expect(global.modemService.updateDeviceStatus).not.toHaveBeenCalled();
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO unregistered_devices'),
            expect.arrayContaining(['android-unknown-01', 'status'])
        );
    });

    test('POST /messages/:id/events stores Android HTTP SMS delivery results', async () => {
        const db = makeDbMock();
        db.get
            .mockResolvedValueOnce({ id: 'android-http-01' })
            .mockResolvedValueOnce({
                id: 41,
                device_id: 'android-http-01',
                to_number: '+8801700000000'
            });
        global.io = {
            to: jest.fn().mockReturnValue({ emit: jest.fn() })
        };

        const router = require('../routes/androidBridgeAdapter');
        const app = buildApp(router, db);
        const res = await request(app)
            .post('/v1/android/bridge/messages/send-sms_abc123/events')
            .send({
                device_id: 'android-http-01',
                event_name: 'DELIVERED',
                timestamp: '2026-04-18T12:10:00.000Z'
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms'),
            ['delivered', 'delivered', '2026-04-18T12:10:00.000Z', 'delivered', 'Android bridge failed', 'send-sms_abc123', 'android-http-01']
        );
        const { refreshSmsConversationBySmsId } = require('../services/smsConversations');
        expect(refreshSmsConversationBySmsId).toHaveBeenCalledWith(db, 41);
    });
});
