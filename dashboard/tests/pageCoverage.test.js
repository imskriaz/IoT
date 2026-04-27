'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
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
        all: jest.fn().mockResolvedValue([{ id: 'device-1', name: 'Device 1' }]),
        run: jest.fn().mockResolvedValue({ lastID: 0, changes: 0 }),
        exec: jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

function buildRenderedApp(router, mountPath, sessionUser, dbMock) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { user: sessionUser, deviceId: sessionUser.deviceId || '' };
        req.user = sessionUser;
        next();
    });
    app.use((req, res, next) => {
        res.render = (view, locals = {}) => res.status(200).json({ view, locals });
        next();
    });
    app.locals.db = dbMock;
    app.use(mountPath, router);
    return app;
}

describe('dashboard screen coverage', () => {
    const adminUser = { id: 1, role: 'admin', username: 'admin', deviceId: 'device-1' };

    beforeEach(() => {
        global.mqttService = { connected: true };
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(false),
            getDeviceStatus: jest.fn().mockReturnValue(null)
        };
    });

    afterEach(() => {
        delete global.mqttService;
        delete global.modemService;
        jest.resetModules();
    });

    test.each([
        ['/contacts', 'pages/contacts', 'Contact Management'],
        ['/modem', 'pages/modem', 'Modem Control'],
        ['/ussd', 'pages/ussd', 'USSD Services'],
        ['/intercom', 'pages/intercom', 'Intercom'],
        ['/storage', 'pages/storage', 'Storage Manager'],
        ['/settings', 'pages/settings', 'System Settings'],
        ['/location', 'pages/location', 'GPS Location'],
        ['/gpio', 'pages/gpio', 'GPIO'],
        ['/devices/queue', 'pages/queue-manager', 'Queue Manager'],
        ['/devices/settings', 'pages/device-settings', 'Device Settings'],
        ['/devices', 'pages/devices', 'Device Manager'],
        ['/devices/about', 'pages/device-about', 'Device About'],
        ['/logs', 'pages/logs', 'System Logs'],
        ['/ota', 'pages/ota', 'OTA Firmware Manager'],
        ['/display', 'pages/display', 'Display'],
        ['/nfc', 'pages/nfc', 'NFC'],
        ['/rfid', 'pages/rfid', 'RFID'],
        ['/touch', 'pages/touch', 'Touch'],
        ['/keyboard', 'pages/keyboard', 'Keyboard']
    ])('GET %s renders %s', async (screenPath, expectedView, expectedTitle) => {
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', adminUser, makeDbMock());

        const res = await request(app).get(screenPath);

        expect(res.status).toBe(200);
        expect(res.body.view).toBe(expectedView);
        expect(res.body.locals.title).toBe(expectedTitle);
    });

    test('system settings screen loads the dedicated page script', async () => {
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', adminUser, makeDbMock());

        const res = await request(app).get('/settings');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/settings');
        expect(res.body.locals.pageScript).toBe('system-settings.js');
    });

    test('system settings screen receives effective superadmin role for env admin username', async () => {
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 1, role: 'viewer', username: 'admin' }, makeDbMock());

        const res = await request(app).get('/settings');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/settings');
        expect(res.body.locals.user).toEqual(expect.objectContaining({
            username: 'admin',
            role: 'superadmin',
            is_env_admin: true
        }));
    });

    test('device settings screen exposes admin edit capability in locals', async () => {
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', adminUser, makeDbMock());

        const res = await request(app).get('/devices/settings');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/device-settings');
        expect(res.body.locals.isAdmin).toBe(true);
    });

    test('device settings screen treats env admin username as admin in locals', async () => {
        const router = require('../routes/index');
        const app = buildRenderedApp(router, '/', { id: 1, role: 'viewer', username: 'admin', deviceId: 'device-1' }, makeDbMock());

        const res = await request(app).get('/devices/settings');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/device-settings');
        expect(res.body.locals.isAdmin).toBe(true);
        expect(res.body.locals.user).toEqual(expect.objectContaining({
            username: 'admin',
            role: 'superadmin',
            is_env_admin: true
        }));
    });

    test('dashboard home renders normalized flat firmware status in page locals', async () => {
        const dbMock = {
            get: jest.fn().mockImplementation(async (sql) => {
                if (sql.includes('COUNT(*) as count FROM sms') && sql.includes("read = 0")) return { count: 0 };
                if (sql.includes('COUNT(*) as count FROM contacts')) return { count: 3 };
                if (sql.includes('COUNT(*) as count FROM ussd')) return { count: 2 };
                if (sql.includes('COUNT(*) as count FROM sms WHERE type = \'outgoing\'')) return { count: 1 };
                if (sql.includes('COUNT(*) as count FROM sms WHERE type = \'incoming\'')) return { count: 4 };
                if (sql.includes('SUM(duration) as total FROM calls')) return { total: 180 };
                return null;
            }),
            all: jest.fn().mockImplementation(async (sql) => {
                if (sql.includes('FROM sms')) return [];
                if (sql.includes('FROM calls')) return [];
                if (sql.includes('SELECT id, name, description FROM devices')) {
                    return [{ id: 'device-1', name: 'Device 1', description: 'Bench device' }];
                }
                if (sql.includes('SELECT id FROM devices')) {
                    return [{ id: 'device-1' }];
                }
                return [];
            }),
            run: jest.fn().mockResolvedValue({ lastID: 0, changes: 0 }),
            exec: jest.fn().mockResolvedValue(undefined)
        };

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
        const app = buildRenderedApp(router, '/', adminUser, dbMock);

        const res = await request(app).get('/');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/index');
        expect(res.body.locals.deviceStatus).toEqual(expect.objectContaining({
            online: true,
            activePath: 'wifi',
            network: 'Wi-Fi',
            operator: 'robi axiata',
            wifi: expect.objectContaining({
                connected: true,
                ssid: 'RiazM',
                ipAddress: '10.147.48.235',
                rssi: -71
            }),
            mqtt: expect.objectContaining({
                connected: true,
                subscribed: true,
                publishedCount: 16
            }),
            sim: expect.objectContaining({
                registered: true,
                operatorName: 'robi axiata',
                telephonySupported: true,
                telephonyEnabled: true,
                dataModeEnabled: true
            }),
            storage: expect.objectContaining({
                mounted: true,
                mediaAvailable: true,
                queueDepth: 1
            })
        }));
        expect(res.body.locals.caps).toEqual(expect.objectContaining({
            wifi: true,
            internet: true,
            storage: true,
            sd: true
        }));
    });
});

describe('admin screen coverage', () => {
    const adminUser = { id: 1, role: 'admin', username: 'admin' };

    afterEach(() => {
        jest.resetModules();
    });

    test.each([
        ['/users', 'pages/users', 'User Management'],
        ['/gateway', 'pages/gateway', 'Payment Gateways']
    ])('GET /admin%s renders %s', async (screenPath, expectedView, expectedTitle) => {
        const router = require('../routes/users');
        const app = buildRenderedApp(router, '/admin', adminUser, makeDbMock());

        const res = await request(app).get(`/admin${screenPath}`);

        expect(res.status).toBe(200);
        expect(res.body.view).toBe(expectedView);
        expect(res.body.locals.title).toBe(expectedTitle);
    });

    test('GET /admin/users renders env admin username with effective superadmin role', async () => {
        const router = require('../routes/users');
        const app = buildRenderedApp(router, '/admin', { id: 1, role: 'viewer', username: 'admin' }, makeDbMock());

        const res = await request(app).get('/admin/users');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/users');
        expect(res.body.locals.user).toEqual(expect.objectContaining({
            username: 'admin',
            role: 'superadmin',
            is_env_admin: true
        }));
    });

    test('GET /admin/capabilities redirects to /devices/capabilities', async () => {
        const router = require('../routes/users');
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.session = { user: adminUser };
            req.user = adminUser;
            next();
        });
        app.locals.db = makeDbMock();
        app.use('/admin', router);

        const res = await request(app).get('/admin/capabilities');

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/devices/capabilities');
    });
});

describe('device screen coverage', () => {
    const adminUser = { id: 1, role: 'admin', username: 'admin' };

    afterEach(() => {
        jest.resetModules();
    });

    test('GET /devices/capabilities renders pages/capabilities', async () => {
        const router = require('../routes/index');
        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([{ id: 'dev-1' }])
        });
        const app = buildRenderedApp(router, '', { ...adminUser, deviceId: 'dev-1' }, db);

        const res = await request(app).get('/devices/capabilities?device=dev-1');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/capabilities');
        expect(res.body.locals.title).toBe('Capability Editor');
    });
});

describe('sidebar navigation coverage', () => {
    const sidebarPath = path.join(__dirname, '..', 'views', 'partials', 'sidebar.html');
    const sidebarTemplate = fs.readFileSync(sidebarPath, 'utf8');
    const headerPath = path.join(__dirname, '..', 'views', 'partials', 'header.html');
    const mainLayoutPath = path.join(__dirname, '..', 'views', 'layouts', 'main.html');
    const mainJsPath = path.join(__dirname, '..', 'public', 'js', 'main.js');
    const commonJsPath = path.join(__dirname, '..', 'public', 'js', 'common.js');
    const manifestPath = path.join(__dirname, '..', 'public', 'manifest.json');
    const iconSvgPath = path.join(__dirname, '..', 'public', 'icons', 'icon.svg');
    const indexPath = path.join(__dirname, '..', 'views', 'pages', 'index.html');
    const devicesPagePath = path.join(__dirname, '..', 'views', 'pages', 'devices.html');
    const modemPath = path.join(__dirname, '..', 'views', 'pages', 'modem.html');
    const queueManagerPath = path.join(__dirname, '..', 'views', 'pages', 'queue-manager.html');
    const deviceAboutPath = path.join(__dirname, '..', 'views', 'pages', 'device-about.html');
    const smsJsPath = path.join(__dirname, '..', 'public', 'js', 'sms.js');
    const smsPagePath = path.join(__dirname, '..', 'views', 'pages', 'sms.html');
    const usersPagePath = path.join(__dirname, '..', 'views', 'pages', 'users.html');

    function renderSidebar(locals = {}) {
        return ejs.render(sidebarTemplate, {
            title: '',
            user: { id: 1, role: 'admin', username: 'admin' },
            ...locals
        }, { filename: sidebarPath });
    }

    test('marks the GPS navigation item active for the GPS Location screen title', () => {
        const html = renderSidebar({ title: 'GPS Location' });

        expect(html).toContain('href="/location" class="nav-link active"');
    });

    test('includes the Intercom navigation item behind the intercom capability gate', () => {
        const html = renderSidebar();

        expect(html).toContain('data-cap="intercom"');
        expect(html).toContain('href="/intercom"');
        expect(html).toContain('<span>Intercom</span>');
    });

    test('uses Module and Device section labels in the sidebar', () => {
        const html = renderSidebar();

        expect(html).toContain('>Module<');
        expect(html).toContain('>Device<');
        expect(html).not.toContain('>System<');
    });

    test('places Gateways, Devices, and System Settings in the Admin section', () => {
        const html = renderSidebar();
        const adminIndex = html.indexOf('>Admin<');
        const gatewayIndex = html.indexOf('href="/admin/gateway"');
        const devicesIndex = html.indexOf('href="/devices"');
        const settingsIndex = html.indexOf('href="/settings"');
        const queueIndex = html.indexOf('href="/devices/queue"');
        const aboutIndex = html.indexOf('href="/devices/about"');

        expect(adminIndex).toBeGreaterThanOrEqual(0);
        expect(gatewayIndex).toBeGreaterThan(adminIndex);
        expect(devicesIndex).toBeGreaterThan(adminIndex);
        expect(settingsIndex).toBeGreaterThan(gatewayIndex);
        expect(queueIndex).toBeGreaterThan(settingsIndex);
        expect(aboutIndex).toBeGreaterThan(queueIndex);
    });

    test('queue manager uses the shared appConfirm flow instead of an undefined legacy helper', () => {
        const html = fs.readFileSync(queueManagerPath, 'utf8');

        expect(html).toContain('window.appConfirm');
        expect(html).not.toContain('window.showConfirmModal');
        expect(html).toContain('Clear Filtered Queue');
        expect(html).toContain('Telephony Leftovers');
        expect(html).toContain('live calls and USSD stay runtime-only over MQTT');
        expect(html).not.toContain('Clear Call Queue');
    });

    test('recent dashboard cleanup files stay free of mojibake fragments', () => {
        const files = {
            mainJs: fs.readFileSync(mainJsPath, 'utf8'),
            index: fs.readFileSync(indexPath, 'utf8'),
            modem: fs.readFileSync(modemPath, 'utf8'),
            queueManager: fs.readFileSync(queueManagerPath, 'utf8')
        };
        const badFragments = [
            'â€¢',
            'Â·',
            'Ã‚Â·',
            'â€¦',
            'â€”',
            'Ã¢â‚¬',
            'Ã°Å¸'
        ];

        Object.entries(files).forEach(([label, content]) => {
            badFragments.forEach((fragment) => {
                expect(content).not.toContain(fragment);
            });
        });
    });

    test('user management destructive actions use the shared appConfirm flow', () => {
        const html = fs.readFileSync(usersPagePath, 'utf8');

        expect(html).toContain("title: 'Terminate Session'");
        expect(html).toContain("title: 'Revoke API Key'");
        expect(html).toContain("title: 'Delete Webhook'");
        expect(html).toContain("title: 'Revoke Invite'");
        expect(html).toContain('window.appConfirm');
    });

    test('device and SMS pages include unregistered delete actions and clamped conversation previews', () => {
        const devicesHtml = fs.readFileSync(devicesPagePath, 'utf8');
        const smsHtml = fs.readFileSync(smsPagePath, 'utf8');
        const smsJs = fs.readFileSync(smsJsPath, 'utf8');

        expect(devicesHtml).toContain('deleteCurrentUnregisteredDevice()');
        expect(devicesHtml).toContain('deleteUnregisteredDevice(deviceId)');
        expect(devicesHtml).toContain("/api/devices/unregistered/${encodeURIComponent(deviceId)}");
        expect(devicesHtml).toContain('<th>Type</th>');
        expect(devicesHtml).toContain('<th>Model</th>');
        expect(devicesHtml).toContain('inferUnregisteredDisplayModel');
        expect(smsHtml).toContain('.conversation-preview {');
        expect(smsJs).toContain('const previewText = thread.scheduledOnly');
        expect(smsJs).toContain('title="${esc(previewText)}"');
    });

    test('dashboard SMS refresh renders linked conversation previews', () => {
        const mainJs = fs.readFileSync(mainJsPath, 'utf8');

        expect(mainJs).toContain("/api/sms/conversations?limit=3");
        expect(mainJs).toContain('function renderDashboardConversationPreviewRows(conversations)');
        expect(mainJs).toContain('data-device-aware-href="${escapeHtml(href)}"');
        expect(mainJs).toContain('buildDashboardConversationHref(thread)');
        expect(mainJs).not.toContain("/api/sms?limit=3");
    });

    test('header status panel exposes queue and device shortcut links', () => {
        const html = fs.readFileSync(headerPath, 'utf8');

        expect(html).toContain('class="status-panel-grid"');
        expect(html).toContain('class="status-panel-column"');
        expect(html).toContain('SIM Number');
        expect(html).toContain('data-status-href="/devices/queue"');
        expect(html).toContain('data-status-href="/devices/about"');
        expect(html).toContain('data-status-href="/modem"');
    });

    test('header module-health wiring triggers device-backed module actions before navigation', () => {
        const js = fs.readFileSync(mainJsPath, 'utf8');

        expect(js).toContain('/api/status/module-action');
        expect(js).toContain('data-status-module');
        expect(js).toContain('runStatusPanelModuleAction');
        expect(js).toContain('data-device-aware-href');
        expect(js).toContain('buildDeviceAwareHref');
    });

    test('dashboard quick actions include SIM number detection and refresh on USSD response', () => {
        const html = fs.readFileSync(indexPath, 'utf8');
        const js = fs.readFileSync(mainJsPath, 'utf8');

        expect(html).toContain('quickSimNumber()');
        expect(html).toContain('/api/quick/sim-number');
        expect(html).toContain('Detect</span> SIM Number');
        expect(js).toContain("socket.on('ussd:response'");
        expect(js).toContain('scheduleDeviceEnvelopeRefresh(500)');
    });

    test('dashboard template exports the active-device status helper for later socket handlers', () => {
        const html = fs.readFileSync(indexPath, 'utf8');

        expect(html).toContain('window.isActiveDashboardDeviceStatus = isActiveDashboardDeviceStatus;');
        expect(html).toContain('window.isActiveDashboardDeviceStatus ? window.isActiveDashboardDeviceStatus(data) : true');
    });

    test('layout and manifest point to the checked-in SVG app icon and modern web-app meta tag', () => {
        const layoutHtml = fs.readFileSync(mainLayoutPath, 'utf8');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const iconSvg = fs.readFileSync(iconSvgPath, 'utf8');

        expect(layoutHtml).toContain('<meta name="mobile-web-app-capable" content="yes">');
        expect(layoutHtml).toContain('<link rel="icon" type="image/svg+xml" href="/icons/icon.svg">');
        expect(layoutHtml).toContain('<link rel="apple-touch-icon" href="/icons/icon.svg">');
        expect(manifest.icons).toEqual([
            expect.objectContaining({
                src: '/icons/icon.svg',
                sizes: 'any',
                type: 'image/svg+xml'
            })
        ]);
        expect(iconSvg).toContain('<svg');
        expect(iconSvg).toContain('linearGradient');
    });

    test('modem page exposes SIM number detect action near modem details', () => {
        const html = fs.readFileSync(modemPath, 'utf8');
        const js = fs.readFileSync(mainJsPath.replace('main.js', 'modem.js'), 'utf8');

        expect(html).toContain('SIM Number Action:');
        expect(html).toContain('detectSimNumberBtn');
        expect(html).toContain('Detect SIM Number');
        expect(js).toContain('function detectSimNumber()');
        expect(js).toContain('/api/quick/sim-number?deviceId=');
    });

    test('ussd page keeps tab URLs synced and renders live responses without HTML injection', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'pages', 'ussd.html'), 'utf8');
        const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ussd.js'), 'utf8');

        expect(html).toContain('id="ussdTabs"');
        expect(html).toContain('id="menuOptionInput"');
        expect(js).toContain('window.syncBootstrapTabsWithUrl(document);');
        expect(js).toContain("fetch(buildUssdApiUrl('/api/ussd/session')");
        expect(js).toContain("setMultilineTextContent(document.getElementById('ussdLiveResponseText'), response);");
        expect(js).toContain("const sessionActive = data?.session_active === true || menuOptions.length > 0;");
        expect(js).toContain('function showMenuOptions(options)');
        expect(js).toContain('function submitMenuReply()');
        expect(js).not.toContain("const formattedResponse = data.response.replace(/\\n/g, '<br>');");
    });

    test('shared tab URLs and modem data charts are wired for direct links and graphs', () => {
        const html = fs.readFileSync(modemPath, 'utf8');
        const commonJs = fs.readFileSync(commonJsPath, 'utf8');
        const js = fs.readFileSync(mainJsPath.replace('main.js', 'modem.js'), 'utf8');

        expect(commonJs).toContain('function syncBootstrapTabsWithUrl(root = document)');
        expect(commonJs).toContain('window.syncBootstrapTabsWithUrl = syncBootstrapTabsWithUrl;');
        expect(js).toContain('window.syncBootstrapTabsWithUrl(document);');
        expect(html).toContain('id="dataUsageHistoryChart"');
        expect(html).toContain('class="modem-chart"');
        expect(html).not.toContain('id="shareUsageChart"');
        expect(html).not.toContain('id="shareUsageSummary"');
        expect(html).not.toContain('data-bs-target="#routing"');
        expect(html.indexOf('chart.umd.min.js')).toBeLessThan(html.indexOf('/js/modem.js'));
    });

    test('modem page script normalizes connection labels and uses plain dash fallbacks', () => {
        const js = fs.readFileSync(mainJsPath.replace('main.js', 'modem.js'), 'utf8');

        expect(js).toContain('function formatWifiSecurityLabel(value)');
        expect(js).toContain('function formatCellularNetworkTypeLabel(value)');
        expect(js).toContain('function isOpenWifiSecurityValue(value)');
        expect(js).toContain('function getWifiClientPresentation(wifi)');
        expect(js).toContain("label: 'Searching'");
        expect(js).toContain('function getSelectedWifiSsid() {');
        expect(js).toContain('function isSelectedWifiPasswordSaved() {');
        expect(js).toContain("let lastWifiScanDeviceId = '';");
        expect(js).toContain('if (nextDeviceId !== deviceId) {');
        expect(js).toContain("lastWifiScanResults = null;");
        expect(js).toContain("lastWifiScanDeviceId = '';");
        expect(js).toContain("const resolvedByResolver = typeof byResolver === 'string' ? byResolver : '';");
        expect(js).toContain("return Promise.resolve(window.resolveActiveDeviceId(false))");
        expect(js).toContain('detailBits.push(`Selected network: ${selectedSsid}`);');
        expect(js).toContain("elements.scanWiFiBtn.disabled = wifiCaps.scan === false;");
        expect(js).toContain("const activeDeviceId = syncActiveDeviceId();");
        expect(js).toContain("showToast('No device selected', 'warning');");
        expect(js).toContain("fetch(`/api/modem/wifi/client/scan?deviceId=${encodeURIComponent(activeDeviceId)}`)");
        expect(js).toContain("if (String(data.scanSource || '').trim() === 'dashboard_host') {");
        expect(js).toContain("showToast(data.message || 'Device scan timed out. Showing dashboard host scan results.', 'warning');");
        expect(js).toContain("savedProfile.openNetwork ? ' (open network)' : ' (password missing)'");
        expect(js).toContain("if (elements.mobileNetwork) elements.mobileNetwork.textContent = networkTypeLabel;");
        expect(js).toContain("if (elements.wifiClientSecurity) elements.wifiClientSecurity.textContent = wifiSecurityLabel || '-';");
        expect(js).toContain("label: 'Connected'");
        expect(js).toContain("label: 'Available'");
        expect(js).not.toContain("label: 'Connected (Active)'");
        expect(js).not.toContain("label: 'Standby'");
        expect(js).not.toContain("label: 'Ready'");
        expect(js).not.toContain("wifi.security || '—'");
        expect(js).not.toContain("'—'");
        expect(js).not.toContain("'â€”'");
    });

    test('modem page uses normalized Wi-Fi wording and active-source labels', () => {
        const js = fs.readFileSync(mainJsPath.replace('main.js', 'modem.js'), 'utf8');
        const modemHtml = fs.readFileSync(mainJsPath.replace('public\\js\\main.js', 'views\\pages\\modem.html'), 'utf8');

        expect(js).toContain("confirm('Disconnect from Wi-Fi?')");
        expect(js).toContain("if (elements.activeSource) elements.activeSource.textContent = 'Offline';");
        expect(js).toContain("'Internet Available'");
        expect(js).toContain("'No Active Internet Path'");
        expect(js).toContain("elements.internetDetails.textContent = `Active path: ${activeSourceLabel}`;");
        expect(js).toContain("elements.internetDetails.textContent = `Detected links: ${sources.join(' + ')}`;");
        expect(js).toContain("'Waiting for Mobile Data, Wi-Fi Client, or USB'");
        expect(js).toContain("return 'Wi-Fi Hotspot';");
        expect(js).not.toContain("label: 'Active Path'");
        expect(js).toContain("const activePathLabel = formatRoutingSourceLabel(status?.internet?.activeSource);");
        expect(js).toContain('let lastUsageSnapshot = null;');
        expect(js).toContain('let lastWifiScanResults = null;');
        expect(js).toContain("renderAvailableWifiNetworks(lastWifiScanResults);");
        expect(js).toContain('function getWifiDisplayEntries(scannedNetworks = null) {');
        expect(js).toContain('function renderAvailableWifiNetworks(scannedNetworks = null) {');
        expect(js).toContain('if (lastWifiScanDeviceId && activeDeviceId && lastWifiScanDeviceId !== activeDeviceId) {');
        expect(js).toContain('lastWifiScanDeviceId = activeDeviceId;');
        expect(js).toContain('Saved only');
        expect(js).toContain('Password missing');
        expect(js).toContain('Show Saved Networks');
        expect(js).toContain('Device scan found ${visibleCount} network');
        expect(js).toContain('Dashboard host scan found ${visibleCount} network');
        expect(js).toContain('Connect actions still run on the device over MQTT.');
        expect(js).toContain("Saved from earlier device setup");
        expect(js).toContain("Retry Selected</button>");
        expect(js).toContain("Selected</span>");
        expect(js).toContain("Saved network</div>");
        expect(js).toContain('const usageDelta = {');
        expect(js).toContain('datasets[0].data.push(usageDelta.overall);');
        expect(js).toContain('function clearChartHistory(chart) {');
        expect(js).toContain('function resetUsageHistory() {');
        expect(js).toContain('function resetModemCharts() {');
        expect(js).toContain('resetModemCharts();');
        expect(js).toContain("resetUsageHistory();");
        expect(js).toContain('function hasUsableLegendText(legendItem) {');
        expect(js).toContain("filter: hasUsableLegendText");
        expect(js).toContain("label: (context) => `${getDatasetLabel(context, 'Usage')}: ${formatBytes(context.parsed.y || 0)}`");
        expect(js).toContain("elements.dataUsageNotice.textContent = `Active path: ${activePathLabel}. Trend shows traffic added since the last refresh using the live device counters.`;");
        expect(js).not.toContain("elements.shareUsageSummary");
        expect(js).not.toContain("Use Prefer Modem Data for live runtime path switching.");
        expect(js).not.toContain("elements.routingApplyBtn");
        expect(js).not.toContain('General routing configuration is not supported by the current firmware');
        expect(js).toContain("showToast('Remote hotspot toggle is not supported by the current firmware.', 'info');");
        expect(js).toContain("showToast('Remote hotspot configuration is not supported by the current firmware.', 'info');");
        expect(js).toContain("showToast('USB tethering control is not supported by the current firmware.', 'info');");
        expect(js).toContain("showToast('Data usage reset is not supported by the current firmware.', 'info');");
        expect(js).toContain('function openManualWiFiEntry() {');
        expect(js).toContain('function openWiFiConnectModal({ ssid = \'\', encrypted = true, security = \'\', manual = false } = {}) {');
        expect(js).toContain('document.getElementById(\'connectSsidDisplay\').value.trim()');
        expect(js).toContain("showToast('Failed to retry saved Wi-Fi network', 'danger');");
        expect(js).toContain("fetch('/api/modem/mobile/toggle', {");
        expect(js).toContain("fetch('/api/modem/mobile/apn', {");
        expect(js).toContain("button.disabled = !canRemoteApn;");
        expect(js).toContain('Client control is not exposed by the current firmware.');
        expect(js).toContain('function setSwitchLabel(labelElement, isSupported)');
        expect(js).toContain("labelElement.textContent = isSupported ? 'Enable' : 'Read-only';");
        expect(js).toContain("elements.hotspotClientsCount.textContent = 'No client telemetry';");
        expect(js).toContain("elements.refreshHotspotClientsBtn.disabled = !isDeviceOnline || !canReadClients;");
        expect(js).toContain("elements.hotspotForm.classList.toggle('d-none', !canRemoteConfigure);");
        expect(js).not.toContain("elements.routingAdvancedControls");
        expect(js).not.toContain("elements.routingPreferModemBtn");
        expect(js).not.toContain("showToast('Runtime modem preference is not supported by this firmware.', 'info');");
        expect(js).toContain("showToast('Connect Wi-Fi first before turning mobile data off', 'warning');");
        expect(js).toContain("showToast('Turn on mobile data and wait for it to connect before turning Wi-Fi off', 'warning');");
        expect(js).toContain("function toggleWiFi(enabled) {");
        expect(js).toContain("fetch('/api/modem/wifi/client/toggle', {");
        expect(js).toContain("elements.dataUsageResetBtn.classList.toggle('d-none', !canRemoteReset);");
        expect(js).not.toContain('function getPathIconPresentation(tone)');
        expect(js).not.toContain('function applyPathPresentation(labelElement, iconElement, state)');
        expect(modemHtml).toContain('Manage mobile data, Wi-Fi connections, and internet sharing');
        expect(modemHtml).toContain('Wi-Fi Client');
        expect(modemHtml).toContain('Wi-Fi Status');
        expect(modemHtml).toContain('id="mobileToggleLabel"');
        expect(modemHtml).toContain('id="wifiToggleLabel"');
        expect(modemHtml).toContain('id="hotspotToggleLabel"');
        expect(modemHtml).toContain('id="usbToggleLabel"');
        expect(modemHtml).toContain('id="refreshHotspotClientsBtn"');
        expect(modemHtml).toContain('id="dataUsageResetBtn"');
        expect(modemHtml).toContain('data-apn-preset');
        expect(modemHtml).toContain('id="hotspotClientsCount"');
        expect(modemHtml).toContain('Hotspot client activity will appear here when the device reports it.');
        expect(modemHtml).toContain('Retry Selected Network');
        expect(modemHtml).toContain('id="manualWiFiBtn"');
        expect(modemHtml).toContain('Manual Entry');
        expect(modemHtml).not.toContain('Active Source:');
        expect(modemHtml).toContain('id="wifiNetworksSummary"');
        expect(modemHtml).toContain('Saved and scanned networks are shown together here.');
        expect(modemHtml).not.toContain('Shared Internet Breakdown');
        expect(modemHtml).not.toContain('Combine mobile data and Wi-Fi for faster speeds');
        expect(modemHtml).not.toContain('Prefer Modem Data');
        expect(modemHtml).not.toContain('Apply Runtime Path');
        expect(modemHtml).toContain('<i class="bi bi-wifi me-2"></i>Wi-Fi Status');
        expect(modemHtml).not.toContain('aria-label="Prefer Modem Data"');
        expect(modemHtml).not.toContain('id="routingAdvancedControls"');
        expect(modemHtml).not.toContain('id="routingConfigHint"');
        expect(modemHtml).not.toContain('Wi-Fi Client: <span id="pathWiFi">Not Connected</span>');
        expect(modemHtml).toContain('Wi-Fi Data');
        expect(modemHtml).toContain('.modem-chart');
        expect(modemHtml).toContain('Connect to Wi-Fi');
        expect(modemHtml).toContain('Selected Network:');
        expect(modemHtml).toContain('placeholder="Enter Wi-Fi name"');
        expect(modemHtml).toContain('id="connectSecurity"');
        expect(modemHtml).not.toContain('id="mobileRuntimeHint"');
        expect(modemHtml).not.toContain('id="apnRuntimeHint"');
        expect(modemHtml).not.toContain('id="hotspotRuntimeHint"');
        expect(modemHtml).not.toContain('id="usbRuntimeHint"');
        expect(modemHtml).not.toContain('Open Device Settings');
        expect(modemHtml).not.toContain('Known Networks:');
        expect(modemHtml).not.toContain('id="disconnectWiFiBtn"');
        expect(modemHtml).not.toContain('WiFi Client');
        expect(modemHtml).not.toContain('WiFi Status');
        expect(modemHtml).not.toContain('Turn the Wi-Fi runtime lane on or off');
        expect(modemHtml).not.toContain('Prefer modem for runtime traffic');
        expect(modemHtml).not.toContain('Primary Source:');
    });

    test('dashboard home Wi-Fi card keeps SSID separate from a short status label', () => {
        const indexHtml = fs.readFileSync(indexPath, 'utf8');
        const mainJs = fs.readFileSync(mainJsPath, 'utf8');
        const dashboardStatusJs = fs.readFileSync(path.join(__dirname, '..', 'utils', 'dashboardStatus.js'), 'utf8');

        expect(indexHtml).toContain("const initialWifiRoleLabel = deviceStatus.wifiRoleLabel || (isDeviceConnected ? 'Primary' : 'Offline');");
        expect(indexHtml).toContain("const initialModemRoleLabel = deviceStatus.modemRoleLabel || (isDeviceConnected ? 'Connected' : 'Offline');");
        expect(indexHtml).toContain("const initialWifiStatusLabel = deviceStatus.wifiStatusLabel || (!isDeviceConnected");
        expect(indexHtml).toContain("if (wifiPrimaryEl) wifiPrimaryEl.textContent = status.wifiRoleLabel || (status.online ? 'Primary' : 'Offline');");
        expect(indexHtml).toContain("if (modemActiveEl) modemActiveEl.textContent = status.modemRoleLabel || (status.online ? 'Connected' : 'Offline');");
        expect(indexHtml).toContain("if (wifiSigMetaEl) wifiSigMetaEl.textContent = status.wifiStatusLabel || 'Not connected';");
        expect(indexHtml).toContain("const wifiStatusLabel = status.wifiStatusLabel || (");
        expect(indexHtml).toContain("const wifiRoleLabel = status.wifiRoleLabel || (");
        expect(mainJs).toContain("status?.wifiStatusLabel || ((status?.wifi?.connected || status?.activePath === 'wifi') ? 'Connected' : 'Not connected')");
        expect(mainJs).toContain("status?.wifiRoleLabel");
        expect(mainJs).toContain("status?.modemRoleLabel");
        expect(dashboardStatusJs).toContain("function resolveWifiStatusLabel(isOnline, wifiConnected, activePath)");
        expect(dashboardStatusJs).toContain("function resolveWifiRoleLabel(isOnline, activePath, wifiConnected, wifiSsid)");
        expect(dashboardStatusJs).toContain("function resolveModemRoleLabel(isOnline, activePath, modemAvailable)");
        expect(dashboardStatusJs).toContain("return (wifiConnected || activePath === 'wifi') ? 'Connected' : 'Not connected';");
    });

    test('dashboard home shows Android ID or IMEI as a dynamic label with plain value text', () => {
        const indexHtml = fs.readFileSync(indexPath, 'utf8');
        const mainJs = fs.readFileSync(mainJsPath, 'utf8');

        expect(indexHtml).toContain("id=\"deviceHardwareIdLabel\"");
        expect(indexHtml).toContain("'Android ID' : (deviceStatus.imei ? 'IMEI' : 'Android ID / IMEI')");
        expect(indexHtml).toContain("deviceStatus.androidId || deviceStatus.imei || 'Not reported by device'");
        expect(indexHtml).not.toContain('>Hardware ID<');
        expect(mainJs).toContain('function getDeviceHardwareIdentity(status, fallback = \'Not reported by device\')');
        expect(mainJs).toContain("label: 'Android ID'");
        expect(mainJs).toContain("label: 'IMEI'");
        expect(mainJs).toContain("window.getDeviceHardwareIdentity = getDeviceHardwareIdentity;");
    });

    test('status panel and compact strip use normalized transport labels instead of raw network text', () => {
        const mainJs = fs.readFileSync(mainJsPath, 'utf8');

        expect(mainJs).toContain('function getStatusNetworkLabel(status)');
        expect(mainJs).toContain("return status?.activePathLabel || status?.network || '---';");
        expect(mainJs).toContain('function getStatusSignalIcon(status)');
        expect(mainJs).toContain("return (status?.signalSource === 'wifi' || status?.activePath === 'wifi') ? 'bi-wifi' : 'bi-broadcast';");
        expect(mainJs).toContain("if (networkEl) networkEl.textContent = getStatusNetworkLabel(status);");
        expect(mainJs).toContain("if (pn) pn.textContent = getStatusNetworkLabel(status);");
        expect(mainJs).toContain("if (smNet) smNet.textContent = getStatusNetworkLabel(status);");
        expect(mainJs).toContain("if (smSig) smSig.innerHTML = `<i class=\"bi ${getStatusSignalIcon(status)} me-1\"></i>${signal !== null ? signal + '%' : '-'}`;");
        expect(mainJs).not.toContain("if (pn) pn.textContent = status.network || '---';");
        expect(mainJs).not.toContain("if (smNet) smNet.textContent = status.network || '---';");
    });

    test('queue manager and modem page use clean ASCII-safe fallback text', () => {
        const queueHtml = fs.readFileSync(queueManagerPath, 'utf8');
        const modemHtml = fs.readFileSync(modemPath, 'utf8');
        const mainJs = fs.readFileSync(mainJsPath, 'utf8');

        expect(queueHtml).toContain("text.slice(0, 140) + '...'");
        expect(queueHtml).toContain("${recent.command || 'command'} - ${recent.status || 'unknown'}");
        expect(queueHtml).toContain("${topDomain.name} lane - ${topDomain.totalOpen} open");
        expect(queueHtml).toContain("recentText += ' - device busy';");
        expect(queueHtml).toContain("recentText += ' - queued';");
        expect(queueHtml).toContain('data-qm-sort="command"');
        expect(queueHtml).toContain('data-qm-sort="status"');
        expect(queueHtml).toContain('data-qm-sort="attempts"');
        expect(queueHtml).toContain('data-qm-sort="created"');
        expect(queueHtml).toContain('data-qm-sort="updated"');
        expect(queueHtml).toContain('sort=${encodeURIComponent(queueSort.field)}');
        expect(queueHtml).toContain('function sortQueueItems(items)');

        expect(modemHtml).toContain('id="mobileOperator">-<');
        expect(modemHtml).toContain('id="simNumber">-<');
        expect(modemHtml).not.toContain('id="routingGateway"');

        expect(mainJs).toContain("let nextTitle = 'Reconnecting...';");
        expect(mainJs).toContain("headerHealth.title = healthHints.join(' - ');");
        expect(mainJs).toContain("console.log('Socket connected');");
        expect(mainJs).toContain("console.log('SMS delivered:', data);");
    });

    test('shared layout prefers route-selected device id before stored local cache', () => {
        const html = fs.readFileSync(mainLayoutPath, 'utf8');

        expect(html).toContain("return current || stored || '';");
    });

    test('sidebar bootstraps from the resolved active device and shared SIM helpers keep URL-scoped context', () => {
        const sidebarHtml = fs.readFileSync(sidebarPath, 'utf8');
        const mainJs = fs.readFileSync(mainJsPath, 'utf8');

        expect(sidebarHtml).toContain("fetch('/api/devices/active')");
        expect(sidebarHtml).toContain('const resolvedActiveId = String(activePayload?.deviceId || \'\').trim();');
        expect(sidebarHtml).toContain('window.readCachedSidebarDevices');
        expect(sidebarHtml).toContain('window.persistCachedSidebarDevices');
        expect(sidebarHtml).toContain('window.persistCachedSidebarDeviceCapabilities');
        expect(sidebarHtml).not.toContain('>SIM<');
        expect(mainJs).toContain('function getRequestedSimSlotFromLocation()');
        expect(mainJs).toContain('const SIDEBAR_VISIBILITY_CACHE_PREFIX = \'sidebarVisibility_v1_\';');
        expect(mainJs).toContain('loadCachedSidebarVisibility(deviceId);');
        expect(mainJs).toContain('const activeDeviceId = getStatusActiveDeviceId();');
        expect(mainJs).toContain('const nextSlot = setStoredActiveSimSlot(slotIndex, activeDeviceId);');
        expect(mainJs).toContain("nextUrl.searchParams.set('simSlot', String(nextSlot));");
        expect(mainJs).toContain("nextUrl.searchParams.delete('simSubscriptionId');");
        expect(mainJs).toContain('if (!parts.length) parts.push(`SIM ${Number(slot.slotIndex || 0) + 1}`);');
        expect(mainJs).toContain('slot.operatorName');
        expect(mainJs).toContain('slot.simNumber');
    });

    test('sms read requests stay slot-scoped', () => {
        const smsJs = fs.readFileSync(smsJsPath, 'utf8');

        expect(smsJs).toContain("requestUrl.searchParams.set('simSlot', String(activeContext.simSlot));");
        expect(smsJs).toContain('parsedBody.simSlot = activeContext.simSlot;');
    });

    test('calls page reacts to explicit hold and ended socket events', () => {
        const callsJsPath = path.join(__dirname, '..', 'public', 'js', 'calls.js');
        const callsJs = fs.readFileSync(callsJsPath, 'utf8');

        expect(callsJs).toContain("function setHoldButtonState(onHold)");
        expect(callsJs).toContain("window.socket.on('call:ended'");
        expect(callsJs).toContain("window.socket.on('call:hold'");
        expect(callsJs).toContain("elements.activeCallStatus.textContent = onHold ? 'On Hold' : 'Connected';");
        expect(callsJs).toContain('resetActiveCallControls();');
        expect(callsJs).toContain("if (status === 'online') status = 'connected';");
        expect(callsJs).toContain("'online': 'Connected'");
    });

    test('calls page opens the call workspace as a modal', () => {
        const callsJsPath = path.join(__dirname, '..', 'public', 'js', 'calls.js');
        const callsHtmlPath = path.join(__dirname, '..', 'views', 'pages', 'calls.html');
        const callsJs = fs.readFileSync(callsJsPath, 'utf8');
        const callsHtml = fs.readFileSync(callsHtmlPath, 'utf8');

        expect(callsHtml).toContain('id="callWorkspaceModal"');
        expect(callsHtml).toContain('id="callWorkspaceCard"');
        expect(callsHtml).toContain('id="callWorkspaceDialerSection"');
        expect(callsHtml).toContain('id="callWorkspaceContactsSection"');
        expect(callsHtml).toContain('id="syncCallsBtn"');
        expect(callsHtml).not.toContain('id="quickContacts"');
        expect(callsHtml).not.toContain('id="dialerModal"');
        expect(callsHtml).not.toContain('id="contactsModal"');
        expect(callsJs).toContain("function setCallWorkspaceMode(mode = 'dialer', options = {})");
        expect(callsJs).toContain("function showCallWorkspaceModal(mode = 'dialer', options = {})");
        expect(callsJs).toContain("async function syncCallHistory()");
        expect(callsJs).toContain("window.openContactsModal = function() {");
        expect(callsJs).toContain("window.openDialerModal = function() {");
        expect(callsJs).toContain("showCallWorkspaceModal('contacts');");
        expect(callsJs).toContain("showCallWorkspaceModal('dialer', { focusDialer: true });");
        expect(callsJs).toContain("window.syncCallHistory = syncCallHistory;");
        expect(callsJs).toContain("typeof window.deviceHttpOnline === 'function'");
        expect(callsJs).toContain("} else if (getCallsTransportMode() === 'http') {");
        expect(callsJs).toContain('checkDeviceConnection();');
    });

    test('device about page resolves the active device from the shared helper first', () => {
        const html = fs.readFileSync(deviceAboutPath, 'utf8');

        expect(html).toContain("if (typeof window.getActiveDeviceId === 'function')");
        expect(html).toContain('return window.getActiveDeviceId() ||');
        expect(html).toContain('live.sim?.subscriberNumber');
        expect(html).toContain('modemData.mobile?.subscriberNumber');
        expect(html).toContain('Checking...');
    });

    test('sms thread loading updates both workspace and modal error surfaces', () => {
        const js = fs.readFileSync(smsJsPath, 'utf8');

        expect(js).toContain("const container = document.getElementById('smsChatMessages') || document.getElementById('smsThreadMessages');");
        expect(js).toContain("const metaEl = document.getElementById('smsChatMeta') || document.getElementById('smsThreadMeta');");
        expect(js).toContain("threadState.messages = [];");
    });

    test('sms live delivery events infer status even when the payload omits it', () => {
        const js = fs.readFileSync(smsJsPath, 'utf8');

        expect(js).toContain('function resolveLiveSmsStatus(data, eventName = \'\', fallbackStatus = \'\')');
        expect(js).toContain("if (normalizedEvent === 'sms:delivered') {");
        expect(js).toContain("return 'delivered';");
        expect(js).toContain('const resolvedStatus = resolveLiveSmsStatus(data, eventName);');
        expect(js).toContain("status: resolvedStatus || entry.status,");
        expect(js).toContain("const status = resolveLiveSmsStatus(data, eventName, outgoing ? 'sent' : 'received');");
        expect(js).toContain('function updateConversationItemStatus(data, eventName = \'\')');
        expect(js).toContain('function updateRenderedThreadMessageStatus(data, eventName = \'\')');
        expect(js).toContain('updateRenderedThreadMessageStatus(data, eventName);');
        expect(js).toContain('updateConversationItemStatus(data, eventName);');
        expect(js).toContain('data-thread-status-pill="1"');
        expect(js).toContain('document.querySelector(`.sms-bubble[data-thread-sms-id="${targetId}"]`)');
    });

    test('sms thread selection syncs for URL-driven and programmatic loads', () => {
        const js = fs.readFileSync(smsJsPath, 'utf8');

        expect(js).toContain('function syncConversationSelection(number, conversationId = threadState.conversationId)');
        expect(js).toContain('syncConversationSelection(target, conversationId);');
        expect(js).toContain("syncConversationSelection('', null);");
    });

    test('sms empty conversation state clears the selected thread and URL', () => {
        const js = fs.readFileSync(smsJsPath, 'utf8');

        expect(js).toContain("clearThreadSelection({ historyMode: 'replace' });");
        expect(js).not.toContain("renderThreadMessages([], '');\r\n            updateThreadActionButtons('');");
    });

    test('sms sim changes clear stale thread state before reloading', () => {
        const js = fs.readFileSync(smsJsPath, 'utf8');

        expect(js).toContain('function handleSmsScopeChange(options = {})');
        expect(js).toContain("const resetThread = options.resetThread !== false;");
        expect(js).toContain("handleSmsScopeChange({ resetThread: true });");
    });

    test('service worker skips localhost fetch interception during development', () => {
        const swJsPath = path.join(__dirname, '..', 'public', 'sw.js');
        const swJs = fs.readFileSync(swJsPath, 'utf8');

        expect(swJs).toContain("const IS_LOCAL = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';");
        expect(swJs).toContain('if (IS_LOCAL) return;');
        expect(swJs).not.toContain('event.respondWith(fetch(request));');
    });

    test('device about page normalizes cellular and Wi-Fi labels', () => {
        const html = fs.readFileSync(deviceAboutPath, 'utf8');

        expect(html).toContain('function formatWifiSecurityLabel(value)');
        expect(html).toContain('function formatCellularNetworkTypeLabel(value)');
        expect(html).toContain('function formatWifiSignalValue(rssi, percent)');
        expect(html).toContain('Cellular (${cellularNetworkType})');
        expect(html).toContain("yes: 'Connected', no: 'No station link'");
        expect(html).toContain('${liveWifi.ssid || wifiClient.ssid} (${wifiSecurity})');
        expect(html).toContain("['Wi-Fi RSSI', offline ? heartbeatNotice : esc(formatWifiSignalValue(liveWifi.rssi, wifiClient.signalStrength))]");
        expect(html).toContain("join(' - ')");
        expect(html).not.toContain("join(' • ')");
    });

    test('device switcher rewrites device-scoped page URLs in place', () => {
        const html = renderSidebar();

        expect(html).toContain('function syncDeviceScopedLocation(deviceId)');
        expect(html).toContain("'/devices/about'");
        expect(html).toContain("'/devices/settings'");
        expect(html).toContain("'/devices/queue'");
        expect(html).toContain('window.history.replaceState');
    });
});
