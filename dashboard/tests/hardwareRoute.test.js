'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const Database = require('better-sqlite3');

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const configuration = () => ({
    schema: 1, boardId: 'waveshare-esp32-s3-a7670e-4g-v2', boardVersion: '1', modules: []
});

describe('hardware configuration routes with real SQLite transactions and authorization', () => {
    let raw, app;
    beforeEach(() => {
        raw = new Database(':memory:');
        raw.pragma('foreign_keys = ON');
        raw.exec(`
            CREATE TABLE devices (id TEXT PRIMARY KEY);
            CREATE TABLE users (id INTEGER PRIMARY KEY);
            CREATE TABLE device_users (device_id TEXT, user_id INTEGER, can_write INTEGER);
            CREATE TABLE device_status_cache (device_id TEXT PRIMARY KEY, payload_json TEXT);
            INSERT INTO devices VALUES ('board-a'), ('board-b');
            INSERT INTO users VALUES (7);
            INSERT INTO device_users VALUES ('board-a', 7, 1);
        `);
        // Run the production hardware schema; regressions in column/trigger
        // definitions must fail these behavioral tests too.
        const source = fs.readFileSync(path.join(__dirname, '../config/database.js'), 'utf8');
        const schema = source.match(/await db\.exec\(`(\s*CREATE TABLE IF NOT EXISTS hardware_catalog_revisions[\s\S]*?)`\);/);
        if (!schema) throw new Error('Production hardware schema block missing');
        raw.exec(schema[1]);
        const trigger = source.match(/await db\.exec\(`(\s*CREATE TRIGGER IF NOT EXISTS hardware_apply_job_immutable_request[\s\S]*?)`\);/);
        if (!trigger) throw new Error('Production hardware immutable request trigger missing');
        raw.exec(trigger[1]);
        app = express();
        app.use(express.json());
        app.locals.db = {
            _raw: raw,
            get: async (sql, values = []) => raw.prepare(sql).get(...values),
            all: async (sql, values = []) => raw.prepare(sql).all(...values)
        };
        app.use((req, _res, next) => {
            req.user = { id: 7, username: 'hardware-operator', role: 'operator' };
            if (req.headers['x-test-role']) req.user.role = req.headers['x-test-role'];
            if (req.headers['x-test-device-scope']) req.apiKeyDeviceIds = [req.headers['x-test-device-scope']];
            next();
        });
        app.use('/api/devices', require('../routes/hardware'));
        app.use((error, _req, res, _next) => res.status(500).json({ success: false, message: error.message }));
    });
    afterEach(() => raw.close());

    const apply = (target, body) => request(target).post('/api/devices/board-a/hardware/apply').send(body);

    test.each([undefined, null, '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, false])(
        'requires a nonnegative safe integer expectedRevision (%s)', async expectedRevision => {
            const response = await apply(app, { configuration: configuration(), expectedRevision });
            expect(response.status).toBe(400);
            expect(raw.prepare('SELECT count(*) AS n FROM device_hardware_configs').get().n).toBe(0);
        }
    );

    test('persists desired intent and its exact immutable snapshot, while keeping applied state empty', async () => {
        const response = await apply(app, { configuration: configuration(), expectedRevision: 0 });
        expect(response.status).toBe(202);
        expect(response.body).toMatchObject({ revision: 1, blocked: true, pending: false, status: 'blocked_driver' });
        const desired = raw.prepare('SELECT * FROM device_hardware_configs').get();
        const job = raw.prepare('SELECT * FROM device_hardware_apply_jobs').get();
        expect(desired.applied_revision).toBeNull();
        expect(desired.observed_revision).toBeNull();
        expect(job.requested_config_json).toBe(desired.desired_json);
        expect(job.requested_hash).toBe(desired.desired_hash);
        expect(job.catalog_version).toBeTruthy();
        const loaded = await request(app).get(`/api/devices/board-a/hardware/jobs/${job.action_id}`);
        expect(loaded.body.job.configuration).toEqual(configuration());
    });

    test('rolls back a first desired insert if the job insert fails', async () => {
        raw.exec("CREATE TRIGGER reject_job BEFORE INSERT ON device_hardware_apply_jobs BEGIN SELECT RAISE(ABORT, 'disk fault simulation'); END");
        expect((await apply(app, { configuration: configuration(), expectedRevision: 0 })).status).toBe(500);
        expect(raw.prepare('SELECT count(*) AS n FROM device_hardware_configs').get().n).toBe(0);
        expect(raw.prepare('SELECT count(*) AS n FROM device_hardware_apply_jobs').get().n).toBe(0);
    });

    test('rolls back an existing desired update if the new job insert fails', async () => {
        await apply(app, { configuration: configuration(), expectedRevision: 0 });
        const before = raw.prepare('SELECT * FROM device_hardware_configs').get();
        raw.exec("CREATE TRIGGER reject_job BEFORE INSERT ON device_hardware_apply_jobs BEGIN SELECT RAISE(ABORT, 'disk fault simulation'); END");
        expect((await apply(app, { configuration: configuration(), expectedRevision: 1 })).status).toBe(500);
        expect(raw.prepare('SELECT * FROM device_hardware_configs').get()).toEqual(before);
        expect(raw.prepare('SELECT count(*) AS n FROM device_hardware_apply_jobs').get().n).toBe(1);
    });

    test('concurrent requests with the same expected revision commit exactly once', async () => {
        const results = await Promise.all([
            apply(app, { configuration: configuration(), expectedRevision: 0 }),
            apply(app, { configuration: configuration(), expectedRevision: 0 })
        ]);
        expect(results.map(r => r.status).sort()).toEqual([202, 409]);
        expect(raw.prepare('SELECT desired_revision FROM device_hardware_configs').get().desired_revision).toBe(1);
        expect(raw.prepare('SELECT count(*) AS n FROM device_hardware_apply_jobs').get().n).toBe(1);
    });

    test('new revisions preserve prior snapshots and server epoch without claiming readiness', async () => {
        await apply(app, { configuration: configuration(), expectedRevision: 0 });
        const first = raw.prepare('SELECT * FROM device_hardware_apply_jobs').get();
        raw.prepare("UPDATE device_hardware_configs SET enrollment_epoch = 'server-epoch' WHERE device_id = 'board-a'").run();
        const next = configuration();
        next.modules = [{ instanceId: 'screen', typeId: 'display.generic-i2c', catalogVersion: '1', parameters: { width: 128, height: 64 } }];
        const response = await apply(app, { configuration: next, expectedRevision: 1, enrollmentEpoch: 'forged' });
        expect(response.status).toBe(202);
        expect(raw.prepare('SELECT * FROM device_hardware_apply_jobs WHERE action_id = ?').get(first.action_id)).toEqual(first);
        const second = raw.prepare('SELECT * FROM device_hardware_apply_jobs WHERE requested_revision = 2').get();
        expect(second.enrollment_epoch).toBe('server-epoch');
        expect(second.previous_hash).toBe(first.requested_hash);
        expect(JSON.parse(second.requested_config_json).modules[0].instanceId).toBe('screen');
    });

    test('browser manifest and epoch cannot grant apply support or establish enrollment', async () => {
        const body = { configuration: configuration(), expectedRevision: 0, enrollmentEpoch: 'forged', manifest: { drivers: [], hardwareConfigApply: true } };
        const checked = await request(app).post('/api/devices/board-a/hardware/validate').send(body);
        expect(checked.status).toBe(200);
        expect(checked.body.applyEligible).toBe(false);
        expect(checked.body.warnings.some(w => w.code === 'missing_driver_manifest')).toBe(true);
        expect((await apply(app, body)).body.blocked).toBe(true);
        expect(raw.prepare('SELECT enrollment_epoch FROM device_hardware_apply_jobs').get().enrollment_epoch).toBeNull();
    });

    test('validation uses the server-reported manifest instead of a browser replacement', async () => {
        raw.prepare('INSERT INTO device_status_cache VALUES (?, ?)').run('board-a', JSON.stringify({ hardware: { driverManifest: { drivers: [] } } }));
        const config = configuration();
        config.modules = [{ instanceId: 'screen', typeId: 'display.generic-i2c', catalogVersion: '1' }];
        const response = await request(app).post('/api/devices/board-a/hardware/validate').send({
            configuration: config, manifest: { drivers: [{ id: 'display_i2c' }] }
        });
        expect(response.status).toBe(422);
        expect(response.body.errors.some(e => e.code === 'missing_driver')).toBe(true);
    });

    test('authorization rejects cross-device mutation and reading a foreign job', async () => {
        const created = await apply(app, { configuration: configuration(), expectedRevision: 0 });
        expect((await request(app).post('/api/devices/board-b/hardware/apply').send({ configuration: configuration(), expectedRevision: 0 })).status).toBe(403);
        expect((await request(app).get(`/api/devices/board-b/hardware/jobs/${created.body.actionId}`)).status).toBe(403);
        // Even with access to both devices, job lookup is device-scoped.
        raw.exec("INSERT INTO device_users VALUES ('board-b', 7, 1)");
        expect((await request(app).get(`/api/devices/board-b/hardware/jobs/${created.body.actionId}`)).status).toBe(404);
    });

    test('viewer and out-of-scope API key cannot create desired intent', async () => {
        expect((await request(app).post('/api/devices/board-a/hardware/apply').set('x-test-role', 'viewer').send({ configuration: configuration(), expectedRevision: 0 })).status).toBe(403);
        expect((await request(app).post('/api/devices/board-a/hardware/apply').set('x-test-device-scope', 'board-b').send({ configuration: configuration(), expectedRevision: 0 })).status).toBe(403);
        expect(raw.prepare('SELECT count(*) AS n FROM device_hardware_configs').get().n).toBe(0);
    });

    test('rejects invalid config without changing desired revision or adding a job', async () => {
        expect((await apply(app, { configuration: { ...configuration(), boardId: 'unknown' }, expectedRevision: 0 })).status).toBe(422);
        expect(raw.prepare('SELECT count(*) AS n FROM device_hardware_apply_jobs').get().n).toBe(0);
        expect(raw.prepare('SELECT count(*) AS n FROM device_hardware_configs').get().n).toBe(0);
    });

    test('fails closed when atomic storage is unavailable', async () => {
        delete app.locals.db._raw;
        expect((await apply(app, { configuration: configuration(), expectedRevision: 0 })).status).toBe(503);
    });

    test('database rejects rewriting a historical request but permits job result changes', async () => {
        await apply(app, { configuration: configuration(), expectedRevision: 0 });
        expect(() => raw.prepare("UPDATE device_hardware_apply_jobs SET requested_config_json = '{}' ").run()).toThrow();
        expect(() => raw.prepare("UPDATE device_hardware_apply_jobs SET requested_revision = 2").run()).toThrow();
        expect(() => raw.prepare("UPDATE device_hardware_apply_jobs SET enrollment_epoch = 'forged'").run()).toThrow();
        expect(() => raw.prepare("UPDATE device_hardware_apply_jobs SET status = 'failed', error_json = '{}' ").run()).not.toThrow();
    });
});
