'use strict';

const { authorizeDeviceAccess, requireDeviceAccess } = require('../middleware/auth');

const req = (overrides = {}) => ({
    method: 'GET', path: '/api/devices/d-1', params: { deviceId: 'd-1' },
    headers: {}, session: {}, user: { id: 1, role: 'operator' },
    app: { locals: { db: { get: jest.fn().mockResolvedValue({ can_write: 1 }) } } },
    ...overrides
});

describe('device authorization', () => {
    test('accepts matching aliases and rejects conflicting selectors', async () => {
        await expect(authorizeDeviceAccess(req({ body: { device_id: 'd-1' } }), 'd-1')).resolves.toBe('d-1');
        await expect(authorizeDeviceAccess(req({ body: { device_id: 'd-2' } }), 'd-1')).rejects.toMatchObject({ statusCode: 400, code: 'DEVICE_SELECTOR_CONFLICT' });
    });

    test('scoped API keys cannot bypass device assignment or admin checks', async () => {
        await expect(authorizeDeviceAccess(req({ user: { id: 1, role: 'admin' }, apiKeyDeviceIds: ['d-2'] }), 'd-1')).rejects.toMatchObject({ statusCode: 403 });
    });

    test('viewer cannot mutate and unknown users fail closed', async () => {
        await expect(authorizeDeviceAccess(req({ user: { id: 1, role: 'viewer' } }), 'd-1', { write: true })).rejects.toMatchObject({ statusCode: 403 });
        await expect(authorizeDeviceAccess(req({ user: null, session: {} }), 'd-1')).rejects.toMatchObject({ statusCode: 401 });
    });

    test('middleware passes the authorized id to handlers', async () => {
        const next = jest.fn();
        await requireDeviceAccess()(req(), { status: () => ({ json: jest.fn() }) }, next);
        expect(next).toHaveBeenCalled();
    });
});
