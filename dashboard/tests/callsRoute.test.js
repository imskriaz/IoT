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
        get: jest.fn().mockResolvedValue({ count: 0 }),
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
    app.use('/api/calls', require('../routes/calls'));
    return app;
}

describe('calls API device scoping', () => {
    afterEach(() => {
        jest.resetModules();
        delete global.mqttService;
        delete global.modemService;
    });

    test('scopes call logs to the requested device', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ count: 0 }),
            all: jest.fn().mockResolvedValue([])
        });
        const app = buildApp(db);

        const res = await request(app).get('/api/calls/logs?deviceId=device-b&page=1&limit=10');

        expect(res.status).toBe(200);
        expect(db.get).toHaveBeenCalledWith(expect.stringContaining('WHERE device_id = ?'), ['device-b']);
        expect(db.all).toHaveBeenCalledWith(expect.stringContaining('WHERE c.device_id = ?'), ['device-b', 10, 0]);
    });

    test('scopes call logs to the requested sim slot', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ count: 0 }),
            all: jest.fn().mockResolvedValue([])
        });
        const app = buildApp(db);

        const res = await request(app).get('/api/calls/logs?deviceId=device-b&simSlot=1&page=1&limit=10');

        expect(res.status).toBe(200);
        expect(db.get).toHaveBeenCalledWith(expect.stringContaining('sim_slot = ?'), ['device-b', 1]);
        expect(db.all).toHaveBeenCalledWith(expect.stringContaining('c.sim_slot = ?'), ['device-b', 1, 10, 0]);
    });

    test('scopes call stats to the requested device', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ count: 0 })
        });
        const app = buildApp(db);

        const res = await request(app).get('/api/calls/stats?deviceId=device-c');

        expect(res.status).toBe(200);
        expect(db.get).toHaveBeenCalledTimes(5);
        expect(db.get.mock.calls.every(([, params]) => params[0] === 'device-c')).toBe(true);
    });

    test('clears only the active device call logs', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 4 })
        });
        const app = buildApp(db);

        const res = await request(app)
            .delete('/api/calls/clear')
            .send({ deviceId: 'device-clear' });

        expect(res.status).toBe(200);
        expect(res.body.deleted).toBe(4);
        expect(db.run).toHaveBeenCalledWith('DELETE FROM calls WHERE device_id = ?', ['device-clear']);
    });

    test('dispatches hold commands through the runtime MQTT lane without persistent queueing', async () => {
        global.mqttService = {
            publishCommand: jest.fn().mockResolvedValue({ queued: false, messageId: 'm-1' }),
            runDeviceOperation: jest.fn((_deviceId, task) => task())
        };
        const app = buildApp(makeDbMock());

        const res = await request(app)
            .post('/api/calls/hold')
            .send({ deviceId: 'device-hold', hold: true });

        expect(res.status).toBe(200);
        expect(res.body.queued).toBe(false);
        expect(global.mqttService.runDeviceOperation).toHaveBeenCalledWith('device-hold', expect.any(Function));
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'device-hold',
            'hold-call',
            { hold: true },
            false,
            15000,
            {
                source: 'dashboard:calls',
                domain: 'telephony',
                skipPersistentQueue: true
            }
        );
    });

    test('dispatches call history sync through the device command lane', async () => {
        global.mqttService = {
            publishCommand: jest.fn().mockResolvedValue({ queued: false, messageId: 'sync-1' }),
            runDeviceOperation: jest.fn((_deviceId, task) => task())
        };
        const app = buildApp(makeDbMock());

        const res = await request(app)
            .post('/api/calls/sync')
            .send({ deviceId: 'device-sync', simSlot: 1 });

        expect(res.status).toBe(200);
        expect(res.body.messageId).toBe('sync-1');
        expect(global.mqttService.runDeviceOperation).toHaveBeenCalledWith('device-sync', expect.any(Function));
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'device-sync',
            'sync-calls',
            { mode: 'new', sim_slot: 1 },
            false,
            90000,
            {
                source: 'dashboard:calls',
                domain: 'telephony'
            }
        );
    });

    test('keeps call end runtime-only and avoids queue wording when voice transport is busy', async () => {
        global.modemService = {
            getStatus: jest.fn().mockReturnValue({
                call: { transportSuspended: true }
            })
        };
        global.mqttService = {
            publishCommand: jest.fn().mockResolvedValue({ queued: false, messageId: 'm-end' }),
            runDeviceOperation: jest.fn((_deviceId, task) => task())
        };
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 1 })
        });
        const app = buildApp(db);

        const res = await request(app)
            .post('/api/calls/end')
            .send({ deviceId: 'device-call' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.transportSuspended).toBe(true);
        expect(res.body.queued).toBe(false);
        expect(res.body.message).toBe('Call end requested while voice transport is busy');
        expect(res.body.message.toLowerCase()).not.toContain('queued');
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'device-call',
            'end-call',
            {},
            false,
            45000,
            {
                source: 'dashboard:calls',
                domain: 'telephony',
                skipPersistentQueue: true
            }
        );
    });

    test('does not treat ending calls as active in the polled status endpoint', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue(null)
        });
        const app = buildApp(db);

        const res = await request(app)
            .get('/api/calls/status?deviceId=device-call');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual({ active: false });
        expect(db.get).toHaveBeenCalledWith(
            expect.not.stringContaining("'ending'"),
            ['device-call']
        );
    });

    test('reconciles stale active call rows when live device state reports no active call', async () => {
        global.modemService = {
            getStatus: jest.fn().mockReturnValue({
                call: { active: false }
            })
        };
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue(null),
            run: jest.fn().mockResolvedValue({ changes: 2 })
        });
        const app = buildApp(db);

        const res = await request(app)
            .get('/api/calls/status?deviceId=device-call&simSlot=0');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual({ active: false });
        expect(global.modemService.getStatus).toHaveBeenCalledWith('device-call');
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining("status IN ('dialing', 'ringing', 'connected', 'answered', 'ending', 'online')"),
            ['ended', 'device-call', 0]
        );
    });
});
