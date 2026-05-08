'use strict';

const { hydrateDeviceStatusFromCache } = require('../utils/deviceStatusCache');

describe('device status cache', () => {
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
            })
        );
        expect(result).toEqual(expect.objectContaining({
            system: expect.objectContaining({ runtimeRamTotal: 354803 })
        }));
    });
});
