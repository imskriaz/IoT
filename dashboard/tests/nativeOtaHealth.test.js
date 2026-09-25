'use strict';

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const flush = () => new Promise(resolve => setImmediate(resolve));
describe('native OTA challenge orchestration', () => {
    let service;
    let sequence;
    const challenge = 'ota_0123456789abcdef01234567';
    const status = (extra = {}) => ({ type: 'device_status', device_id: 'unit',
        boot_id: '0123456789abcdef', status_sequence: ++sequence,
        ota_state: 'pending_verify', ota_validation_action_id: challenge,
        mqtt_connected: true, mqtt_subscribed: true, ...extra });
    const receive = (data, packet = {}, topic = 'device/unit/status') =>
        service.handleMessage(topic, Buffer.from(JSON.stringify(data)), packet);
    beforeEach(() => {
        jest.resetModules();
        global.app = { locals: {} };
        service = require('../services/mqttService');
        service.connected = true;
        service.publishCommand = jest.fn().mockResolvedValue({});
        service.otaLifecycle.observeStatus = jest.fn().mockResolvedValue(null);
        sequence = 0;
    });
    afterEach(() => { service.disconnect(); delete global.app; jest.restoreAllMocks(); });

    test('requests exact challenge once and does not manufacture valid state', async () => {
        receive(status()); receive(status()); await flush();
        expect(service.publishCommand).toHaveBeenCalledTimes(1);
        expect(service.publishCommand).toHaveBeenCalledWith('unit', 'get_status', {}, false, 10000,
            { messageId: challenge, skipPersistentQueue: true });
        receive(status()); await flush();
        expect(service.publishCommand).toHaveBeenCalledTimes(1);
        expect(service.deviceStatus.get('unit').lastStatus.ota_state).toBe('pending_verify');
    });
    test.each([
        { device_id: 'other' }, { type: 'status' }, { boot_id: 'bad' },
        { status_sequence: 0 }, { status_sequence: 1.5 }, { status_sequence: 4294967296 },
        { ota_state: 'valid' }, { mqtt_connected: false }, { mqtt_subscribed: false },
        { ota_validation_action_id: 'old-command' }
    ])('rejects invalid eligibility %j', async extra => {
        receive(status(extra)); await flush(); expect(service.publishCommand).not.toHaveBeenCalled();
    });
    test('retained and delayed status cannot request health', async () => {
        receive(status(), { retain: true });
        receive(status({ status_sequence: 9, ota_state: 'valid' }));
        receive(status({ status_sequence: 8 }));
        await flush(); expect(service.publishCommand).not.toHaveBeenCalled();
    });
    test('status-like events are not direct health evidence', async () => {
        receive(status(), {}, 'device/unit/event');
        await flush(); expect(service.publishCommand).not.toHaveBeenCalled();
    });
    test('publication failure retries only after backoff and another fresh status', async () => {
        let now = 100000;
        jest.spyOn(Date, 'now').mockImplementation(() => now);
        service.publishCommand.mockRejectedValueOnce(new Error('offline'));
        receive(status()); await flush();
        now += 9999; receive(status()); await flush();
        expect(service.publishCommand).toHaveBeenCalledTimes(1);
        now++; receive(status()); await flush();
        expect(service.publishCommand).toHaveBeenCalledTimes(2);
    });
    test('new challenge can progress while old publish settles, cleanup cancels dispatch', async () => {
        receive(status());
        service.clearDeviceStatus('unit');
        await flush(); expect(service.publishCommand).not.toHaveBeenCalled();
        receive(status()); await flush();
        receive(status({ ota_validation_action_id: 'ota_0123456789abcdef01234568' }));
        await flush(); expect(service.publishCommand).toHaveBeenCalledTimes(2);
        service.disconnect(); expect(service.otaHealthRequests.size).toBe(0);
    });
});
