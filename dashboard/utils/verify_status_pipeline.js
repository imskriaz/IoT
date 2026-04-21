'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const { normalizeBaseUrl } = require('./phase1_capture');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function parseArgs(argv) {
    const args = {
        baseUrl: 'http://127.0.0.1:3001',
        username: process.env.DASHBOARD_USERNAME || process.env.ADMIN_USERNAME || 'admin',
        password: process.env.DASHBOARD_PASSWORD || process.env.ADMIN_PASSWORD || 'admin123',
        deviceId: '',
        payload: '',
        payloadDir: path.join(__dirname, '..', 'temp', 'status-captures'),
        quiet: false
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];

        switch (arg) {
            case '--base-url':
                if (next) {
                    args.baseUrl = next;
                    i += 1;
                }
                break;
            case '--username':
                if (next) {
                    args.username = next;
                    i += 1;
                }
                break;
            case '--password':
                if (next) {
                    args.password = next;
                    i += 1;
                }
                break;
            case '--device':
            case '--device-id':
                if (next) {
                    args.deviceId = next;
                    i += 1;
                }
                break;
            case '--payload':
                if (next) {
                    args.payload = next;
                    i += 1;
                }
                break;
            case '--payload-dir':
                if (next) {
                    args.payloadDir = next;
                    i += 1;
                }
                break;
            case '--quiet':
                args.quiet = true;
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
                break;
            default:
                break;
        }
    }

    return args;
}

function printHelp() {
    process.stdout.write(
        [
            'Dashboard status pipeline verifier',
            '',
            'Usage:',
            '  node utils/verify_status_pipeline.js --device ws-a7670e-476178',
            '',
            'Options:',
            '  --base-url     Dashboard base URL (default: http://127.0.0.1:3001)',
            '  --username     Dashboard username (default: admin)',
            '  --password     Dashboard password (default: admin123)',
            '  --device       Device ID override; otherwise inferred from payload',
            '  --payload      Path to saved MQTT status payload JSON',
            '  --payload-dir  Directory searched when --payload is omitted',
            '  --quiet        Suppress normal stdout output',
            '  --help         Show this help text'
        ].join('\n') + '\n'
    );
}

function buildCookieHeader(setCookieHeaders = []) {
    return setCookieHeaders
        .map((entry) => String(entry || '').split(';')[0].trim())
        .filter(Boolean)
        .join('; ');
}

async function login(baseUrl, username, password) {
    const body = new URLSearchParams({
        username: String(username || ''),
        password: String(password || '')
    }).toString();

    const response = await axios.post(`${baseUrl}/auth/login`, body, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        maxRedirects: 0,
        validateStatus: () => true
    });

    const cookieHeader = buildCookieHeader(response.headers['set-cookie'] || []);
    if (!cookieHeader) {
        throw new Error(`Login failed with status ${response.status}; no session cookie returned`);
    }

    return cookieHeader;
}

async function apiGet(client, url) {
    const response = await client.get(url, {
        validateStatus: () => true
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`GET ${url} failed with status ${response.status}`);
    }

    return response.data;
}

function toNumberOrNull(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function roundTemperature(value) {
    const numeric = toNumberOrNull(value);
    return numeric === null ? null : Math.round(numeric * 10) / 10;
}

function parseModemSignalPercent(rawSignal) {
    const raw = parseInt(rawSignal, 10);
    if (Number.isNaN(raw) || raw === 99 || raw < 0) {
        return null;
    }

    const clamped = Math.min(31, Math.max(0, raw));
    const dbm = (clamped * 2) - 113;
    return Math.min(100, Math.max(0, Math.round(((dbm + 113) / 62) * 100)));
}

function parseWifiSignalPercent(rssi) {
    const raw = parseInt(rssi, 10);
    if (Number.isNaN(raw)) {
        return null;
    }

    return Math.min(100, Math.max(0, Math.round((raw + 100) * 2)));
}

function readPayloadFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveLatestPayload(payloadDir) {
    const entries = fs.readdirSync(payloadDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .map((entry) => {
            const absolutePath = path.join(payloadDir, entry.name);
            const stat = fs.statSync(absolutePath);
            return {
                absolutePath,
                mtimeMs: stat.mtimeMs
            };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (!entries.length) {
        throw new Error(`No payload JSON files found in ${payloadDir}`);
    }

    return entries[0].absolutePath;
}

function compareField(mismatches, label, actual, expected) {
    if (expected === null || expected === undefined || expected === '') {
        return;
    }

    if (actual !== expected) {
        mismatches.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function compareStatusPipeline(payload, apiStatus) {
    const data = apiStatus?.data || apiStatus || {};
    const mismatches = [];
    const checks = [];

    const deviceId = String(payload?.device_id || '').trim();
    const activePath = String(payload?.active_path || '').trim().toLowerCase() || null;
    const wifiConnected = payload?.wifi_connected === true;
    const wifiActive = activePath === 'wifi' || wifiConnected;
    const operator = String(payload?.modem_operator_name || payload?.modem_operator || '').trim() || null;
    const payloadVoltage = toNumberOrNull(payload?.voltage_mV ?? payload?.voltageMv);
    const payloadBattery = toNumberOrNull(payload?.battery);
    const payloadTemperature = roundTemperature(payload?.temperature);
    const payloadImei = String(payload?.imei || '').trim() || null;
    const payloadWifiRssi = toNumberOrNull(payload?.wifi_rssi);
    const payloadWifiSignal = wifiActive ? parseWifiSignalPercent(payloadWifiRssi) : null;
    const payloadCellularSignal = parseModemSignalPercent(payload?.modem_signal);
    const payloadIp = activePath === 'wifi'
        ? String(payload?.wifi_ip_address || '').trim()
        : String(payload?.modem_ip_address || payload?.modem_data_ip || '').trim();

    checks.push('activePath');
    compareField(mismatches, 'activePath', data.activePath ?? null, activePath);

    checks.push('imei');
    compareField(mismatches, 'imei', data.imei ?? null, payloadImei);

    checks.push('battery');
    compareField(
        mismatches,
        'battery',
        toNumberOrNull(data.battery),
        payloadBattery === null ? null : Math.round(payloadBattery)
    );

    checks.push('voltageMv');
    compareField(mismatches, 'voltageMv', toNumberOrNull(data.voltageMv), payloadVoltage);

    checks.push('temperature');
    compareField(mismatches, 'temperature', roundTemperature(data.temperature), payloadTemperature);

    checks.push('operator');
    compareField(mismatches, 'operator', data.operator ?? null, operator);

    checks.push('ip');
    compareField(mismatches, 'ip', data.ip ?? null, payloadIp || null);

    checks.push('wifi.ssid');
    compareField(mismatches, 'wifi.ssid', data?.wifi?.ssid ?? null, payload?.wifi_ssid || null);

    checks.push('wifi.ipAddress');
    compareField(mismatches, 'wifi.ipAddress', data?.wifi?.ipAddress ?? null, payload?.wifi_ip_address || null);

    checks.push('wifi.rssi');
    compareField(mismatches, 'wifi.rssi', toNumberOrNull(data?.wifi?.rssi), payloadWifiRssi);

    checks.push('wifiSignal');
    compareField(
        mismatches,
        'wifiSignal',
        wifiActive ? toNumberOrNull(data.wifiSignal) : null,
        payloadWifiSignal
    );

    checks.push('cellularSignal');
    compareField(mismatches, 'cellularSignal', toNumberOrNull(data.cellularSignal), payloadCellularSignal);

    checks.push('storage.queueDepth');
    compareField(
        mismatches,
        'storage.queueDepth',
        toNumberOrNull(data?.storage?.queueDepth),
        toNumberOrNull(payload?.storage_queue_depth)
    );

    checks.push('storage.mediaAvailable');
    if (typeof payload?.storage_media_available === 'boolean') {
        compareField(
            mismatches,
            'storage.mediaAvailable',
            Boolean(data?.storage?.mediaAvailable),
            payload.storage_media_available
        );
    }

    checks.push('taskCount');
    compareField(
        mismatches,
        'taskCount',
        toNumberOrNull(data?.taskCount),
        toNumberOrNull(payload?.task_count)
    );

    checks.push('missingTaskCount');
    compareField(
        mismatches,
        'missingTaskCount',
        toNumberOrNull(data?.missingTaskCount),
        toNumberOrNull(payload?.missing_task_count)
    );

    if (typeof payload?.health_degraded === 'boolean') {
        checks.push('healthDegraded');
        compareField(
            mismatches,
            'healthDegraded',
            typeof data?.healthDegraded === 'boolean' ? data.healthDegraded : null,
            payload.health_degraded
        );
    }

    checks.push('degradedModuleCount');
    compareField(
        mismatches,
        'degradedModuleCount',
        toNumberOrNull(data?.degradedModuleCount),
        toNumberOrNull(payload?.degraded_module_count)
    );

    checks.push('failedModuleCount');
    compareField(
        mismatches,
        'failedModuleCount',
        toNumberOrNull(data?.failedModuleCount),
        toNumberOrNull(payload?.failed_module_count)
    );

    checks.push('healthLastReason');
    compareField(
        mismatches,
        'healthLastReason',
        data?.healthLastReason ?? null,
        payload?.health_last_reason || null
    );

    return {
        ok: mismatches.length === 0,
        deviceId,
        checks,
        mismatches
    };
}

async function verifyStatusPipeline(options = {}) {
    const args = {
        ...parseArgs([]),
        ...options
    };
    const baseUrl = normalizeBaseUrl(args.baseUrl);
    const payloadPath = args.payload ? path.resolve(args.payload) : resolveLatestPayload(args.payloadDir);
    const payload = readPayloadFile(payloadPath);
    const deviceId = String(args.deviceId || payload?.device_id || '').trim();

    if (!deviceId) {
        throw new Error('No device ID available from arguments or payload');
    }

    const cookie = await login(baseUrl, args.username, args.password);
    const client = axios.create({
        baseURL: baseUrl,
        headers: {
            Cookie: cookie,
            Accept: 'application/json'
        },
        maxRedirects: 0
    });

    const statusResponse = await apiGet(client, `/api/status?deviceId=${encodeURIComponent(deviceId)}`);
    const comparison = compareStatusPipeline(payload, statusResponse.data);

    return {
        payloadPath,
        deviceId,
        statusResponse,
        comparison
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const result = await verifyStatusPipeline(args);

    if (!args.quiet) {
        process.stdout.write(`Payload: ${result.payloadPath}\n`);
        process.stdout.write(`Device: ${result.deviceId}\n`);
        process.stdout.write(`Checks: ${result.comparison.checks.join(', ')}\n`);
        if (result.comparison.ok) {
            process.stdout.write('PIPELINE OK\n');
        } else {
            process.stdout.write('PIPELINE MISMATCH\n');
            result.comparison.mismatches.forEach((entry) => {
                process.stdout.write(`- ${entry}\n`);
            });
        }
    }

    if (!result.comparison.ok) {
        process.exitCode = 1;
    }
}

module.exports = {
    compareStatusPipeline,
    parseArgs,
    parseModemSignalPercent,
    parseWifiSignalPercent,
    resolveLatestPayload,
    verifyStatusPipeline
};

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    });
}
