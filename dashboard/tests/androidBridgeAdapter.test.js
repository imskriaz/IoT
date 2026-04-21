'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
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
    });
});
