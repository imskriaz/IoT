'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../config/device', () => ({ DEFAULT_DEVICE_ID: '' }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

function buildApp(route, mount, { user = { id: 9, role: 'operator' }, db, apiKeyDeviceIds } = {}) {
    const app = express();
    app.use(express.json());
    app.locals.db = db;
    app.use((req, _res, next) => {
        req.user = user;
        req.apiKeyDeviceIds = apiKeyDeviceIds;
        next();
    });
    app.use(mount, route);
    return app;
}

describe('GPIO and queue device authorization', () => {
    let db;
    let publishCommand;
    let queueState;

    beforeEach(() => {
        jest.resetModules();
        db = {
            get: jest.fn(async sql => String(sql).includes('FROM device_users') ? null : null),
            all: jest.fn().mockResolvedValue([]),
            run: jest.fn().mockResolvedValue({ changes: 0 })
        };
        publishCommand = jest.fn();
        queueState = jest.fn();
        global.mqttService = {
            connected: true,
            publishCommand,
            getDeviceQueueState: queueState,
            restartDevice: jest.fn(),
            restartModem: jest.fn()
        };
    });

    afterEach(() => {
        delete global.mqttService;
        delete global.io;
    });

    test.each([
        '/api/gpio/status?deviceId=foreign',
        '/api/gpio/pin/2?device_id=foreign',
        '/api/gpio/read/2?device=foreign'
    ])('unassigned user cannot read GPIO state through %s', async path => {
        const app = buildApp(require('../routes/gpio'), '/api/gpio', { db });
        const response = await request(app).get(path);
        expect(response.status).toBe(403);
        expect(publishCommand).not.toHaveBeenCalled();
    });

    test.each([
        ['/api/gpio/mode', { deviceId: 'foreign', pin: 2, mode: 'output' }],
        ['/api/gpio/write', { deviceId: 'foreign', pin: 2, value: 1 }],
        ['/api/gpio/pwm', { deviceId: 'foreign', pin: 2, duty: 20 }],
        ['/api/gpio/led', { deviceId: 'foreign', enabled: true }],
        ['/api/gpio/command', { deviceId: 'foreign', command: 'gpio-write', params: { pin: 2, value: 1 } }]
    ])('unassigned user cannot publish via %s', async (path, body) => {
        const app = buildApp(require('../routes/gpio'), '/api/gpio', { db });
        const response = await request(app).post(path).send(body);
        expect(response.status).toBe(403);
        expect(publishCommand).not.toHaveBeenCalled();
    });

    test('viewer and read-only assignee cannot mutate GPIO', async () => {
        db.get.mockResolvedValue({ can_write: 0 });
        const viewer = buildApp(require('../routes/gpio'), '/api/gpio', { user: { id: 9, role: 'viewer' }, db });
        expect((await request(viewer).post('/api/gpio/write').send({ deviceId: 'mine', pin: 2, value: 1 })).status).toBe(403);

        const operator = buildApp(require('../routes/gpio'), '/api/gpio', { db });
        expect((await request(operator).post('/api/gpio/write').send({ deviceId: 'mine', pin: 2, value: 1 })).status).toBe(403);
        expect(publishCommand).not.toHaveBeenCalled();
    });

    test('conflicting GPIO selectors fail before assignment lookup or publish', async () => {
        const app = buildApp(require('../routes/gpio'), '/api/gpio', { db });
        const response = await request(app)
            .post('/api/gpio/write?deviceId=mine')
            .send({ deviceId: 'foreign', pin: 2, value: 1 });
        expect(response.status).toBe(400);
        expect(db.get).not.toHaveBeenCalled();
        expect(publishCommand).not.toHaveBeenCalled();
    });

    test('queue records remain private to assigned devices', async () => {
        const app = buildApp(require('../routes/queue'), '/api/queue', { db });
        expect((await request(app).get('/api/queue?deviceId=foreign')).status).toBe(403);
        expect((await request(app).delete('/api/queue/job-1?deviceId=foreign')).status).toBe(403);
        expect(db.all).not.toHaveBeenCalled();
        expect(db.run).not.toHaveBeenCalled();
        expect(queueState).not.toHaveBeenCalled();
    });

    test.each(['/api/queue/clear', '/api/queue/actions/restart-device', '/api/queue/actions/restart-modem'])(
        'queue mutation %s requires device write access', async path => {
            db.get.mockResolvedValue({ can_write: 0 });
            const app = buildApp(require('../routes/queue'), '/api/queue', { db });
            const response = await request(app).post(path).send({ deviceId: 'mine' });
            expect(response.status).toBe(403);
            expect(db.run).not.toHaveBeenCalled();
            expect(global.mqttService.restartDevice).not.toHaveBeenCalled();
            expect(global.mqttService.restartModem).not.toHaveBeenCalled();
        }
    );

    test('admin API key scope cannot cross devices through GPIO or queue', async () => {
        const options = { user: { id: 1, role: 'admin' }, db, apiKeyDeviceIds: ['mine'] };
        const gpio = buildApp(require('../routes/gpio'), '/api/gpio', options);
        const queue = buildApp(require('../routes/queue'), '/api/queue', options);
        expect((await request(gpio).get('/api/gpio/status?deviceId=foreign')).status).toBe(403);
        expect((await request(queue).get('/api/queue?deviceId=foreign')).status).toBe(403);
        expect(publishCommand).not.toHaveBeenCalled();
        expect(db.all).not.toHaveBeenCalled();
    });

    test('GPIO status consumes the firmware action result and exposes only the implemented pin', async () => {
        publishCommand.mockResolvedValue({
            success: true,
            result: 'completed',
            receivedAt: '2026-09-17T00:00:00.000Z',
            payload: { pin: 2, level: 1, allowed_pins: [2] }
        });
        const app = buildApp(require('../routes/gpio'), '/api/gpio', {
            user: { id: 1, role: 'admin' },
            db
        });

        const response = await request(app).get('/api/gpio/status?deviceId=mine');

        expect(response.status).toBe(200);
        expect(response.body.data).toEqual(expect.objectContaining({
            online: true,
            cached: false,
            allowedPins: [2]
        }));
        expect(response.body.data.pins).toEqual([
            expect.objectContaining({ pin: 2, value: 1, mode: 'input_output' })
        ]);
        expect(publishCommand).toHaveBeenCalledWith(
            'mine',
            'gpio-status',
            {},
            true,
            12000,
            expect.objectContaining({ skipQueue: true, domain: 'status' })
        );
    });

    test('GPIO rejects unimplemented pins and features before publishing', async () => {
        const app = buildApp(require('../routes/gpio'), '/api/gpio', {
            user: { id: 1, role: 'admin' },
            db
        });

        expect((await request(app).post('/api/gpio/write').send({ deviceId: 'mine', pin: 33, value: 1 })).status).toBe(422);
        expect((await request(app).post('/api/gpio/mode').send({ deviceId: 'mine', pin: 2, mode: 'output' })).status).toBe(501);
        expect((await request(app).post('/api/gpio/pwm').send({ deviceId: 'mine', pin: 2, duty: 128 })).status).toBe(501);
        expect((await request(app).post('/api/gpio/led').send({ deviceId: 'mine', enabled: true })).status).toBe(501);
        expect((await request(app).post('/api/gpio/command').send({
            deviceId: 'mine',
            command: 'led',
            params: { r: 255, g: 0, b: 0 }
        })).status).toBe(422);
        expect((await request(app).post('/api/gpio/rules').send({
            deviceId: 'mine',
            name: 'unsupported LED rule',
            condition: 'pin2 === 1',
            action: { command: 'led', r: 255, g: 0, b: 0 }
        })).status).toBe(400);
        expect(publishCommand).not.toHaveBeenCalled();
    });

    test('timed GPIO writes use the device-owned bounded pulse command', async () => {
        publishCommand.mockResolvedValue({
            success: true,
            result: 'completed',
            payload: { pin: 2, pulse_ms: 500, final_level: 0, allowed_pins: [2] }
        });
        const app = buildApp(require('../routes/gpio'), '/api/gpio', {
            user: { id: 1, role: 'admin' },
            db
        });

        const response = await request(app)
            .post('/api/gpio/write')
            .send({ deviceId: 'mine', pin: 2, value: 1, type: 'digital', duration: 500 });

        expect(response.status).toBe(200);
        expect(response.body.data).toEqual(expect.objectContaining({
            pin: 2,
            value: 0,
            duration: 500,
            command: 'gpio-pulse'
        }));
        expect(publishCommand).toHaveBeenCalledWith(
            'mine',
            'gpio-pulse',
            { pin: 2, value: 1, ttl_ms: 500 },
            true,
            15000,
            expect.objectContaining({ domain: 'control' })
        );
    });

    test.each([
        { success: true, result: 'accepted', payload: { pin: 2, level: 1 } },
        { success: true, result: 'failed', payload: { pin: 2, level: 1 } },
        { success: true, result: 'completed', payload: { pin: 2, level: null } },
        { success: true, result: 'completed', payload: { pin: 2, level: '' } },
        { success: true, result: 'completed', payload: { level: 1 } },
        { success: true, result: 'completed', payload: { pin: 33, level: 1 } }
    ])('invalid or nonterminal GPIO results never become live LOW/HIGH: %j', async result => {
        publishCommand.mockResolvedValue(result);
        const app = buildApp(require('../routes/gpio'), '/api/gpio', { user: { id: 1, role: 'admin' }, db });
        const response = await request(app).get('/api/gpio/status?deviceId=mine');
        expect(response.body.data).toMatchObject({ online: false, cached: true });
        expect(response.body.data.pins[0].value).toBeNull();
    });

    test.each([1, 49, 10001, -1])('rejects pulse duration %s before hardware dispatch', async duration => {
        const app = buildApp(require('../routes/gpio'), '/api/gpio', { user: { id: 1, role: 'admin' }, db });
        const response = await request(app).post('/api/gpio/write').send({ deviceId: 'mine', pin: 2, value: 1, duration });
        expect(response.status).toBe(400);
        expect(publishCommand).not.toHaveBeenCalled();
    });

    test('generic GPIO pulse canonicalizes duration and excludes envelope overrides', async () => {
        const app = buildApp(require('../routes/gpio'), '/api/gpio', { user: { id: 1, role: 'admin' }, db });
        const response = await request(app).post('/api/gpio/command').send({
            deviceId: 'mine', command: 'gpio-pulse',
            params: { pin: '2', value: true, duration: 500, command: 'reboot', messageId: 'override' }
        });
        expect(response.status).toBe(200);
        expect(publishCommand).toHaveBeenCalledWith('mine', 'gpio-pulse', { pin: 2, value: 1, ttl_ms: 500 }, false);
    });

    test('generic GPIO rejects conflicting pulse durations before dispatch', async () => {
        const app = buildApp(require('../routes/gpio'), '/api/gpio', { user: { id: 1, role: 'admin' }, db });
        const response = await request(app).post('/api/gpio/command').send({
            deviceId: 'mine', command: 'gpio-pulse', params: { pin: 2, value: 1, duration: 500, ttl_ms: 1000 }
        });
        expect(response.status).toBe(400);
        expect(publishCommand).not.toHaveBeenCalled();
    });

    test.each([undefined, { success: true, result: 'accepted' }, { success: true, result: 'failed' }])(
        'generic GPIO does not claim completion for %j', async result => {
            publishCommand.mockResolvedValue(result);
            const app = buildApp(require('../routes/gpio'), '/api/gpio', { user: { id: 1, role: 'admin' }, db });
            const response = await request(app).post('/api/gpio/command').send({
                deviceId: 'mine', command: 'gpio-status', waitForResponse: true
            });
            expect(response.body.success).toBe(false);
        }
    );

    test('assigned operator can read its durable queue', async () => {
        db.get.mockImplementation(async sql => String(sql).includes('FROM device_users') ? { can_write: 1 } : null);
        db.all.mockResolvedValue([{ id: 12, deviceId: 'mine', status: 'pending' }]);
        queueState.mockResolvedValue({ summary: { pending: 1 } });
        const app = buildApp(require('../routes/queue'), '/api/queue', { db });
        const response = await request(app).get('/api/queue?deviceId=mine');
        expect(response.status).toBe(200);
        expect(response.body.data.items).toEqual([{ id: 12, deviceId: 'mine', status: 'pending' }]);
        expect(queueState).toHaveBeenCalledWith('mine');
    });

    test('USSD history and send cannot cross device assignment', async () => {
        const ussd = buildApp(require('../routes/ussd'), '/api/ussd', { db });
        expect((await request(ussd).get('/api/ussd/history?deviceId=foreign')).status).toBe(403);
        expect((await request(ussd).post('/api/ussd/send').send({ deviceId: 'foreign', code: '*123#' })).status).toBe(403);
        expect(publishCommand).not.toHaveBeenCalled();
    });

    test('call status and dial cannot cross device assignment', async () => {
        const calls = buildApp(require('../routes/calls'), '/api/calls', { db });
        expect((await request(calls).get('/api/calls/status?deviceId=foreign')).status).toBe(403);
        expect((await request(calls).post('/api/calls/dial').send({ deviceId: 'foreign', number: '+15551234567' })).status).toBe(403);
        expect(publishCommand).not.toHaveBeenCalled();
    });
});
