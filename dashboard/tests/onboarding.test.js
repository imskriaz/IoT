'use strict';

const express = require('express');
const EventEmitter = require('events');
const request = require('supertest');
const http = require('http');
const fs = require('fs');
const path = require('path');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.setTimeout(15000);

function makeDbMock(overrides = {}) {
    return {
        get: jest.fn().mockResolvedValue(null),
        all: jest.fn().mockResolvedValue([]),
        run: jest.fn().mockResolvedValue({ lastID: 0, changes: 0 }),
        ...overrides
    };
}

function buildRenderedApp(router, dbMock = null) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { user: { id: 1, role: 'admin', username: 'admin' } };
        req.user = req.session.user;
        next();
    });
    app.use((req, res, next) => {
        res.render = (view, locals = {}) => res.status(200).json({ view, locals });
        next();
    });
    app.locals.db = dbMock || makeDbMock();
    app.use('/', router);
    return app;
}

function buildApiApp(router, dbMock = null) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { user: { id: 1, role: 'admin', username: 'admin' } };
        req.user = req.session.user;
        next();
    });
    app.locals.db = dbMock || makeDbMock();
    app.use('/', router);
    return app;
}

function makeMockClientRequest() {
    const req = new EventEmitter();
    const headers = new Map();
    req.write = jest.fn();
    req.destroy = jest.fn();
    req.setNoDelay = jest.fn();
    req.setSocketKeepAlive = jest.fn();
    req.abort = jest.fn();
    req.setHeader = jest.fn((name, value) => headers.set(String(name).toLowerCase(), value));
    req.getHeader = jest.fn((name) => headers.get(String(name).toLowerCase()));
    req.removeHeader = jest.fn((name) => headers.delete(String(name).toLowerCase()));
    return req;
}

async function withRunningServer(app, callback) {
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, () => resolve(instance));
    });
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        return await callback(baseUrl);
    } finally {
        await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
}

describe('onboarding routes', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('keeps board model implicit and scopes bridge onboarding fields', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'pages', 'onboarding.html'), 'utf8');

        expect(html).toContain('type="hidden" id="fModel"');
        expect(html).not.toContain('<label class="form-label">Board Model</label>');
        expect(html).toContain('data-onboard-scope="esp32"');
        expect(html).not.toContain('data-onboard-scope="mqtt"');
        expect(html).not.toContain('<label class="form-label">Location');
        expect(html).not.toContain('MQTT Server');
        expect(html).toContain('data-onboard-scope="android-transport"');
        expect(html).toContain('function applyStep3FieldVisibility()');
        expect(html).toContain("if (scope === 'esp32') show = !bridgeDevice;");
        expect(html).toContain("if (scope === 'mqtt') show = wizardState.deviceType === 'esp32-s3';");
        expect(html).toContain("if (scope === 'android-transport') show = wizardState.deviceType === 'android';");
        expect(html).toContain('The secure setup code carries both realtime and fallback connection details.');
        expect(html).toContain('Register &amp; Generate App Setup');
        expect(html).not.toContain('Device Detected');
        expect(html).not.toContain("nameInput.value = 'Android Bridge'");
        expect(html).toContain("wizardState.deviceInfo = data.device || {};");
        expect(html).toContain("wizardState.writer.write(encoder.encode('status_json\\n'))");
        expect(html).toContain('resolveEspDeviceId(info)');
        expect(html).toContain('readSerialStatusJsonWithTimeout(7000)');
        expect(html).toContain('function extractStatusJsonResponse(buffer)');
        expect(html).toContain('hardware_uid: resolveEspHardwareUid(wizardState.deviceInfo || {})');
        expect(html).toContain('function checkHardwareUid()');
        expect(html).toContain('/api/onboard/check-hardware/');
        expect(html).toContain('id="step2Duplicate"');
        expect(html).toContain('function findExistingOnboardedDevice(info = {})');
        expect(html).toContain('function showDuplicateBlock(deviceId)');
        expect(html.indexOf('id="fFirmwareFile"')).toBeLessThan(html.indexOf('id="cardSerial"'));
        expect(html).toContain('Onboarding the same device again is blocked.');
        expect(html).not.toContain('httpSMS');
        expect(html).not.toContain('typeHttpSms');
        expect(html).not.toContain('Dashboard &gt; API Keys');
        expect(html.indexOf('id="typeAndroid"')).toBeLessThan(html.indexOf('id="typeEsp32"'));
    });

    test('keeps dashboard onboarding entry points routed through the onboarding page', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'pages', 'index.html'), 'utf8');

        expect(html).not.toContain('quickOnboard');
        expect(html).not.toContain('quick-onboard');
        expect(html).not.toContain('quickOnboardModal');
        expect(html).not.toContain('/api/onboard/register');
        expect(html).toContain('href="/onboard"');
    });

    test('renders the onboarding page with MQTT defaults', async () => {
        const router = require('../routes/onboarding');
        const app = buildRenderedApp(router);

        const res = await request(app).get('/onboard');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/onboarding');
        expect(res.body.locals.title).toBe('Device Onboarding');
        expect(res.body.locals.showHeader).toBe(false);
        expect(res.body.locals.showSidebar).toBe(false);
        expect(res.body.locals.showStatusChrome).toBe(false);
        expect(res.body.locals.mqttPort).toBe(1883);
        expect(res.body.locals.setupApExampleLabel).toBe('cfg-XXXX');
        expect(res.body.locals.bleNamePrefixes).toContain('Device-Setup');
        expect(res.body.locals.bleNamePrefixes).not.toContain('IoT-Setup');
    });

    test('returns the setup AP timeout message with cfg wording', async () => {
        jest.spyOn(http, 'request').mockImplementation((_options, _callback) => {
            const req = makeMockClientRequest();
            req.end = () => process.nextTick(() => req.emit('timeout'));
            return req;
        });

        const router = require('../routes/onboarding');
        const app = buildApiApp(router);
        await withRunningServer(app, async (baseUrl) => {
            const res = await fetch(`${baseUrl}/api/onboard/wifi-send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device_id: 'idf-device-1' })
            });
            const data = await res.json();

            expect(res.status).toBe(504);
            expect(data.success).toBe(false);
            expect(data.message).toContain('cfg-XXXX');
            expect(data.message).not.toContain('IoT-Setup');
        });
    });

    test('proxies setup AP config through current firmware API and schedules reboot', async () => {
        const requests = [];
        jest.spyOn(http, 'request').mockImplementation((options, callback) => {
            const req = makeMockClientRequest();
            let body = '';

            req.write = jest.fn((chunk) => {
                body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
            });
            req.end = () => {
                process.nextTick(() => {
                    requests.push({ options, body });
                    const response = new EventEmitter();
                    response.statusCode = options.path === '/api/reboot' ? 200 : 200;
                    callback(response);
                    if (options.path === '/api/config') {
                        response.emit('data', JSON.stringify({ ok: true, restart_required: true }));
                    } else if (options.path === '/api/reboot') {
                        response.emit('data', JSON.stringify({ ok: true, detail: 'reboot_scheduled' }));
                    } else {
                        response.emit('data', JSON.stringify({ ok: true }));
                    }
                    response.emit('end');
                });
            };
            return req;
        });

        const router = require('../routes/onboarding');
        const app = buildApiApp(router);
        await withRunningServer(app, async (baseUrl) => {
            const res = await fetch(`${baseUrl}/api/onboard/wifi-send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_id: 'idf-device-1',
                    mqtt_host: 'broker.example.com',
                    mqtt_port: 1883
                })
            });
            const data = await res.json();

            expect(res.status).toBe(200);
            expect(data.success).toBe(true);
            expect(data.response).toEqual({ ok: true, restart_required: true });
            expect(data.reboot).toEqual({ ok: true, detail: 'reboot_scheduled' });
            expect(requests).toHaveLength(2);
            expect(requests[0].options.path).toBe('/api/config');
            expect(JSON.parse(requests[0].body)).toEqual({
                device_id_override: 'idf-device-1',
                wifi_ssid: '',
                wifi_password: '',
                mqtt_uri: 'mqtt://broker.example.com:1883',
                mqtt_username: '',
                mqtt_password: ''
            });
            expect(requests[1].options.path).toBe('/api/reboot');
        });
    });

    test('returns Android provisioning token and QR data after register', async () => {
        const db = makeDbMock();
        const router = require('../routes/onboarding');
        const app = buildApiApp(router, db);

        const res = await request(app)
            .post('/api/onboard/register')
            .send({
                device_id: 'android-test-01',
                name: 'Android Bridge',
                model: 'android-sms-bridge',
                bridge_type: 'android',
                mqtt_host: '144.79.218.153',
                mqtt_port: 1883,
                mqtt_user: 'device',
                mqtt_pass: '153520'
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.provisioning.type).toBe('android');
        expect(res.body.provisioning.setup_token).not.toMatch(/^[a-z]+\:/i);
        expect(res.body.provisioning.summary).toMatchObject({
            device_id: 'android-test-01',
            topic_prefix: 'device',
            mqtt_configured: true
        });
        expect(res.body.provisioning.summary).not.toHaveProperty('mqtt_password');
        expect(res.body.provisioning.summary).not.toHaveProperty('mqtt_username');
        expect(res.body.provisioning).not.toHaveProperty('payload');
        expect(res.body.provisioning.qr_data_url).toMatch(/^data:image\/png;base64,/);
    });

    test('returns Android automatic fallback provisioning with an auto-generated device API key', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ lastID: 88, changes: 1 })
        });
        const router = require('../routes/onboarding');
        const app = buildApiApp(router, db);

        const res = await request(app)
            .post('/api/onboard/register')
            .send({
                device_id: 'android-http-01',
                name: 'Android HTTP',
                model: 'android-sms-bridge',
                bridge_type: 'android',
                transport_mode: 'http'
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.provisioning.type).toBe('android');
        expect(res.body.provisioning.summary).toMatchObject({
            transport_mode: 'auto',
            api_key_name: 'Android HTTP',
            server_url: expect.any(String)
        });
        expect(res.body.provisioning).not.toHaveProperty('payload');
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO api_keys'),
            expect.arrayContaining([
                1,
                'Android HTTP',
                expect.any(String),
                expect.any(String),
                'write',
                JSON.stringify(['android-http-01']),
                120
            ])
        );
    });

    test('does not return provisioning for unsupported legacy bridge types', async () => {
        const db = makeDbMock();
        const router = require('../routes/onboarding');
        const app = buildApiApp(router, db);

        const res = await request(app)
            .post('/api/onboard/register')
            .send({
                device_id: 'legacy-http-01',
                name: 'Legacy HTTP',
                model: 'legacy-http-bridge',
                bridge_type: 'legacy-http'
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.provisioning).toBeNull();
    });

    test('probes current firmware setup AP via /api/config first', async () => {
        jest.spyOn(http, 'request').mockImplementation((options, callback) => {
            const req = makeMockClientRequest();
            req.end = () => {
                process.nextTick(() => {
                    const response = new EventEmitter();
                    response.statusCode = 200;
                    callback(response);
                    if (options.path === '/api/config') {
                        response.emit('data', JSON.stringify({
                            meta: {
                                device_id: 'ws-a7670e-476178',
                                hardware_uid: 'AABBCC476178',
                                hotspot_ssid: 'cfg-476178',
                                hotspot_ip: '192.168.4.1',
                                provisioning_active: true,
                                rescue_portal_active: false,
                                activation_reason: 'config_required',
                                wifi_configured: false,
                                wifi_connected: false,
                                wifi_disconnect_reason: 0,
                                wifi_disconnect_reason_text: '',
                                wifi_seen_ssid: '',
                                wifi_ip: ''
                            },
                            config: { mqtt_uri: 'mqtt://144.79.218.153:1883' },
                            runtime: { mqtt_running: false }
                        }));
                    } else {
                        response.emit('data', JSON.stringify({ legacy: true }));
                    }
                    response.emit('end');
                });
            };
            return req;
        });

        const router = require('../routes/onboarding');
        const app = buildApiApp(router);
        await withRunningServer(app, async (baseUrl) => {
            const res = await fetch(`${baseUrl}/api/onboard/wifi-probe`);
            const data = await res.json();

            expect(res.status).toBe(200);
            expect(data.success).toBe(true);
            expect(data.reachable).toBe(true);
            expect(data.protocol).toBe('api-config');
            expect(data.device.device_id).toBe('ws-a7670e-476178');
            expect(data.device.hardware_uid).toBe('AABBCC476178');
            expect(data.device.hotspot_ssid).toBe('cfg-476178');
            expect(data.device.wifi_disconnect_reason_text).toBe('');
            expect(data.device.config.mqtt_uri).toBe('mqtt://144.79.218.153:1883');
        });
    });

    test('derives setup AP device id from hardware UID when meta omits a device id', async () => {
        jest.spyOn(http, 'request').mockImplementation((options, callback) => {
            const req = makeMockClientRequest();
            req.end = () => {
                process.nextTick(() => {
                    const response = new EventEmitter();
                    response.statusCode = 200;
                    callback(response);
                    response.emit('data', JSON.stringify({
                        meta: {
                            hardware_uid: 'AABBCC476178',
                            hotspot_ssid: 'cfg-476178'
                        },
                        config: {},
                        runtime: {}
                    }));
                    response.emit('end');
                });
            };
            return req;
        });

        const router = require('../routes/onboarding');
        const app = buildApiApp(router);
        await withRunningServer(app, async (baseUrl) => {
            const res = await fetch(`${baseUrl}/api/onboard/wifi-probe`);
            const data = await res.json();

            expect(res.status).toBe(200);
            expect(data.device.device_id).toBe('ws-a7670e-476178');
            expect(data.device.hardware_uid).toBe('AABBCC476178');
        });
    });

    test('blocks duplicate onboarding instead of updating an existing device', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ id: 'ws-a7670e-476178' }),
            run: jest.fn().mockResolvedValue({ lastID: 1, changes: 1 })
        });
        const router = require('../routes/onboarding');
        const app = buildApiApp(router, db);

        const res = await request(app)
            .post('/api/onboard/register')
            .send({
                device_id: 'ws-a7670e-476178',
                name: 'Workshop ESP32',
                model: 'esp32-s3-a7670e'
            });

        expect(res.status).toBe(409);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('already onboarded');
        expect(db.run).not.toHaveBeenCalled();
    });

    test('checks ESP32 hardware UID availability before registration', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({ id: 'ws-a7670e-476178' })
        });
        const router = require('../routes/onboarding');
        const app = buildApiApp(router, db);

        const res = await request(app)
            .get('/api/onboard/check-hardware/AA:BB:CC:47:61:78')
            .query({ device_id: 'new-random-id' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            exists: true,
            device_id: 'ws-a7670e-476178'
        });
    });

    test('blocks ESP32 duplicate onboarding by hardware UID even when the proposed id is new', async () => {
        const db = makeDbMock({
            get: jest.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ id: 'ws-a7670e-476178' }),
            run: jest.fn().mockResolvedValue({ lastID: 1, changes: 1 })
        });
        const router = require('../routes/onboarding');
        const app = buildApiApp(router, db);

        const res = await request(app)
            .post('/api/onboard/register')
            .send({
                device_id: 'new-random-id',
                name: 'Workshop ESP32 Again',
                model: 'esp32-s3-a7670e',
                hardware_uid: 'AA:BB:CC:47:61:78'
            });

        expect(res.status).toBe(409);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('already onboarded as ws-a7670e-476178');
        expect(db.run).not.toHaveBeenCalled();
    });

    test('stores ESP32 hardware UID with the device profile during onboarding', async () => {
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([]),
            run: jest.fn().mockResolvedValue({ lastID: 1, changes: 1 })
        });
        const router = require('../routes/onboarding');
        const app = buildApiApp(router, db);

        const res = await request(app)
            .post('/api/onboard/register')
            .send({
                device_id: 'ws-a7670e-476178',
                name: 'Workshop ESP32',
                model: 'esp32-s3-a7670e',
                capabilities: {
                    hardware_uid: 'AABBCC476178',
                    chip: 'ESP32-S3'
                }
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('hardware_uid'),
            expect.arrayContaining(['aabbcc476178'])
        );
    });
});
