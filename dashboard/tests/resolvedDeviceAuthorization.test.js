'use strict';

const express = require('express');
const request = require('supertest');
const Database = require('better-sqlite3');

jest.mock('../config/device', () => ({ DEFAULT_DEVICE_ID: 'default-device' }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { requireDeviceAccess } = require('../middleware/auth');
const { resolveDeviceId } = require('../utils/deviceResolver');
const queueRouter = require('../routes/queue');

describe('resolved device authorization and handler identity', () => {
    let sqlite;
    let db;
    let runtimeQueue;

    function app({ deviceId, apiKeyDeviceIds, role = 'operator' } = {}) {
        const server = express();
        server.use(express.json());
        server.locals.db = db;
        server.use((req, _res, next) => {
            req.user = { id: 7, role };
            req.session = { deviceId };
            req.apiKeyDeviceIds = apiKeyDeviceIds;
            next();
        });
        server.get('/api/devices/:id/target', requireDeviceAccess('id'), (req, res) => {
            res.json({ deviceId: resolveDeviceId(req) });
        });
        server.use('/api/queue', queueRouter);
        return server;
    }

    beforeEach(() => {
        sqlite = new Database(':memory:');
        sqlite.exec(`
            CREATE TABLE device_users (device_id TEXT, user_id INTEGER, can_write INTEGER);
            CREATE TABLE device_command_queue (id TEXT PRIMARY KEY, device_id TEXT, command TEXT, status TEXT);
            INSERT INTO device_users VALUES ('mine', 7, 1);
            INSERT INTO device_command_queue VALUES ('mine', 'foreign', 'get-status', 'completed');
            INSERT INTO device_command_queue VALUES ('job-1', 'mine', 'get-status', 'completed');
            INSERT INTO device_command_queue VALUES ('default-job', 'default-device', 'get-status', 'completed');
        `);
        db = {
            get: jest.fn(async (sql, params = []) => sqlite.prepare(sql).get(...params)),
            run: jest.fn(async (sql, params = []) => sqlite.prepare(sql).run(...params))
        };
        runtimeQueue = jest.fn().mockResolvedValue({});
        global.mqttService = { _emitDeviceQueueState: runtimeQueue };
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(false),
            getAllDevices: jest.fn().mockReturnValue([])
        };
    });

    afterEach(() => {
        sqlite.close();
        delete global.modemService;
        delete global.mqttService;
    });

    test('a record ID equal to an assigned device cannot authorize another selected device', async () => {
        const response = await request(app({ deviceId: 'foreign' })).delete('/api/queue/mine');
        expect(response.status).toBe(403);
        expect(sqlite.prepare('SELECT id FROM device_command_queue WHERE id = ?').get('mine')).toBeDefined();
        expect(db.run).not.toHaveBeenCalled();
        expect(runtimeQueue).not.toHaveBeenCalled();
    });

    test('admin key cannot use its allowed device as a record ID to escape scope', async () => {
        const response = await request(app({ deviceId: 'foreign', role: 'admin', apiKeyDeviceIds: ['mine'] }))
            .delete('/api/queue/mine');
        expect(response.status).toBe(403);
        expect(db.run).not.toHaveBeenCalled();
    });

    test('session selection permits deleting an owned record without a repeated selector', async () => {
        const response = await request(app({ deviceId: 'mine' })).delete('/api/queue/job-1');
        expect(response.status).toBe(200);
        expect(sqlite.prepare('SELECT id FROM device_command_queue WHERE id = ?').get('job-1')).toBeUndefined();
        expect(runtimeQueue).toHaveBeenCalledWith('mine');
        expect(db.get).toHaveBeenCalledWith(expect.stringContaining('FROM device_users'), ['mine', 7]);
    });

    test('default device fallback requires assignment and respects scoped admin keys', async () => {
        expect((await request(app()).delete('/api/queue/default-job')).status).toBe(403);
        expect((await request(app({ role: 'admin', apiKeyDeviceIds: ['mine'] })).delete('/api/queue/default-job')).status).toBe(403);
        sqlite.prepare('INSERT INTO device_users VALUES (?, ?, ?)').run('default-device', 7, 1);
        expect((await request(app()).delete('/api/queue/default-job')).status).toBe(200);
    });

    test('single online fallback is authorized and stays pinned while assignment lookup awaits', async () => {
        global.modemService.getAllDevices.mockReturnValue([{ id: 'mine', online: true }]);
        db.get.mockImplementation(async (sql, params = []) => {
            const row = sqlite.prepare(sql).get(...params);
            if (sql.includes('FROM device_users')) {
                await Promise.resolve();
                global.modemService.getAllDevices.mockReturnValue([{ id: 'foreign', online: true }]);
            }
            return row;
        });
        const response = await request(app()).delete('/api/queue/job-1');
        expect(response.status).toBe(200);
        expect(runtimeQueue).toHaveBeenCalledWith('mine');
        expect(db.get).toHaveBeenCalledWith(expect.stringContaining('WHERE id = ? AND device_id = ?'), ['job-1', 'mine']);
    });

    test('an unassigned single online device never reaches queue storage', async () => {
        global.modemService.getAllDevices.mockReturnValue([{ id: 'foreign', online: true }]);
        expect((await request(app()).delete('/api/queue/mine')).status).toBe(403);
        expect(db.get).toHaveBeenCalledTimes(1);
        expect(db.run).not.toHaveBeenCalled();
    });

    test('a route may explicitly declare id as a device ID and override session selection', async () => {
        const response = await request(app({ deviceId: 'foreign' })).get('/api/devices/mine/target');
        expect(response.status).toBe(200);
        expect(response.body.deviceId).toBe('mine');
    });

    test('conflicting explicit selectors still fail before storage or runtime access', async () => {
        expect((await request(app()).get('/api/devices/mine/target?deviceId=foreign')).status).toBe(400);
        expect((await request(app()).delete('/api/queue/job-1?deviceId=mine').set('x-device-id', 'foreign')).status).toBe(400);
        expect(db.get).not.toHaveBeenCalled();
        expect(db.run).not.toHaveBeenCalled();
    });
});
