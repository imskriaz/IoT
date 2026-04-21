'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../utils/moduleHealth', () => ({
    getDeviceModuleHealth: jest.fn(),
    markModuleFailure: jest.fn().mockResolvedValue(undefined),
    markModuleSuccess: jest.fn().mockResolvedValue(undefined),
    upsertModuleHealth: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../utils/deviceCapabilities', () => ({
    getDeviceCapabilities: jest.fn()
}));

jest.mock('../services/webcamCaptureService', () => ({
    saveCapture: jest.fn(),
    listCaptures: jest.fn(),
    getCaptureSummary: jest.fn(),
    deleteCapture: jest.fn()
}));

describe('POST /api/intercom/call/start', () => {
    function buildApp(router, dbMock) {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.session = { user: { id: 1, role: 'admin', username: 'admin' } };
            req.user = req.session.user;
            next();
        });
        app.locals.db = dbMock;
        app.use('/api/intercom', router);
        return app;
    }

    beforeEach(() => {
        jest.resetModules();
        delete global.mqttService;
        delete global.io;
        delete global.app;
    });

    test('persists active intercom state immediately after a call starts', async () => {
        const persistedRuns = [];
        const backingDb = {
            prepare: jest.fn().mockReturnValue({
                all: jest.fn().mockReturnValue([]),
                run: jest.fn((...args) => {
                    persistedRuns.push(args);
                })
            })
        };

        jest.doMock('../config/database', () => ({
            getDatabase: () => backingDb
        }));

        const dbMock = {
            get: jest.fn().mockResolvedValue(null),
            run: jest.fn().mockResolvedValue({ lastID: 0, changes: 1 })
        };

        global.mqttService = {
            connected: true,
            publishCommand: jest.fn().mockResolvedValue({ success: true })
        };

        const router = require('../routes/intercom');
        const app = buildApp(router, dbMock);

        const res = await request(app)
            .post('/api/intercom/call/start')
            .send({ deviceId: 'device-42', type: 'audio' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith('device-42', 'intercom-call-start', {
            callId: expect.any(String),
            type: 'audio'
        });
        expect(backingDb.prepare).toHaveBeenCalled();
        expect(persistedRuns).toEqual([
            ['device-42', 1, 'audio', null]
        ]);
    });
});

describe('GET /api/intercom/status', () => {
    function buildApp(router, dbMock) {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.session = { user: { id: 1, role: 'admin', username: 'admin' } };
            req.user = req.session.user;
            next();
        });
        app.locals.db = dbMock;
        app.use('/api/intercom', router);
        return app;
    }

    beforeEach(() => {
        jest.resetModules();
        delete global.mqttService;
        delete global.modemService;
        delete global.io;
        delete global.app;
    });

    test('uses normalized device status as the source of truth for online state', async () => {
        const { getDeviceCapabilities } = require('../utils/deviceCapabilities');
        const { getDeviceModuleHealth } = require('../utils/moduleHealth');

        getDeviceCapabilities.mockResolvedValue({
            caps: {
                camera: true,
                audio: true
            }
        });
        getDeviceModuleHealth.mockResolvedValue([]);

        global.mqttService = {
            connected: true,
            isDeviceOnline: jest.fn().mockReturnValue(true)
        };
        global.modemService = {
            getDeviceStatus: jest.fn().mockReturnValue({
                online: false,
                lastSeen: '2026-04-12T10:00:00.000Z'
            })
        };

        const dbMock = {
            get: jest.fn().mockResolvedValue(null)
        };

        const router = require('../routes/intercom');
        const app = buildApp(router, dbMock);

        const res = await request(app).get('/api/intercom/status?deviceId=device-42');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.headers['cache-control']).toContain('no-store');
        expect(res.headers.pragma).toBe('no-cache');
        expect(res.headers.expires).toBe('0');
        expect(res.body.data.online).toBe(false);
        expect(res.body.data.support).toEqual(expect.objectContaining({
            signaling: true,
            camera: true,
            audio: true,
            intercom: true
        }));
        expect(getDeviceModuleHealth).toHaveBeenCalledWith(
            dbMock,
            'device-42',
            expect.objectContaining({
                camera: true,
                audio: true
            }),
            expect.objectContaining({
                mqttConnected: true,
                live: expect.objectContaining({
                    online: false,
                    lastSeen: '2026-04-12T10:00:00.000Z'
                })
            })
        );
    });

    test('marks capture list responses as non-cacheable', async () => {
        const { listCaptures, getCaptureSummary } = require('../services/webcamCaptureService');

        listCaptures.mockResolvedValue([]);
        getCaptureSummary.mockResolvedValue({
            total: 0,
            motionDetected: 0,
            faceDetected: 0,
            recognized: 0
        });

        const dbMock = {
            get: jest.fn().mockResolvedValue(null)
        };

        const router = require('../routes/intercom');
        const app = buildApp(router, dbMock);

        const res = await request(app).get('/api/intercom/captures?deviceId=device-42');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.headers['cache-control']).toContain('no-store');
        expect(res.headers.pragma).toBe('no-cache');
        expect(res.headers.expires).toBe('0');
        expect(listCaptures).toHaveBeenCalledWith(expect.objectContaining({
            deviceId: 'device-42'
        }));
        expect(getCaptureSummary).toHaveBeenCalledWith(dbMock, 'device-42');
    });
});
