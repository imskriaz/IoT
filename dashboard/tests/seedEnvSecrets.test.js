'use strict';

const fs = require('fs');
const path = require('path');

const {
    SAFE_SECRET_SPECS,
    applyReplacementPlan,
    buildReplacementPlan,
    createSafetyCopyFile,
    formatSafetyCopyStamp,
    generateSecret,
    parseArgs,
    seedSecrets,
    shouldReplaceValue
} = require('../utils/seed_env_secrets');

const workspaceTempRoot = path.join(__dirname, '..', 'temp', 'jest-seed-env');

function createTempDir() {
    fs.mkdirSync(workspaceTempRoot, { recursive: true });
    return fs.mkdtempSync(path.join(workspaceTempRoot, 'case-'));
}

function removeTempDir(tempDir) {
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {
        // Best-effort cleanup for Windows temp-file quirks.
    }
}

describe('seed_env_secrets utility', () => {
    test('generateSecret returns values for supported keys', () => {
        const session = generateSecret('SESSION_SECRET');
        const admin = generateSecret('ADMIN_PASSWORD');

        expect(session).toMatch(/^[a-f0-9]{96}$/);
        expect(admin.length).toBeGreaterThanOrEqual(20);
    });

    test('shouldReplaceValue only targets safe placeholder or empty values', () => {
        expect(shouldReplaceValue('SUPER_PASS', 'change-this-superadmin-password')).toBe(true);
        expect(shouldReplaceValue('SUPER_PASS', '')).toBe(true);
        expect(shouldReplaceValue('SUPER_PASS', 'real-secret')).toBe(false);
        expect(shouldReplaceValue('MQTT_PASSWORD', 'your-mqtt-password')).toBe(false);
    });

    test('buildReplacementPlan only includes safe supported keys', () => {
        const plan = buildReplacementPlan([
            'SESSION_SECRET=change-this-to-a-long-random-string',
            'ADMIN_PASSWORD=real-admin-pass',
            'SUPER_PASS=change-this-superadmin-password',
            'MQTT_PASSWORD=your-mqtt-password'
        ].join('\n'));

        expect(plan.replacements.map((entry) => entry.key)).toEqual(['SESSION_SECRET', 'SUPER_PASS']);
        expect(plan.skipped).toEqual(
            expect.arrayContaining([
                { key: 'ADMIN_PASSWORD', reason: 'already set' }
            ])
        );
    });

    test('applyReplacementPlan replaces only targeted lines', () => {
        const nextContent = applyReplacementPlan(
            'SESSION_SECRET=change-this\nADMIN_PASSWORD=keep-me\n',
            [{ key: 'SESSION_SECRET', lineIndex: 0, nextValue: 'abc123' }],
            '\n'
        );

        expect(nextContent).toContain('SESSION_SECRET=abc123');
        expect(nextContent).toContain('ADMIN_PASSWORD=keep-me');
    });

    test('seedSecrets supports dry run and write mode', () => {
        const tempDir = createTempDir();
        try {
            const envFilePath = path.join(tempDir, '.env');
            const safetyCopyDir = path.join(tempDir, 'safety-copies');
            fs.writeFileSync(envFilePath, [
                'SESSION_SECRET=change-this-to-a-long-random-string',
                'ADMIN_PASSWORD=real-admin-pass',
                'SUPER_PASS=change-this-superadmin-password'
            ].join('\n'), 'utf8');

            const dryRun = seedSecrets({ envFilePath, write: false });
            expect(dryRun.mode).toBe('dry-run');
            expect(dryRun.replacements).toEqual(['SESSION_SECRET', 'SUPER_PASS']);
            expect(dryRun.safetyCopyPath).toBeNull();

            const writeResult = seedSecrets({
                envFilePath,
                write: true,
                safetyCopyDir,
                timestamp: '2026-04-13T00:00:00.000Z'
            });
            const nextContent = fs.readFileSync(envFilePath, 'utf8');
            expect(writeResult.mode).toBe('write');
            expect(writeResult.safetyCopyPath).toBe(path.join(safetyCopyDir, '.env.2026-04-13T00-00-00-000Z.bak'));
            expect(fs.existsSync(writeResult.safetyCopyPath)).toBe(true);
            expect(nextContent).not.toContain('change-this-superadmin-password');
            expect(nextContent).toContain('ADMIN_PASSWORD=real-admin-pass');
        } finally {
            removeTempDir(tempDir);
        }
    });

    test('parseArgs defaults to dry run unless write is requested', () => {
        expect(parseArgs([])).toEqual({ write: false, dryRun: true, keys: null });
        expect(parseArgs(['--write', '--keys=SESSION_SECRET,SUPER_PASS'])).toEqual({
            write: true,
            dryRun: false,
            keys: ['SESSION_SECRET', 'SUPER_PASS']
        });
    });

    test('safe secret specs stay limited to dashboard-owned keys', () => {
        expect(Object.keys(SAFE_SECRET_SPECS).sort()).toEqual(['ADMIN_PASSWORD', 'SESSION_SECRET', 'SUPER_PASS']);
    });

    test('formatSafetyCopyStamp and createSafetyCopyFile produce stable safety copy paths', () => {
        const tempDir = createTempDir();
        try {
            const stamp = formatSafetyCopyStamp('2026-04-13T01:02:03.456Z');
            expect(stamp).toBe('2026-04-13T01-02-03-456Z');

            const safetyCopyPath = createSafetyCopyFile(
                path.join(tempDir, '.env'),
                'PORT=3001\n',
                path.join(tempDir, 'safety-copies'),
                '2026-04-13T01:02:03.456Z'
            );

            expect(safetyCopyPath).toBe(path.join(tempDir, 'safety-copies', '.env.2026-04-13T01-02-03-456Z.bak'));
            expect(fs.readFileSync(safetyCopyPath, 'utf8')).toBe('PORT=3001\n');
        } finally {
            removeTempDir(tempDir);
        }
    });
});
