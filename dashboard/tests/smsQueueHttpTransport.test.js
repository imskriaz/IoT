'use strict';

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../services/packageService', () => ({
    assertSmsWithinPackageLimit: jest.fn().mockResolvedValue()
}));

jest.mock('../services/userAccessService', () => ({
    assertUserSmsWithinLimits: jest.fn().mockResolvedValue()
}));

jest.mock('../services/smsConversations', () => ({
    attachSmsToConversation: jest.fn().mockResolvedValue(88)
}));

jest.mock('../services/pushNotificationService', () => ({
    sendToTokens: jest.fn().mockResolvedValue({ sent: 1, failed: 0, skipped: 0, results: [] })
}));

describe('smsQueue HTTP transport lane', () => {
    const originalPhoneCountryCode = process.env.PHONE_COUNTRY_CODE;

    beforeEach(() => {
        jest.resetModules();
        process.env.PHONE_COUNTRY_CODE = '880';
        global.io = { to: jest.fn().mockReturnValue({ emit: jest.fn() }) };
    });

    afterEach(() => {
        if (originalPhoneCountryCode === undefined) delete process.env.PHONE_COUNTRY_CODE;
        else process.env.PHONE_COUNTRY_CODE = originalPhoneCountryCode;
        delete global.io;
        jest.clearAllMocks();
    });

    test('queues httpSMS device rows without requiring MQTT publishCommand', async () => {
        const db = {
            get: jest.fn().mockResolvedValue({
                type: 'httpsms-bridge',
                capabilities: JSON.stringify({ sms: true, transport_mode: 'http' })
            }),
            all: jest.fn().mockResolvedValue([{ push_token: 'fcm-token-123', platform: 'android', app_id: 'httpsms' }]),
            run: jest.fn(async (sql) => {
                if (String(sql).includes('INSERT INTO sms')) return { lastID: 61, changes: 1 };
                return { changes: 1 };
            })
        };
        const pushNotificationService = require('../services/pushNotificationService');
        const { queueSmsForDelivery } = require('../services/smsQueue');

        const result = await queueSmsForDelivery({
            db,
            mqttService: null,
            deviceId: 'httpsms-01',
            to: '01700000000',
            message: 'HTTP lane',
            userId: 7,
            source: 'httpsms'
        });

        expect(result).toEqual(expect.objectContaining({
            success: true,
            queued: true,
            id: 61,
            to: '+8801700000000',
            status: 'queued',
            transport: 'http'
        }));
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO sms'),
            expect.arrayContaining(['httpsms-01', 'self', '+8801700000000', 'HTTP lane'])
        );
        expect(db.all).toHaveBeenCalledWith(
            expect.stringContaining('FROM device_push_tokens'),
            ['httpsms-01']
        );
        expect(pushNotificationService.sendToTokens).toHaveBeenCalledWith(
            [{ push_token: 'fcm-token-123', platform: 'android', app_id: 'httpsms' }],
            expect.objectContaining({
                data: expect.objectContaining({
                    KEY_MESSAGE_ID: result.messageId,
                    message_id: result.messageId,
                    device_id: 'httpsms-01'
                })
            })
        );
    });
});
