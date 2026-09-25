'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../config/device', () => ({ DEFAULT_DEVICE_ID: '' }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const modemService = require('../services/modemService');
const router = require('../routes/status');

describe('status HTTP device authorization', () => {
    let db;
    let runtimeRead;
    let publish;

    function app({ user = { id: 7, role: 'operator' }, session = {}, apiKeyDeviceIds, apiKey } = {}) {
        const server = express();
        server.use(express.json());
        server.locals.db = db;
        server.use((req, _res, next) => {
            Object.assign(req, { user, session, apiKeyDeviceIds, apiKey });
            next();
        });
        server.use('/api/status', router);
        return server;
    }

    beforeEach(() => {
        db = { get: jest.fn().mockResolvedValue(null), all: jest.fn().mockResolvedValue([]) };
        runtimeRead = jest.spyOn(modemService, 'getDeviceStatus');
        jest.spyOn(modemService, 'getAllDevices').mockReturnValue([
            { id: 'mine', online: false, status: { private: 'mine' } },
            { id: 'other', online: true, status: { private: 'other' } }
        ]);
        publish = jest.fn();
        global.mqttService = {
            connected: true, isDeviceOnline: jest.fn().mockReturnValue(true),
            publishCommand: publish, sendCommand: publish,
            getDeviceQueueState: jest.fn(), isDeviceBusy: jest.fn()
        };
        delete global.modemService;
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete global.mqttService;
        delete global.modemService;
    });

    function expectNoDeviceWork() {
        expect(runtimeRead).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(global.mqttService.getDeviceQueueState).not.toHaveBeenCalled();
        expect(global.mqttService.isDeviceBusy).not.toHaveBeenCalled();
        expect(db.get.mock.calls.every(([sql]) => sql.includes('FROM device_users'))).toBe(true);
    }

    test.each(['/api/status?deviceId=other&refresh=1', '/api/status', '/api/status/devices'])('unauthenticated %s is rejected', async url => {
        const response = await request(app({ user: null })).get(url);
        expect(response.status).toBe(401);
        expectNoDeviceWork();
    });

    test.each(['deviceId', 'device_id', 'device'])('unassigned %s cannot read cached status or refresh', async alias => {
        const response = await request(app()).get(`/api/status?${alias}=other&refresh=1`);
        expect(response.status).toBe(403);
        expect(db.get).toHaveBeenCalledWith(expect.stringContaining('FROM device_users'), ['other', 7]);
        expectNoDeviceWork();
    });

    test('implicit session and single-online selection still require assignment', async () => {
        expect((await request(app({ session: { deviceId: 'other' } })).get('/api/status?refresh=1')).status).toBe(403);
        global.modemService = modemService;
        expect((await request(app()).get('/api/status?refresh=1')).status).toBe(403);
        expectNoDeviceWork();
    });

    test('conflicting header and query selectors fail before device access', async () => {
        const response = await request(app()).get('/api/status?deviceId=mine&refresh=1').set('x-device-id', 'other');
        expect(response.status).toBe(400);
        expect(db.get).not.toHaveBeenCalled();
        expectNoDeviceWork();
    });

    test.each([
        { user: { id: 7, role: 'viewer' }, assignment: { can_write: 1 } },
        { user: { id: 7, role: 'operator' }, assignment: { can_write: 0 } },
        { user: { id: 7, role: 'operator' }, assignment: null }
    ])('module actions enforce role and write assignment: %j', async ({ user, assignment }) => {
        db.get.mockResolvedValue(assignment);
        const response = await request(app({ user })).post('/api/status/module-action').send({ device_id: 'other', moduleKey: 'wifi' });
        expect(response.status).toBe(403);
        expectNoDeviceWork();
    });

    test('history denies unassigned devices and rejects conflicting selectors', async () => {
        expect((await request(app()).get('/api/status/history/other')).status).toBe(403);
        expect((await request(app()).get('/api/status/history/mine?deviceId=other')).status).toBe(400);
        expectNoDeviceWork();
    });

    test('administrator API keys remain restricted on status and module actions', async () => {
        const server = app({ user: { id: 7, role: 'admin' }, apiKey: { device_ids: '["mine"]' } });
        expect((await request(server).get('/api/status?deviceId=other&refresh=1')).status).toBe(403);
        expect((await request(server).post('/api/status/module-action').send({ deviceId: 'other', moduleKey: 'wifi' })).status).toBe(403);
        expectNoDeviceWork();
    });

    test('device list includes assigned offline devices without exposing other status', async () => {
        db.all.mockResolvedValue([{ device_id: 'mine' }]);
        const response = await request(app()).get('/api/status/devices');
        expect(response.status).toBe(200);
        expect(response.body.data).toEqual([{ id: 'mine', online: false, status: { private: 'mine' } }]);
        expect(JSON.stringify(response.body)).not.toContain('other');
    });

    test('device list intersects key scope with user assignments', async () => {
        db.all.mockResolvedValue([{ device_id: 'mine' }]);
        const response = await request(app({ apiKeyDeviceIds: ['other'] })).get('/api/status/devices');
        expect(response.status).toBe(200);
        expect(response.body.data).toEqual([]);
    });

    test('administrator device list honors key scope and explicit selection', async () => {
        const server = app({ user: { id: 7, role: 'admin' }, apiKeyDeviceIds: ['mine'] });
        expect((await request(server).get('/api/status/devices')).body.data.map(d => d.id)).toEqual(['mine']);
        expect((await request(server).get('/api/status/devices?deviceId=other')).body.data).toEqual([]);
        expect(db.all).not.toHaveBeenCalled();
    });

    test('assignment storage failure does not return the unfiltered list', async () => {
        db.all.mockRejectedValue(new Error('database unavailable'));
        const response = await request(app()).get('/api/status/devices');
        expect(response.status).toBe(500);
        expect(response.body.data).toBeUndefined();
    });
});
