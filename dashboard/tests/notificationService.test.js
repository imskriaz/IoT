'use strict';

const { buildNotificationActionUrl } = require('../services/notificationService');

describe('notificationService link builder', () => {
    test('builds deep links for SMS notifications', () => {
        expect(buildNotificationActionUrl({
            category: 'sms',
            deviceId: 'android-1',
            metadata: { from: '+15551234567' }
        })).toBe('/sms?device=android-1&thread=%2B15551234567');

        expect(buildNotificationActionUrl({
            category: 'sms',
            deviceId: 'android-1',
            metadata: { conversationId: 42, thread: '+15550000000' }
        })).toBe('/sms?device=android-1&conversation=42&thread=%2B15550000000');
    });

    test('builds deep links for calls and device-scoped categories', () => {
        expect(buildNotificationActionUrl({
            category: 'call',
            deviceId: 'android-1',
            metadata: { number: '+15551234567' }
        })).toBe('/calls?device=android-1&to=%2B15551234567');

        expect(buildNotificationActionUrl({
            category: 'queue',
            deviceId: 'esp32-1'
        })).toBe('/devices/queue?device=esp32-1');

        expect(buildNotificationActionUrl({
            category: 'network',
            deviceId: 'esp32-1'
        })).toBe('/devices/about?device=esp32-1');
    });

    test('preserves explicit links and adds device context when available', () => {
        expect(buildNotificationActionUrl({
            category: 'device',
            deviceId: 'esp32-1',
            actionUrl: '/devices/settings?tab=wifi'
        })).toBe('/devices/settings?tab=wifi&device=esp32-1');

        expect(buildNotificationActionUrl({
            category: 'automation',
            actionUrl: '/automation?flow=7'
        })).toBe('/automation?flow=7');
    });
});
