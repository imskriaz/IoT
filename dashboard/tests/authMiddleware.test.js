'use strict';

const authMiddleware = require('../middleware/auth');

function createResponse() {
    return {
        statusCode: 200,
        body: null,
        redirectTarget: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
        redirect(target) {
            this.redirectTarget = target;
            return this;
        }
    };
}

describe('auth middleware', () => {
    test('treats mounted /api routes as API requests and returns 401 JSON when unauthenticated', async () => {
        const req = {
            originalUrl: '/api/sms',
            path: '/sms',
            url: '/sms',
            baseUrl: '/api',
            headers: {},
            session: {},
            app: { locals: { db: null } }
        };
        const res = createResponse();
        const next = jest.fn();

        await authMiddleware(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({
            success: false,
            message: 'Authentication required'
        });
        expect(res.redirectTarget).toBeNull();
    });

    test('allows the health endpoint through without authentication', async () => {
        const req = {
            originalUrl: '/health',
            path: '/health',
            url: '/health',
            baseUrl: '',
            headers: {},
            session: {},
            app: { locals: { db: null } }
        };
        const res = createResponse();
        const next = jest.fn();

        await authMiddleware(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.redirectTarget).toBeNull();
        expect(res.body).toBeNull();
    });

    test('allows signed API OTA downloads through without authentication', async () => {
        const req = {
            originalUrl: '/api/ota/download/firmware.bin?expires=1778230671676&sig=test',
            path: '/ota/download/firmware.bin',
            url: '/ota/download/firmware.bin?expires=1778230671676&sig=test',
            baseUrl: '/api',
            headers: {},
            session: {},
            app: { locals: { db: null } }
        };
        const res = createResponse();
        const next = jest.fn();

        await authMiddleware(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.redirectTarget).toBeNull();
        expect(res.body).toBeNull();
    });

    test('requires login for the onboarding page', async () => {
        const req = {
            originalUrl: '/onboard',
            path: '/onboard',
            url: '/onboard',
            baseUrl: '',
            headers: {},
            session: {},
            app: { locals: { db: null } }
        };
        const res = createResponse();
        const next = jest.fn();

        await authMiddleware(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.redirectTarget).toBe('/auth/login');
    });

    test('requires authentication for onboarding APIs', async () => {
        const req = {
            originalUrl: '/api/onboard/check-id/device-1',
            path: '/api/onboard/check-id/device-1',
            url: '/api/onboard/check-id/device-1',
            baseUrl: '',
            headers: {},
            session: {},
            app: { locals: { db: null } }
        };
        const res = createResponse();
        const next = jest.fn();

        await authMiddleware(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({
            success: false,
            message: 'Authentication required'
        });
    });

    test('rejects inactive session users on API requests and clears the session', async () => {
        const destroy = jest.fn((callback) => callback());
        const req = {
            originalUrl: '/api/sms',
            path: '/sms',
            url: '/sms',
            baseUrl: '/api',
            headers: {},
            session: {
                user: { id: 7, username: 'legacy-root', role: 'superadmin' },
                destroy
            },
            flash: jest.fn(),
            app: {
                locals: {
                    db: {
                        get: jest.fn().mockResolvedValue({ id: 7, role: 'superadmin', is_active: 0 })
                    }
                }
            }
        };
        const res = createResponse();
        const next = jest.fn();

        await authMiddleware(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({
            success: false,
            message: 'Account is inactive'
        });
    });

    test('rejects inactive API-key users before authentication succeeds', async () => {
        const req = {
            originalUrl: '/api/sms',
            path: '/sms',
            url: '/sms',
            baseUrl: '/api',
            headers: {
                authorization: 'Bearer edk_testtoken'
            },
            session: {},
            app: {
                locals: {
                    db: {
                        get: jest.fn().mockResolvedValue(null),
                        run: jest.fn().mockResolvedValue(undefined)
                    }
                }
            }
        };
        const res = createResponse();
        const next = jest.fn();

        await authMiddleware(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({
            success: false,
            message: 'Authentication required'
        });
        expect(req.app.locals.db.get).toHaveBeenCalledWith(
            expect.stringContaining('u.is_active = 1'),
            [expect.any(String)]
        );
    });

    test('accepts valid X-API-Key requests and applies read scope', async () => {
        const req = {
            originalUrl: '/api/sms',
            path: '/sms',
            url: '/sms',
            baseUrl: '/api',
            method: 'GET',
            headers: {
                'x-api-key': 'edk_validtoken'
            },
            session: {},
            app: {
                locals: {
                    db: {
                        get: jest.fn().mockResolvedValue({
                            id: 12,
                            name: 'Swagger test key',
                            scopes: 'read',
                            device_ids: JSON.stringify(['android-http-01']),
                            username: 'operator',
                            role: 'operator',
                            uid: 5
                        }),
                        run: jest.fn().mockResolvedValue(undefined)
                    }
                }
            }
        };
        const res = createResponse();
        const next = jest.fn();

        await authMiddleware(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toEqual(expect.objectContaining({
            id: 5,
            username: 'operator',
            role: 'operator'
        }));
        expect(req.session.user).toEqual(req.user);
        expect(req.apiKey).toEqual(expect.objectContaining({
            id: 12,
            name: 'Swagger test key',
            scopes: 'read',
            device_ids: JSON.stringify(['android-http-01'])
        }));
        expect(res.statusCode).toBe(200);
    });
});
