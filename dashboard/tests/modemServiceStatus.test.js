jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

describe('modemService status normalization', () => {
    let modemService;

    beforeEach(() => {
        jest.resetModules();
        modemService = require('../services/modemService');
        modemService.resetDevices();
    });

    test('prefers Arduino nested status fields for operator, sim, and battery telemetry', () => {
        modemService.updateDeviceStatus('device-arduino', {
            active_path: 'modem',
            mobile: {
                signalStrength: 22,
                signalDbm: -69,
                networkType: 'LTE',
                operator: 'Grameenphone',
                ipAddress: '10.0.0.5',
                registered: true
            },
            system: {
                battery: 81,
                voltage_mV: 4098,
                charging: true,
                uptime: 3210,
                temperature: 33.2
            },
            sim: {
                number: '+8801628301525',
                mcc: '47001'
            },
            imei: '123456789012345'
        });

        const status = modemService.getDeviceStatus('device-arduino');

        expect(status).toMatchObject({
            online: true,
            operator: 'Grameenphone',
            simNumber: '+8801628301525',
            battery: 81,
            voltageMv: 4098,
            charging: true,
            imei: '123456789012345'
        });
        expect(status.sim).toMatchObject({
            number: '+8801628301525'
        });
    });

    test('preserves the modem operator code when the device does not report a carrier name', () => {
        modemService.updateDeviceStatus('device-espidf', {
            active_path: 'modem',
            modem_registered: true,
            modem_signal: 19,
            modem_operator: '47002',
            modem_operator_name: '47002',
            modem_subscriber_number: '+8801700000000',
            modem_data_ip: '100.64.1.23',
            sensors: {
                batterySoc: 67,
                batteryVoltage_mV: 3920,
                charging: false,
                temperature_C: 29
            },
            imei: '867530900000001'
        });

        const status = modemService.getDeviceStatus('device-espidf');

        expect(status).toMatchObject({
            online: true,
            operator: '47002',
            simNumber: '+8801700000000',
            battery: 67,
            voltageMv: 3920,
            charging: false,
            ip: '100.64.1.23',
            imei: '867530900000001'
        });
        expect(status.sim).toMatchObject({
            number: '+8801700000000',
            operatorName: '47002'
        });
    });

    test('preserves the last known SIM number when a later status omits it', () => {
        modemService.updateDeviceStatus('device-sim-cache', {
            active_path: 'modem',
            modem_registered: true,
            modem_operator_name: 'robi axiata',
            modem_subscriber_number: '+8801887300993',
            mqtt_connected: true,
            mqtt_subscribed: true
        });

        modemService.updateDeviceStatus('device-sim-cache', {
            active_path: 'modem',
            modem_registered: true,
            modem_operator_name: 'robi axiata',
            mobile: {
                simNumber: '',
                subscriberNumber: ''
            },
            sim: {
                number: '',
                subscriberNumber: ''
            },
            mqtt_connected: true,
            mqtt_subscribed: true
        });

        const status = modemService.getDeviceStatus('device-sim-cache');

        expect(status.simNumber).toBe('+8801887300993');
        expect(status.sim).toMatchObject({
            number: '+8801887300993',
            subscriberNumber: '+8801887300993'
        });
    });
});
