'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { deviceId: 'device-1', user: { id: 1 } };
        next();
    });
    app.use('/api/esp32-console', require('../routes/esp32Console'));
    return app;
}

describe('ESP32 MQTT console route', () => {
    afterEach(() => {
        delete global.mqttService;
        jest.resetModules();
    });

    test('returns command presets and vendor notes', async () => {
        const app = buildApp();

        const res = await request(app).get('/api/esp32-console/commands');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.presets).toEqual(expect.arrayContaining([
            expect.objectContaining({ command: 'get-status' }),
            expect.objectContaining({ command: 'modem-at' })
        ]));
        expect(res.body.data.vendorNotes.length).toBeGreaterThan(0);
    });

    test('publishes live MQTT command without persistent queue or compatibility fallback', async () => {
        const publishCommand = jest.fn().mockResolvedValue({
            success: true,
            detail: 'status_snapshot'
        });
        global.mqttService = { publishCommand };
        const app = buildApp();

        const res = await request(app)
            .post('/api/esp32-console/command')
            .send({
                command: 'get-status',
                payload: {},
                waitForResponse: true,
                timeoutMs: 15000
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(publishCommand).toHaveBeenCalledWith(
            'device-1',
            'get-status',
            {},
            true,
            15000,
            expect.objectContaining({
                source: 'dashboard-esp32-console',
                skipPersistentQueue: true,
                bypassCompatibility: true,
                domain: 'status'
            })
        );
    });

    test('rejects invalid command names', async () => {
        global.mqttService = { publishCommand: jest.fn() };
        const app = buildApp();

        const res = await request(app)
            .post('/api/esp32-console/command')
            .send({ command: 'device/1/command/get-status', payload: {} });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(global.mqttService.publishCommand).not.toHaveBeenCalled();
    });
});
