'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const dashboardRoot = path.resolve(__dirname, '..');
const envPath = path.join(dashboardRoot, '.env');
const envExamplePath = path.join(dashboardRoot, '.env.example');
const MIN_LABEL_WIDTH = 32;

const PLACEHOLDER_PATTERNS = [
    /change-this/i,
    /your-/i,
    /example\.com/i,
    /your-mqtt-password/i
];

const RECOMMENDED_PRESENCE_KEYS = [
    'NODE_ENV',
    'PORT',
    'MQTT_PROTOCOL',
    'PHONE_COUNTRY_CODE',
    'DEVICE_SETUP_AP_IP',
    'DEVICE_SETUP_AP_PREFIX',
    'SERIAL_BAUD'
];

const SECRET_KEYS = Object.freeze([
    'SESSION_SECRET',
    'MQTT_PASSWORD',
    'ADMIN_PASSWORD',
    'SUPER_PASS',
    'EMAIL_PASS',
    'TELEGRAM_BOT_TOKEN',
    'FCM_SERVER_KEY',
    'FIREBASE_SERVER_KEY',
    'APNS_PRIVATE_KEY',
    'OTA_DOWNLOAD_SECRET',
    'WIFI_PASSWORD',
    'HOTSPOT_PASSWORD'
]);

const CRITICAL_PLACEHOLDER_KEYS = new Set([
    'SESSION_SECRET',
    'MQTT_PASSWORD',
    'ADMIN_PASSWORD',
    'SUPER_PASS'
]);

const REQUIRED_KEYS = Object.freeze([
    'SESSION_SECRET',
    'MQTT_HOST',
    'MQTT_PORT'
]);

const REPORT_SECTIONS = Object.freeze([
    {
        title: 'Core',
        keys: ['NODE_ENV', 'PORT', 'DB_PATH', 'TZ', 'LOG_LEVEL']
    },
    {
        title: 'MQTT',
        keys: ['MQTT_HOST', 'MQTT_PORT', 'MQTT_PROTOCOL', 'MQTT_USER', 'MQTT_PASSWORD', 'MQTT_CLIENT_ID']
    },
    {
        title: 'Device And Refresh',
        keys: ['DEVICE_ID', 'DEFAULT_DEVICE_ID', 'DASHBOARD_DEVICE_STATUS_REFRESH_MS', 'DEVICE_STATUS_AUTO_REFRESH_MS', 'PHONE_COUNTRY_CODE']
    },
    {
        title: 'Provisioning',
        keys: ['DEVICE_SETUP_AP_IP', 'DEVICE_SETUP_AP_PREFIX', 'DEVICE_BLE_NAME_PREFIXES', 'SERIAL_PORT', 'BLUETOOTH_SERIAL_PORT', 'SERIAL_BAUD', 'RUNTIME_CONFIG_WIFI_ENABLED', 'RUNTIME_CONFIG_WIFI_TIMEOUT_MS']
    }
]);

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return { exists: false, values: {} };
    }

    const content = fs.readFileSync(filePath, 'utf8');
    return {
        exists: true,
        values: dotenv.parse(content)
    };
}

function createLabelFormatter(labels = []) {
    const width = Math.max(
        MIN_LABEL_WIDTH,
        ...labels.map((label) => String(label).length + 2)
    );

    return (label) => `${label}: `.padEnd(width, ' ');
}

function maskValue(value) {
    if (!value) return '(empty)';
    return '********';
}

function displayValue(key, value, secretKeys = SECRET_KEYS) {
    const secrets = secretKeys instanceof Set ? secretKeys : new Set(secretKeys);
    if (secrets.has(key)) {
        return maskValue(value);
    }
    return value === '' ? '(empty)' : String(value);
}

function isPlaceholder(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return false;
    return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isTruthy(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function compareWithExample(localEnv, exampleEnv) {
    const missing = [];
    for (const key of RECOMMENDED_PRESENCE_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(exampleEnv, key)) {
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(localEnv, key)) {
            missing.push(key);
        }
    }
    return missing.sort();
}

function findMissingRequired(localEnvValues) {
    return REQUIRED_KEYS.filter((key) => {
        const value = localEnvValues[key];
        return value === undefined || String(value).trim() === '';
    });
}

function findPlaceholderWarnings(localEnvValues) {
    return Object.keys(localEnvValues)
        .filter((key) => isPlaceholder(localEnvValues[key]))
        .sort();
}

function categorizePlaceholderWarnings(localEnvValues) {
    const all = findPlaceholderWarnings(localEnvValues);
    return {
        critical: all.filter((key) => CRITICAL_PLACEHOLDER_KEYS.has(key)),
        informational: all.filter((key) => !CRITICAL_PLACEHOLDER_KEYS.has(key))
    };
}

function buildReport({
    localEnv,
    exampleEnv,
    platform = process.platform,
    dashboardRootPath = dashboardRoot
}) {
    const local = localEnv || { exists: false, values: {} };
    const example = exampleEnv || { exists: false, values: {} };
    const localValues = local.values || {};
    const secretKeys = new Set(SECRET_KEYS);

    const sections = REPORT_SECTIONS.map((section) => ({
        title: section.title,
        keys: section.keys,
        values: section.keys.map((key) => ({
            key,
            value: displayValue(
                key,
                Object.prototype.hasOwnProperty.call(localValues, key) ? localValues[key] : '',
                secretKeys
            )
        }))
    }));

    const checks = [
        {
            label: 'hosted hotspot support',
            value: platform === 'win32' ? 'available' : 'unsupported on this platform'
        },
        {
            label: 'serial bridge enabled',
            value: isTruthy(localValues.SERIAL_BRIDGE_ENABLED) ? 'true' : 'false'
        },
        {
            label: 'runtime wifi fallback',
            value: isTruthy(localValues.RUNTIME_CONFIG_WIFI_ENABLED) ? 'true' : 'false'
        }
    ];

    const missingRequired = findMissingRequired(localValues);
    const placeholderWarnings = categorizePlaceholderWarnings(localValues);
    const missingFromLocal = example.exists
        ? compareWithExample(localValues, example.values || {})
        : [];

    const summary = {
        missingRequiredCount: missingRequired.length,
        criticalPlaceholderCount: placeholderWarnings.critical.length,
        placeholderCount: placeholderWarnings.informational.length,
        missingFromLocalCount: missingFromLocal.length
    };

    summary.status = !local.exists || summary.missingRequiredCount
        ? 'error'
        : (summary.criticalPlaceholderCount || summary.placeholderCount || summary.missingFromLocalCount)
            ? 'warning'
            : 'ok';

    return {
        header: {
            dashboardRoot: dashboardRootPath,
            platform,
            exampleFound: example.exists,
            envFound: local.exists
        },
        summary,
        sections,
        checks,
        findings: [
            {
                label: 'missing required keys',
                value: missingRequired.length ? missingRequired.join(', ') : 'none'
            },
            {
                label: 'critical placeholder values',
                value: placeholderWarnings.critical.length ? placeholderWarnings.critical.join(', ') : 'none'
            },
            {
                label: 'placeholder values',
                value: placeholderWarnings.informational.length ? placeholderWarnings.informational.join(', ') : 'none detected'
            },
            {
                label: 'missing from local .env',
                value: missingFromLocal.length ? missingFromLocal.join(', ') : 'none'
            }
        ],
        notes: [
            'dashboard/.env is for the dashboard process only.',
            'Wi-Fi, APN, and device MQTT runtime credentials belong to device runtime config, not repo-tracked env files.',
            'Use npm run env:check after editing dashboard/.env or moving machines.'
        ]
    };
}

function determineExitCode(report, { strict = false } = {}) {
    if (!report?.header?.envFound) {
        return 1;
    }

    if ((report.summary?.missingRequiredCount || 0) > 0) {
        return 1;
    }

    if (strict && (report.summary?.criticalPlaceholderCount || 0) > 0) {
        return 1;
    }

    return 0;
}

function printSection(title, writeLine) {
    writeLine('');
    writeLine(title);
}

function renderNamedRows(rows, writeLine) {
    const formatLabel = createLabelFormatter(rows.map((row) => row.label));
    for (const row of rows) {
        writeLine(`  ${formatLabel(row.label)}${row.value}`);
    }
}

function renderReport(report, writeLine = console.log) {
    writeLine('IoT dashboard environment check');
    writeLine(`Dashboard root             ${report.header.dashboardRoot}`);
    writeLine(`Platform                   ${report.header.platform}`);
    writeLine(`.env.example               ${report.header.exampleFound ? 'found' : 'missing'}`);
    writeLine(`.env                       ${report.header.envFound ? 'found' : 'missing'}`);
    writeLine(`Status                     ${report.summary?.status || 'unknown'}`);

    if (!report.header.envFound) {
        writeLine('');
        writeLine('Action');
        writeLine('  Copy dashboard/.env.example to dashboard/.env before running the dashboard.');
        return;
    }

    for (const section of report.sections) {
        printSection(section.title, writeLine);
        renderNamedRows(
            section.values.map((entry) => ({ label: entry.key, value: entry.value })),
            writeLine
        );
    }

    printSection('Checks', writeLine);
    renderNamedRows(report.checks, writeLine);

    printSection('Findings', writeLine);
    renderNamedRows(report.findings, writeLine);

    printSection('Notes', writeLine);
    for (const note of report.notes) {
        writeLine(`  ${note}`);
    }
}

function main() {
    const strict = process.argv.includes('--strict');
    const localEnv = loadEnvFile(envPath);
    const exampleEnv = loadEnvFile(envExamplePath);

    dotenv.config({ path: envPath, override: false });

    const report = buildReport({
        localEnv,
        exampleEnv,
        platform: process.platform,
        dashboardRootPath: dashboardRoot
    });

    renderReport(report);
    process.exitCode = determineExitCode(report, { strict });
}

module.exports = {
    SECRET_KEYS,
    REQUIRED_KEYS,
    RECOMMENDED_PRESENCE_KEYS,
    buildReport,
    categorizePlaceholderWarnings,
    compareWithExample,
    createLabelFormatter,
    determineExitCode,
    displayValue,
    findMissingRequired,
    findPlaceholderWarnings,
    isPlaceholder,
    isTruthy,
    loadEnvFile,
    renderReport
};

if (require.main === module) {
    main();
}
