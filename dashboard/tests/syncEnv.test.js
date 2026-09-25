'use strict';

const fs = require('fs');
const path = require('path');

const {
    appendMissingEntries,
    buildSyncPlan,
    detectEol,
    extractExampleEntries,
    parseEnvKeys,
    syncEnvFiles
} = require('../utils/sync_env');

const workspaceTempRoot = path.join(__dirname, '..', 'temp', 'jest-sync-env');

function createTempDir() {
    fs.mkdirSync(workspaceTempRoot, { recursive: true });
    return fs.mkdtempSync(path.join(workspaceTempRoot, 'case-'));
}

function removeTempDir(tempDir) {
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {
        // Windows can keep a short-lived handle on hidden-style temp files.
        // Best-effort cleanup is enough for these tests.
    }
}

describe('sync_env utility', () => {
    test('parseEnvKeys extracts env keys only', () => {
        const keys = parseEnvKeys([
            '# comment',
            'PORT=3001',
            ' MQTT_HOST = broker',
            'not-a-key',
            'MQTT_PASSWORD=secret'
        ].join('\n'));

        expect(Array.from(keys).sort()).toEqual(['MQTT_HOST', 'MQTT_PASSWORD', 'PORT']);
    });

    test('extractExampleEntries preserves entry order and original lines', () => {
        const entries = extractExampleEntries('PORT=3001\n# comment\nMQTT_PROTOCOL=mqtt');
        expect(entries).toEqual([
            { key: 'PORT', line: 'PORT=3001' },
            { key: 'MQTT_PROTOCOL', line: 'MQTT_PROTOCOL=mqtt' }
        ]);
    });

    test('buildSyncPlan returns only missing keys', () => {
        const exampleContent = 'PORT=3001\nMQTT_PROTOCOL=mqtt\nSERIAL_BAUD=115200';
        const localContent = 'PORT=3001\n';
        const plan = buildSyncPlan(exampleContent, localContent);

        expect(plan.missingKeys).toEqual(['MQTT_PROTOCOL', 'SERIAL_BAUD']);
    });

    test('appendMissingEntries appends a sync block without overwriting existing values', () => {
        const result = appendMissingEntries(
            'PORT=9000\n',
            [
                { key: 'MQTT_PROTOCOL', line: 'MQTT_PROTOCOL=mqtt' },
                { key: 'SERIAL_BAUD', line: 'SERIAL_BAUD=115200' }
            ],
            '\n',
            '2026-04-13T00:00:00.000Z'
        );

        expect(result).toContain('PORT=9000');
        expect(result).toContain('# Added from .env.example by env:sync on 2026-04-13T00:00:00.000Z');
        expect(result).toContain('MQTT_PROTOCOL=mqtt');
        expect(result).toContain('SERIAL_BAUD=115200');
    });

    test('syncEnvFiles updates an existing env file with missing keys', () => {
        const tempDir = createTempDir();
        try {
            const envFilePath = path.join(tempDir, '.env');
            const envExampleFilePath = path.join(tempDir, '.env.example');

            fs.writeFileSync(envExampleFilePath, 'PORT=3001\nMQTT_PROTOCOL=mqtt\nSERIAL_BAUD=115200\n', 'utf8');
            fs.writeFileSync(envFilePath, 'PORT=9000\n', 'utf8');

            const result = syncEnvFiles({
                envFilePath,
                envExampleFilePath,
                timestamp: '2026-04-13T00:00:00.000Z'
            });

            const nextContent = fs.readFileSync(envFilePath, 'utf8');
            expect(result).toEqual({
                action: 'updated',
                missingKeys: ['MQTT_PROTOCOL', 'SERIAL_BAUD']
            });
            expect(nextContent).toContain('PORT=9000');
            expect(nextContent).toContain('MQTT_PROTOCOL=mqtt');
            expect(nextContent).toContain('SERIAL_BAUD=115200');
        } finally {
            removeTempDir(tempDir);
        }
    });

    test('syncEnvFiles creates env file from example when missing', () => {
        const tempDir = createTempDir();
        try {
            const envFilePath = path.join(tempDir, '.env');
            const envExampleFilePath = path.join(tempDir, '.env.example');

            fs.writeFileSync(envExampleFilePath, 'PORT=3001\nMQTT_PROTOCOL=mqtt\n', 'utf8');

            const result = syncEnvFiles({
                envFilePath,
                envExampleFilePath,
                timestamp: '2026-04-13T00:00:00.000Z'
            });

            expect(result).toEqual({
                action: 'created',
                missingKeys: ['PORT', 'MQTT_PROTOCOL']
            });
            expect(fs.readFileSync(envFilePath, 'utf8')).toBe('PORT=3001\nMQTT_PROTOCOL=mqtt\n');
        } finally {
            removeTempDir(tempDir);
        }
    });

    test('detectEol prefers CRLF when present', () => {
        expect(detectEol('A=1\r\nB=2\r\n')).toBe('\r\n');
        expect(detectEol('A=1\nB=2\n')).toBe('\n');
    });
});
