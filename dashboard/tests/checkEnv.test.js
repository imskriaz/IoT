'use strict';

const {
    buildReport,
    categorizePlaceholderWarnings,
    compareWithExample,
    createLabelFormatter,
    determineExitCode,
    displayValue,
    findMissingRequired,
    findPlaceholderWarnings,
    renderReport
} = require('../utils/check_env');

describe('check_env utility', () => {
    test('compareWithExample only flags recommended missing keys', () => {
        const localEnv = {
            NODE_ENV: 'development',
            PORT: '3001',
            PHONE_COUNTRY_CODE: '880',
            DEVICE_SETUP_AP_IP: '192.168.4.1',
            DEVICE_SETUP_AP_PREFIX: 'cfg',
            SERIAL_BAUD: '115200'
        };
        const exampleEnv = {
            NODE_ENV: 'development',
            PORT: '3001',
            MQTT_PROTOCOL: 'mqtt',
            PHONE_COUNTRY_CODE: '880',
            DEVICE_SETUP_AP_IP: '192.168.4.1',
            DEVICE_SETUP_AP_PREFIX: 'cfg',
            SERIAL_BAUD: '115200',
            OPTIONAL_ONLY: 'x'
        };

        expect(compareWithExample(localEnv, exampleEnv)).toEqual(['MQTT_PROTOCOL']);
    });

    test('buildReport detects missing required keys and placeholders', () => {
        const report = buildReport({
            localEnv: {
                exists: true,
                values: {
                    MQTT_HOST: 'broker.local',
                    ADMIN_EMAIL: 'admin@example.com'
                }
            },
            exampleEnv: {
                exists: true,
                values: {
                    NODE_ENV: 'development',
                    PORT: '3001',
                    MQTT_PROTOCOL: 'mqtt',
                    PHONE_COUNTRY_CODE: '880',
                    DEVICE_SETUP_AP_IP: '192.168.4.1',
                    DEVICE_SETUP_AP_PREFIX: 'cfg',
                    SERIAL_BAUD: '115200'
                }
            },
            platform: 'linux',
            dashboardRootPath: '/tmp/dashboard'
        });

        expect(report.findings.find((item) => item.label === 'critical placeholder values').value).toBe('none');
        expect(report.findings.find((item) => item.label === 'placeholder values').value).toContain('ADMIN_EMAIL');
        expect(report.findings.find((item) => item.label === 'missing required keys').value).toContain('SESSION_SECRET');
        expect(report.findings.find((item) => item.label === 'missing required keys').value).toContain('MQTT_PORT');
        expect(report.checks.find((item) => item.label === 'hosted hotspot support').value).toBe('unsupported on this platform');
        expect(report.summary.status).toBe('error');
    });

    test('displayValue masks secrets and formatter keeps long labels separated', () => {
        expect(displayValue('MQTT_PASSWORD', 'secret')).toBe('********');
        expect(displayValue('MQTT_HOST', 'broker.local')).toBe('broker.local');

        const formatLabel = createLabelFormatter(['DASHBOARD_DEVICE_STATUS_REFRESH_MS']);
        expect(formatLabel('DASHBOARD_DEVICE_STATUS_REFRESH_MS')).toBe('DASHBOARD_DEVICE_STATUS_REFRESH_MS: ');
    });

    test('renderReport prints action when .env is missing', () => {
        const lines = [];
        renderReport({
            header: {
                dashboardRoot: '/tmp/dashboard',
                platform: 'win32',
                exampleFound: true,
                envFound: false
            },
            sections: [],
            checks: [],
            findings: [],
            notes: [],
            exitCode: 1
        }, (line) => lines.push(line));

        expect(lines.join('\n')).toContain('Copy dashboard/.env.example to dashboard/.env');
    });

    test('findPlaceholderWarnings returns sorted placeholder keys', () => {
        expect(findPlaceholderWarnings({
            ADMIN_EMAIL: 'admin@example.com',
            MQTT_PASSWORD: 'real-secret',
            SESSION_SECRET: 'change-this-value'
        })).toEqual(['ADMIN_EMAIL', 'SESSION_SECRET']);
    });

    test('categorizePlaceholderWarnings separates critical and informational placeholders', () => {
        expect(categorizePlaceholderWarnings({
            ADMIN_EMAIL: 'admin@example.com',
            SUPER_PASS: 'change-this-superadmin-password',
            MAPBOX_API_KEY: 'your-mapbox-key'
        })).toEqual({
            critical: ['SUPER_PASS'],
            informational: ['ADMIN_EMAIL', 'MAPBOX_API_KEY']
        });
    });

    test('determineExitCode only fails on critical placeholders in strict mode', () => {
        const warningReport = buildReport({
            localEnv: {
                exists: true,
                values: {
                    SESSION_SECRET: 'real-secret',
                    MQTT_HOST: 'broker.local',
                    MQTT_PORT: '1883',
                    SUPER_PASS: 'change-this-superadmin-password'
                }
            },
            exampleEnv: { exists: true, values: {} },
            platform: 'win32',
            dashboardRootPath: 'D:\\dashboard'
        });

        expect(warningReport.summary.status).toBe('warning');
        expect(determineExitCode(warningReport, { strict: false })).toBe(0);
        expect(determineExitCode(warningReport, { strict: true })).toBe(1);
    });
});
