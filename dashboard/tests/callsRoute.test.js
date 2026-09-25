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

function buildApp(db, session = { user: { id: 1, username: 'tester', role: 'admin' }, deviceId: 'device-a' }) {
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

    test('rejects unsupported hold and mute without publishing', async () => {
        global.mqttService = {
            publishCommand: jest.fn().mockResolvedValue({ queued: false, messageId: 'm-1' }),
            runDeviceOperation: jest.fn((_deviceId, task) => task())
        };
        const app = buildApp(makeDbMock());

        const res = await request(app)
            .post('/api/calls/hold')
            .send({ deviceId: 'device-hold', hold: true });
        const mute = await request(app).post('/api/calls/mute').send({ deviceId: 'device-hold', mute: true });
        expect(res.status).toBe(501);
        expect(mute.status).toBe(501);
        expect(global.mqttService.publishCommand).not.toHaveBeenCalled();
    });

    test('dispatches call history sync through the device command lane', async () => {
        global.mqttService = {
            publishCommand: jest.fn().mockResolvedValue({ queued: false, messageId: 'sync-1' }),
            runDeviceOperation: jest.fn((_deviceId, task) => task())
        };
        const app = buildApp(makeDbMock({ get: jest.fn().mockResolvedValue({ board: 'android' }) }));

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
            publishCommand: jest.fn().mockResolvedValue({ result: 'completed', messageId: 'm-end' }),
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
        expect(res.body.message).toBe('Device accepted hangup while voice transport is busy; waiting for call state');
        expect(res.body.message.toLowerCase()).not.toContain('queued');
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'device-call',
            'end-call',
            {},
            true,
            45000,
            {
                source: 'dashboard:calls',
                domain: 'telephony',
                skipPersistentQueue: true
            }
        );
    });

    test('does not create a dial row from a broker publish receipt or device failure', async () => {
        const db = makeDbMock();
        global.mqttService = {
            publishCommand: jest.fn()
                .mockResolvedValueOnce({ messageId: 'publish-only' })
                .mockResolvedValueOnce({ result: 'failed', message: 'modem busy' }),
            runDeviceOperation: jest.fn((_deviceId, task) => task())
        };
        const app = buildApp(db);
        const first = await request(app).post('/api/calls/dial').send({ deviceId: 'device-call', number: '+15551234567' });
        const second = await request(app).post('/api/calls/dial').send({ deviceId: 'device-call', number: '+15551234567' });
        expect(first.status).toBe(202);
        expect(first.body.pending).toBe(true);
        expect(second.status).toBe(502);
        expect(db.run).not.toHaveBeenCalled();
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'device-call', 'make-call', expect.objectContaining({ number: '+15551234567' }),
            true, 45000, expect.objectContaining({ skipPersistentQueue: true })
        );
    });

    test('does not change call rows when hangup fails', async () => {
        const db = makeDbMock();
        global.mqttService = {
            publishCommand: jest.fn().mockResolvedValue({ result: 'rejected', message: 'no active call' }),
            runDeviceOperation: jest.fn((_deviceId, task) => task())
        };
        const res = await request(buildApp(db)).post('/api/calls/end').send({ deviceId: 'device-call' });
        expect(res.status).toBe(502);
        expect(db.run).not.toHaveBeenCalled();
    });

    test('rejects ESP32 answer, reject, and sync before device publish', async () => {
        const db = makeDbMock({ get: jest.fn().mockResolvedValue({ board: 'ESP32-S3-A7670E' }) });
        global.mqttService = { publishCommand: jest.fn(), runDeviceOperation: jest.fn() };
        const app = buildApp(db);
        const answer = await request(app).post('/api/calls/answer').send({ deviceId: 'device-call' });
        const reject = await request(app).post('/api/calls/reject').send({ deviceId: 'device-call' });
        const sync = await request(app).post('/api/calls/sync').send({ deviceId: 'device-call' });
        expect([answer.status, reject.status, sync.status]).toEqual([501, 501, 501]);
        expect(db.run).not.toHaveBeenCalled();
        expect(global.mqttService.publishCommand).not.toHaveBeenCalled();
    });

    test('does not mutate Android call history before answer/reject terminal results', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ board: 'android' })
        });
        global.mqttService = {
            publishCommand: jest.fn()
                .mockResolvedValueOnce({ messageId: 'answer-pending' })
                .mockResolvedValueOnce({ result: 'rejected', message: 'no ringing call', messageId: 'reject-failed' }),
            runDeviceOperation: jest.fn((_deviceId, task) => task())
        };
        const app = buildApp(db);

        const answer = await request(app).post('/api/calls/answer').send({ deviceId: 'device-android' });
        const reject = await request(app).post('/api/calls/reject').send({ deviceId: 'device-android' });

        expect(answer.status).toBe(202);
        expect(answer.body).toEqual(expect.objectContaining({ success: false, pending: true, messageId: 'answer-pending' }));
        expect(reject.status).toBe(502);
        expect(reject.body).toEqual(expect.objectContaining({ success: false, pending: false, messageId: 'reject-failed' }));
        expect(db.run).not.toHaveBeenCalled();
        expect(global.mqttService.publishCommand).toHaveBeenNthCalledWith(
            1, 'device-android', 'answer-call', {}, true, 45000,
            { source: 'dashboard:calls', domain: 'telephony', skipPersistentQueue: true }
        );
        expect(global.mqttService.publishCommand).toHaveBeenNthCalledWith(
            2, 'device-android', 'reject-call', {}, true, 45000,
            { source: 'dashboard:calls', domain: 'telephony', skipPersistentQueue: true }
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
                online: true,
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

    test('reconciles an active database row before reporting status from a fresh inactive device', async () => {
        global.modemService = { getStatus: jest.fn().mockReturnValue({ online: true, call: { active: false } }) };
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue(null),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        });
        const res = await request(buildApp(db)).get('/api/calls/status?deviceId=device-call');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ active: false });
        expect(db.run.mock.invocationCallOrder[0]).toBeLessThan(db.get.mock.invocationCallOrder[0]);
    });
});
