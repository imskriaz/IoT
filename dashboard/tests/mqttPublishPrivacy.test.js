'use strict';
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

test.each([false, true])('publish logs no profile body (serialized=%s)', async serialized => {
    jest.resetModules();
    const service = require('../services/mqttService');
    const logger = require('../utils/logger');
    const previousClient = service.client;
    const previousConnected = service.connected;
    const client = { publish: jest.fn((_topic, _payload, _options, callback) => callback(null)) };
    service.client = client;
    service.connected = true;
    jest.clearAllMocks();
    try {
        const body = { profiles: [{ ssid: 'private-network', password: 'private-password' }] };
        const wire = JSON.stringify(body);
        await service.publish('device/test/command/wifi_profiles_apply', serialized ? wire : body);
        expect(client.publish.mock.calls[0][1]).toBe(wire);
        const logged = JSON.stringify(logger.debug.mock.calls);
        expect(logged).not.toContain('private-password');
        expect(logged).not.toContain('private-network');
        expect(logger.debug).toHaveBeenCalledWith('MQTT publish completed', {
            topic: 'device/test/command/wifi_profiles_apply', bytes: Buffer.byteLength(wire)
        });
    } finally {
        service.client = previousClient;
        service.connected = previousConnected;
    }
});
