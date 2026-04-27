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
        run: jest.fn().mockResolvedValue({ lastID: 1, changes: 1 }),
        ...overrides
    };
}

function buildApp(db, session = { user: { id: 1, username: 'tester' }, deviceId: 'device-a' }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = session;
        next();
    });
    app.locals.db = db;
    app.use('/api/ussd', require('../routes/ussd'));
    return app;
}

describe('ussd API runtime dispatch', () => {
    afterEach(() => {
        jest.resetModules();
        delete global.mqttService;
    });

    test('dispatches send requests through the runtime MQTT lane and records pending history', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ lastID: 7, changes: 1 })
        });
        global.mqttService = {
            connected: true,
            publishCommand: jest.fn().mockResolvedValue({ messageId: 'ussd-1' })
        };
        const app = buildApp(db);

        const res = await request(app)
            .post('/api/ussd/send')
            .send({ deviceId: 'device-b', code: '*123#', description: 'Balance' });

        expect(res.status).toBe(200);
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'device-b',
            'send-ussd',
            { code: '*123#' },
            false,
            60000,
            {
                source: 'dashboard:ussd',
                domain: 'telephony',
                skipPersistentQueue: true
            }
        );
        expect(db.run).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('INSERT INTO ussd'),
            ['device-b', '*123#', 'Balance', 1, null, 0, null]
        );
        expect(res.body).toEqual(expect.objectContaining({
            success: true,
            message: 'USSD request dispatched',
            data: expect.objectContaining({
                id: 7,
                code: '*123#',
                status: 'pending',
                queued: false,
                messageId: 'ussd-1',
                sessionId: '7',
                menuLevel: 0
            })
        }));
    });

    test('dispatches USSD through the selected sim slot', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ lastID: 8, changes: 1 })
        });
        global.mqttService = {
            connected: true,
            publishCommand: jest.fn().mockResolvedValue({ messageId: 'ussd-2' })
        };
        const app = buildApp(db);

        const res = await request(app)
            .post('/api/ussd/send')
            .send({ deviceId: 'device-b', code: '*123#', description: 'Balance', simSlot: 1 });

        expect(res.status).toBe(200);
        expect(db.run).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('INSERT INTO ussd'),
            ['device-b', '*123#', 'Balance', 1, null, 0, 1]
        );
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'device-b',
            'send-ussd',
            { code: '*123#', sim_slot: 1 },
            false,
            60000,
            {
                source: 'dashboard:ussd',
                domain: 'telephony',
                skipPersistentQueue: true
            }
        );
        expect(res.body).toEqual(expect.objectContaining({
            success: true,
            data: expect.objectContaining({
                simSlot: 1
            })
        }));
    });

    test('cancels an older open session before dispatching a new root USSD request', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValueOnce({
                id: 5,
                code: '*123#',
                response: '1. Balance\n2. Offers',
                timestamp: '2026-04-19T12:00:00.000Z',
                status: 'active',
                session_id: '5',
                menu_level: 0
            }),
            run: jest.fn()
                .mockResolvedValueOnce({ changes: 1 })
                .mockResolvedValueOnce({ lastID: 9, changes: 1 })
        });
        global.mqttService = {
            connected: true,
            publishCommand: jest.fn()
                .mockResolvedValueOnce({ messageId: 'cancel-1' })
                .mockResolvedValueOnce({ messageId: 'ussd-3' })
        };
        const app = buildApp(db);

        const res = await request(app)
            .post('/api/ussd/send')
            .send({ deviceId: 'device-b', code: '*222#', description: 'Account' });

        expect(res.status).toBe(200);
        expect(db.run).toHaveBeenNthCalledWith(
            1,
            `UPDATE ussd SET status = 'cancelled' WHERE device_id = ? AND status IN ('pending', 'active')`,
            ['device-b']
        );
        expect(global.mqttService.publishCommand).toHaveBeenNthCalledWith(
            1,
            'device-b',
            'cancel-ussd',
            {},
            true,
            15000,
            {
                source: 'dashboard:ussd',
                domain: 'telephony',
                skipPersistentQueue: true
            }
        );
        expect(global.mqttService.publishCommand).toHaveBeenNthCalledWith(
            2,
            'device-b',
            'send-ussd',
            { code: '*222#' },
            false,
            60000,
            {
                source: 'dashboard:ussd',
                domain: 'telephony',
                skipPersistentQueue: true
            }
        );
        expect(db.run).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('INSERT INTO ussd'),
            ['device-b', '*222#', 'Account', 1, null, 0, null]
        );
        expect(res.body).toEqual(expect.objectContaining({
            success: true,
            data: expect.objectContaining({
                sessionId: '9',
                menuLevel: 0
            })
        }));
    });

    test('expands digit-only menu replies against the active session code', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValueOnce({
                id: 15,
                code: '*123#',
                response: '1. Balance\n2. Offers',
                timestamp: '2026-04-21T11:00:00.000Z',
                status: 'active',
                session_id: '15',
                menu_level: 0
            }),
            run: jest.fn().mockResolvedValue({ lastID: 16, changes: 1 })
        });
        global.mqttService = {
            connected: true,
            publishCommand: jest.fn().mockResolvedValue({ messageId: 'ussd-4' })
        };
        const app = buildApp(db);

        const res = await request(app)
            .post('/api/ussd/send')
            .send({ deviceId: 'device-b', code: '1' });

        expect(res.status).toBe(200);
        expect(db.run).toHaveBeenNthCalledWith(
            1,
            `UPDATE ussd SET status = 'cancelled' WHERE device_id = ? AND status IN ('pending', 'active')`,
            ['device-b']
        );
        expect(global.mqttService.publishCommand).toHaveBeenNthCalledWith(
            1,
            'device-b',
            'cancel-ussd',
            {},
            true,
            15000,
            {
                source: 'dashboard:ussd',
                domain: 'telephony',
                skipPersistentQueue: true
            }
        );
        expect(global.mqttService.publishCommand).toHaveBeenNthCalledWith(
            2,
            'device-b',
            'send-ussd',
            { code: '*123*1#' },
            false,
            60000,
            {
                source: 'dashboard:ussd',
                domain: 'telephony',
                skipPersistentQueue: true
            }
        );
        expect(db.run).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('INSERT INTO ussd'),
            ['device-b', '*123*1#', 'USSD Option 1', 1, '15', 1, null]
        );
        expect(res.body).toEqual(expect.objectContaining({
            success: true,
            data: expect.objectContaining({
                code: '*123*1#',
                requestedCode: '1',
                sessionId: '15',
                menuLevel: 1
            })
        }));
    });

    test('marks the request failed when runtime MQTT dispatch throws', async () => {
        const db = makeDbMock({
            run: jest.fn()
                .mockResolvedValueOnce({ lastID: 9, changes: 1 })
                .mockResolvedValueOnce({ changes: 1 })
        });
        global.mqttService = {
            connected: true,
            publishCommand: jest.fn().mockRejectedValue(new Error('dispatch timeout'))
        };
        const app = buildApp(db);

        const res = await request(app)
            .post('/api/ussd/send')
            .send({ deviceId: 'device-b', code: '*121#' });

        expect(res.status).toBe(500);
        expect(db.run).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining("UPDATE ussd SET status = 'failed'"),
            ['dispatch timeout', 9]
        );
        expect(res.body).toEqual({
            success: false,
            message: 'Failed to send USSD request'
        });
    });

    test('scopes history to the requested device', async () => {
        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([]),
            get: jest.fn().mockResolvedValue({ count: 0 })
        });
        const app = buildApp(db);

        const res = await request(app)
            .get('/api/ussd/history?deviceId=device-h&page=1&limit=10');

        expect(res.status).toBe(200);
        expect(db.all).toHaveBeenCalledWith(
            expect.stringContaining('WHERE u.device_id = ?'),
            ['device-h', 10, 0]
        );
        expect(db.get).toHaveBeenCalledWith(
            'SELECT COUNT(*) as count FROM ussd WHERE device_id = ?',
            ['device-h']
        );
    });

    test('reports active USSD session details and parsed menu options', async () => {
        const db = makeDbMock({
            get: jest.fn()
                .mockResolvedValueOnce({
                    id: 12,
                    code: '*123#',
                    response: '1. Balance\n2. Offers',
                    timestamp: '2026-04-19T12:00:00.000Z',
                    status: 'active',
                    session_id: '12',
                    menu_level: 0
                })
        });
        const app = buildApp(db);

        const res = await request(app)
            .get('/api/ussd/session?deviceId=device-s');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            data: {
                active: true,
                currentCode: '*123#',
                lastRequest: '2026-04-19T12:00:00.000Z',
                menuLevel: 0,
                sessionId: '12',
                pending: false,
                lastResponse: '1. Balance\n2. Offers',
                menuOptions: [
                    { option: '1', label: 'Balance' },
                    { option: '2', label: 'Offers' }
                ]
            }
        });
    });

    test('clears history only for the active device', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 3 })
        });
        const app = buildApp(db);

        const res = await request(app)
            .delete('/api/ussd/history?deviceId=device-clear');

        expect(res.status).toBe(200);
        expect(db.run).toHaveBeenCalledWith('DELETE FROM ussd WHERE device_id = ?', ['device-clear']);
    });

    test('ending a session clears pending and active USSD rows for the device', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 2 })
        });
        global.mqttService = {
            connected: true,
            publishCommand: jest.fn().mockResolvedValue({ messageId: 'cancel-2' })
        };
        const app = buildApp(db);

        const res = await request(app)
            .post('/api/ussd/session/end?deviceId=device-clear');

        expect(res.status).toBe(200);
        expect(db.run).toHaveBeenCalledWith(
            `UPDATE ussd SET status = 'cancelled' WHERE device_id = ? AND status IN ('pending', 'active')`,
            ['device-clear']
        );
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'device-clear',
            'cancel-ussd',
            {},
            true,
            15000,
            {
                source: 'dashboard:ussd',
                domain: 'telephony',
                skipPersistentQueue: true
            }
        );
    });
});
