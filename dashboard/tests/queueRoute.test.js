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
        exec: jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

function buildApp(router, sessionUser = { id: 1, role: 'admin', username: 'admin', deviceId: 'device-7' }, dbMock = null) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { user: sessionUser, deviceId: sessionUser.deviceId || '' };
        req.user = sessionUser;
        req.flash = jest.fn();
        next();
    });
    app.locals.db = dbMock || makeDbMock();
    app.use('/api/queue', router);
    return app;
}

describe('queue route bulk clear', () => {
    afterEach(() => {
        delete global.mqttService;
        jest.resetModules();
    });

    test('clears completed rows as part of device queue bulk clear', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ count: 4 }),
            run: jest.fn().mockResolvedValue({ changes: 4 })
        });
        global.mqttService = {
            _emitDeviceQueueState: jest.fn().mockResolvedValue(undefined)
        };

        const router = require('../routes/queue');
        const app = buildApp(router, { id: 1, role: 'admin', username: 'admin', deviceId: '7hd7g-xkdvx7-kv753n' }, db);

        const res = await request(app)
            .post('/api/queue/clear')
            .send({ deviceId: '7hd7g-xkdvx7-kv753n', scope: 'device' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual(expect.objectContaining({
            deleted: 4,
            deviceId: '7hd7g-xkdvx7-kv753n',
            scope: 'device'
        }));

        const countSql = db.get.mock.calls[0][0];
        const countParams = db.get.mock.calls[0][1];
        expect(countSql).toContain("status IN (?,?,?,?,?)");
        expect(countParams).toEqual([
            '7hd7g-xkdvx7-kv753n',
            'pending',
            'waiting_response',
            'failed',
            'ambiguous',
            'completed'
        ]);

        const deleteSql = db.run.mock.calls[0][0];
        const deleteParams = db.run.mock.calls[0][1];
        expect(deleteSql).toContain("DELETE FROM device_command_queue WHERE device_id = ? AND status IN (?,?,?,?,?)");
        expect(deleteParams).toEqual(countParams);
        expect(global.mqttService._emitDeviceQueueState).toHaveBeenCalledWith('7hd7g-xkdvx7-kv753n');
    });
});
