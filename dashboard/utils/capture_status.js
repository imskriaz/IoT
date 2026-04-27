'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mqtt = require('mqtt');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function parseArgs(argv) {
    const args = {
        host: process.env.MQTT_HOST || '127.0.0.1',
        port: Number(process.env.MQTT_PORT || 1883),
        username: process.env.MQTT_USER || '',
        password: process.env.MQTT_PASSWORD || '',
        protocol: 'mqtt',
        deviceId: process.env.DEVICE_ID || '',
        topic: '',
        timeoutMs: 30000,
        outDir: path.join(__dirname, '..', 'temp', 'status-captures'),
        quiet: false,
        validate: true
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];

        switch (arg) {
            case '--host':
                if (next) {
                    args.host = next;
                    i += 1;
                }
                break;
            case '--port':
                if (next) {
                    args.port = Number(next);
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
            case '--protocol':
                if (next) {
                    args.protocol = next;
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
            case '--topic':
                if (next) {
                    args.topic = next;
                    i += 1;
                }
                break;
            case '--timeout-ms':
                if (next) {
                    args.timeoutMs = Number(next);
                    i += 1;
                }
                break;
            case '--out-dir':
                if (next) {
                    args.outDir = next;
                    i += 1;
                }
                break;
            case '--no-validate':
                args.validate = false;
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

    if (!args.topic) {
        const deviceId = String(args.deviceId || '').trim();
        args.topic = deviceId ? `device/${deviceId}/status` : '';
    }

    return args;
}

function printHelp() {
    process.stdout.write(
        [
            'MQTT device_status capture helper',
            '',
            'Usage:',
            '  node utils/capture_status.js --device ws-a7670e-476178',
            '',
            'Options:',
            '  --device       Device ID; builds topic as device/{deviceId}/status',
            '  --topic        Full MQTT topic override',
            '  --host         MQTT host (default: MQTT_HOST from dashboard/.env)',
            '  --port         MQTT port (default: MQTT_PORT from dashboard/.env)',
            '  --username     MQTT username',
            '  --password     MQTT password',
            '  --protocol     mqtt or mqtts (default: mqtt)',
            '  --timeout-ms   Timeout waiting for first payload (default: 30000)',
            '  --out-dir      Directory to save captured payload JSON',
            '  --no-validate  Skip firmware payload verification',
            '  --quiet        Suppress normal stdout output',
            '  --help         Show this help text'
        ].join('\n') + '\n'
    );
}

function sanitizeFileSegment(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function fileStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function getVerifierPath() {
    const candidates = [
        path.join(
            __dirname,
            '..',
            '..',
            'firmware',
            'espidf',
            'esp32-s3-a7670e',
            'verify-status-payload.js'
        ),
        path.join(
            __dirname,
            '..',
            '..',
            'firmware',
            'esp32-s3-a7670e',
            'espidf',
            'verify-status-payload.js'
        )
    ];

    return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function validatePayload(savedPath) {
    const verifier = getVerifierPath();

    if (!fs.existsSync(verifier)) {
        return { skipped: true, message: `verifier not found at ${verifier}` };
    }

    const result = spawnSync(process.execPath, [verifier, savedPath], {
        encoding: 'utf8'
    });

    return {
        skipped: false,
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || ''
    };
}

async function captureStatus(options = {}) {
    const args = { ...parseArgs([]), ...options };

    if (!args.topic) {
        throw new Error('missing MQTT topic; pass --device or --topic');
    }

    fs.mkdirSync(args.outDir, { recursive: true });

    const brokerUrl = `${args.protocol}://${args.host}:${args.port}`;
    const client = mqtt.connect(brokerUrl, {
        username: args.username || undefined,
        password: args.password || undefined,
        reconnectPeriod: 0,
        connectTimeout: Math.min(args.timeoutMs, 15000)
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;

        function finishError(error) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try { client.end(true); } catch (_) {}
            reject(error);
        }

        function finishSuccess(result) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try { client.end(true); } catch (_) {}
            resolve(result);
        }

        timer = setTimeout(() => {
            finishError(new Error(`timed out after ${args.timeoutMs}ms waiting for ${args.topic}`));
        }, args.timeoutMs);

        client.once('error', finishError);

        client.once('connect', () => {
            client.subscribe(args.topic, { qos: 0 }, (error) => {
                if (error) {
                    finishError(error);
                }
            });
        });

        client.on('message', (topic, payloadBuffer) => {
            const raw = payloadBuffer.toString('utf8');
            let parsed = null;

            try {
                parsed = JSON.parse(raw);
            } catch (error) {
                finishError(new Error(`received non-JSON payload on ${topic}: ${error.message}`));
                return;
            }

            const label = sanitizeFileSegment(args.deviceId || topic) || 'status';
            const outputPath = path.join(args.outDir, `${fileStamp()}_${label}.json`);
            fs.writeFileSync(outputPath, JSON.stringify(parsed, null, 2));

            const result = {
                topic,
                payload: parsed,
                outputPath
            };

            if (args.validate) {
                result.validation = validatePayload(outputPath);
            }

            finishSuccess(result);
        });
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const result = await captureStatus(args);

    if (!args.quiet) {
        process.stdout.write(`Captured ${result.topic}\n`);
        process.stdout.write(`Saved payload to ${result.outputPath}\n`);
        if (result.validation) {
            if (result.validation.skipped) {
                process.stdout.write(`Validation skipped: ${result.validation.message}\n`);
            } else {
                process.stdout.write(result.validation.stdout || result.validation.stderr || '');
            }
        }
    }
}

module.exports = {
    captureStatus,
    parseArgs
};

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    });
}
