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
            scope: 'device',
            status: 'all'
        }));

        const countSql = db.get.mock.calls[0][0];
        const countParams = db.get.mock.calls[0][1];
        expect(countSql).toContain("status IN (?,?,?,?,?)");
        expect(countSql).toContain("command NOT IN (?,?,?,?,?,?,?)");
        expect(countParams).toEqual([
            '7hd7g-xkdvx7-kv753n',
            'pending',
            'waiting_response',
            'failed',
            'ambiguous',
            'completed',
            'make-call',
            'call-dial',
            'answer-call',
            'reject-call',
            'end-call',
            'hold-call',
            'mute-call'
        ]);

        const deleteSql = db.run.mock.calls[0][0];
        const deleteParams = db.run.mock.calls[0][1];
        expect(deleteSql).toContain("DELETE FROM device_command_queue WHERE device_id = ? AND status IN (?,?,?,?,?)");
        expect(deleteSql).toContain("command NOT IN (?,?,?,?,?,?,?)");
        expect(deleteParams).toEqual(countParams);
        expect(global.mqttService._emitDeviceQueueState).toHaveBeenCalledWith('7hd7g-xkdvx7-kv753n');
    });

    test('clears only the selected status filter', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ count: 2 }),
            run: jest.fn().mockResolvedValue({ changes: 2 })
        });

        const router = require('../routes/queue');
        const app = buildApp(router, { id: 1, role: 'admin', username: 'admin', deviceId: 'device-7' }, db);

        const res = await request(app)
            .post('/api/queue/clear')
            .send({ deviceId: 'device-7', scope: 'all', status: 'failed' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual(expect.objectContaining({
            deleted: 2,
            deviceId: 'device-7',
            scope: 'all',
            status: 'failed'
        }));

        const countSql = db.get.mock.calls[0][0];
        const countParams = db.get.mock.calls[0][1];
        expect(countSql).toContain("status IN (?)");
        expect(countSql).not.toContain("command NOT IN");
        expect(countParams).toEqual(['device-7', 'failed']);

        const deleteParams = db.run.mock.calls[0][1];
        expect(deleteParams).toEqual(countParams);
    });

    test('open filter clears open statuses except active dispatching rows', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ count: 3 }),
            run: jest.fn().mockResolvedValue({ changes: 3 })
        });

        const router = require('../routes/queue');
        const app = buildApp(router, { id: 1, role: 'admin', username: 'admin', deviceId: 'device-7' }, db);

        const res = await request(app)
            .post('/api/queue/clear')
            .send({ deviceId: 'device-7', scope: 'call', status: 'open' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const countSql = db.get.mock.calls[0][0];
        const countParams = db.get.mock.calls[0][1];
        expect(countSql).toContain("status IN (?,?,?,?)");
        expect(countSql).toContain("command IN (?,?,?,?,?,?,?)");
        expect(countParams).toEqual([
            'device-7',
            'pending',
            'waiting_response',
            'failed',
            'ambiguous',
            'make-call',
            'call-dial',
            'answer-call',
            'reject-call',
            'end-call',
            'hold-call',
            'mute-call'
        ]);
    });
});

describe('queue route list ordering', () => {
    afterEach(() => {
        delete global.mqttService;
        jest.resetModules();
    });

    test('lists queue rows newest updated first without status grouping', async () => {
        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([
                {
                    id: 'queue-new',
                    command: 'restart-device',
                    status: 'completed',
                    updatedAt: '2026-04-24 14:30:00',
                    createdAt: '2026-04-24 14:29:00'
                }
            ])
        });
        global.mqttService = {
            getDeviceQueueState: jest.fn().mockResolvedValue({
                summary: { pending: 0, active: 0, failed: 0 },
                recent: []
            })
        };

        const router = require('../routes/queue');
        const app = buildApp(router, { id: 1, role: 'admin', username: 'admin', deviceId: 'device-7' }, db);

        const res = await request(app)
            .get('/api/queue')
            .query({ deviceId: 'device-7', scope: 'all', status: 'all', limit: 30 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.items).toHaveLength(1);
        expect(res.body.data).toEqual(expect.objectContaining({
            sort: 'updated',
            direction: 'desc'
        }));

        const sql = db.all.mock.calls[0][0];
        expect(sql).toContain('ORDER BY datetime(updated_at) DESC');
        expect(sql).toContain('datetime(created_at) DESC');
        expect(sql).not.toContain('WHEN status');
    });

    test('sorts by requested created timestamp direction', async () => {
        const db = makeDbMock();
        const router = require('../routes/queue');
        const app = buildApp(router, { id: 1, role: 'admin', username: 'admin', deviceId: 'device-7' }, db);

        const res = await request(app)
            .get('/api/queue')
            .query({ deviceId: 'device-7', scope: 'all', status: 'all', sort: 'created', direction: 'asc' });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(expect.objectContaining({
            sort: 'created',
            direction: 'asc'
        }));

        const sql = db.all.mock.calls[0][0];
        expect(sql).toContain('ORDER BY datetime(created_at) ASC');
    });

    test('sorts by requested attempts direction', async () => {
        const db = makeDbMock();
        const router = require('../routes/queue');
        const app = buildApp(router, { id: 1, role: 'admin', username: 'admin', deviceId: 'device-7' }, db);

        const res = await request(app)
            .get('/api/queue')
            .query({ deviceId: 'device-7', scope: 'all', status: 'all', sort: 'attempts', direction: 'desc' });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(expect.objectContaining({
            sort: 'attempts',
            direction: 'desc'
        }));

        const sql = db.all.mock.calls[0][0];
        expect(sql).toContain('ORDER BY attempt_count DESC');
        expect(sql).toContain('max_attempts DESC');
    });

    test('defaults command sort to ascending and rejects unknown sort fields', async () => {
        const db = makeDbMock();
        const router = require('../routes/queue');
        const app = buildApp(router, { id: 1, role: 'admin', username: 'admin', deviceId: 'device-7' }, db);

        const commandRes = await request(app)
            .get('/api/queue')
            .query({ deviceId: 'device-7', scope: 'all', status: 'all', sort: 'command' });

        expect(commandRes.status).toBe(200);
        expect(commandRes.body.data).toEqual(expect.objectContaining({
            sort: 'command',
            direction: 'asc'
        }));
        expect(db.all.mock.calls[0][0]).toContain('ORDER BY LOWER(command) ASC');

        const unsafeRes = await request(app)
            .get('/api/queue')
            .query({ deviceId: 'device-7', scope: 'all', status: 'all', sort: 'updated_at DESC; DROP TABLE users', direction: 'sideways' });

        expect(unsafeRes.status).toBe(200);
        expect(unsafeRes.body.data).toEqual(expect.objectContaining({
            sort: 'updated',
            direction: 'desc'
        }));
        expect(db.all.mock.calls[1][0]).toContain('ORDER BY datetime(updated_at) DESC');
        expect(db.all.mock.calls[1][0]).not.toContain('DROP TABLE');
    });
});
