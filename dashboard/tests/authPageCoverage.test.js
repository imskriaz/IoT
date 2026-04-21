'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
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
        all: jest.fn().mockResolvedValue([]),
        run: jest.fn().mockResolvedValue({ lastID: 0, changes: 0 }),
        ...overrides
    };
}

function buildRenderedAuthApp(session = {}, dbMock = makeDbMock()) {
    const app = express();
    const router = require('../routes/auth');

    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => {
        req.session = { ...session };
        req.flash = jest.fn(() => []);
        req.user = req.session.user || null;
        res.render = (view, locals = {}) => res.status(200).json({ view, locals });
        next();
    });
    app.locals.db = dbMock;
    app.use('/auth', router);
    return app;
}

function buildAuthApp(session = {}, dbMock = makeDbMock()) {
    const app = express();
    const router = require('../routes/auth');

    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, _res, next) => {
        req.session = { ...session };
        req.flash = jest.fn(() => []);
        req.user = req.session.user || null;
        next();
    });
    app.locals.db = dbMock;
    app.use('/auth', router);
    return app;
}

describe('auth screen coverage', () => {
    afterEach(() => {
        jest.resetModules();
    });

    test('renders the login page for signed-out users', async () => {
        const app = buildRenderedAuthApp();

        const res = await request(app).get('/auth/login');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/login');
        expect(res.body.locals.title).toBe('Login');
        expect(res.body.locals.layout).toBe(false);
    });

    test('redirects the login page to dashboard when a session already exists', async () => {
        const app = buildAuthApp({
            user: { id: 1, username: 'admin', role: 'admin' }
        });

        const res = await request(app).get('/auth/login');

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/dashboard');
    });

    test('rejects inactive users on POST /auth/login before creating a session', async () => {
        const passwordHash = bcrypt.hashSync('legacy-pass', 4);
        const db = makeDbMock({
            get: jest.fn().mockResolvedValue({
                id: 9,
                username: 'superadmin',
                password: passwordHash,
                role: 'superadmin',
                is_active: 0,
                must_change_password: 0
            }),
            run: jest.fn().mockResolvedValue({ lastID: 0, changes: 1 })
        });
        const app = buildAuthApp({}, db);

        const res = await request(app)
            .post('/auth/login')
            .type('form')
            .send({ username: 'superadmin', password: 'legacy-pass' });

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/auth/login');
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO login_audit'),
            expect.arrayContaining(['superadmin', 9, expect.anything(), expect.anything(), 'inactive_user'])
        );
    });

    test('renders the change-password page for an authenticated user', async () => {
        const app = buildRenderedAuthApp({
            user: { id: 1, username: 'admin', role: 'admin' }
        });

        const res = await request(app).get('/auth/change-password');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/change-password');
        expect(res.body.locals.title).toBe('Change Password');
        expect(res.body.locals.layout).toBe(false);
    });

    test('renders the forgot-password page for signed-out users', async () => {
        const app = buildRenderedAuthApp();

        const res = await request(app).get('/auth/forgot-password');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/forgot-password');
        expect(res.body.locals.title).toBe('Forgot Password');
        expect(res.body.locals.layout).toBe(false);
    });

    test('renders the reset-password page when the token is valid', async () => {
        const app = buildRenderedAuthApp({}, makeDbMock({
            get: jest.fn().mockResolvedValue({ id: 7 })
        }));

        const res = await request(app).get('/auth/reset-password/test-token');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/reset-password');
        expect(res.body.locals.title).toBe('Reset Password');
        expect(res.body.locals.layout).toBe(false);
        expect(res.body.locals.token).toBe('test-token');
    });

    test('renders the 2FA challenge page when a pending user exists', async () => {
        const app = buildRenderedAuthApp({
            pendingUserId: 4
        });

        const res = await request(app).get('/auth/2fa');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/2fa');
        expect(res.body.locals.title).toBe('Two-Factor Authentication');
        expect(res.body.locals.layout).toBe(false);
    });

    test('renders the forced 2FA setup page for users flagged to complete setup', async () => {
        const app = buildRenderedAuthApp({
            user: { id: 2, username: 'operator', role: 'operator', must_setup_2fa: true }
        });

        const res = await request(app).get('/auth/setup-2fa-required');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/setup-2fa-required');
        expect(res.body.locals.title).toBe('Set Up Two-Factor Authentication');
        expect(res.body.locals.layout).toBe(false);
    });

    test('renders the invite registration page when the invite token is valid', async () => {
        const app = buildRenderedAuthApp({}, makeDbMock({
            get: jest.fn().mockResolvedValue({
                token: 'invite-123',
                email: 'user@example.com',
                role: 'viewer'
            })
        }));

        const res = await request(app).get('/auth/register?token=invite-123');

        expect(res.status).toBe(200);
        expect(res.body.view).toBe('pages/register');
        expect(res.body.locals.title).toBe('Create Account');
        expect(res.body.locals.layout).toBe(false);
        expect(res.body.locals.token).toBe('invite-123');
        expect(res.body.locals.email).toBe('user@example.com');
        expect(res.body.locals.role).toBe('viewer');
    });

    test('redirects invite registration to login when the token is missing', async () => {
        const app = buildAuthApp();

        const res = await request(app).get('/auth/register');

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/auth/login');
    });

    test('layout render does not require showSidebar and defaults to sidebar enabled', async () => {
        const layoutPath = path.join(__dirname, '..', 'views', 'layouts', 'main.html');
        const html = await ejs.renderFile(layoutPath, {
            title: 'Dashboard',
            user: { id: 1, username: 'admin', role: 'admin' },
            csrfToken: 'csrf-token',
            assetVersion: 'test',
            deviceId: '',
            body: '<section>Body</section>',
            success_msg: [],
            error_msg: []
        }, {
            root: path.join(__dirname, '..', 'views'),
            views: [path.join(__dirname, '..', 'views')]
        });

        expect(html).toContain('id="sidebarDeviceSelector"');
        expect(html).toContain('onclick="toggleSidebar()"');
    });

    test('layout render omits sidebar and mobile toggle when showSidebar is false', async () => {
        const layoutPath = path.join(__dirname, '..', 'views', 'layouts', 'main.html');
        const html = await ejs.renderFile(layoutPath, {
            title: 'Device Onboarding',
            user: null,
            csrfToken: 'csrf-token',
            assetVersion: 'test',
            deviceId: '',
            body: '<section>Body</section>',
            success_msg: [],
            error_msg: [],
            showSidebar: false
        }, {
            root: path.join(__dirname, '..', 'views'),
            views: [path.join(__dirname, '..', 'views')]
        });

        expect(html).not.toContain('id="sidebarDeviceSelector"');
        expect(html).not.toContain('onclick="toggleSidebar()"');
        expect(html).toContain('main-content-full');
    });

    test('layout render omits dashboard status chrome when showStatusChrome is false', async () => {
        const layoutPath = path.join(__dirname, '..', 'views', 'layouts', 'main.html');
        const html = await ejs.renderFile(layoutPath, {
            title: 'Device Onboarding',
            user: null,
            csrfToken: 'csrf-token',
            assetVersion: 'test',
            deviceId: '',
            body: '<section>Body</section>',
            success_msg: [],
            error_msg: [],
            showSidebar: false,
            showStatusChrome: false
        }, {
            root: path.join(__dirname, '..', 'views'),
            views: [path.join(__dirname, '..', 'views')]
        });

        expect(html).not.toContain('id="statusPill"');
        expect(html).not.toContain('id="statusPanel"');
        expect(html).not.toContain('id="globalConnectionOverlay"');
    });
});
