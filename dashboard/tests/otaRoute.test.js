'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

function validEsp32S3Image(elfHex) {
    const buffer = Buffer.alloc(336, 0);
    buffer[0] = 0xe9;
    buffer[1] = 1;
    buffer[23] = 1;
    buffer.writeUInt16LE(9, 12);
    buffer.writeUInt32LE(256, 28);
    buffer.writeUInt32LE(0xabcd5432, 32);
    buffer.write('route-test', 48, 'ascii');
    Buffer.from(elfHex, 'hex').copy(buffer, 176);
    let checksum = 0xef;
    for (let index = 32; index < 288; index += 1) checksum ^= buffer[index];
    buffer[303] = checksum;
    crypto.createHash('sha256').update(buffer.subarray(0, 304)).digest().copy(buffer, 304);
    return buffer;
}

describe('OTA route boot-verification contract', () => {
    const firmwareDir = path.join(__dirname, '../data/firmware');
    const filename = 'jest-route-candidate.bin';
    const corruptFilename = 'jest-route-corrupt.bin';
    const filePath = path.join(firmwareDir, filename);
    const corruptPath = path.join(firmwareDir, corruptFilename);
    const sourceElf = 'a'.repeat(64);
    const candidateElf = 'b'.repeat(64);
    let app;
    let previousMqtt;
    let previousBaseUrl;

    beforeAll(() => {
        fs.mkdirSync(firmwareDir, { recursive: true });
        const image = validEsp32S3Image(candidateElf);
        fs.writeFileSync(filePath, image);
        image[96] ^= 1;
        fs.writeFileSync(corruptPath, image);
    });

    afterAll(() => {
        fs.rmSync(filePath, { force: true });
        fs.rmSync(corruptPath, { force: true });
    });

    beforeEach(() => {
        previousMqtt = global.mqttService;
        previousBaseUrl = process.env.OTA_BASE_URL;
        process.env.OTA_BASE_URL = 'https://device.example.test';
        global.mqttService = {
            connected: true,
            deviceStatus: new Map([['device-a', {
                online: true,
                lastStatusAt: new Date().toISOString(),
                lastStatus: {
                    boot_id: '0123456789abcdef', ota_slot: 'ota_0', ota_state: 'valid',
                    firmware_elf_sha256: sourceElf
                }
            }]]),
            otaLifecycle: { enqueue: jest.fn().mockResolvedValue({ success: true, queued: true, status: 'pending' }) }
        };
        app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { id: 1, username: 'route-admin', role: 'admin' };
            req.session = { user: req.user };
            next();
        });
        app.use('/api/ota', require('../routes/ota'));
    });

    afterEach(() => {
        global.mqttService = previousMqtt;
        if (previousBaseUrl === undefined) delete process.env.OTA_BASE_URL;
        else process.env.OTA_BASE_URL = previousBaseUrl;
    });

    test('returns 202 and stages exact image/source boot evidence without claiming completion', async () => {
        const response = await request(app).post('/api/ota/flash')
            .send({ deviceId: 'device-a', filename });
        expect(response.status).toBe(202);
        expect(response.body.message).toMatch(/waiting for verified reboot/i);
        expect(global.mqttService.otaLifecycle.enqueue).toHaveBeenCalledWith(
            'device-a',
            expect.objectContaining({
                url: expect.stringMatching(/^https:\/\/device\.example\.test\/api\/ota\/download\//),
                _ota: expect.objectContaining({
                    source_boot_id: '0123456789abcdef',
                    source_slot: 'ota_0', target_slot: 'ota_1',
                    source_elf_sha256: sourceElf,
                    expected_elf_sha256: candidateElf
                })
            }),
            300000,
            expect.objectContaining({ source: 'dashboard', domain: 'system' })
        );
    });

    test('fails before enqueue for stale boot evidence or a corrupted image', async () => {
        global.mqttService.deviceStatus.get('device-a').lastStatusAt = new Date(Date.now() - 91000).toISOString();
        let response = await request(app).post('/api/ota/flash')
            .send({ deviceId: 'device-a', filename });
        expect(response.status).toBe(412);

        global.mqttService.deviceStatus.get('device-a').lastStatusAt = new Date().toISOString();
        response = await request(app).post('/api/ota/flash')
            .send({ deviceId: 'device-a', filename: corruptFilename });
        expect(response.status).toBe(412);
        expect(response.body.message).toMatch(/checksum|digest/i);
        expect(global.mqttService.otaLifecycle.enqueue).not.toHaveBeenCalled();
    });

    test('reports a second active OTA as a conflict', async () => {
        const error = new Error('An OTA update is already pending or needs boot verification');
        error.code = 'OTA_ALREADY_PENDING';
        global.mqttService.otaLifecycle.enqueue.mockRejectedValue(error);
        const response = await request(app).post('/api/ota/flash')
            .send({ deviceId: 'device-a', filename });
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ success: false, message: expect.stringMatching(/already pending/i) });
    });
});
