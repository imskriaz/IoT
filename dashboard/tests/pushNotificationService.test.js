'use strict';

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const { PushNotificationService } = require('../services/pushNotificationService');

describe('pushNotificationService', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
        jest.clearAllMocks();
    });

    test('notifies linked Expo tokens for a target device', async () => {
        const db = {
            all: jest.fn().mockResolvedValue([
                {
                    push_token: 'ExpoPushToken[abc123]',
                    platform: 'android',
                    app_id: 'expo-app',
                    phone_device_id: 'phone-1'
                }
            ])
        };
        const fetchFn = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: jest.fn().mockResolvedValue('ok')
        });
        const service = new PushNotificationService({
            app: { locals: { db } },
            fetchFn,
            http2Module: { connect: jest.fn() }
        });

        const result = await service.notifyLinkedDevices('esp32-1', {
            title: 'New SMS received',
            body: 'From +8801000000000: hello',
            data: { type: 'sms.incoming', deviceId: 'esp32-1' }
        });

        expect(db.all).toHaveBeenCalledWith(expect.stringContaining('FROM phone_device_links'), ['esp32-1']);
        expect(fetchFn).toHaveBeenCalledWith(
            'https://exp.host/--/api/v2/push/send',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'Content-Type': 'application/json' })
            })
        );
        expect(result.sent).toBe(1);
        expect(result.failed).toBe(0);
    });

    test('uses FCM for android tokens when a server key is configured', async () => {
        process.env.FCM_SERVER_KEY = 'fcm-secret';
        const fetchFn = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: jest.fn().mockResolvedValue('ok')
        });
        const service = new PushNotificationService({
            app: { locals: { db: null } },
            fetchFn,
            http2Module: { connect: jest.fn() }
        });

        const result = await service.sendToToken({
            push_token: 'android-device-token',
            platform: 'android',
            app_id: null
        }, {
            title: 'Incoming call',
            body: 'From +8801000000001',
            data: { type: 'call.incoming' }
        });

        expect(fetchFn).toHaveBeenCalledWith(
            'https://fcm.googleapis.com/fcm/send',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ Authorization: 'key=fcm-secret' })
            })
        );
        expect(result.ok).toBe(true);
        expect(result.provider).toBe('fcm');
    });

    test('deduplicates tokens before dispatching', async () => {
        const fetchFn = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: jest.fn().mockResolvedValue('ok')
        });
        const service = new PushNotificationService({
            app: { locals: { db: null } },
            fetchFn,
            http2Module: { connect: jest.fn() }
        });

        const result = await service.sendToTokens([
            { push_token: 'ExpoPushToken[same]', platform: 'android', app_id: 'expo-app' },
            { push_token: 'ExpoPushToken[same]', platform: 'android', app_id: 'expo-app' }
        ], {
            title: 'Alert',
            body: 'Only one send expected'
        });

        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(result.sent).toBe(1);
    });
});
