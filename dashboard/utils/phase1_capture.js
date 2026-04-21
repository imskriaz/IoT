'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function parseArgs(argv) {
    const args = {
        baseUrl: 'http://127.0.0.1:3001',
        username: process.env.DASHBOARD_USERNAME || process.env.ADMIN_USERNAME || 'admin',
        password: process.env.DASHBOARD_PASSWORD || process.env.ADMIN_PASSWORD || 'admin123',
        deviceId: '',
        outDir: path.join(__dirname, '..', 'temp', 'phase1-captures'),
        label: '',
        note: '',
        quiet: false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];

        switch (arg) {
            case '--base-url':
                if (next) {
                    args.baseUrl = next;
                    i++;
                }
                break;
            case '--username':
                if (next) {
                    args.username = next;
                    i++;
                }
                break;
            case '--password':
                if (next) {
                    args.password = next;
                    i++;
                }
                break;
            case '--device':
            case '--device-id':
                if (next) {
                    args.deviceId = next;
                    i++;
                }
                break;
            case '--out-dir':
                if (next) {
                    args.outDir = next;
                    i++;
                }
                break;
            case '--label':
                if (next) {
                    args.label = next;
                    i++;
                }
                break;
            case '--note':
                if (next) {
                    args.note = next;
                    i++;
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
            'Phase 1 dashboard capture helper',
            '',
            'Usage:',
            '  node utils/phase1_capture.js [options]',
            '',
            'Options:',
            '  --base-url   Dashboard base URL (default: http://127.0.0.1:3001)',
            '  --username   Dashboard username (default: admin)',
            '  --password   Dashboard password (default: admin123)',
            '  --device     Device ID to capture (defaults to active device, then first listed device)',
            '  --out-dir    Output directory for JSON captures',
            '  --label      Optional short label stored in capture metadata and filename',
            '  --note       Optional free-form note stored in capture metadata',
            '  --quiet      Suppress normal stdout output',
            '  --help       Show this help text'
        ].join('\n') + '\n'
    );
}

function normalizeBaseUrl(value) {
    return String(value || '').replace(/\/+$/, '');
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

async function apiPost(client, url, payload) {
    const response = await client.post(url, payload, {
        validateStatus: () => true
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`POST ${url} failed with status ${response.status}`);
    }

    return response.data;
}

async function captureGet(client, url) {
    try {
        const response = await client.get(url, {
            validateStatus: () => true
        });

        return {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            data: response.data
        };
    } catch (error) {
        return {
            ok: false,
            status: 0,
            error: error.message
        };
    }
}

function chooseDeviceId(requestedDeviceId, activeResponse, devicesResponse) {
    const requested = String(requestedDeviceId || '').trim();
    if (requested) return requested;

    const active = String(activeResponse?.deviceId || '').trim();
    if (active) return active;

    const devices = Array.isArray(devicesResponse?.devices) ? devicesResponse.devices : [];
    const online = devices.find((device) => device?.online && device?.id);
    if (online) return String(online.id).trim();

    const first = devices.find((device) => device?.id);
    return first ? String(first.id).trim() : '';
}

function safeFileStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeFileSegment(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const result = await capturePhase1(args);
    if (!args.quiet) {
        process.stdout.write(`Saved Phase 1 capture to ${result.outputPath}\n`);
    }
}

async function capturePhase1(options = {}) {
    const args = {
        ...parseArgs([]),
        ...options
    };
    const baseUrl = normalizeBaseUrl(args.baseUrl);

    await fs.promises.mkdir(args.outDir, { recursive: true });

    const cookie = await login(baseUrl, args.username, args.password);
    const client = axios.create({
        baseURL: baseUrl,
        headers: {
            Cookie: cookie,
            Accept: 'application/json'
        },
        maxRedirects: 0
    });

    const [activeDevice, devices] = await Promise.all([
        apiGet(client, '/api/devices/active'),
        apiGet(client, '/api/devices')
    ]);

    const deviceId = chooseDeviceId(args.deviceId, activeDevice, devices);
    if (!deviceId) {
        throw new Error('No device ID available from arguments, active session, or /api/devices');
    }

    const listedDevices = Array.isArray(devices?.devices) ? devices.devices : [];
    const deviceIsListed = listedDevices.some((entry) => String(entry?.id || '').trim() === deviceId);

    if (deviceIsListed) {
        try {
            await apiPost(client, '/api/devices/active', { deviceId });
        } catch (error) {
            process.stderr.write(`Phase 1 capture note: unable to set active device to ${deviceId} (${error.message})\n`);
        }
    } else if (args.deviceId) {
        process.stderr.write(`Phase 1 capture note: ${deviceId} is not currently listed in /api/devices, so active-device persistence was skipped\n`);
    }

    const [status, specs, storageInfo, modemStatus, smsList] = await Promise.all([
        captureGet(client, `/api/status?deviceId=${encodeURIComponent(deviceId)}`),
        captureGet(client, `/api/devices/${encodeURIComponent(deviceId)}/specs`),
        captureGet(client, `/api/storage/info?deviceId=${encodeURIComponent(deviceId)}`),
        captureGet(client, `/api/modem/status?deviceId=${encodeURIComponent(deviceId)}`),
        captureGet(client, `/api/sms?deviceId=${encodeURIComponent(deviceId)}&limit=10`)
    ]);

    const capture = {
        capturedAt: new Date().toISOString(),
        baseUrl,
        deviceId,
        label: String(args.label || '').trim(),
        note: String(args.note || '').trim(),
        activeDevice,
        devices,
        captures: {
            status,
            specs,
            storageInfo,
            modemStatus,
            recentSms: smsList
        }
    };

    const labelSegment = sanitizeFileSegment(args.label);
    const fileName = labelSegment
        ? `phase1-capture-${deviceId}-${labelSegment}-${safeFileStamp()}.json`
        : `phase1-capture-${deviceId}-${safeFileStamp()}.json`;
    const outputPath = path.join(args.outDir, fileName);
    await fs.promises.writeFile(outputPath, JSON.stringify(capture, null, 2));

    return {
        outputPath,
        capture,
        baseUrl,
        deviceId,
        deviceIsListed,
        label: capture.label,
        note: capture.note
    };
}

module.exports = {
    capturePhase1,
    parseArgs,
    normalizeBaseUrl,
    sanitizeFileSegment
};

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`Phase 1 capture failed: ${error.message}\n`);
        process.exit(1);
    });
}
