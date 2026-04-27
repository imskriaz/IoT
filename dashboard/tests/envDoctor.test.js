'use strict';

jest.mock('../utils/check_env', () => ({
    categorizePlaceholderWarnings: jest.fn(),
    loadEnvFile: jest.fn(),
    buildReport: jest.fn(),
    determineExitCode: jest.fn(),
    renderReport: jest.fn()
}));

jest.mock('../utils/seed_env_secrets', () => ({
    SAFE_SECRET_SPECS: {
        SESSION_SECRET: { kind: 'hex', bytes: 48 },
        ADMIN_PASSWORD: { kind: 'base64url', bytes: 18 },
        SUPER_PASS: { kind: 'base64url', bytes: 18 }
    },
    seedSecrets: jest.fn()
}));

jest.mock('../utils/sync_env', () => ({
    syncEnvFiles: jest.fn()
}));

const {
    categorizePlaceholderWarnings,
    loadEnvFile,
    buildReport,
    determineExitCode,
    renderReport
} = require('../utils/check_env');
const { seedSecrets } = require('../utils/seed_env_secrets');
const { syncEnvFiles } = require('../utils/sync_env');
const { renderDoctor, runDoctor } = require('../utils/env_doctor');

describe('env_doctor utility', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        syncEnvFiles.mockReturnValue({
            action: 'unchanged',
            missingKeys: []
        });

        seedSecrets.mockReturnValue({
            mode: 'skipped',
            replacements: [],
            skipped: [],
            safetyCopyPath: null
        });

        loadEnvFile.mockImplementation((filePath) => ({
            exists: true,
            values: filePath.endsWith('.env')
                ? {
                    SESSION_SECRET: 'real-secret',
                    MQTT_HOST: 'broker.local',
                    MQTT_PORT: '1883',
                    SUPER_PASS: 'change-this-superadmin-password'
                }
                : {}
        }));

        buildReport.mockReturnValue({
            header: {
                dashboardRoot: 'D:\\Projects\\IoT\\dashboard',
                platform: 'win32',
                exampleFound: true,
                envFound: true
            },
            summary: {
                status: 'warning'
            },
            sections: [],
            checks: [],
            findings: [],
            notes: []
        });

        categorizePlaceholderWarnings.mockReturnValue({
            critical: ['SUPER_PASS'],
            informational: ['ADMIN_EMAIL']
        });

        determineExitCode.mockImplementation((_report, { strict }) => (strict ? 1 : 0));
    });

    test('runDoctor orchestrates sync, report build, and fixable critical detection', () => {
        const result = runDoctor({
            strict: false,
            writeSafeSecrets: false,
            envFilePath: 'D:\\Projects\\IoT\\dashboard\\.env',
            envExampleFilePath: 'D:\\Projects\\IoT\\dashboard\\.env.example',
            dashboardRootPath: 'D:\\Projects\\IoT\\dashboard',
            platform: 'win32'
        });

        expect(syncEnvFiles).toHaveBeenCalled();
        expect(seedSecrets).not.toHaveBeenCalled();
        expect(buildReport).toHaveBeenCalled();
        expect(result.fixableCritical).toEqual(['SUPER_PASS']);
        expect(result.exitCode).toBe(0);
    });

    test('runDoctor supports safe secret write mode', () => {
        seedSecrets.mockReturnValue({
            mode: 'write',
            replacements: ['SUPER_PASS'],
            skipped: [],
            safetyCopyPath: 'D:\\Projects\\IoT\\dashboard\\temp\\env-safety-copies\\.env.test.bak'
        });

        const result = runDoctor({
            strict: true,
            writeSafeSecrets: true,
            envFilePath: 'D:\\Projects\\IoT\\dashboard\\.env',
            envExampleFilePath: 'D:\\Projects\\IoT\\dashboard\\.env.example',
            dashboardRootPath: 'D:\\Projects\\IoT\\dashboard',
            platform: 'win32'
        });

        expect(seedSecrets).toHaveBeenCalledWith({
            envFilePath: 'D:\\Projects\\IoT\\dashboard\\.env',
            write: true
        });
        expect(result.seedResult.replacements).toEqual(['SUPER_PASS']);
        expect(result.exitCode).toBe(1);
    });

    test('renderDoctor prints suggested fix lines for fixable critical placeholders', () => {
        const lines = [];
        renderDoctor({
            strict: false,
            writeSafeSecrets: false,
            syncResult: { action: 'unchanged', missingKeys: [] },
            seedResult: { replacements: [], skipped: [], safetyCopyPath: null },
            report: {
                header: {
                    dashboardRoot: 'D:\\Projects\\IoT\\dashboard',
                    platform: 'win32',
                    exampleFound: true,
                    envFound: true
                },
                summary: { status: 'warning' },
                sections: [],
                checks: [],
                findings: [],
                notes: []
            },
            fixableCritical: ['SUPER_PASS'],
            exitCode: 0
        }, (line) => lines.push(line));

        expect(renderReport).toHaveBeenCalled();
        expect(lines.join('\n')).toContain('npm run env:secrets -- --keys=SUPER_PASS');
        expect(lines.join('\n')).toContain('Doctor status              warning');
    });

    test('renderDoctor labels env write safety copy without calling it a backup', () => {
        const lines = [];
        renderDoctor({
            strict: true,
            writeSafeSecrets: true,
            syncResult: { action: 'unchanged', missingKeys: [] },
            seedResult: {
                replacements: ['SUPER_PASS'],
                skipped: [],
                safetyCopyPath: 'D:\\Projects\\IoT\\dashboard\\temp\\env-safety-copies\\.env.test.bak'
            },
            report: {
                header: {
                    dashboardRoot: 'D:\\Projects\\IoT\\dashboard',
                    platform: 'win32',
                    exampleFound: true,
                    envFound: true
                },
                summary: { status: 'warning' },
                sections: [],
                checks: [],
                findings: [],
                notes: []
            },
            fixableCritical: [],
            exitCode: 1
        }, (line) => lines.push(line));

        const legacyLabel = ['Backup', 'path'].join(' ');
        expect(lines.join('\n')).toContain('Safety copy path');
        expect(lines.join('\n')).not.toContain(legacyLabel);
    });
});
