'use strict';

const zlib = require('zlib');

const { encodeProvisioningToken } = require('../utils/provisioningToken');

function decodeToken(token) {
    return JSON.parse(zlib.inflateRawSync(Buffer.from(token, 'base64url')).toString('utf8'));
}

describe('provisioning token encoder', () => {
    test('emits a compact opaque setup code that is shorter than legacy json base64url', () => {
        const payload = {
            schema: 'iot.android-bridge.v1',
            generated_at: '2026-04-18T12:00:00.000Z',
            transport: { mode: 'mqtt' },
            server_url: '',
            api_key: '',
            device: {
                id: 'android-test-01',
                name: 'Android Bridge',
                topic_prefix: 'device'
            },
            mqtt: {
                host: '144.79.218.153',
                port: 1883,
                protocol: 'mqtt',
                username: 'device',
                password: '153520'
            }
        };

        const legacy = `legacy:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
        const current = encodeProvisioningToken(payload);

        expect(current).not.toMatch(/^[a-z]+\:/i);
        expect(current.length).toBeLessThan(legacy.length);
    });

    test('drops default mqtt fields to keep the token compact', () => {
        const payload = {
            transport: { mode: 'mqtt' },
            device: {
                id: 'android-test-01',
                topic_prefix: 'device'
            },
            mqtt: {
                host: 'broker.internal',
                port: 1883,
                protocol: 'mqtt',
                username: '',
                password: ''
            }
        };

        const current = encodeProvisioningToken(payload);

        expect(current).not.toMatch(/^[a-z]+\:/i);
        expect(current.length).toBeLessThan(100);
    });

    test('keeps realtime and dashboard fallback details for automatic Android provisioning', () => {
        const current = encodeProvisioningToken({
            transport: { mode: 'auto' },
            server_url: 'https://dashboard.example.test',
            api_key: 'dbk_test',
            device: {
                id: 'android-auto-01',
                topic_prefix: 'device'
            },
            mqtt: {
                host: 'broker.example.test',
                port: 1883,
                protocol: 'mqtt',
                username: 'bridge',
                password: 'secret'
            }
        });

        expect(decodeToken(current)).toMatchObject({
            tm: 'auto',
            di: 'android-auto-01',
            su: 'https://dashboard.example.test',
            ak: 'dbk_test',
            mh: 'broker.example.test',
            mu: 'bridge',
            mw: 'secret'
        });
    });
});
