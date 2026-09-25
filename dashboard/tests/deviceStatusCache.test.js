'use strict';

const { hydrateDeviceStatusFromCache } = require('../utils/deviceStatusCache');

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

describe('device status cache', () => {
    test('restart hydration preserves original observation age and expires without new device evidence', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-09-12T00:00:00Z'));
        const modemService = require('../services/modemService');
        modemService.resetDevices();
        const observedAt = new Date(Date.now() - 110000).toISOString();
        const db = { get: jest.fn().mockResolvedValue({
            payload_json: JSON.stringify({ device_id: 'device-cache', wifi_connected: true }),
            updated_at: observedAt
        }) };
        try {
            const restored = await hydrateDeviceStatusFromCache(db, modemService, 'device-cache');
            expect(restored.lastSeen).toBe(observedAt);
            expect(restored.online).toBe(true);
            jest.advanceTimersByTime(11000);
            expect(modemService.getDeviceStatus('device-cache').online).toBe(false);
            await hydrateDeviceStatusFromCache(db, modemService, 'device-cache');
            expect(modemService.getDeviceStatus('device-cache').lastSeen).toBe(observedAt);
            expect(modemService.isDeviceOnline('device-cache')).toBe(false);
            modemService.updateDeviceStatus('device-cache', { wifi_connected: true });
            expect(modemService.getDeviceStatus('device-cache').online).toBe(true);
            expect(modemService.getDeviceStatus('device-cache').lastSeen).toBe(new Date().toISOString());
        } finally {
            modemService.resetDevices();
            jest.useRealTimers();
        }
    });

    test('forced cache hydration does not advance or rewind an existing observation', async () => {
        const modemService = require('../services/modemService');
        modemService.resetDevices();
        modemService.updateDeviceStatus('device-existing', { wifi_connected: true });
        const originalSeenAt = modemService.getDeviceStatus('device-existing').lastSeen;
        const db = { get: jest.fn().mockResolvedValue({
            payload_json: JSON.stringify({ device_id: 'device-existing' }),
            updated_at: new Date(Date.now() - 60000).toISOString()
        }) };
        await hydrateDeviceStatusFromCache(db, modemService, 'device-existing', { force: true });
        expect(modemService.getDeviceStatus('device-existing').lastSeen).toBe(originalSeenAt);
        modemService.resetDevices();
    });

    test('keeps current online status unless force hydration is requested', async () => {
        const db = {
            get: jest.fn().mockResolvedValue({
                payload_json: JSON.stringify({ device_id: 'device-1', runtime_ram_total_bytes: 354803 }),
                updated_at: new Date().toISOString()
            })
        };
        const modemService = {
            getDeviceStatus: jest.fn().mockReturnValue({ deviceId: 'device-1', online: true }),
            updateDeviceStatus: jest.fn()
        };

        const result = await hydrateDeviceStatusFromCache(db, modemService, 'device-1');

        expect(result).toEqual({ deviceId: 'device-1', online: true });
        expect(db.get).not.toHaveBeenCalled();
        expect(modemService.updateDeviceStatus).not.toHaveBeenCalled();
    });

    test('force hydration merges fresh cached hardware metrics even when online', async () => {
        const cachedPayload = {
            device_id: 'device-1',
            runtime_ram_total_bytes: 354803,
            psram_total_bytes: 8388608
        };
        const db = {
            get: jest.fn().mockResolvedValue({
                payload_json: JSON.stringify(cachedPayload),
                updated_at: new Date().toISOString()
            })
        };
        const modemService = {
            getDeviceStatus: jest.fn()
                .mockReturnValueOnce({ deviceId: 'device-1', online: true })
                .mockReturnValueOnce({ deviceId: 'device-1', online: true, system: { runtimeRamTotal: 354803 } }),
            updateDeviceStatus: jest.fn()
        };

        const result = await hydrateDeviceStatusFromCache(db, modemService, 'device-1', { force: true });

        expect(modemService.updateDeviceStatus).toHaveBeenCalledWith(
            'device-1',
            expect.objectContaining({
                runtime_ram_total_bytes: 354803,
                psram_total_bytes: 8388608,
                cached_status: true
            }),
            { fromCache: true, observedAt: expect.any(String) }
        );
        expect(result).toEqual(expect.objectContaining({
            system: expect.objectContaining({ runtimeRamTotal: 354803 })
        }));
    });
});
