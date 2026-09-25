'use strict';

jest.mock('serialport', () => ({ SerialPort: jest.fn() }));
jest.mock('@serialport/parser-readline', () => ({ ReadlineParser: jest.fn() }));
jest.mock('../services/modemService', () => ({
    handleHeartbeat: jest.fn(), updateDeviceStatus: jest.fn(), getAllDevices: jest.fn(() => [])
}));
jest.mock('../utils/logger', () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const service = require('../services/serialBridgeService');
const modem = require('../services/modemService');

afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); delete global.io; service._app = null; });

test('serial observation cannot renew runtime heartbeat or durable online state', () => {
    jest.spyOn(service, '_getTargetDeviceId').mockReturnValue('device-1');
    const emit = jest.fn();
    global.io = { to: jest.fn(() => ({ emit })) };
    const run = jest.fn();
    service._app = { locals: { db: { run } } };
    service._emitSerialObservation('serial_console_status');
    expect(modem.handleHeartbeat).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('device:serial-observation', expect.objectContaining({ deviceId: 'device-1', source: 'serial_debug' }));
    expect(emit.mock.calls[0][1]).not.toHaveProperty('online');
});

test('serial snapshot returns diagnostics without overwriting runtime status', async () => {
    jest.spyOn(service, '_runConsoleCommand').mockResolvedValue(['STATUS_JSON {"device_id":"device-1","mqtt_connected":false}']);
    const snapshot = { device_id: 'device-1', mqtt_connected: false };
    jest.spyOn(service, '_buildSnapshot').mockReturnValue(snapshot);
    jest.spyOn(service, '_emitSerialObservation').mockImplementation(() => {});
    expect(await service._captureSnapshot('device-1')).toBe(snapshot);
    expect(modem.updateDeviceStatus).not.toHaveBeenCalled();
    expect(modem.handleHeartbeat).not.toHaveBeenCalled();
});
