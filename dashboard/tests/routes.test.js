'use strict';

const express = require('express');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const request = require('supertest');
const { execFile } = require('child_process');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../services/automationEngine', () => ({
    invalidateCache: jest.fn(),
    testRun: jest.fn()
}));

jest.mock('child_process', () => ({
    execFile: jest.fn()
}));

process.env.DB_PATH = ':memory:';

// ---------------------------------------------------------------------------
// Minimal DB mock — enough for routes that call db.get / db.all / db.run
// ---------------------------------------------------------------------------
function makeDbMock(overrides = {}) {
    return {
        get: jest.fn().mockResolvedValue(null),
        all: jest.fn().mockResolvedValue([]),
        run: jest.fn().mockResolvedValue({ lastID: 0, changes: 0 }),
        exec: jest.fn().mockResolvedValue(undefined),
        prepare: jest.fn().mockReturnValue({ all: jest.fn().mockReturnValue([]) }),
        close: jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

// ---------------------------------------------------------------------------
// Helper: build a minimal Express app with a session-like user injected
// ---------------------------------------------------------------------------
function buildApp(router, mountPath, sessionUser = { id: 1, role: 'admin', username: 'admin' }, dbMock = null) {
    const app = express();
    app.use(express.json());

    // Inject session and user so auth middleware is satisfied
    app.use((req, _res, next) => {
        req.session = { user: sessionUser };
        req.user = sessionUser;
        req.flash = jest.fn();
        next();
    });

    app.locals.db = dbMock || makeDbMock();
    app.use(mountPath, router);
    return app;
}

function buildRenderedApp(router, mountPath, sessionUser = { id: 1, role: 'admin', username: 'admin' }, dbMock = null) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { user: sessionUser, deviceId: sessionUser.deviceId || '' };
        req.user = sessionUser;
        req.flash = jest.fn();
        next();
    });
    app.use((req, res, next) => {
        res.render = (view, locals = {}) => res.status(200).json({ view, locals });
        next();
    });
    app.locals.db = dbMock || makeDbMock();
    app.use(mountPath, router);
    return app;
}

function getSqlStatements(mockFn) {
    return (mockFn.mock.calls || []).map((call) => call[0]).filter((sql) => typeof sql === 'string');
}

describe('Settings routes', () => {
    const originalEnv = {
        MQTT_HOST: process.env.MQTT_HOST,
        MQTT_PORT: process.env.MQTT_PORT,
        MQTT_PROTOCOL: process.env.MQTT_PROTOCOL,
        MQTT_USER: process.env.MQTT_USER,
        MQTT_PASSWORD: process.env.MQTT_PASSWORD,
        MQTT_CLIENT_ID: process.env.MQTT_CLIENT_ID,
        MQTT_REJECT_UNAUTHORIZED: process.env.MQTT_REJECT_UNAUTHORIZED,
        DASHBOARD_DEVICE_STATUS_REFRESH_MS: process.env.DASHBOARD_DEVICE_STATUS_REFRESH_MS,
        LOG_RETENTION_DAYS: process.env.LOG_RETENTION_DAYS,
        LOG_LEVEL: process.env.LOG_LEVEL,
        TZ: process.env.TZ,
        PHONE_COUNTRY_CODE: process.env.PHONE_COUNTRY_CODE,
        PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
        OTA_BASE_URL: process.env.OTA_BASE_URL
    };

    afterEach(() => {
        Object.entries(originalEnv).forEach(([key, value]) => {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        });
        delete global.mqttService;
        jest.restoreAllMocks();
    });

    test('GET /api/settings returns dashboard and MQTT runtime fields used by the page', async () => {
        process.env.MQTT_HOST = 'broker.example.com';
        process.env.MQTT_PORT = '8883';
        process.env.MQTT_PROTOCOL = 'mqtts';
        process.env.MQTT_USER = 'device';
        process.env.MQTT_PASSWORD = 'secret';
        process.env.MQTT_CLIENT_ID = 'dashboard-main';
        process.env.MQTT_REJECT_UNAUTHORIZED = 'true';
        process.env.PHONE_COUNTRY_CODE = '880';
        process.env.PUBLIC_BASE_URL = 'https://dashboard.example.com';
        process.env.OTA_BASE_URL = 'https://ota.example.com';

        global.mqttService = {
            getStatus: jest.fn().mockReturnValue({
                connected: true,
                state: 'connected',
                host: 'broker.example.com',
                port: 8883,
                protocol: 'mqtts',
                clientId: 'dashboard-main',
                username: 'device'
            })
        };

        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, makeDbMock());
        const res = await request(app).get('/api/settings');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.mqtt).toEqual(expect.objectContaining({
            host: 'broker.example.com',
            port: 8883,
            protocol: 'mqtts',
            username: 'device',
            clientId: 'dashboard-main',
            rejectUnauthorized: true,
            connected: true
        }));
        expect(res.body.data.system).toEqual(expect.objectContaining({
            phoneCountryCode: '880',
            publicBaseUrl: 'https://dashboard.example.com',
            otaBaseUrl: 'https://ota.example.com'
        }));
    });

    test('GET /api/settings treats dashboard .env values as editable settings, not external locks', async () => {
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue(
            'DASHBOARD_DEVICE_STATUS_REFRESH_MS=60000\nLOG_LEVEL=info\nTZ=Asia/Dhaka\n'
        );

        process.env.DASHBOARD_DEVICE_STATUS_REFRESH_MS = '60000';
        process.env.LOG_LEVEL = 'info';
        process.env.TZ = 'Asia/Dhaka';

        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, makeDbMock());
        const res = await request(app).get('/api/settings');

        expect(res.status).toBe(200);
        expect(res.body.data.effective.deviceStatusRefreshMs.source).toBe('dashboard_env');
        expect(res.body.data.effective.logLevel.source).toBe('dashboard_env');
        expect(res.body.data.effective.timezone.source).toBe('dashboard_env');
        expect(res.body.data.environmentOverrides.some(item => item.key === 'timezone' && item.active)).toBe(false);
    });

    test('POST /api/settings/mqtt saves protocol and TLS verification settings', async () => {
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue(
            'MQTT_HOST=old-broker\nMQTT_PORT=1883\nMQTT_PROTOCOL=mqtt\nMQTT_USER=old\nMQTT_CLIENT_ID=old-client\nMQTT_REJECT_UNAUTHORIZED=false\n'
        );
        const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

        global.mqttService = {
            reconnect: jest.fn().mockResolvedValue(undefined)
        };

        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, makeDbMock());
        const res = await request(app)
            .post('/api/settings/mqtt')
            .send({
                host: 'secure-broker.example.com',
                port: 8883,
                protocol: 'mqtts',
                username: 'device',
                password: 'secret-pass',
                clientId: 'dashboard-secure',
                rejectUnauthorized: true
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const nextEnv = writeSpy.mock.calls[0][1];
        expect(nextEnv).toContain('MQTT_HOST=secure-broker.example.com');
        expect(nextEnv).toContain('MQTT_PORT=8883');
        expect(nextEnv).toContain('MQTT_PROTOCOL=mqtts');
        expect(nextEnv).toContain('MQTT_REJECT_UNAUTHORIZED=true');
        expect(global.mqttService.reconnect).toHaveBeenCalledWith(expect.objectContaining({
            host: 'secure-broker.example.com',
            port: 8883,
            protocol: 'mqtts',
            username: 'device',
            password: 'secret-pass',
            clientId: 'dashboard-secure',
            rejectUnauthorized: true
        }));
    });

    test('POST /api/settings/system saves dashboard-side env settings', async () => {
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue(
            'PHONE_COUNTRY_CODE=1\nPUBLIC_BASE_URL=http://localhost:3001\nOTA_BASE_URL=\n'
        );
        const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([]),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        });

        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, db);
        const res = await request(app)
            .post('/api/settings/system')
            .send({
                deviceName: 'Dashboard',
                phoneCountryCode: '+880',
                publicBaseUrl: 'https://dashboard.example.com/',
                otaBaseUrl: 'https://ota.example.com/',
                timezone: 'Asia/Dhaka',
                logLevel: 'info',
                autoRestart: false,
                restartSchedule: '03:00',
                backupConfig: true,
                deviceStatusRefreshMs: 60000,
                statusWatchIntervalMs: 45000,
                statusWatchTtlMs: 180000,
                statusWatchRefreshMs: 120000,
                logRetentionDays: 30
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const nextEnv = writeSpy.mock.calls[0][1];
        expect(nextEnv).toContain('PHONE_COUNTRY_CODE=880');
        expect(nextEnv).toContain('PUBLIC_BASE_URL=https://dashboard.example.com');
        expect(nextEnv).toContain('OTA_BASE_URL=https://ota.example.com');
        expect(res.body.data.system).toEqual(expect.objectContaining({
            phoneCountryCode: '880',
            publicBaseUrl: 'https://dashboard.example.com',
            otaBaseUrl: 'https://ota.example.com'
        }));
    });

    test('POST /api/settings/system updates dashboard-owned runtime env keys when they exist in .env', async () => {
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        let envContent = 'DASHBOARD_DEVICE_STATUS_REFRESH_MS=60000\nLOG_RETENTION_DAYS=30\nLOG_LEVEL=info\nTZ=Asia/Dhaka\nPHONE_COUNTRY_CODE=880\nPUBLIC_BASE_URL=http://localhost:3001\nOTA_BASE_URL=\n';
        jest.spyOn(fs, 'readFileSync').mockImplementation(() => envContent);
        const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation((_path, nextContent) => {
            envContent = nextContent;
        });

        process.env.DASHBOARD_DEVICE_STATUS_REFRESH_MS = '60000';
        process.env.LOG_RETENTION_DAYS = '30';
        process.env.LOG_LEVEL = 'info';
        process.env.TZ = 'Asia/Dhaka';

        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([]),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        });

        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, db);
        const res = await request(app)
            .post('/api/settings/system')
            .send({
                deviceName: 'Dashboard',
                phoneCountryCode: '+880',
                publicBaseUrl: 'https://dashboard.example.com/',
                otaBaseUrl: 'https://ota.example.com/',
                timezone: 'Asia/Kolkata',
                logLevel: 'warn',
                autoRestart: false,
                restartSchedule: '03:00',
                backupConfig: true,
                deviceStatusRefreshMs: 90000,
                statusWatchIntervalMs: 45000,
                statusWatchTtlMs: 180000,
                statusWatchRefreshMs: 120000,
                logRetentionDays: 45
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const nextEnv = writeSpy.mock.calls[0][1];
        expect(nextEnv).toContain('DASHBOARD_DEVICE_STATUS_REFRESH_MS=90000');
        expect(nextEnv).toContain('LOG_RETENTION_DAYS=45');
        expect(nextEnv).toContain('LOG_LEVEL=warn');
        expect(nextEnv).toContain('TZ=Asia/Kolkata');
        expect(res.body.data.system).toEqual(expect.objectContaining({
            deviceStatusRefreshMs: 90000,
            logRetentionDays: 45,
            logLevel: 'warn',
            timezone: 'Asia/Kolkata'
        }));
        expect(res.body.data.effective.timezone.source).toBe('dashboard_env');
    });

    test('POST /api/settings/system updates logger transport levels at runtime', async () => {
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue('LOG_LEVEL=info\n');
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([]),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        });

        const previousLogger = global.logger;
        global.logger = {
            level: 'info',
            transports: [
                { level: 'info' },
                { level: 'warn' },
                { level: 'error' }
            ]
        };

        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, db);
        const res = await request(app)
            .post('/api/settings/system')
            .send({
                deviceName: 'Dashboard',
                phoneCountryCode: '+880',
                publicBaseUrl: 'https://dashboard.example.com/',
                otaBaseUrl: '',
                timezone: 'Asia/Dhaka',
                logLevel: 'error',
                autoRestart: false,
                restartSchedule: '03:00',
                backupConfig: true,
                deviceStatusRefreshMs: 60000,
                statusWatchIntervalMs: 45000,
                statusWatchTtlMs: 180000,
                statusWatchRefreshMs: 120000,
                logRetentionDays: 30
            });

        expect(res.status).toBe(200);
        expect(global.logger.level).toBe('error');
        expect(global.logger.transports[0].level).toBe('error');
        expect(global.logger.transports[1].level).toBe('error');
        expect(global.logger.transports[2].level).toBe('error');
        global.logger = previousLogger;
    });

    test('POST /api/settings/backup/create creates only a database backup', async () => {
        const existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((targetPath) => {
            const normalized = String(targetPath);
            if (normalized.includes(path.join('dashboard', 'backups'))) return true;
            if (normalized.includes(path.join('dashboard', 'data', 'database.sqlite'))) return true;
            if (normalized.includes(path.join('dashboard', '.env'))) return true;
            return false;
        });
        const copySpy = jest.spyOn(fs, 'copyFileSync').mockImplementation(() => {});
        jest.spyOn(fs, 'readdirSync').mockReturnValue([]);

        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 1 })
        });

        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, db);
        const res = await request(app).post('/api/settings/backup/create');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(copySpy).toHaveBeenCalledTimes(1);
        expect(copySpy.mock.calls[0][0]).toContain(path.join('dashboard', 'data', 'database.sqlite'));
        expect(copySpy.mock.calls[0][1]).toContain(path.join('dashboard', 'backups', 'backup-'));
        expect(copySpy.mock.calls[0][1]).toContain('.db');
        expect(existsSpy).toHaveBeenCalled();
    });

    test('GET /api/settings/backups lists only database backups', async () => {
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readdirSync').mockReturnValue([
            'backup-2026-04-21.db',
            'env-2026-04-21.backup',
            'notes.txt'
        ]);
        jest.spyOn(fs, 'statSync').mockReturnValue({
            size: 128,
            birthtime: new Date('2026-04-21T07:00:00Z'),
            mtime: new Date('2026-04-21T07:10:00Z')
        });

        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, makeDbMock());
        const res = await request(app).get('/api/settings/backups');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].name).toBe('backup-2026-04-21.db');
    });

    test('backup restore rejects non-database backup filenames', async () => {
        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, makeDbMock());
        const res = await request(app)
            .post('/api/settings/backup/restore')
            .send({ file: 'env-2026-04-21.backup' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBe('Invalid filename');
    });

    test('backup download rejects non-database backup filenames', async () => {
        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, makeDbMock());
        const res = await request(app).get('/api/settings/backups/env-2026-04-21.backup/download');

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBe('Invalid filename');
    });

    test('backup delete rejects non-database backup filenames', async () => {
        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, makeDbMock());
        const res = await request(app).delete('/api/settings/backups/env-2026-04-21.backup');

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBe('Invalid filename');
    });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/test/available
// ---------------------------------------------------------------------------
describe('GET /api/test/available', () => {
    let app;

    beforeAll(() => {
        // getDeviceCapabilities uses db.get — mock returns null (no caps row)
        const db = makeDbMock();
        const router = require('../routes/test');
        app = buildApp(router, '/api/test', { id: 1, role: 'admin', username: 'admin' }, db);
    });

    test('returns 200 with success:true and a tests object', async () => {
        const res = await request(app).get('/api/test/available?deviceId=1');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toBeDefined();
        expect(typeof res.body.data).toBe('object');
    });

    test('response includes known test ids', async () => {
        const res = await request(app).get('/api/test/available?deviceId=1');

        expect(res.status).toBe(200);
        // A few representative test IDs that must be present
        expect(res.body.data).toHaveProperty('modem');
        expect(res.body.data).toHaveProperty('battery');
        expect(res.body.data).toHaveProperty('gps');
    });

    test('each test entry has id, name, and supported flag', async () => {
        const res = await request(app).get('/api/test/available?deviceId=1');

        const entries = Object.values(res.body.data);
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) {
            expect(entry).toHaveProperty('id');
            expect(entry).toHaveProperty('name');
            expect(typeof entry.supported).toBe('boolean');
        }
    });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/test/run — MQTT not connected
// ---------------------------------------------------------------------------
describe('POST /api/test/run (MQTT not connected)', () => {
    let app;

    beforeAll(() => {
        global.mqttService = {
            connected: false,
            publishCommand: jest.fn().mockRejectedValue(new Error('MQTT not connected'))
        };

        const db = makeDbMock();
        const router = require('../routes/test');
        app = buildApp(router, '/api/test', { id: 1, role: 'admin', username: 'admin' }, db);
    });

    afterAll(() => {
        delete global.mqttService;
    });

    test('returns non-500 when test exists but device has no battery capability', async () => {
        const res = await request(app)
            .post('/api/test/run')
            .send({ deviceId: '1', testId: 'battery' });

        // battery requires 'battery' cap; with no capabilities the test is
        // marked unsupported, so the route returns 200 skipped — never 500.
        expect(res.status).not.toBe(500);
        expect(res.body.success).toBe(true);
    });

    test('returns 400 when testId is missing', async () => {
        const res = await request(app)
            .post('/api/test/run')
            .send({ deviceId: '1' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('returns 404 when testId does not exist', async () => {
        const res = await request(app)
            .post('/api/test/run')
            .send({ deviceId: '1', testId: 'nonexistent_test_xyz' });

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
    });

    test('skipped response includes runId, testId, and skipped flag', async () => {
        const res = await request(app)
            .post('/api/test/run')
            .send({ deviceId: '1', testId: 'battery' });

        expect(res.body.data).toHaveProperty('runId');
        expect(res.body.data.testId).toBe('battery');
        expect(res.body.data.skipped).toBe(true);
    });
});

describe('POST /api/test/run (SMS functionality)', () => {
    let app;

    beforeAll(() => {
        const requestStatus = jest.fn().mockResolvedValue({
            success: true,
            telephony_supported: true,
            telephony_enabled: true,
            modem_registered: true,
            mqtt_connected: true,
            sms_ready: true,
            sms_sent_count: 3,
            sms_received_count: 1,
            sms_failure_count: 0,
            sms_last_detail: 'running'
        });

        global.mqttService = {
            connected: true,
            requestStatus,
            publishCommand: jest.fn().mockImplementation(async (_deviceId, command) => {
                if (command === 'get-status') {
                    return {
                        success: true,
                        telephony_supported: true,
                        telephony_enabled: true,
                        modem_registered: true,
                        mqtt_connected: true,
                        sms_ready: true,
                        sms_sent_count: 3,
                        sms_received_count: 1,
                        sms_failure_count: 0,
                        sms_last_detail: 'running'
                    };
                }
                throw new Error(`Unexpected command: ${command}`);
            })
        };

        const db = makeDbMock();
        const router = require('../routes/test');
        app = buildApp(router, '/api/test', { id: 1, role: 'admin', username: 'admin' }, db);
    });

    afterAll(() => {
        delete global.mqttService;
    });

    test('sms test completes using live status readiness checks', async () => {
        const run = await request(app)
            .post('/api/test/run')
            .send({ deviceId: '1', testId: 'sms' });

        expect(run.status).toBe(200);
        expect(run.body.success).toBe(true);
        expect(run.body.data).toHaveProperty('runId');

        await new Promise(resolve => setTimeout(resolve, 50));

        const status = await request(app)
            .get(`/api/test/status/${run.body.data.runId}?deviceId=1`);

        expect(status.status).toBe(200);
        expect(status.body.success).toBe(true);
        expect(status.body.data.completed).toBe(true);
        expect(status.body.data.status).toBe('completed');
        expect(status.body.data.details).toMatchObject({
            liveSendAttempted: false,
            readiness: expect.objectContaining({
                telephonySupported: true,
                telephonyEnabled: true,
                modemRegistered: true,
                mqttConnected: true,
                smsReady: true
            }),
            success: true
        });
        expect(global.mqttService.requestStatus).toHaveBeenCalledWith(
            '1',
            expect.objectContaining({
                force: true,
                source: 'dashboard-test-sms'
            })
        );
    });
});

describe('POST /api/settings/clear-device-data', () => {
    afterEach(() => {
        delete global.modemService;
        delete global.mqttService;
    });

    test('clears only the requested device data', async () => {
        global.modemService = {
            devices: new Map([['device-clear', { id: 'device-clear' }], ['device-keep', { id: 'device-keep' }]]),
            resetDevices: jest.fn()
        };
        global.mqttService = {
            clearDeviceStatus: jest.fn(),
            clearAllDevices: jest.fn()
        };

        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ lastID: 0, changes: 1 })
        });

        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, db);
        app.locals.mqttHandlers = {
            suppressDeletedDevice: jest.fn().mockResolvedValue(undefined),
            unsuppressDeletedDevice: jest.fn().mockResolvedValue(undefined),
            releaseDeviceRuntime: jest.fn(),
            deletedDevices: new Set(['device-keep']),
            _registeredDeviceCache: new Map([
                ['device-clear', { registered: true }],
                ['device-keep', { registered: true }]
            ]),
            _gpsDebounce: new Map([['device-clear', setTimeout(() => {}, 1000)]])
        };

        const res = await request(app)
            .post('/api/settings/clear-device-data')
            .send({ deviceId: 'device-clear' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.deviceId).toBe('device-clear');
        expect(db.run).toHaveBeenCalledWith('DELETE FROM devices WHERE id = ?', ['device-clear']);
        expect(db.run).toHaveBeenCalledWith('DELETE FROM device_profiles WHERE device_id = ?', ['device-clear']);
        expect(db.run).toHaveBeenCalledWith('DELETE FROM phone_device_links WHERE phone_device_id = ? OR target_device_id = ?', ['device-clear', 'device-clear']);
        expect(db.run).not.toHaveBeenCalledWith('DELETE FROM devices');
        expect(global.modemService.resetDevices).not.toHaveBeenCalled();
        expect(global.mqttService.clearAllDevices).not.toHaveBeenCalled();
        expect(global.mqttService.clearDeviceStatus).toHaveBeenCalledWith('device-clear');
        expect(app.locals.mqttHandlers.suppressDeletedDevice).toHaveBeenCalledWith('device-clear');
        expect(app.locals.mqttHandlers.releaseDeviceRuntime).toHaveBeenCalledWith('device-clear');
    });

    test('rejects unscoped device-data clear requests', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ lastID: 0, changes: 1 })
        });
        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app).post('/api/settings/clear-device-data');

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(db.run).not.toHaveBeenCalled();
    });

    test('rejects all-device clear requests without a selected device', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ lastID: 0, changes: 1 })
        });
        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app)
            .post('/api/settings/clear-device-data')
            .send({ allDevices: true });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(db.run).not.toHaveBeenCalled();
    });

    test('rolls back selected-device clear when a delete fails', async () => {
        global.modemService = {
            resetDevices: jest.fn()
        };
        global.mqttService = {
            clearAllDevices: jest.fn(),
            clearDeviceStatus: jest.fn()
        };

        const run = jest.fn(async (sql) => {
            if (sql === 'DELETE FROM devices WHERE id = ?') {
                throw new Error('foreign key failed');
            }
            return { lastID: 0, changes: 1 };
        });
        const db = makeDbMock({ run });

        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, db);
        app.locals.mqttHandlers = {
            suppressDeletedDevice: jest.fn().mockResolvedValue(undefined),
            unsuppressDeletedDevice: jest.fn().mockResolvedValue(undefined),
            releaseDeviceRuntime: jest.fn()
        };

        const res = await request(app)
            .post('/api/settings/clear-device-data')
            .send({ deviceId: 'device-clear' });

        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(run).toHaveBeenCalledWith('BEGIN IMMEDIATE');
        expect(run).toHaveBeenCalledWith('ROLLBACK');
        expect(app.locals.mqttHandlers.unsuppressDeletedDevice).toHaveBeenCalledWith('device-clear');
        expect(global.modemService.resetDevices).not.toHaveBeenCalled();
        expect(global.mqttService.clearAllDevices).not.toHaveBeenCalled();
        expect(global.mqttService.clearDeviceStatus).not.toHaveBeenCalled();
    });

    test('rejects non-admin users', async () => {
        const db = makeDbMock();
        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 2, role: 'operator', username: 'operator' }, db);

        const res = await request(app).post('/api/settings/clear-device-data');

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
    });
});

describe('log maintenance routes', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('POST /api/settings/logs/clear clears file and database-backed logs', async () => {
        const originalExistsSync = fs.existsSync;
        const originalReaddirSync = fs.readdirSync;
        jest.spyOn(fs, 'existsSync').mockImplementation((targetPath) => {
            if (String(targetPath).includes(`${path.sep}dashboard${path.sep}logs`)) {
                return true;
            }
            return originalExistsSync(targetPath);
        });
        jest.spyOn(fs, 'readdirSync').mockImplementation((targetPath) => {
            if (String(targetPath).includes(`${path.sep}dashboard${path.sep}logs`)) {
                return [
                    'app-2026-04-20.log',
                    'mqtt-2026-04-20.log',
                    'error-2026-04-20.log'
                ];
            }
            return originalReaddirSync(targetPath);
        });
        const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 3 })
        });

        const router = require('../routes/settings');
        const app = buildApp(router, '/api/settings', { id: 1, role: 'admin', username: 'admin' }, db);
        const res = await request(app).post('/api/settings/logs/clear');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(writeSpy).toHaveBeenCalledTimes(3);
        expect(db.run).toHaveBeenCalledWith('DELETE FROM system_logs');
        expect(db.run).toHaveBeenCalledWith('DELETE FROM mqtt_logs');
        expect(db.run).toHaveBeenCalledWith('DELETE FROM automation_logs');
        expect(db.run).toHaveBeenCalledWith('DELETE FROM flow_execution_log');
        expect(db.run).toHaveBeenCalledWith('DELETE FROM login_audit');
    });

    test('DELETE /api/logs clears the requested log source files', async () => {
        const originalExistsSync = fs.existsSync;
        const originalReaddirSync = fs.readdirSync;
        jest.spyOn(fs, 'existsSync').mockImplementation((targetPath) => {
            if (String(targetPath).includes(`${path.sep}dashboard${path.sep}logs`)) {
                return true;
            }
            return originalExistsSync(targetPath);
        });
        jest.spyOn(fs, 'readdirSync').mockImplementation((targetPath) => {
            if (String(targetPath).includes(`${path.sep}dashboard${path.sep}logs`)) {
                return [
                    'mqtt-2026-04-20.log',
                    'mqtt-2026-04-19.log',
                    'app-2026-04-20.log'
                ];
            }
            return originalReaddirSync(targetPath);
        });
        const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

        const router = require('../routes/logs');
        const app = buildApp(router, '/api/logs', { id: 1, role: 'admin', username: 'admin' }, makeDbMock());
        const res = await request(app).delete('/api/logs?source=mqtt');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual(expect.objectContaining({ source: 'mqtt', cleared: 2 }));
        expect(writeSpy).toHaveBeenCalledTimes(2);
    });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/devices/:id/specs
// ---------------------------------------------------------------------------
describe('GET /api/devices/:id/specs', () => {
    let app;

    beforeAll(() => {
        global.mqttService = { connected: false };
        global.modemService = {
            getDeviceStatus: jest.fn().mockReturnValue({}),
            getStatus: jest.fn().mockReturnValue({})
        };

        const db = makeDbMock({
            // Simulate a device row being returned
            get: jest.fn().mockResolvedValue({
                id: '1',
                name: 'Test Device',
                type: 'esp32',
                status: 'offline',
                last_seen: null,
                created_at: '2024-01-01T00:00:00.000Z',
                description: null,
                location: null,
                apn: null,
                mqtt_host: null,
                mqtt_user: null,
                local_ip: null,
                capabilities: null,
                firmware_version: null,
                board: null,
                probed_at: null,
                updated_at: null,
                has_gps: 0,
                has_battery: 0,
                has_sd: 0,
                has_camera: 0,
                has_audio: 0,
                has_display: 0,
                has_nfc: 0,
                has_rfid: 0,
                has_touch: 0,
                has_keyboard: 0
            }),
            all: jest.fn().mockResolvedValue([])
        });

        const router = require('../routes/devices');
        app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
    });

    afterAll(() => {
        delete global.mqttService;
        delete global.modemService;
    });

    test('returns 200 with device specs object', async () => {
        const res = await request(app).get('/api/devices/1/specs');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.deviceId).toBe('1');
        expect(res.body.specs).toBeDefined();
    });

    test('response includes caps, live, and metadata fields', async () => {
        const res = await request(app).get('/api/devices/1/specs');

        expect(res.body).toHaveProperty('caps');
        expect(res.body).toHaveProperty('live');
        expect(res.body).toHaveProperty('metadata');
    });

    test('response includes live Wi-Fi fields when modem state reports them', async () => {
        global.modemService.getDeviceStatus.mockReturnValueOnce({
            wifi: {
                connected: true,
                ssid: 'OfficeLab',
                ipAddress: '192.168.1.42',
                rssi: -58
            }
        });

        const res = await request(app).get('/api/devices/1/specs');

        expect(res.status).toBe(200);
        expect(res.body.live.wifi).toEqual({
            connected: true,
            ssid: 'OfficeLab',
            ipAddress: '192.168.1.42',
            rssi: -58
        });
    });

    test('response includes SIM inventory merged from stored slot rows', async () => {
        global.modemService.getDeviceStatus.mockReturnValueOnce({
            online: true,
            sim: {
                activeSlotIndex: 1
            }
        });

        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({
                id: '1',
                name: 'Test Device',
                type: 'esp32',
                status: 'offline',
                last_seen: null,
                created_at: '2024-01-01T00:00:00.000Z',
                description: null,
                location: null,
                apn: null,
                mqtt_host: null,
                mqtt_user: null,
                local_ip: null,
                capabilities: null,
                firmware_version: null,
                board: null,
                probed_at: null,
                updated_at: null,
                has_gps: 0,
                has_battery: 0,
                has_sd: 0,
                has_camera: 0,
                has_audio: 0,
                has_display: 0,
                has_nfc: 0,
                has_rfid: 0,
                has_touch: 0,
                has_keyboard: 0
            }),
            all: jest.fn((sql) => {
                if (String(sql).includes('FROM sims')) {
                    return Promise.resolve([
                        { slot_index: 0, sim_number: '+8801000000000', operator_name: 'Robi', carrier_name: 'robi axiata', network_type: 'LTE', is_ready: 1, is_registered: 1 },
                        { slot_index: 1, sim_number: '+8801000000001', operator_name: 'Grameenphone', carrier_name: 'GP', network_type: 'LTE', is_ready: 1, is_registered: 1 }
                    ]);
                }
                return Promise.resolve([]);
            })
        });
        const router = require('../routes/devices');
        const localApp = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(localApp).get('/api/devices/1/specs');

        expect(res.status).toBe(200);
        expect(res.body.simInventory).toEqual(expect.objectContaining({
            simNumber: '+8801000000001',
            operator: 'Grameenphone',
            simSlotCount: 2,
            dualSim: true,
            activeSimSlotIndex: 1
        }));
        expect(res.body.simInventory.simSlots).toHaveLength(2);
    });

    test('returns 404 when device does not exist', async () => {
        const db = makeDbMock({ get: jest.fn().mockResolvedValue(null) });
        const router = require('../routes/devices');
        const appNoDevice = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(appNoDevice).get('/api/devices/99/specs');

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
    });
});

describe('GET /api/devices/:id', () => {
    afterEach(() => {
        delete global.modemService;
    });

    test('returns stored connectivity profile fields and effective MQTT defaults for the settings page', async () => {
        const previousMqttHost = process.env.MQTT_HOST;
        const previousMqttPort = process.env.MQTT_PORT;
        const previousMqttUser = process.env.MQTT_USER;
        const previousMqttPassword = process.env.MQTT_PASSWORD;
        process.env.MQTT_HOST = '144.79.218.153';
        process.env.MQTT_PORT = '1883';
        process.env.MQTT_USER = 'device';
        process.env.MQTT_PASSWORD = '153520';

        global.modemService = {
            getDeviceStatus: jest.fn().mockReturnValue({
                online: true,
                uptime: '12m',
                activePath: 'wifi'
            }),
            getStatus: jest.fn().mockReturnValue({})
        };

        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({
                id: 'dev-1',
                name: 'Roof Unit',
                type: 'esp32-s3',
                status: 'offline',
                last_seen: '2026-04-10T10:00:00.000Z',
                created_at: '2026-04-10T09:00:00.000Z',
                description: null,
                location: 'Roof',
                apn: 'internet',
                wifi_ssid: 'RIAZ-GAP',
                wifi_pass: '12345678',
                mqtt_host: null,
                mqtt_user: null,
                local_ip: null,
                board: 'esp32-s3-a7670e',
                firmware_version: '1.0.0',
                updated_at: '2026-04-10T10:00:00.000Z'
            })
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
        const res = await request(app).get('/api/devices/dev-1');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.device.wifi_ssid).toBe('RIAZ-GAP');
        expect(res.body.device.wifi_pass).toBe('12345678');
        expect(res.body.device.apn).toBe('internet');
        expect(res.body.device.online).toBe(true);
        expect(res.body.device.mqtt_pass_set).toBe(false);
        expect(res.body.device.mqtt_effective).toEqual(expect.objectContaining({
            configured: true,
            uri: 'mqtt://144.79.218.153:1883',
            username: 'device',
            passwordSet: true,
            source: 'system_defaults',
            sources: expect.objectContaining({
                uri: 'system',
                username: 'system',
                password: 'system'
            })
        }));

        if (previousMqttHost === undefined) delete process.env.MQTT_HOST;
        else process.env.MQTT_HOST = previousMqttHost;
        if (previousMqttPort === undefined) delete process.env.MQTT_PORT;
        else process.env.MQTT_PORT = previousMqttPort;
        if (previousMqttUser === undefined) delete process.env.MQTT_USER;
        else process.env.MQTT_USER = previousMqttUser;
        if (previousMqttPassword === undefined) delete process.env.MQTT_PASSWORD;
        else process.env.MQTT_PASSWORD = previousMqttPassword;
    });

    test('merges stored SIM slot inventory into the device detail payload', async () => {
        global.modemService = {
            getDeviceStatus: jest.fn().mockReturnValue({
                online: true,
                uptime: '12m',
                activePath: 'modem',
                sim: {
                    activeSlotIndex: 1
                }
            }),
            getStatus: jest.fn().mockReturnValue({})
        };

        const db = makeDbMock({
            get: jest.fn((sql) => {
                if (String(sql).includes('FROM devices d')) {
                    return Promise.resolve({
                        id: 'dev-1',
                        name: 'Roof Unit',
                        type: 'esp32-s3',
                        status: 'offline',
                        last_seen: '2026-04-10T10:00:00.000Z',
                        created_at: '2026-04-10T09:00:00.000Z',
                        description: null,
                        location: 'Roof',
                        apn: 'internet',
                        wifi_ssid: 'RIAZ-GAP',
                        wifi_pass: '12345678',
                        mqtt_host: null,
                        mqtt_user: null,
                        mqtt_pass_set: 0,
                        local_ip: null,
                        board: 'esp32-s3-a7670e',
                        firmware_version: '1.0.0',
                        updated_at: '2026-04-10T10:00:00.000Z'
                    });
                }
                return Promise.resolve(null);
            }),
            all: jest.fn((sql) => {
                if (String(sql).includes('FROM sims')) {
                    return Promise.resolve([
                        { slot_index: 0, sim_number: '+8801000000000', operator_name: 'Robi', carrier_name: 'robi axiata', network_type: 'LTE', is_ready: 1, is_registered: 1 },
                        { slot_index: 1, sim_number: '+8801000000001', operator_name: 'Grameenphone', carrier_name: 'GP', network_type: 'LTE', is_ready: 1, is_registered: 1 }
                    ]);
                }
                return Promise.resolve([]);
            })
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
        const res = await request(app).get('/api/devices/dev-1');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.device.simNumber).toBe('+8801000000001');
        expect(res.body.device.subscriberNumber).toBe('+8801000000001');
        expect(res.body.device.operator).toBe('Grameenphone');
        expect(res.body.device.simSlotCount).toBe(2);
        expect(res.body.device.dualSim).toBe(true);
        expect(res.body.device.activeSimSlotIndex).toBe(1);
        expect(res.body.device.simSlots).toHaveLength(2);
        expect(res.body.device.sim.slots).toHaveLength(2);
    });
});

describe('GET /api/devices/:id/sims', () => {
    afterEach(() => {
        delete global.modemService;
    });

    test('returns stored SIM inventory merged with live slot selection', async () => {
        global.modemService = {
            getDeviceStatus: jest.fn().mockReturnValue({
                online: true,
                sim: {
                    activeSlotIndex: 0
                }
            }),
            getStatus: jest.fn().mockReturnValue({})
        };

        const db = makeDbMock({
            get: jest.fn((sql) => {
                if (String(sql).includes('SELECT id FROM devices')) {
                    return Promise.resolve({ id: 'dev-1' });
                }
                return Promise.resolve(null);
            }),
            all: jest.fn((sql) => {
                if (String(sql).includes('FROM sims')) {
                    return Promise.resolve([
                        { slot_index: 0, sim_number: '+8801000000000', operator_name: 'Robi', carrier_name: 'robi axiata', network_type: 'LTE', is_ready: 1, is_registered: 1 },
                        { slot_index: 1, sim_number: '+8801000000001', operator_name: 'Grameenphone', carrier_name: 'GP', network_type: 'LTE', is_ready: 1, is_registered: 0 }
                    ]);
                }
                return Promise.resolve([]);
            })
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
        const res = await request(app).get('/api/devices/dev-1/sims');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.deviceId).toBe('dev-1');
        expect(res.body.simNumber).toBe('+8801000000000');
        expect(res.body.operator).toBe('Robi');
        expect(res.body.simSlotCount).toBe(2);
        expect(res.body.dualSim).toBe(true);
        expect(res.body.activeSimSlotIndex).toBe(0);
        expect(res.body.simSlots[1]).toEqual(expect.objectContaining({
            slotIndex: 1,
            number: '+8801000000001',
            operatorName: 'Grameenphone',
            registered: false
        }));
    });
});

describe('PUT /api/devices/:id', () => {
    test('persists connectivity profile fields alongside name/location', async () => {
        const db = makeDbMock({
            run: jest.fn()
                .mockResolvedValueOnce({ changes: 1 })
                .mockResolvedValueOnce({ changes: 1 })
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
        const res = await request(app)
            .put('/api/devices/dev-2')
            .send({
                name: 'Lab Device',
                location: 'Desk',
                apn: 'internet',
                wifi_ssid: 'RIAZ-GAP',
                wifi_pass: '12345678'
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const sqlStatements = getSqlStatements(db.run);
        expect(sqlStatements[0]).toContain('UPDATE devices SET name = ?');
        expect(sqlStatements[1]).toContain('INSERT INTO device_profiles');
        expect(sqlStatements[1]).toContain('wifi_ssid');
        expect(sqlStatements[1]).toContain('wifi_pass');
        expect(sqlStatements[1]).toContain('apn');
    });
});

describe('POST /api/devices/:id/runtime-config/apply', () => {
    const originalSerialPort = process.env.SERIAL_PORT;
    const originalBluetoothPort = process.env.BLUETOOTH_SERIAL_PORT;
    const originalWifiEnabled = process.env.RUNTIME_CONFIG_WIFI_ENABLED;
    const originalSetupApIp = process.env.DEVICE_SETUP_AP_IP;

    beforeEach(() => {
        process.env.SERIAL_PORT = 'COM5';
        delete process.env.BLUETOOTH_SERIAL_PORT;
        delete process.env.RUNTIME_CONFIG_WIFI_ENABLED;
        delete process.env.DEVICE_SETUP_AP_IP;
        delete global.mqttService;
    });

    afterEach(() => {
        if (originalSerialPort === undefined) delete process.env.SERIAL_PORT;
        else process.env.SERIAL_PORT = originalSerialPort;
        if (originalBluetoothPort === undefined) delete process.env.BLUETOOTH_SERIAL_PORT;
        else process.env.BLUETOOTH_SERIAL_PORT = originalBluetoothPort;
        if (originalWifiEnabled === undefined) delete process.env.RUNTIME_CONFIG_WIFI_ENABLED;
        else process.env.RUNTIME_CONFIG_WIFI_ENABLED = originalWifiEnabled;
        if (originalSetupApIp === undefined) delete process.env.DEVICE_SETUP_AP_IP;
        else process.env.DEVICE_SETUP_AP_IP = originalSetupApIp;
        delete global.mqttService;
    });

    test('stores connectivity profile and applies it over serial when available', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue({
                apn: 'internet',
                wifi_ssid: 'RIAZ-GAP',
                wifi_pass: '12345678',
                mqtt_host: 'broker.example.com',
                mqtt_user: 'device-3',
                mqtt_pass: 'supersecret'
            })
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
        app.locals.serialBridge = {
            applyRuntimeConfig: jest.fn().mockResolvedValue({
                restartRequired: true,
                applied: ['wifi_ssid', 'wifi_password', 'modem_apn']
            })
        };

        const res = await request(app)
            .post('/api/devices/dev-3/runtime-config/apply')
            .send({
                apn: 'internet',
                wifi_ssid: 'RIAZ-GAP',
                wifi_pass: '12345678'
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.applied).toBe(true);
        expect(res.body.transport).toBe('serial');
        expect(res.body.partialApplied).toBe(false);
        expect(res.body.compatibilityWarning).toBeNull();
        expect(app.locals.serialBridge.applyRuntimeConfig).toHaveBeenCalledWith(expect.objectContaining({
            wifiSsid: 'RIAZ-GAP',
            wifiPassword: '12345678',
            modemApn: 'internet',
            mqttUri: 'mqtt://broker.example.com:1883',
            mqttUsername: 'device-3',
            mqttPassword: 'supersecret',
            mqttEnabled: true,
            modemFallbackEnabled: true
        }), undefined);
    });

    test('surfaces legacy serial config when MQTT fields were skipped on device', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue({
                apn: 'internet',
                wifi_ssid: 'GM-GAP',
                wifi_pass: 'gmgap@tongi'
            })
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
        app.locals.serialBridge = {
            applyRuntimeConfig: jest.fn()
                .mockRejectedValueOnce(new Error('not_supported detail=key'))
                .mockResolvedValueOnce({
                    restartRequired: true,
                    applied: ['device_id_override', 'wifi_ssid', 'wifi_password', 'modem_apn'],
                    compatibilityMode: 'legacy_serial_config',
                    skippedFields: ['mqttUri', 'mqttUsername', 'mqttPassword', 'mqttEnabled', 'modemFallbackEnabled']
                })
        };

        const res = await request(app)
            .post('/api/devices/dev-legacy/runtime-config/apply')
            .send({
                apn: 'internet',
                wifi_ssid: 'GM-GAP',
                wifi_pass: 'gmgap@tongi',
                device_id_override: 'dev-legacy'
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.transport).toBe('serial');
        expect(res.body.partialApplied).toBe(true);
        expect(res.body.compatibilityMode).toBe('legacy_serial_config');
        expect(res.body.skippedMqttFields).toEqual([
            'mqttUri',
            'mqttUsername',
            'mqttPassword',
            'mqttEnabled',
            'modemFallbackEnabled'
        ]);
        expect(res.body.compatibilityWarning).toMatch(/legacy config schema/i);
    });

    test('falls back to bluetooth serial when primary serial fails', async () => {
        process.env.BLUETOOTH_SERIAL_PORT = 'COM4';
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue({
                apn: 'internet',
                wifi_ssid: 'RIAZ-GAP',
                wifi_pass: '12345678',
                device_id_override: 'dev-3'
            })
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
        app.locals.serialBridge = {
            applyRuntimeConfig: jest.fn()
                .mockRejectedValueOnce(new Error('primary unavailable'))
                .mockResolvedValueOnce({
                    restartRequired: true,
                    applied: ['device_id_override', 'wifi_ssid', 'wifi_password', 'modem_apn']
                })
        };

        const res = await request(app)
            .post('/api/devices/dev-3/runtime-config/apply')
            .send({
                apn: 'internet',
                wifi_ssid: 'RIAZ-GAP',
                wifi_pass: '12345678',
                device_id_override: 'dev-3'
            });

        expect(res.status).toBe(200);
        expect(res.body.transport).toBe('bluetooth');
        expect(res.body.appliedFields).toContain('device_id_override');
        expect(app.locals.serialBridge.applyRuntimeConfig).toHaveBeenNthCalledWith(1, expect.objectContaining({
            wifiSsid: 'RIAZ-GAP',
            wifiPassword: '12345678',
            modemApn: 'internet',
            deviceIdOverride: 'dev-3',
            mqttEnabled: false,
            modemFallbackEnabled: true
        }), undefined);
        expect(app.locals.serialBridge.applyRuntimeConfig).toHaveBeenNthCalledWith(2, expect.objectContaining({
            wifiSsid: 'RIAZ-GAP',
            wifiPassword: '12345678',
            modemApn: 'internet',
            deviceIdOverride: 'dev-3',
            mqttEnabled: false,
            modemFallbackEnabled: true
        }), { portPath: 'COM4' });
    });

    test('returns stored-only when serial transport is unavailable', async () => {
        delete process.env.SERIAL_PORT;
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue({
                apn: 'internet',
                wifi_ssid: 'RIAZ-GAP',
                wifi_pass: '12345678'
            })
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
        const res = await request(app)
            .post('/api/devices/dev-4/runtime-config/apply')
            .send({
                apn: 'internet',
                wifi_ssid: 'RIAZ-GAP',
                wifi_pass: '12345678'
            });

        expect(res.status).toBe(202);
        expect(res.body.success).toBe(true);
        expect(res.body.stored).toBe(true);
        expect(res.body.applied).toBe(false);
        expect(res.body.transport).toBe('stored_only');
    });

    test('falls back to MQTT and requests Wi-Fi reconnect after applying Wi-Fi config', async () => {
        delete process.env.SERIAL_PORT;
        delete process.env.BLUETOOTH_SERIAL_PORT;
        delete process.env.RUNTIME_CONFIG_WIFI_ENABLED;
        delete process.env.DEVICE_SETUP_AP_IP;

        global.mqttService = {
            connected: true,
            publishCommand: jest.fn().mockResolvedValue({ success: true })
        };

        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue({
                apn: 'internet',
                wifi_ssid: 'RiazM',
                wifi_pass: '12345678'
            })
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app)
            .post('/api/devices/dev-mqtt/runtime-config/apply')
            .send({
                apn: 'internet',
                wifi_ssid: 'RiazM',
                wifi_pass: '12345678'
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.transport).toBe('mqtt');
        expect(global.mqttService.publishCommand).toHaveBeenNthCalledWith(
            1,
            'dev-mqtt',
            'config-set',
            { key: 'wifi_ssid', value: 'RiazM' },
            true,
            10000,
            { source: 'dashboard-config', skipPersistentQueue: true }
        );
        expect(global.mqttService.publishCommand).toHaveBeenNthCalledWith(
            2,
            'dev-mqtt',
            'config-set',
            { key: 'wifi_password', value: '12345678' },
            true,
            10000,
            { source: 'dashboard-config', skipPersistentQueue: true }
        );
        expect(global.mqttService.publishCommand).toHaveBeenNthCalledWith(
            3,
            'dev-mqtt',
            'config-set',
            { key: 'modem_apn', value: 'internet' },
            true,
            10000,
            { source: 'dashboard-config', skipPersistentQueue: true }
        );
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'dev-mqtt',
            'config-set',
            { key: 'mqtt_enabled', value: 'false' },
            true,
            10000,
            { source: 'dashboard-config', skipPersistentQueue: true }
        );
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'dev-mqtt',
            'config-set',
            { key: 'modem_fallback_enabled', value: 'true' },
            true,
            10000,
            { source: 'dashboard-config', skipPersistentQueue: true }
        );
        expect(global.mqttService.publishCommand).toHaveBeenLastCalledWith(
            'dev-mqtt',
            'wifi-reconnect',
            {},
            true,
            10000,
            { source: 'dashboard-config', skipPersistentQueue: true }
        );
    });
});

describe('GET /api/devices/:id/runtime-config/read', () => {
    const originalSerialPort = process.env.SERIAL_PORT;
    const originalBluetoothPort = process.env.BLUETOOTH_SERIAL_PORT;
    const originalWifiEnabled = process.env.RUNTIME_CONFIG_WIFI_ENABLED;
    const originalSetupApIp = process.env.DEVICE_SETUP_AP_IP;

    beforeEach(() => {
        process.env.SERIAL_PORT = 'COM5';
        delete process.env.BLUETOOTH_SERIAL_PORT;
        delete process.env.RUNTIME_CONFIG_WIFI_ENABLED;
        delete process.env.DEVICE_SETUP_AP_IP;
    });

    afterEach(() => {
        if (originalSerialPort === undefined) delete process.env.SERIAL_PORT;
        else process.env.SERIAL_PORT = originalSerialPort;
        if (originalBluetoothPort === undefined) delete process.env.BLUETOOTH_SERIAL_PORT;
        else process.env.BLUETOOTH_SERIAL_PORT = originalBluetoothPort;
        if (originalWifiEnabled === undefined) delete process.env.RUNTIME_CONFIG_WIFI_ENABLED;
        else process.env.RUNTIME_CONFIG_WIFI_ENABLED = originalWifiEnabled;
        if (originalSetupApIp === undefined) delete process.env.DEVICE_SETUP_AP_IP;
        else process.env.DEVICE_SETUP_AP_IP = originalSetupApIp;
    });

    test('reads runtime config over serial when available', async () => {
        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, makeDbMock());
        app.locals.serialBridge = {
            getRuntimeConfig: jest.fn().mockResolvedValue({
                schemaVersion: 1,
                deviceIdOverride: '',
                wifiSsid: 'RIAZ-GAP',
                wifiPasswordSet: true,
                modemApn: 'internet'
            })
        };

        const res = await request(app).get('/api/devices/dev-5/runtime-config/read');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.transport).toBe('serial');
        expect(res.body.data.wifi_ssid).toBe('RIAZ-GAP');
        expect(res.body.data.wifi_password_set).toBe(true);
        expect(res.body.data.apn).toBe('internet');
    });

    test('returns unavailable when serial transport is not configured', async () => {
        delete process.env.SERIAL_PORT;
        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, makeDbMock());

        const res = await request(app).get('/api/devices/dev-6/runtime-config/read');

        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(res.body.transport).toBe('unavailable');
    });
});

describe('GET /api/devices/:id/hotspot-diagnostics', () => {
    afterEach(() => {
        execFile.mockReset();
    });

    test('returns hosted-network SSID and password mismatch against the stored device profile', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ wifi_ssid: 'RIAZ-GAP', wifi_pass: '12345678' })
        });

        execFile.mockImplementation((_file, args, _opts, callback) => {
            if (args.includes('setting=security')) {
                callback(null, `
Hosted network security settings
--------------------------------
    User security key      : iotdevice123
`, '');
                return;
            }

            callback(null, `
Hosted network settings
-----------------------
    Mode                   : Allowed
    SSID name              : "IoT_Hotspot"

Hosted network status
---------------------
    Status                 : Not available
`, '');
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
        const res = await request(app).get('/api/devices/dev-7/hotspot-diagnostics');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.desiredSsid).toBe('RIAZ-GAP');
        expect(res.body.data.hostedSsid).toBe('IoT_Hotspot');
        expect(res.body.data.matchesDesired).toBe(false);
        expect(res.body.data.passwordMatchesDesired).toBe(false);
        expect(res.body.data).not.toHaveProperty('hostedPassword');
    });
});

describe('POST /api/devices/:id/runtime-config/use-host-hotspot', () => {
    const originalSerialPort = process.env.SERIAL_PORT;
    const originalWifiEnabled = process.env.RUNTIME_CONFIG_WIFI_ENABLED;
    const originalSetupApIp = process.env.DEVICE_SETUP_AP_IP;

    beforeEach(() => {
        process.env.SERIAL_PORT = 'COM5';
        delete process.env.RUNTIME_CONFIG_WIFI_ENABLED;
        delete process.env.DEVICE_SETUP_AP_IP;
        delete global.mqttService;
    });

    afterEach(() => {
        execFile.mockReset();
        if (originalSerialPort === undefined) delete process.env.SERIAL_PORT;
        else process.env.SERIAL_PORT = originalSerialPort;
        if (originalWifiEnabled === undefined) delete process.env.RUNTIME_CONFIG_WIFI_ENABLED;
        else process.env.RUNTIME_CONFIG_WIFI_ENABLED = originalWifiEnabled;
        if (originalSetupApIp === undefined) delete process.env.DEVICE_SETUP_AP_IP;
        else process.env.DEVICE_SETUP_AP_IP = originalSetupApIp;
        delete global.mqttService;
    });

    test('stores Windows hotspot settings and applies them over serial when requested', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn().mockResolvedValue({
                apn: 'internet',
                mqtt_host: 'broker.example.com',
                mqtt_user: 'device-8',
                mqtt_pass: 'supersecret'
            })
        });

        execFile.mockImplementation((_file, args, _opts, callback) => {
            if (args.includes('setting=security')) {
                callback(null, `
Hosted network security settings
--------------------------------
    User security key      : 12345678
`, '');
                return;
            }

            callback(null, `
Hosted network settings
-----------------------
    Mode                   : Allowed
    SSID name              : "RIAZ-GAP"

Hosted network status
---------------------
    Status                 : Started
`, '');
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
        app.locals.serialBridge = {
            applyRuntimeConfig: jest.fn().mockResolvedValue({
                restartRequired: true,
                applied: ['wifi_ssid', 'wifi_password']
            })
        };

        const res = await request(app)
            .post('/api/devices/dev-8/runtime-config/use-host-hotspot')
            .send({ apply: true });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.applied).toBe(true);
        expect(res.body.transport).toBe('serial');
        expect(res.body.data.wifi_ssid).toBe('RIAZ-GAP');
        expect(res.body.data.wifi_password_set).toBe(true);
        expect(app.locals.serialBridge.applyRuntimeConfig).toHaveBeenCalledWith(expect.objectContaining({
            wifiSsid: 'RIAZ-GAP',
            wifiPassword: '12345678',
            modemApn: 'internet',
            mqttUri: 'mqtt://broker.example.com:1883',
            mqttUsername: 'device-8',
            mqttPassword: 'supersecret',
            mqttEnabled: true,
            modemFallbackEnabled: true
        }), undefined);
        const sqlStatements = getSqlStatements(db.run);
        expect(sqlStatements.some((sql) => sql.includes('INSERT INTO device_profiles'))).toBe(true);
    });
});

describe('POST /api/devices/:id/hotspot/configure-host', () => {
    afterEach(() => {
        execFile.mockReset();
    });

    test('configures the Windows hotspot from the stored device profile and attempts to start it', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({
                wifi_ssid: 'RIAZ-GAP',
                wifi_pass: '12345678'
            })
        });

        execFile.mockImplementation((_file, args, _opts, callback) => {
            if (args[1] === 'set') {
                callback(null, 'The hosted network mode has been set to allow.\nThe SSID of the hosted network has been successfully changed.\nThe user key passphrase of the hosted network has been successfully changed.\n', '');
                return;
            }
            if (args[1] === 'start') {
                callback(null, 'The hosted network started.\n', '');
                return;
            }

            callback(null, `
Hosted network settings
-----------------------
    Mode                   : Allowed
    SSID name              : "RIAZ-GAP"

Hosted network status
---------------------
    Status                 : Started
`, '');
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app)
            .post('/api/devices/dev-9/hotspot/configure-host')
            .send({ start: true });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.wifi_ssid).toBe('RIAZ-GAP');
        expect(res.body.data.started).toBe(true);
        expect(res.body.data.hosted_ssid).toBe('RIAZ-GAP');
        expect(execFile).toHaveBeenCalledWith(
            'netsh',
            ['wlan', 'set', 'hostednetwork', 'mode=allow', 'ssid=RIAZ-GAP', 'key=12345678'],
            { windowsHide: true },
            expect.any(Function)
        );
    });
});

describe('GET /api/devices', () => {
    afterEach(() => {
        delete global.mqttService;
        delete global.modemService;
    });

    test('merges richer live runtime fields into the device list response', async () => {
        global.modemService = {
            getStatus: jest.fn().mockReturnValue({
                online: true,
                signal: 67,
                signalDbm: -71,
                battery: 92,
                network: 'Wi-Fi',
                operator: 'Wi-Fi',
                activePath: 'wifi',
                wifi: {
                    connected: true,
                    ssid: 'BenchNet',
                    ipAddress: '192.168.1.50',
                    rssi: -58
                },
                mqtt: {
                    connected: true,
                    subscribed: true,
                    reconnectCount: 2
                },
                sync: {
                    inSync: true,
                    dashboardAckAgeMs: 1200
                },
                storage: {
                    mounted: true,
                    queueDepth: 1
                },
                queues: {
                    storagePending: 1
                },
                lastSeen: '2026-04-03T10:00:00.000Z'
            })
        };

        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([
                {
                    id: 'device-1',
                    name: 'Bench Device',
                    status: 'offline',
                    created_at: '2026-04-01T00:00:00.000Z',
                    assigned_users: 1
                }
            ])
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app).get('/api/devices');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.devices).toHaveLength(1);
        expect(res.body.devices[0]).toEqual(expect.objectContaining({
            id: 'device-1',
            online: true,
            signal: 67,
            signalDbm: -71,
            battery: 92,
            activePath: 'wifi',
            wifi: expect.objectContaining({
                connected: true,
                ssid: 'BenchNet'
            }),
            mqtt: expect.objectContaining({
                connected: true,
                subscribed: true
            }),
            sync: expect.objectContaining({
                inSync: true,
                dashboardAckAgeMs: 1200
            }),
            storage: expect.objectContaining({
                mounted: true,
                queueDepth: 1
            }),
            queueState: expect.objectContaining({
                device: expect.objectContaining({
                    storagePending: 1
                })
            }),
            lastSeen: '2026-04-03T10:00:00.000Z'
        }));
    });

    test('sorts the requested active ESP32 device first and infers firmware type from live status', async () => {
        global.modemService = {
            isDeviceOnline: jest.fn((deviceId) => deviceId === 'esp32-1'),
            getStatus: jest.fn((deviceId) => {
                if (deviceId === 'esp32-1') {
                    return {
                        online: true,
                        activePath: 'wifi',
                        wifi: {
                            connected: true,
                            ssid: 'RiazM',
                            ipAddress: '10.77.196.235'
                        },
                        mqtt: {
                            connected: true,
                            subscribed: true
                        },
                        task_count: 8,
                        lastSeen: '2026-04-19T10:00:00.000Z'
                    };
                }
                return {
                    online: false,
                    platform: 'android',
                    lastSeen: '2026-04-19T11:00:00.000Z'
                };
            })
        };

        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([
                {
                    id: 'android-1',
                    name: 'Android Bridge',
                    type: 'android',
                    board: 'android-sms-bridge',
                    capabilities: JSON.stringify({ bridge: 'android' }),
                    created_at: '2026-04-01T00:00:00.000Z',
                    assigned_users: 1
                },
                {
                    id: 'esp32-1',
                    name: 'ESP32 Live',
                    type: 'android',
                    board: 'esp32-s3-a7670e',
                    capabilities: JSON.stringify({ bridge: 'firmware', board: 'esp32-s3-a7670e' }),
                    created_at: '2026-04-02T00:00:00.000Z',
                    assigned_users: 1
                }
            ])
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app).get('/api/devices?device=esp32-1');

        expect(res.status).toBe(200);
        expect(res.body.devices.map(device => device.id)).toEqual(['esp32-1', 'android-1']);
        expect(res.body.devices[0]).toEqual(expect.objectContaining({
            id: 'esp32-1',
            type: 'esp32',
            deviceType: 'esp32',
            online: true,
            activePath: 'wifi'
        }));
        expect(res.body.devices[0].capabilities).toEqual(expect.objectContaining({
            bridge: 'firmware',
            board: 'esp32-s3-a7670e'
        }));
    });

    test('active device falls back to the first accessible registered device even when offline', async () => {
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(false),
            getAllDevices: jest.fn().mockReturnValue([])
        };

        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({
                id: 'device-offline-1'
            })
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app).get('/api/devices/active');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            deviceId: 'device-offline-1'
        });
        expect(db.get).toHaveBeenCalledWith(expect.stringContaining('FROM devices'));
    });

    test('active device clears stale session selection when no devices exist', async () => {
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(false),
            getAllDevices: jest.fn().mockReturnValue([])
        };

        const sessionRef = {
            user: { id: 1, role: 'admin', username: 'admin' },
            deviceId: 'deleted-device',
            save: (callback) => callback?.()
        };
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue(null)
        });

        const router = require('../routes/devices');
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.session = sessionRef;
            req.user = sessionRef.user;
            req.flash = jest.fn();
            next();
        });
        app.locals.db = db;
        app.use('/api/devices', router);

        const res = await request(app).get('/api/devices/active');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, deviceId: '' });
        expect(sessionRef.deviceId).toBeUndefined();
    });

    test('keeps an explicitly selected offline device first in the list response', async () => {
        global.modemService = {
            isDeviceOnline: jest.fn((deviceId) => deviceId === 'device-live-1'),
            getStatus: jest.fn((deviceId) => ({
                online: deviceId === 'device-live-1',
                lastSeen: deviceId === 'device-live-1'
                    ? '2026-04-20T11:00:00.000Z'
                    : '2026-04-20T12:00:00.000Z'
            }))
        };

        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([
                {
                    id: 'device-live-1',
                    name: 'Live Device',
                    type: 'esp32',
                    created_at: '2026-04-10T00:00:00.000Z',
                    assigned_users: 1
                },
                {
                    id: 'device-offline-1',
                    name: 'Offline Device',
                    type: 'esp32',
                    created_at: '2026-04-09T00:00:00.000Z',
                    assigned_users: 1
                }
            ])
        });

        const router = require('../routes/devices');
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.session = {
                user: { id: 1, role: 'admin', username: 'admin' },
                deviceId: 'device-offline-1',
                save: (callback) => callback?.()
            };
            req.user = req.session.user;
            req.flash = jest.fn();
            next();
        });
        app.locals.db = db;
        app.use('/api/devices', router);

        const res = await request(app).get('/api/devices');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.devices.map((device) => device.id)).toEqual([
            'device-offline-1',
            'device-live-1'
        ]);
    });

    test('infers Android lane from android-prefixed IDs even with stale ESP metadata', async () => {
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(false),
            getStatus: jest.fn().mockReturnValue({
                online: false,
                mqtt: { connected: true },
                activePath: 'http'
            })
        };

        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([
                {
                    id: 'android-e2e-20260423b',
                    name: 'Android E2E',
                    type: 'esp32',
                    board: 'esp32-s3-a7670e',
                    capabilities: JSON.stringify({}),
                    created_at: '2026-04-23T00:00:00.000Z',
                    assigned_users: 1
                }
            ])
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app).get('/api/devices');

        expect(res.status).toBe(200);
        expect(res.body.devices[0]).toEqual(expect.objectContaining({
            id: 'android-e2e-20260423b',
            type: 'android',
            deviceType: 'android'
        }));
    });

    test('treats the env admin username as admin for device listing even if the stored role is lower', async () => {
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(false),
            getStatus: jest.fn().mockReturnValue({ online: false, lastSeen: null })
        };

        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([
                {
                    id: 'device-a',
                    name: 'Device A',
                    type: 'android',
                    created_at: '2026-04-01T00:00:00.000Z',
                    assigned_users: 0
                },
                {
                    id: 'device-b',
                    name: 'Device B',
                    type: 'esp32',
                    created_at: '2026-04-02T00:00:00.000Z',
                    assigned_users: 1
                }
            ])
        });

        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'viewer', username: 'admin' }, db);

        const res = await request(app).get('/api/devices');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.devices.map((device) => device.id)).toEqual(['device-a', 'device-b']);
    });
});

describe('rendered dashboard pages', () => {
    afterEach(() => {
        delete global.mqttService;
        delete global.modemService;
    });

    test('renders the dashboard home page with device-scoped SMS and calls queries', async () => {
        const db = makeDbMock({
            all: jest.fn()
                .mockResolvedValueOnce([{ id: 1 }])
                .mockResolvedValueOnce([{
                    conversation_id: 2,
                    primary_number: '+8801628301525',
                    title: 'Primary thread',
                    unread_count: 1,
                    message_count: 3,
                    last_message_preview: 'Latest conversation preview',
                    last_message_direction: 'incoming',
                    last_message_status: 'received',
                    last_message_at: '2026-04-16T08:00:00.000Z'
                }])
                .mockResolvedValueOnce([{ id: 3 }])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ id: 'device-11', name: 'Device 11', description: '' }]),
            get: jest.fn()
                .mockResolvedValueOnce({ count: 4 })
                .mockResolvedValueOnce({ count: 5 })
                .mockResolvedValueOnce({ count: 6 })
                .mockResolvedValueOnce({ count: 7 })
                .mockResolvedValueOnce({ count: 8 })
        });
        global.mqttService = { connected: true };
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(true),
            getDeviceStatus: jest.fn().mockReturnValue({
                signal: 80,
                battery: 91,
                network: 'LTE',
                operator: 'TestNet',
                temperature: 31,
                uptime: '1h',
                ip: '192.168.1.50',
                imei: '123456789012345'
            })
        };
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 11, role: 'admin', username: 'admin', deviceId: 'device-11' }, db);

        const res = await request(app).get('/');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/index');
        const allSql = getSqlStatements(db.all);
        const getSql = getSqlStatements(db.get);
        expect(allSql.some((sql) => sql.includes('FROM sms') && sql.includes('WHERE device_id = ?'))).toBe(true);
        expect(allSql.some((sql) => sql.includes('FROM sms_conversations') && sql.includes('WHERE device_id = ?'))).toBe(true);
        expect(allSql.some((sql) => sql.includes('FROM calls') && sql.includes('WHERE device_id = ?'))).toBe(true);
        expect(getSql.some((sql) => sql.includes('FROM sms') && sql.includes('WHERE device_id = ?'))).toBe(true);

        const templatePath = path.join(__dirname, '..', 'views', 'pages', 'index.html');
        const template = fs.readFileSync(templatePath, 'utf8');
        const html = ejs.render(template, {
            ...res.body.locals,
            deviceId: 'device-11',
            moment: require('moment')
        }, { filename: templatePath });
        expect(html).toContain('Conversations');
        expect(html).toContain('Latest conversation preview');
        expect(html).toContain('Primary thread');
    });

    test('auto-selects and stores the latest registered device when no current device exists', async () => {
        const sessionRef = {
            user: { id: 11, role: 'admin', username: 'admin' },
            deviceId: '',
            save: (callback) => callback?.()
        };
        const db = makeDbMock({
            all: jest.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ id: 'device-latest', name: 'Latest Device', description: '' }]),
            get: jest.fn()
                .mockResolvedValueOnce({ id: 'device-latest' })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
        });
        global.mqttService = { connected: true };
        global.modemService = {
            isDeviceOnline: jest.fn((deviceId) => deviceId === 'device-latest'),
            getDeviceStatus: jest.fn().mockReturnValue({
                signal: 72,
                battery: 88,
                network: 'LTE',
                operator: 'TestNet'
            })
        };

        const router = require('../routes/index');
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.session = sessionRef;
            req.user = sessionRef.user;
            req.flash = jest.fn();
            next();
        });
        app.use((req, res, next) => {
            res.render = (view, locals = {}) => res.status(200).json({ view, locals });
            next();
        });
        app.locals.db = db;
        app.use('/', router);

        const res = await request(app).get('/');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/index');
        expect(res.body.locals.deviceId).toBe('device-latest');
        expect(sessionRef.deviceId).toBe('device-latest');
        expect(global.modemService.isDeviceOnline).toHaveBeenCalledWith('device-latest');
    });

    test('renders dashboard without an active device when the stored device was deleted', async () => {
        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([]),
            get: jest.fn().mockResolvedValue({ count: 0 })
        });
        global.mqttService = { connected: true };
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(false),
            getDeviceStatus: jest.fn().mockReturnValue({})
        };

        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', {
            id: 11,
            role: 'admin',
            username: 'admin',
            deviceId: 'deleted-device'
        }, db);

        const res = await request(app).get('/dashboard');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/index');
        expect(res.body.locals.deviceId).toBe('');
        expect(res.body.locals.hasRegisteredDevices).toBe(false);
        expect(res.body.locals.hasActiveDevice).toBe(false);
    });

    test('renders the health placeholder node so live updates can fill it later', async () => {
        const db = makeDbMock({
            all: jest.fn()
                .mockResolvedValueOnce([{ id: 1 }])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ id: 2 }])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ id: 'device-11', name: 'Device 11', description: '' }]),
            get: jest.fn()
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
        });
        global.mqttService = { connected: true };
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(true),
            getDeviceStatus: jest.fn().mockReturnValue({
                signal: null,
                battery: null,
                network: 'Cellular',
                operator: null,
                temperature: null,
                uptime: null,
                ip: '10.172.126.118',
                imei: null,
                lastSeen: null,
                mqtt: null
            })
        };
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 11, role: 'admin', username: 'admin', deviceId: 'device-11' }, db);

        const res = await request(app).get('/');

        expect(res.status).toBe(200);
        const templatePath = path.join(__dirname, '..', 'views', 'pages', 'index.html');
        const template = fs.readFileSync(templatePath, 'utf8');
        const html = ejs.render(template, {
            ...res.body.locals,
            deviceId: 'device-11',
            moment: require('moment')
        }, { filename: templatePath });

        expect(html).toContain('id="dashboardLastSeen"');
        expect(html).toContain('id="deviceHealth"');
        expect(html).toMatch(/id="deviceHealth"[\s\S]*?>\s*N\/A\s*</);
        expect(html).toContain('id="dashCharging"');
        expect(html).toContain('id="dashBatteryVoltage"');
        expect(html).toContain('id="dashBatteryState"');
        expect(html).toContain('Not reported by device');
        expect(html).toContain('id="dashBatteryValue"');
        expect(html).toContain('id="dashCellSignalValue"');
        expect(html).toContain('id="dashWifiSignalValue"');
        expect(html).toContain('N/A');
        expect(html).toContain('id="dashboardTelemetryNotice"');
        expect(html).toContain('Limited device telemetry on this link');
        expect(html).toContain('Not reported');
        expect(html).toContain('Not reported by device');
    });

    test('renders operator and SIM number on the dashboard network card when live status provides them', async () => {
        const db = makeDbMock({
            all: jest.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ id: 'device-11', name: 'Device 11', description: '' }]),
            get: jest.fn()
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
        });
        global.mqttService = { connected: true };
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(true),
            getDeviceStatus: jest.fn().mockReturnValue({
                activePath: 'modem',
                network: 'Cellular',
                operator: 'Grameenphone',
                ip: '10.172.126.118',
                sim: {
                    registered: true,
                    number: '+8801628301525'
                }
            })
        };
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 11, role: 'admin', username: 'admin', deviceId: 'device-11' }, db);

        const res = await request(app).get('/');

        expect(res.status).toBe(200);
        const templatePath = path.join(__dirname, '..', 'views', 'pages', 'index.html');
        const template = fs.readFileSync(templatePath, 'utf8');
        const html = ejs.render(template, {
            ...res.body.locals,
            deviceId: 'device-11',
            moment: require('moment')
        }, { filename: templatePath });

        expect(html).toContain('id="dashOperator"');
        expect(html).toContain('Grameenphone');
        expect(html).toContain('id="dashSimNumber"');
        expect(html).toContain('+8801628301525');
    });

    test('renders the active device card with active path, current network, and active signal', async () => {
        const db = makeDbMock({
            all: jest.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ id: 'device-11', name: 'Device 11', description: '' }]),
            get: jest.fn()
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
        });
        global.mqttService = { connected: true };
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(true),
            getDeviceStatus: jest.fn().mockReturnValue({
                activePath: 'modem',
                network: 'Cellular',
                operator: 'robi axiata',
                mobile: {
                    networkType: 'LTE'
                },
                signal: 74,
                cellularSignal: 74,
                wifiSignal: null,
                wifi: {
                    connected: false,
                    ssid: 'RiazM'
                },
                ip: '10.216.251.212',
                sim: {
                    registered: true
                }
            })
        };
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 11, role: 'admin', username: 'admin', deviceId: 'device-11' }, db);

        const res = await request(app).get('/');

        expect(res.status).toBe(200);
        const templatePath = path.join(__dirname, '..', 'views', 'pages', 'index.html');
        const template = fs.readFileSync(templatePath, 'utf8');
        const html = ejs.render(template, {
            ...res.body.locals,
            deviceId: 'device-11',
            moment: require('moment')
        }, { filename: templatePath });

        expect(html).toContain('<div class="text-muted">Active</div>');
        expect(html).toContain('<div class="fw-semibold active-card-primary">Modem (4G/LTE)</div>');
        expect(html).toContain('<div class="text-muted">Current</div>');
        expect(html).toContain('class="fw-semibold text-truncate active-card-current" title="robi axiata">robi axiata</div>');
        expect(html).toContain('<div class="text-muted">Signal</div>');
        expect(html).toContain('<div class="fw-semibold active-card-signal">74%</div>');
        expect(html).toContain('id="dashWifiPrimary">');
        expect(html).toContain('Not connected');
        expect(html).toContain('id="dashModemActive">');
        expect(html).toContain('Fallback');
    });

    test('renders flat firmware home status with Wi-Fi, MQTT, modem, and missing SIM wording', async () => {
        const db = makeDbMock({
            all: jest.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ id: 'device-11', name: 'Device 11', description: '' }]),
            get: jest.fn()
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
        });
        global.mqttService = {
            connected: true,
            getDeviceQueueState: jest.fn().mockResolvedValue({
                summary: {
                    pending: 0,
                    active: 0,
                    failed: 0,
                    ambiguous: 0,
                    totalOpen: 0
                },
                recent: []
            })
        };
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(true),
            getDeviceStatus: jest.fn().mockReturnValue({
                active_path: 'wifi',
                wifi_configured: true,
                wifi_started: true,
                wifi_connected: true,
                wifi_ip_assigned: true,
                wifi_ssid: 'RiazM',
                wifi_ip_address: '10.147.48.235',
                wifi_rssi: -71,
                mqtt_configured: true,
                mqtt_connected: true,
                mqtt_subscribed: true,
                mqtt_reconnect_count: 0,
                mqtt_published_count: 16,
                mqtt_publish_failures: 0,
                modem_registered: true,
                modem_signal: 20,
                modem_operator_name: 'robi axiata',
                telephony_supported: true,
                telephony_enabled: true,
                data_mode_enabled: true,
                sd_mounted: true,
                storage_media_available: true,
                storage_buffered_only: false,
                storage_queue_depth: 1,
                storage_total_bytes: 62519640064,
                storage_used_bytes: 458752,
                storage_free_bytes: 62519181312
            })
        };
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 11, role: 'admin', username: 'admin', deviceId: 'device-11' }, db);

        const res = await request(app).get('/');

        expect(res.status).toBe(200);
        const templatePath = path.join(__dirname, '..', 'views', 'pages', 'index.html');
        const template = fs.readFileSync(templatePath, 'utf8');
        const html = ejs.render(template, {
            ...res.body.locals,
            deviceId: 'device-11',
            moment: require('moment')
        }, { filename: templatePath });

        expect(html).toContain('id="dashWifiSsid"');
        expect(html).toContain('RiazM');
        expect(html).toContain('id="dashOperator"');
        expect(html).toContain('robi axiata');
        expect(html).toContain('id="dashSimNumber"');
        expect(html).toContain('Checking...');
        expect(html).toContain('id="dashWifiIp"');
        expect(html).toContain('10.147.48.235');
        expect(html).toContain('id="dashWifiPrimary">');
        expect(html).toContain('Primary');
        expect(html).toContain('id="dashWifiSignalMeta">Connected<');
    });

    test('hides SMS and call home widgets when live status says telephony is unsupported', async () => {
        const db = makeDbMock({
            all: jest.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ id: 'device-11', name: 'Device 11', description: '' }]),
            get: jest.fn()
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
        });
        global.mqttService = { connected: true };
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(true),
            getDeviceStatus: jest.fn().mockReturnValue({
                activePath: 'modem',
                network: 'Cellular',
                operator: 'TestNet',
                ip: '10.172.126.118',
                sim: {
                    registered: true
                },
                telephonySupported: false,
                telephonyEnabled: false,
                dataModeEnabled: true
            })
        };
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 11, role: 'admin', username: 'admin', deviceId: 'device-11' }, db);

        const res = await request(app).get('/');

        expect(res.status).toBe(200);
        const templatePath = path.join(__dirname, '..', 'views', 'pages', 'index.html');
        const template = fs.readFileSync(templatePath, 'utf8');
        const html = ejs.render(template, {
            ...res.body.locals,
            deviceId: 'device-11',
            moment: require('moment')
        }, { filename: templatePath });

        expect(html).not.toContain('href="/sms" class="btn btn-sm btn-primary"');
        expect(html).not.toContain('href="/calls" class="btn btn-sm btn-primary"');
        expect(html).not.toContain('data-bs-target="#sendSmsModal"');
        expect(html).not.toContain('id="sendSmsModal"');
        expect(html).not.toContain('SMS Sent');
        expect(html).not.toContain('Call Duration');
        expect(html).not.toContain('USSD Queries');
        expect(html).not.toContain('Check</span> Balance');
        expect(html).toContain('Restart</span> Modem');
        expect(html).toContain('System Activity');
    });

    test('renders dashboard and device queue summaries on the home page from live queue state', async () => {
        const db = makeDbMock({
            all: jest.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ id: 'device-11', name: 'Device 11', description: '' }]),
            get: jest.fn()
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 })
        });
        global.mqttService = {
            connected: true,
            getDeviceQueueState: jest.fn().mockResolvedValue({
                summary: {
                    pending: 2,
                    active: 1,
                    failed: 0,
                    ambiguous: 0,
                    totalOpen: 3
                },
                recent: [
                    {
                        command: 'sms.send',
                        status: 'waiting_response'
                    }
                ]
            })
        };
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(true),
            getDeviceStatus: jest.fn().mockReturnValue({
                network: 'Cellular',
                operator: 'TestNet',
                ip: '10.172.126.118',
                sim: {
                    registered: true
                },
                telephonySupported: true,
                telephonyEnabled: true,
                dataModeEnabled: true,
                queues: {
                    total: 4,
                    storagePending: 2
                }
            })
        };
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 11, role: 'admin', username: 'admin', deviceId: 'device-11' }, db);

        const res = await request(app).get('/');

        expect(res.status).toBe(200);
        const templatePath = path.join(__dirname, '..', 'views', 'pages', 'index.html');
        const template = fs.readFileSync(templatePath, 'utf8');
        const html = ejs.render(template, {
            ...res.body.locals,
            deviceId: 'device-11',
            moment: require('moment')
        }, { filename: templatePath });

        expect(html).toContain('id="dashQueueSummary"');
        expect(html).toContain('2 pending, 1 active');
        expect(html).toContain('id="dashDeviceQueue"');
        expect(html).toContain('4 pending');
        expect(html).toContain('id="dashStorageQueue"');
        expect(html).toContain('2 pending');
        expect(html).toContain('id="dashRecentQueue"');
        expect(html).toContain('sms.send: waiting_response');
    });

    test('renders a stable last-seen placeholder when the page has no live device timestamp yet', async () => {
        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([]),
            get: jest.fn().mockResolvedValue({ count: 0 })
        });
        global.mqttService = { connected: true };
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(false),
            getDeviceStatus: jest.fn().mockReturnValue(null)
        };
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 11, role: 'admin', username: 'admin', deviceId: '' }, db);

        const res = await request(app).get('/');

        expect(res.status).toBe(200);
        const templatePath = path.join(__dirname, '..', 'views', 'pages', 'index.html');
        const template = fs.readFileSync(templatePath, 'utf8');
        const html = ejs.render(template, {
            ...res.body.locals,
            deviceId: '',
            moment: require('moment')
        }, { filename: templatePath });

        expect(html).toContain('id="dashboardLastSeen"');
        expect(html).toContain('Last seen: -');
    });

    test('renders the SMS page and scopes message queries by active device', async () => {
        const db = makeDbMock({
            get: jest.fn()
                .mockResolvedValueOnce({ count: 12 })
                .mockResolvedValueOnce({ count: 2 }),
            all: jest.fn()
                .mockResolvedValueOnce([{ id: 'phone-11' }])
                .mockResolvedValueOnce([{ id: 1, message: 'hello' }])
        });
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 11, role: 'admin', username: 'admin', deviceId: 'phone-11' }, db);

        const res = await request(app).get('/sms');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/sms');
        const getSql = getSqlStatements(db.get);
        const allSql = getSqlStatements(db.all);
        expect(getSql.some((sql) => sql.includes('FROM sms') && sql.includes('WHERE device_id = ?'))).toBe(true);
        expect(allSql.some((sql) => sql.includes('FROM sms') && sql.includes('WHERE device_id = ?'))).toBe(true);
    });

    test('renders SMS page HTML with compact conversation workspace and schedule controls', async () => {
        const db = makeDbMock({
            get: jest.fn()
                .mockResolvedValueOnce({ count: 3 })
                .mockResolvedValueOnce({ count: 1 }),
            all: jest.fn()
                .mockResolvedValueOnce([{ id: 'phone-11' }])
                .mockResolvedValueOnce([
                    {
                        id: 1,
                        from_number: '+8801628301525',
                        to_number: null,
                        message: 'hello inbox',
                        timestamp: '2026-04-13T10:00:00.000Z',
                        read: 0,
                        type: 'incoming',
                        status: 'received'
                    },
                    {
                        id: 2,
                        from_number: 'self',
                        to_number: '+8801628301525',
                        message: 'hello sent',
                        timestamp: '2026-04-13T10:05:00.000Z',
                        read: 1,
                        type: 'outgoing',
                        status: 'queued'
                    },
                    {
                        id: 3,
                        from_number: '+8801711111111',
                        to_number: null,
                        message: 'hello inbox two',
                        timestamp: '2026-04-13T10:10:00.000Z',
                        read: 1,
                        type: 'incoming',
                        status: 'received'
                    }
                ])
        });
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 11, role: 'admin', username: 'admin', deviceId: 'phone-11' }, db);

        const res = await request(app).get('/sms');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/sms');

        const templatePath = path.join(__dirname, '..', 'views', 'pages', 'sms.html');
        const template = fs.readFileSync(templatePath, 'utf8');
        const html = ejs.render(template, {
            ...res.body.locals,
            moment: require('moment')
        }, { filename: templatePath });

        expect(html).toContain('id="smsTotalCount"');
        expect(html).toMatch(/id="smsTotalCount"[\s\S]*?>\s*3\s*</);
        expect(html).toContain('id="smsSentCount"');
        expect(html).toMatch(/id="smsSentCount"[\s\S]*?>\s*1\s*</);
        expect(html).toContain('id="smsInboxCount"');
        expect(html).toMatch(/id="smsInboxCount"[\s\S]*?>\s*2\s*</);
        expect(html).toContain('id="smsUnreadCount"');
        expect(html).toMatch(/id="smsUnreadCount"[\s\S]*?>\s*1\s*</);
        expect(html).toContain('id="smsConversationWorkspace"');
        expect(html).toContain('id="smsConversationList"');
        expect(html).toContain('id="smsChatMessages"');
        expect(html).toContain('id="smsChatForm"');
        expect(html).toContain('id="smsChatTo"');
        expect(html).toContain('id="smsChatMessage"');
        expect(html).toContain('sms-conversation-state sms-conversation-state-loading');
        expect(html).toContain('sms-chat-summary-row');
        expect(html).toContain('sms-media-icon');
        expect(html).toContain('sms-media-meta');
        expect(html).toContain('id="scheduleModal"');
        expect(html).toContain('id="scheduledBadge"');
        expect(html).toContain('id="schedCreateBtn"');
        expect(html).toContain('data-bs-target="#scheduleModal"');
        expect(html).toContain("openContactsModal('smsChatTo')");
        expect(html).toContain("openContactsModal('modalTo')");
        expect(html).toContain('id="contactCompanyFilter"');
        expect(html).not.toContain('id="smsTabs"');
        expect(html).not.toContain('id="inboxUnreadBadge"');
    });

    test('renders SMS empty state and hides unread badge when unread count is zero', async () => {
        const db = makeDbMock({
            get: jest.fn()
                .mockResolvedValueOnce({ count: 0 })
                .mockResolvedValueOnce({ count: 0 }),
            all: jest.fn()
                .mockResolvedValueOnce([{ id: 'phone-11' }])
                .mockResolvedValueOnce([])
        });
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 11, role: 'admin', username: 'admin', deviceId: 'phone-11' }, db);

        const res = await request(app).get('/sms');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/sms');

        const templatePath = path.join(__dirname, '..', 'views', 'pages', 'sms.html');
        const template = fs.readFileSync(templatePath, 'utf8');
        const html = ejs.render(template, {
            ...res.body.locals,
            moment: require('moment')
        }, { filename: templatePath });

        expect(html).toMatch(/id="smsTotalCount"[\s\S]*?>\s*0\s*</);
        expect(html).toMatch(/id="smsUnreadCount"[\s\S]*?>\s*0\s*</);
        expect(html).toContain('id="smsConversationWorkspace"');
        expect(html).toContain('Loading conversations...');
        expect(html).toContain('Pick a conversation from the left');
        expect(html).toContain('sms-conversation-state sms-conversation-state-empty');
        expect(html).toContain('id="smsChatForm"');
        expect(html).not.toContain('id="smsTabs"');
        expect(html).not.toContain('No messages in inbox');
    });

    test('normalizes phone-like and service senders for the conversation data', async () => {
        const db = makeDbMock({
            get: jest.fn()
                .mockResolvedValueOnce({ count: 2 })
                .mockResolvedValueOnce({ count: 2 }),
            all: jest.fn()
                .mockResolvedValueOnce([{ id: 'phone-11' }])
                .mockResolvedValueOnce([
                    {
                        id: 1,
                        from_number: '+8801628301525',
                        to_number: null,
                        message: 'hello from phone',
                        timestamp: '2026-04-13T10:00:00.000Z',
                        read: 0,
                        type: 'incoming',
                        status: 'received'
                    },
                    {
                        id: 2,
                        from_number: '989898',
                        to_number: null,
                        message: 'Your OTP is 123456',
                        timestamp: '2026-04-13T10:05:00.000Z',
                        read: 0,
                        type: 'incoming',
                        status: 'received'
                    }
                ])
        });
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 11, role: 'admin', username: 'admin', deviceId: 'phone-11' }, db);

        const res = await request(app).get('/sms');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/sms');

        const templatePath = path.join(__dirname, '..', 'views', 'pages', 'sms.html');
        const template = fs.readFileSync(templatePath, 'utf8');
        const html = ejs.render(template, {
            ...res.body.locals,
            moment: require('moment')
        }, { filename: templatePath });

        expect(html).toContain('id="smsConversationWorkspace"');
        expect(html).toContain('id="smsChatForm"');
        expect(res.body.locals.messages[0]).toMatchObject({
            from_number: '+8801628301525',
            display_from: '+8801628301525',
            sender_is_phone: true
        });
        expect(res.body.locals.messages[1]).toMatchObject({
            from_number: '989898',
            display_from: 'Verification Service',
            sender_is_phone: false
        });
    });

    test('renders the Calls page and scopes stats by active device', async () => {
        const db = makeDbMock({
            all: jest.fn().mockResolvedValueOnce([{ id: 'phone-11' }]),
            get: jest.fn()
                .mockResolvedValueOnce({ count: 9 })
                .mockResolvedValueOnce({ count: 3 })
                .mockResolvedValueOnce({ count: 1 })
        });
        global.mqttService = { connected: true };
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(true)
        };
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 11, role: 'admin', username: 'admin', deviceId: 'phone-11' }, db);

        const res = await request(app).get('/calls');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/calls');
        const getSql = getSqlStatements(db.get);
        expect(getSql.some((sql) => sql.includes('FROM calls') && sql.includes('WHERE device_id = ?'))).toBe(true);
        expect(getSql.some((sql) => sql.includes("status = 'answered'") && sql.includes('WHERE device_id = ?'))).toBe(true);
        expect(getSql.some((sql) => sql.includes("status = 'missed'") && sql.includes('WHERE device_id = ?'))).toBe(true);
    });

    test('renders the USSD page and scopes recent history by active device', async () => {
        const db = makeDbMock({
            all: jest.fn()
                .mockResolvedValueOnce([{ id: 'phone-11' }])
                .mockResolvedValueOnce([{ id: 1, device_id: 'phone-11', code: '*123#' }])
        });
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 11, role: 'admin', username: 'admin', deviceId: 'phone-11' }, db);

        const res = await request(app).get('/ussd');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/ussd');
        expect(res.body.locals.deviceId).toBe('phone-11');
        expect(db.all).toHaveBeenCalledWith(
            expect.stringContaining('WHERE device_id = ?'),
            ['phone-11']
        );
    });

    test('legacy device about path redirects to the device-scoped route', async () => {
        const router = require('../routes/index');
        const app = buildRenderedApp(
            router,
            '/',
            { id: 11, role: 'admin', username: 'admin', deviceId: 'device-11' },
            makeDbMock({
                all: jest.fn().mockResolvedValueOnce([{ id: 'device-11' }])
            })
        );

        const about = await request(app).get('/device-about?device=device-11');

        expect(about.status).toBe(302);
        expect(about.headers.location).toBe('/devices/about?device=device-11');
    });

    test('renders the device-scoped Device About page', async () => {
        const router = require('../routes/index');
        const app = buildRenderedApp(
            router,
            '/',
            { id: 11, role: 'admin', username: 'admin', deviceId: 'device-11' },
            makeDbMock({
                all: jest.fn().mockResolvedValueOnce([{ id: 'device-11' }])
            })
        );

        const about = await request(app).get('/devices/about?device=device-11');

        expect(about.status).toBe(200);
        expect(about.body.view).toBe('pages/device-about');
    });

    test('legacy queue manager path redirects to the device-scoped route', async () => {
        const router = require('../routes/index');
        const app = buildRenderedApp(
            router,
            '/',
            { id: 11, role: 'admin', username: 'admin', deviceId: 'device-11' },
            makeDbMock({
                all: jest.fn().mockResolvedValueOnce([{ id: 'device-11' }])
            })
        );

        const queue = await request(app).get('/queue-manager?device=device-11');

        expect(queue.status).toBe(302);
        expect(queue.headers.location).toBe('/devices/queue?device=device-11');
    });

    test('renders the Webcam page', async () => {
        const router = require('../routes/index');
        const app = buildRenderedApp(
            router,
            '/',
            { id: 11, role: 'admin', username: 'admin', deviceId: 'device-11' },
            makeDbMock({
                all: jest.fn().mockResolvedValueOnce([{ id: 'device-11' }])
            })
        );

        const webcam = await request(app).get('/webcam');

        expect(webcam.status).toBe(200);
        expect(webcam.body.view).toBe('pages/webcam');
    });

    test('renders the Test Center page', async () => {
        const router = require('../routes/index');
        const app = buildRenderedApp(
            router,
            '/',
            { id: 11, role: 'admin', username: 'admin', deviceId: 'device-11' },
            makeDbMock({
                all: jest.fn().mockResolvedValueOnce([{ id: 'device-11' }])
            })
        );

        const testPage = await request(app).get('/test');

        expect(testPage.status).toBe(200);
        expect(testPage.body.view).toBe('pages/test');
    });

    test('renders the Automation page', async () => {
        const router = require('../routes/index');
        const app = buildRenderedApp(
            router,
            '/',
            { id: 11, role: 'admin', username: 'admin', deviceId: 'device-11' },
            makeDbMock({
                all: jest.fn().mockResolvedValueOnce([{ id: 'device-11' }])
            })
        );

        const automation = await request(app).get('/automation');

        expect(automation.status).toBe(200);
        expect(automation.body.view).toBe('pages/automation');
    });
});

describe('storage routes', () => {
    afterEach(() => {
        delete global.mqttService;
    });

    test('creates a directory through the storage-mkdir firmware command', async () => {
        global.mqttService = {
            connected: true,
            publishCommand: jest.fn().mockResolvedValue({
                success: true,
                message: 'directory created'
            })
        };

        const router = require('../routes/storage');
        const app = buildApp(router, '/api/storage');

        const res = await request(app)
            .post('/api/storage/mkdir')
            .send({ deviceId: 'device-1', path: 'logs', name: 'today' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'device-1',
            'storage-mkdir',
            { path: 'logs', name: 'today' },
            true,
            15000
        );
    });

    test('returns enriched storage diagnostics from storage-info payloads', async () => {
        const mqttService = new EventEmitter();
        mqttService.connected = true;
        mqttService.publishCommand = jest.fn().mockImplementation(async (deviceId) => {
            process.nextTick(() => {
                mqttService.emit('storage:info', deviceId, {
                    mounted: true,
                    cardDetected: true,
                    total: 1024,
                    used: 256,
                    free: 768,
                    filesystem: 'FAT32',
                    cardType: 'SDHC/SDXC',
                    bus: 'SPI',
                    pins: { cs: 10, mosi: 11, miso: 13, clk: 12 },
                    lastError: null
                });
            });
        });
        global.mqttService = mqttService;

        const router = require('../routes/storage');
        const app = buildApp(router, '/api/storage');

        const res = await request(app).get('/api/storage/info?deviceId=device-1&refresh=1');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(mqttService.publishCommand).toHaveBeenCalledWith(
            'device-1',
            'storage-info',
            {},
            false,
            10000,
            expect.objectContaining({
                skipQueue: true,
                source: 'dashboard-storage',
                domain: 'status',
                bypassCompatibility: true
            })
        );
        expect(res.body.data.sd).toMatchObject({
            available: true,
            mounted: true,
            cardDetected: true,
            type: 'SSD',
            filesystem: 'FAT32',
            cardType: 'SDHC/SDXC',
            bus: 'SPI',
            pins: { cs: 10, mosi: 11, miso: 13, clk: 12 },
            lastError: null
        });
    });
});

describe('POST /api/devices', () => {
    test('creates a phone device and returns 201', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ lastID: 0, changes: 1 })
        });
        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 7, role: 'admin', username: 'admin' }, db);

        const res = await request(app)
            .post('/api/devices')
            .send({ id: 'phone-1', name: 'Phone 1', type: 'phone' });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.device.id).toBe('phone-1');
        expect(res.body.device.type).toBe('phone');
    });
});

describe('DELETE /api/devices/:id', () => {
    test('suppresses and fully releases runtime state for a deleted device', async () => {
        const db = makeDbMock({
            run: jest.fn((sql) => {
                if (sql === 'BEGIN' || sql === 'COMMIT') {
                    return Promise.resolve({ lastID: 0, changes: 0 });
                }
                if (sql.includes('DELETE FROM devices WHERE id = ?')) {
                    return Promise.resolve({ lastID: 0, changes: 1 });
                }
                return Promise.resolve({ lastID: 0, changes: 1 });
            })
        });
        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
        const mqttHandlers = {
            suppressDeletedDevice: jest.fn().mockResolvedValue(undefined),
            unsuppressDeletedDevice: jest.fn().mockResolvedValue(undefined),
            releaseDeviceRuntime: jest.fn().mockResolvedValue(undefined)
        };
        app.locals.mqttHandlers = mqttHandlers;

        const res = await request(app).delete('/api/devices/device-1');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.deleted).toBe(true);
        expect(res.body.suppressed).toBe(true);
        expect(mqttHandlers.suppressDeletedDevice).toHaveBeenCalledWith('device-1');
        expect(mqttHandlers.releaseDeviceRuntime).toHaveBeenCalledWith('device-1');
        expect(mqttHandlers.unsuppressDeletedDevice).not.toHaveBeenCalled();
    });

    test('keeps suppression when the delete target is already missing', async () => {
        const db = makeDbMock({
            run: jest.fn((sql) => {
                if (sql === 'BEGIN' || sql === 'COMMIT') {
                    return Promise.resolve({ lastID: 0, changes: 0 });
                }
                if (sql.includes('DELETE FROM devices WHERE id = ?')) {
                    return Promise.resolve({ lastID: 0, changes: 0 });
                }
                return Promise.resolve({ lastID: 0, changes: 1 });
            })
        });
        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
        const mqttHandlers = {
            suppressDeletedDevice: jest.fn().mockResolvedValue(undefined),
            unsuppressDeletedDevice: jest.fn().mockResolvedValue(undefined),
            releaseDeviceRuntime: jest.fn().mockResolvedValue(undefined)
        };
        app.locals.mqttHandlers = mqttHandlers;

        const res = await request(app).delete('/api/devices/missing-device');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.deleted).toBe(false);
        expect(res.body.suppressed).toBe(true);
        expect(mqttHandlers.suppressDeletedDevice).toHaveBeenCalledWith('missing-device');
        expect(mqttHandlers.unsuppressDeletedDevice).not.toHaveBeenCalled();
        expect(mqttHandlers.releaseDeviceRuntime).toHaveBeenCalledWith('missing-device');
    });

    test('also clears quarantined device state during authoritative delete', async () => {
        const run = jest.fn((sql) => {
            if (sql === 'BEGIN' || sql === 'COMMIT') {
                return Promise.resolve({ lastID: 0, changes: 0 });
            }
            if (sql.includes('DELETE FROM devices WHERE id = ?')) {
                return Promise.resolve({ lastID: 0, changes: 0 });
            }
            return Promise.resolve({ lastID: 0, changes: 1 });
        });
        const db = makeDbMock({ run });
        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
        app.locals.mqttHandlers = {
            suppressDeletedDevice: jest.fn().mockResolvedValue(undefined),
            unsuppressDeletedDevice: jest.fn().mockResolvedValue(undefined),
            releaseDeviceRuntime: jest.fn().mockResolvedValue(undefined)
        };

        const res = await request(app).delete('/api/devices/ghost-1');

        expect(res.status).toBe(200);
        expect(db.run).toHaveBeenCalledWith('DELETE FROM unregistered_device_events WHERE device_id = ?', ['ghost-1']);
        expect(db.run).toHaveBeenCalledWith('DELETE FROM unregistered_devices WHERE device_id = ?', ['ghost-1']);
    });

    test('clears sms conversations before deleting the device row', async () => {
        const db = makeDbMock({
            run: jest.fn((sql) => {
                if (sql === 'BEGIN' || sql === 'COMMIT') {
                    return Promise.resolve({ lastID: 0, changes: 0 });
                }
                if (sql.includes('DELETE FROM devices WHERE id = ?')) {
                    return Promise.resolve({ lastID: 0, changes: 1 });
                }
                return Promise.resolve({ lastID: 0, changes: 1 });
            })
        });
        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);
        app.locals.mqttHandlers = {
            suppressDeletedDevice: jest.fn().mockResolvedValue(undefined),
            unsuppressDeletedDevice: jest.fn().mockResolvedValue(undefined),
            releaseDeviceRuntime: jest.fn().mockResolvedValue(undefined)
        };

        const res = await request(app).delete('/api/devices/device-1');

        expect(res.status).toBe(200);
        expect(db.run).toHaveBeenCalledWith('DELETE FROM sms_conversations WHERE device_id = ?', ['device-1']);
    });
});

describe('Unregistered device routes', () => {
    test('allows the env-backed admin username to access the unregistered device list as superadmin', async () => {
        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([
                {
                    device_id: 'ghost-1',
                    first_seen: '2026-04-20T08:00:00.000Z',
                    last_seen: '2026-04-20T09:00:00.000Z',
                    event_count: 3,
                    last_event_type: 'status',
                    last_number: '+8801700000000',
                    last_payload: JSON.stringify({ model: 'A7670', platform: 'android' }),
                    notes: ''
                }
            ])
        });
        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app).get('/api/devices/unregistered');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.devices).toEqual([
            expect.objectContaining({
                device_id: 'ghost-1',
                event_count: 3,
                device_type: 'android',
                model: 'A7670',
                identity: expect.objectContaining({
                    model: 'A7670'
                })
            })
        ]);
    });

    test('deletes a quarantined unregistered device and its event history', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ device_id: 'ghost-1' }),
            run: jest.fn().mockResolvedValue({ lastID: 0, changes: 1 })
        });
        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app).delete('/api/devices/unregistered/ghost-1');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: 'Unregistered device deleted'
        });
        expect(db.run).toHaveBeenCalledWith('DELETE FROM unregistered_device_events WHERE device_id = ?', ['ghost-1']);
        expect(db.run).toHaveBeenCalledWith('DELETE FROM unregistered_devices WHERE device_id = ?', ['ghost-1']);
    });

    test('keeps ESP telemetry devices as ESP during unregistered assignment', async () => {
        const db = makeDbMock({
            get: jest.fn((sql) => {
                if (sql.includes('FROM unregistered_devices')) {
                    return Promise.resolve({
                        device_id: '7hd7g-xkdvx7-kv753n',
                        last_payload: JSON.stringify({
                            type: 'device_status',
                            device_id: '7hd7g-xkdvx7-kv753n',
                            active_path: 'modem',
                            wifi_configured: true,
                            free_heap_bytes: 8206580,
                            storage_media_mounted: true
                        })
                    });
                }
                if (sql.includes('FROM users')) {
                    return Promise.resolve({ id: 2 });
                }
                if (sql.includes('LEFT JOIN device_profiles')) {
                    return Promise.resolve({ type: 'esp32-s3-a7670e', board: 'esp32-s3-a7670e' });
                }
                if (sql.includes('SELECT name FROM devices')) {
                    return Promise.resolve({ name: 'ESP32-S3 A7670E' });
                }
                return Promise.resolve(null);
            }),
            run: jest.fn().mockResolvedValue({ lastID: 0, changes: 1 })
        });
        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app)
            .post('/api/devices/unregistered/7hd7g-xkdvx7-kv753n/assign')
            .send({
                name: 'ESP32-S3 A7670E',
                type: 'android',
                user_id: 2
            });

        expect(res.status).toBe(200);
        expect(res.body.device.type).toBe('esp32-s3-a7670e');
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO devices'),
            ['7hd7g-xkdvx7-kv753n', 'ESP32-S3 A7670E', 'esp32-s3-a7670e', 'offline']
        );
    });

    test('assigns android-prefixed unregistered IDs as Android despite status-like payloads', async () => {
        const db = makeDbMock({
            get: jest.fn((sql) => {
                if (sql.includes('FROM unregistered_devices')) {
                    return Promise.resolve({
                        device_id: 'android-e2e-20260423b',
                        last_payload: JSON.stringify({
                            type: 'status',
                            device_id: 'android-e2e-20260423b',
                            active_path: 'http',
                            transport: 'http'
                        })
                    });
                }
                if (sql.includes('LEFT JOIN device_profiles')) {
                    return Promise.resolve({ type: 'esp32', board: 'esp32-s3-a7670e' });
                }
                return Promise.resolve(null);
            }),
            run: jest.fn().mockResolvedValue({ lastID: 0, changes: 1 })
        });
        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app)
            .post('/api/devices/unregistered/android-e2e-20260423b/assign')
            .send({
                name: 'Android E2E',
                type: 'esp32'
            });

        expect(res.status).toBe(200);
        expect(res.body.device.type).toBe('android');
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO devices'),
            ['android-e2e-20260423b', 'Android E2E', 'android', 'offline']
        );
    });

    test('builds Android recovery QR for android-prefixed devices with stale ESP type', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({
                id: 'android-e2e-20260423b',
                name: 'Android E2E',
                type: 'esp32',
                status: 'offline',
                board: 'esp32-s3-a7670e',
                capabilities: JSON.stringify({})
            }),
            run: jest.fn().mockResolvedValue({ lastID: 0, changes: 1 })
        });
        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app).get('/api/devices/android-e2e-20260423b/provisioning-qr');

        expect(res.status).toBe(200);
        expect(res.body).toEqual(expect.objectContaining({
            success: true,
            lane: 'android',
            device_id: 'android-e2e-20260423b'
        }));
        expect(res.body.setup_token).toBeTruthy();
        expect(res.body.qr_data_url).toMatch(/^data:image\/png;base64,/);
    });
});

describe('PUT /api/devices/:id/push-token', () => {
    test('stores a push token for a writable device', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ can_write: 1 }),
            run: jest.fn().mockResolvedValue({ lastID: 1, changes: 1 })
        });
        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 3, role: 'operator', username: 'operator' }, db);

        const res = await request(app)
            .put('/api/devices/device-1/push-token')
            .send({ token: 'expo-token-123', platform: 'android' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

describe('PUT /api/devices/:id/link-to/:targetId', () => {
    test('links a phone device to a target device', async () => {
        const db = makeDbMock({
            get: jest.fn()
                .mockResolvedValueOnce({ id: 'phone-1' })
                .mockResolvedValueOnce({ id: 'esp32-1' }),
            run: jest.fn().mockResolvedValue({ lastID: 0, changes: 1 })
        });
        const router = require('../routes/devices');
        const app = buildApp(router, '/api/devices', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app).put('/api/devices/phone-1/link-to/esp32-1');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.link.phoneDeviceId).toBe('phone-1');
        expect(res.body.link.targetDeviceId).toBe('esp32-1');
    });
});

describe('POST /api/sms/bulk-import', () => {
    test('imports new SMS rows and returns counts', async () => {
        let insertId = 0;
        const db = makeDbMock({
            run: jest.fn(async (sql) => {
                if (sql === 'BEGIN' || sql === 'COMMIT') return { lastID: 0, changes: 0 };
                if (String(sql).includes('INSERT OR IGNORE INTO sms')) {
                    insertId += 1;
                    return { lastID: insertId, changes: 1 };
                }
                return { lastID: 0, changes: 0 };
            })
        });
        const router = require('../routes/sms');
        const app = buildApp(router, '/api/sms', { id: 2, role: 'admin', username: 'admin' }, db);

        const res = await request(app)
            .post('/api/sms/bulk-import')
            .send({
                deviceId: 'phone-1',
                messages: [
                    { id: 'm1', from: '+8801000000001', message: 'hello', timestamp: '2026-03-25T10:00:00.000Z' },
                    { id: 'm2', to: '+8801000000002', type: 'outgoing', message: 'world', timestamp: '2026-03-25T10:01:00.000Z' }
                ]
            });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.imported).toBe(2);
        expect(res.body.skipped).toBe(0);
    });
});

describe('POST /api/automation/flows', () => {
    test('creates a flow and refreshes the engine cache', async () => {
        const automationEngine = require('../services/automationEngine');
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ lastID: 41, changes: 1 }),
            get: jest.fn().mockResolvedValue({
                id: 41,
                name: 'SMS Flow',
                description: '',
                nodes: '[]',
                edges: '[]',
                enabled: 1,
                device_id: 'device-9'
            })
        });
        const router = require('../routes/automation');
        const app = buildApp(router, '/api/automation', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app)
            .post('/api/automation/flows')
            .send({
                name: 'SMS Flow',
                nodes: [{ id: 't1', type: 'trigger.sms_incoming', config: {} }],
                edges: [],
                device_id: 'device-9'
            });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.flow.id).toBe(41);
        expect(automationEngine.invalidateCache).toHaveBeenCalled();
    });
});

describe('POST /api/automation/flows/:id/run', () => {
    test('returns the manual test-run result from the automation engine', async () => {
        const automationEngine = require('../services/automationEngine');
        automationEngine.testRun.mockResolvedValueOnce({
            status: 'success',
            log: ['[TEST RUN]', '[ACTION] action.log_event'],
            context: { deviceId: 'dev-1' }
        });

        const router = require('../routes/automation');
        const app = buildApp(router, '/api/automation', { id: 1, role: 'admin', username: 'admin' }, makeDbMock());

        const res = await request(app)
            .post('/api/automation/flows/7/run')
            .send({ deviceId: 'dev-1', eventType: 'sms.incoming' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe('success');
        expect(automationEngine.testRun).toHaveBeenCalledWith(7, {
            deviceId: 'dev-1',
            eventType: 'sms.incoming'
        });
    });
});

describe('Gateway admin routes', () => {
    afterEach(() => {
        jest.resetModules();
    });

    test('GET /admin/api/gateway returns configured gateways and primary payment instructions', async () => {
        const configured = JSON.stringify([
            {
                code: 'bkash',
                name: 'bKash',
                enabled: true,
                primary: false,
                account_number: '01628301525',
                account_type: 'Personal',
                instructions: 'Use bKash.'
            },
            {
                code: 'nagad',
                name: 'Nagad',
                enabled: true,
                primary: true,
                account_number: '01700000000',
                account_type: 'Merchant',
                instructions: 'Use Nagad.'
            }
        ]);
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ value: configured })
        });
        const router = require('../routes/users');
        const app = buildApp(router, '/admin', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app).get('/admin/api/gateway');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.gateways).toHaveLength(2);
        expect(res.body.primary_gateway_code).toBe('nagad');
        expect(res.body.payment).toEqual(expect.objectContaining({
            code: 'nagad',
            method: 'Nagad',
            number: '01700000000',
            message: 'Use Nagad.'
        }));
    });

    test('PUT /admin/api/gateway normalizes and saves gateways', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 1 })
        });
        const router = require('../routes/users');
        const app = buildApp(router, '/admin', { id: 2, role: 'admin', username: 'admin' }, db);

        const res = await request(app)
            .put('/admin/api/gateway')
            .send({
                gateways: [
                    {
                        code: '  bkash  ',
                        name: 'bKash',
                        enabled: true,
                        primary: false,
                        account_number: '01628301525',
                        account_type: 'Personal',
                        instructions: 'Pay by bKash'
                    },
                    {
                        code: 'nagad',
                        name: 'Nagad',
                        enabled: true,
                        primary: true,
                        account_number: '01700000000',
                        account_type: 'Merchant',
                        instructions: 'Pay by Nagad'
                    }
                ]
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.primary_gateway_code).toBe('nagad');
        expect(res.body.payment).toEqual(expect.objectContaining({
            code: 'nagad',
            method: 'Nagad',
            number: '01700000000'
        }));
        expect(db.run).toHaveBeenCalled();
        expect(db.run.mock.calls[0][1][0]).toBe('payment_gateways');
        expect(db.run.mock.calls[0][1][3]).toBe(2);
    });
});

describe('Dashboard quick routes', () => {
    afterEach(() => {
        delete global.mqttService;
        delete global.modemService;
    });

    test('POST /api/quick/balance records and dispatches the active sim scope', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ ussd_code: '*123#' }),
            run: jest.fn().mockResolvedValue({ lastID: 51, changes: 1 })
        });
        global.mqttService = {
            connected: true,
            publishCommand: jest.fn().mockResolvedValue({ messageId: 'quick-balance-1' })
        };

        const router = require('../routes/index');
        const app = buildApp(router, '', { id: 9, role: 'admin', username: 'admin' }, db);

        const res = await request(app)
            .post('/api/quick/balance')
            .send({ deviceId: 'device-q1', simSlot: 1 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO ussd'),
            ['device-q1', '*123#', 9, 1]
        );
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'device-q1',
            'send-ussd',
            {
                code: '*123#',
                sim_slot: 1
            },
            false,
            60000,
            {
                source: 'dashboard:quick-ussd',
                domain: 'telephony',
                skipPersistentQueue: true
            }
        );
    });

    test('POST /api/quick/sim-number records and dispatches the selected sim slot', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue(null),
            run: jest.fn().mockResolvedValue({ lastID: 61, changes: 1 })
        });
        global.modemService = {
            getDeviceStatus: jest.fn().mockReturnValue({ operator: 'robi' })
        };
        global.mqttService = {
            connected: true,
            publishCommand: jest.fn().mockResolvedValue({ messageId: 'quick-own-number-1' })
        };

        const router = require('../routes/index');
        const app = buildApp(router, '', { id: 5, role: 'admin', username: 'admin' }, db);

        const res = await request(app)
            .post('/api/quick/sim-number')
            .send({ deviceId: 'device-q2', simSlot: 0 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO ussd'),
            ['device-q2', '*2#', 5, 0]
        );
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'device-q2',
            'send-ussd',
            {
                code: '*2#',
                sim_slot: 0
            },
            false,
            60000,
            {
                source: 'dashboard:quick-ussd',
                domain: 'telephony',
                skipPersistentQueue: true
            }
        );
    });
});

describe('User account and detail routes', () => {
    function makeUserDetailDb(targetUser, options = {}) {
        const summary = options.summary || {
            outgoing_total: 0,
            incoming_total: 0,
            outgoing_30d: 0,
            api_30d: 0,
            dashboard_30d: 0,
            last_sent_at: null
        };
        const get = jest.fn(async (sql, params) => {
            if (sql.includes('SELECT * FROM users WHERE id = ?')) {
                return Number(params[0]) === Number(targetUser.id) ? targetUser : null;
            }
            if (sql.includes('FROM sms') && sql.includes('AS outgoing_total')) {
                return summary;
            }
            return null;
        });
        const all = jest.fn(async (sql) => {
            if (sql.includes('FROM device_users du')) return options.assignedDevices || [];
            if (sql.includes('GROUP BY substr(timestamp, 1, 10)')) return options.chartRows || [];
            if (sql.includes('FROM sms') && sql.includes('LIMIT ?')) return options.recentRows || [];
            if (sql.includes('FROM login_audit')) return options.auditRows || [];
            if (sql.includes('FROM login_sessions')) return options.sessionRows || [];
            if (sql.includes('FROM device_package_requests')) return options.packageRequests || [];
            if (sql.includes('FROM devices') && sql.includes('ORDER BY COALESCE(name, id) ASC')) {
                return options.availableDevices || [];
            }
            return [];
        });

        return makeDbMock({ get, all });
    }

    test('GET /admin/account redirects an authenticated user to their own detail page', async () => {
        const router = require('../routes/users');
        const app = buildApp(router, '/admin', { id: 9, role: 'operator', username: 'operator' }, makeDbMock());

        const res = await request(app).get('/admin/account');

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/admin/users/9');
    });

    test('GET /admin/account redirects anonymous users to login', async () => {
        const router = require('../routes/users');
        const app = buildApp(router, '/admin', null, makeDbMock());

        const res = await request(app).get('/admin/account');

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/auth/login');
    });

    test('GET /admin/users/:id renders self-service detail for the signed-in user', async () => {
        const router = require('../routes/users');
        const db = makeUserDetailDb({ id: 5, username: 'operator-5', role: 'operator' });
        const app = buildRenderedApp(router, '/admin', { id: 5, role: 'operator', username: 'operator-5' }, db);

        const res = await request(app).get('/admin/users/5');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/user-detail');
        expect(res.body.locals.title).toBe('My Account');
        expect(res.body.locals.targetUserId).toBe(5);
        expect(res.body.locals.canManageUser).toBe(false);
    });

    test('GET /admin/users/:id redirects a non-admin away from other users', async () => {
        const router = require('../routes/users');
        const app = buildRenderedApp(router, '/admin', { id: 5, role: 'operator', username: 'operator-5' }, makeDbMock());

        const res = await request(app).get('/admin/users/8');

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/admin/account');
    });

    test('GET /admin/users/:id renders admin management mode for another user', async () => {
        const router = require('../routes/users');
        const db = makeUserDetailDb({ id: 12, username: 'viewer-12', role: 'viewer' });
        const app = buildRenderedApp(router, '/admin', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app).get('/admin/users/12');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/user-detail');
        expect(res.body.locals.title).toBe('User: viewer-12');
        expect(res.body.locals.targetUserId).toBe(12);
        expect(res.body.locals.canManageUser).toBe(true);
    });

    test('GET /admin/api/users/:id/detail hides admin-only data on self view', async () => {
        const router = require('../routes/users');
        const db = makeUserDetailDb(
            {
                id: 7,
                username: 'self-user',
                role: 'operator',
                preferences: JSON.stringify({ dashboard_send_disabled: false })
            },
            {
                assignedDevices: [{ device_id: 'android-1', device_name: 'Bridge', device_type: 'android', can_write: 1 }],
                chartRows: [{ day: '2026-04-18', outgoing_total: 3, api_total: 1, dashboard_total: 2 }],
                recentRows: [{ id: 11, device_id: 'android-1', to_number: '+8801', message: 'hi', status: 'sent', source: 'dashboard', timestamp: '2026-04-18 10:00:00' }],
                auditRows: [{ id: 1, username: 'self-user', success: 1, ip: '127.0.0.1', user_agent: 'jest', reason: '', created_at: '2026-04-18 10:00:00' }],
                sessionRows: [{ id: 21, ip_address: '127.0.0.1', user_agent: 'jest', device_info: 'Chrome', logged_in_at: '2026-04-18 09:00:00', last_active: '2026-04-18 10:00:00', is_active: 1 }],
                packageRequests: [{ id: 31, device_id: 'android-1', package_name: 'Starter', price_bdt: 99, status: 'pending', requested_at: '2026-04-18 09:30:00', reviewed_at: null }],
                availableDevices: [{ id: 'should-not-leak', name: 'Hidden' }]
            }
        );
        const app = buildApp(router, '/admin', { id: 7, role: 'operator', username: 'self-user' }, db);

        const res = await request(app).get('/admin/api/users/7/detail');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.permissions).toEqual({ can_manage: false, is_self: true });
        expect(res.body.user.username).toBe('self-user');
        expect(res.body.devices).toHaveLength(1);
        expect(res.body.package_requests).toHaveLength(1);
        expect(res.body).not.toHaveProperty('available_devices');
    });

    test('GET /admin/api/users/:id/detail includes available devices for admins', async () => {
        const router = require('../routes/users');
        const db = makeUserDetailDb(
            {
                id: 8,
                username: 'managed-user',
                role: 'viewer',
                preferences: '{}'
            },
            {
                availableDevices: [{ id: 'esp32-1', name: 'ESP32 Alpha', type: 'esp32', status: 'online' }]
            }
        );
        const app = buildApp(router, '/admin', { id: 1, role: 'admin', username: 'admin' }, db);

        const res = await request(app).get('/admin/api/users/8/detail');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.permissions).toEqual({ can_manage: true, is_self: false });
        expect(res.body.available_devices).toEqual([
            { id: 'esp32-1', name: 'ESP32 Alpha', type: 'esp32', status: 'online' }
        ]);
    });

    test('GET /admin/api/users/:id/detail blocks non-admin access to another user', async () => {
        const router = require('../routes/users');
        const app = buildApp(router, '/admin', { id: 3, role: 'operator', username: 'operator-3' }, makeDbMock());

        const res = await request(app).get('/admin/api/users/4/detail');

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBe('Forbidden');
    });

    test('GET /admin/api/users/:id/detail honors the env admin username even when the stored role is lower', async () => {
        const router = require('../routes/users');
        const db = makeUserDetailDb(
            {
                id: 14,
                username: 'managed-user',
                role: 'viewer',
                preferences: '{}'
            },
            {
                availableDevices: [{ id: 'android-77', name: 'Bridge 77', type: 'android', status: 'online' }]
            }
        );
        const app = buildApp(router, '/admin', { id: 1, role: 'viewer', username: 'admin' }, db);

        const res = await request(app).get('/admin/api/users/14/detail');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.permissions).toEqual({ can_manage: true, is_self: false });
        expect(res.body.available_devices).toEqual([
            { id: 'android-77', name: 'Bridge 77', type: 'android', status: 'online' }
        ]);
    });
});
