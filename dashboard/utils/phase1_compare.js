'use strict';

const fs = require('fs');
const path = require('path');

function sanitizeFileSegment(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function parseArgs(argv) {
    const args = {
        from: '',
        to: '',
        deviceId: '',
        label: '',
        dir: path.join(__dirname, '..', 'temp', 'phase1-captures'),
        outDir: path.join(__dirname, '..', 'temp', 'phase1-reports'),
        save: false,
        saveJson: false,
        failOnWarning: false,
        quiet: false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];

        switch (arg) {
            case '--from':
                if (next) {
                    args.from = next;
                    i++;
                }
                break;
            case '--to':
                if (next) {
                    args.to = next;
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
            case '--label':
                if (next) {
                    args.label = next;
                    i++;
                }
                break;
            case '--dir':
                if (next) {
                    args.dir = next;
                    i++;
                }
                break;
            case '--out-dir':
                if (next) {
                    args.outDir = next;
                    i++;
                }
                break;
            case '--save':
                args.save = true;
                break;
            case '--save-json':
                args.saveJson = true;
                break;
            case '--fail-on-warning':
                args.failOnWarning = true;
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
            'Phase 1 dashboard capture compare helper',
            '',
            'Usage:',
            '  node utils/phase1_compare.js [options]',
            '',
            'Options:',
            '  --from   Older capture JSON file',
            '  --to     Newer capture JSON file',
            '  --device Only consider captures for this device when auto-selecting files',
            '  --label  Only consider captures whose label starts with this text when auto-selecting files',
            '  --dir    Capture directory used when --from/--to are omitted',
            '  --out-dir  Report directory used when --save is set',
            '  --save   Write the report to a timestamped .md file as well as stdout',
            '  --save-json  Write structured compare analysis to a timestamped .json file',
            '  --fail-on-warning  Exit with status 2 when compare warnings are present',
            '  --quiet  Suppress normal stdout output',
            '  --help   Show this help text',
            '',
            'If --from and --to are omitted, the two newest files in the capture directory are used.'
        ].join('\n') + '\n'
    );
}

function getLatestCapturePair(dir, deviceId = '', label = '') {
    const normalizedDeviceId = String(deviceId || '').trim();
    const normalizedLabel = String(label || '').trim().toLowerCase();
    const files = fs.readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.json'))
        .map((name) => ({
            name,
            fullPath: path.join(dir, name),
            stat: fs.statSync(path.join(dir, name))
        }))
        .filter((entry) => {
            const capture = readJson(entry.fullPath);

            if (normalizedDeviceId && String(capture?.deviceId || '').trim() !== normalizedDeviceId) {
                return false;
            }

            if (normalizedLabel) {
                const captureLabel = String(capture?.label || '').trim().toLowerCase();
                if (!captureLabel.startsWith(normalizedLabel)) {
                    return false;
                }
            }

            return true;
        })
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    if (files.length < 2) {
        const scopes = [];
        if (normalizedDeviceId) {
            scopes.push(`device ${normalizedDeviceId}`);
        }
        if (normalizedLabel) {
            scopes.push(`label ${normalizedLabel}`);
        }
        const scope = scopes.length > 0 ? ` for ${scopes.join(' and ')}` : '';
        throw new Error(`Need at least two capture files in ${dir}${scope}`);
    }

    return {
        from: files[1].fullPath,
        to: files[0].fullPath
    };
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeFileStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function captureNode(capture, key) {
    return capture?.captures?.[key] || null;
}

function captureData(capture, key) {
    return captureNode(capture, key)?.data || null;
}

function statusPayload(capture) {
    return captureData(capture, 'status')?.data || null;
}

function smsPayload(capture) {
    return captureData(capture, 'recentSms') || null;
}

function deviceList(capture) {
    return Array.isArray(captureData(capture, 'devices')?.devices)
        ? captureData(capture, 'devices').devices
        : Array.isArray(capture?.devices?.devices)
            ? capture.devices.devices
            : [];
}

function fmt(value, fallback = '-') {
    if (value == null || value === '') return fallback;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function fmtBool(value) {
    return value == null ? '-' : (value ? 'yes' : 'no');
}

function fmtChange(before, after, fallback = '-') {
    return `${fmt(before, fallback)} -> ${fmt(after, fallback)}`;
}

function fmtNumberDelta(before, after) {
    const a = Number(before);
    const b = Number(after);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return `${fmt(before)} -> ${fmt(after)}`;
    }
    const delta = b - a;
    const suffix = delta === 0 ? ' (delta 0)' : ` (delta ${delta > 0 ? '+' : ''}${delta})`;
    return `${a} -> ${b}${suffix}`;
}

function countSmsByType(payload, type) {
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    return rows.filter((row) => String(row?.type || '').trim().toLowerCase() === type).length;
}

function findListedDevice(capture, deviceId) {
    return deviceList(capture).find((entry) => String(entry?.id || '').trim() === String(deviceId || '').trim()) || null;
}

function analyzeCaptures(fromCapture, toCapture) {
    const fromStatus = statusPayload(fromCapture) || {};
    const toStatus = statusPayload(toCapture) || {};
    const fromDeviceId = String(fromCapture?.deviceId || '').trim();
    const toDeviceId = String(toCapture?.deviceId || '').trim();
    const deviceId = toDeviceId || fromDeviceId || '';
    const fromListed = findListedDevice(fromCapture, deviceId);
    const toListed = findListedDevice(toCapture, deviceId);
    const fromSms = smsPayload(fromCapture);
    const toSms = smsPayload(toCapture);
    const fromAt = new Date(fromCapture.capturedAt);
    const toAt = new Date(toCapture.capturedAt);
    const durationMs = Math.max(0, toAt.getTime() - fromAt.getTime());
    const durationMinutes = Math.round(durationMs / 60000);

    const warnings = [];
    if (!toStatus.online) warnings.push('device is offline in the newer capture');
    if (toStatus.activePath === 'wifi' && !toStatus.wifi?.connected) warnings.push('active path is Wi-Fi but Wi-Fi is not connected');
    if (toStatus.mqtt?.connected && !toStatus.mqtt?.subscribed) warnings.push('MQTT is connected but not subscribed');
    if (Number(toStatus.mqtt?.publishFailures || 0) > Number(fromStatus.mqtt?.publishFailures || 0)) warnings.push('MQTT publish failure count increased');
    if (Number(toStatus.storage?.queueDepth || 0) > Number(fromStatus.storage?.queueDepth || 0)) warnings.push('storage queue depth increased');
    if (Number(toStatus.storage?.dropped || 0) > Number(fromStatus.storage?.dropped || 0)) warnings.push('storage dropped count increased');
    if (toStatus.sync?.inSync === false) warnings.push('device reports sync drift');
    if (toStatus.systemRuntime?.rebootReason && fromStatus.systemRuntime?.rebootReason && toStatus.systemRuntime.rebootReason !== fromStatus.systemRuntime.rebootReason) warnings.push('reboot reason changed between captures');

    return {
        deviceId,
        durationMinutes,
        warnings,
        warningCount: warnings.length,
        status: warnings.length > 0 ? 'attention' : 'ok',
        fromLabel: String(fromCapture?.label || '').trim(),
        toLabel: String(toCapture?.label || '').trim(),
        fromNote: String(fromCapture?.note || '').trim(),
        toNote: String(toCapture?.note || '').trim(),
        fromCapture,
        toCapture,
        fromStatus,
        toStatus,
        fromListed: Boolean(fromListed),
        toListed: Boolean(toListed),
        fromSms,
        toSms
    };
}

function summarize(fromCapture, toCapture) {
    const analysis = analyzeCaptures(fromCapture, toCapture);
    const {
        deviceId,
        durationMinutes,
        warnings,
        fromLabel,
        toLabel,
        fromNote,
        toNote,
        fromCapture: fromData,
        toCapture: toData,
        fromStatus,
        toStatus,
        fromListed,
        toListed,
        fromSms,
        toSms
    } = analysis;

    const lines = [];
    lines.push('# Phase 1 Capture Compare');
    lines.push('');
    lines.push(`Device: ${fmt(deviceId, '(none)')}`);
    lines.push(`From: ${fmt(fromData.capturedAt)}`);
    if (fromLabel) {
        lines.push(`From label: ${fromLabel}`);
    }
    if (fromNote) {
        lines.push(`From note: ${fromNote}`);
    }
    lines.push(`To: ${fmt(toData.capturedAt)}`);
    if (toLabel) {
        lines.push(`To label: ${toLabel}`);
    }
    if (toNote) {
        lines.push(`To note: ${toNote}`);
    }
    lines.push(`Elapsed: ${durationMinutes} minute(s)`);
    lines.push(`Status: ${analysis.status}`);
    lines.push(`Warnings: ${analysis.warningCount}`);
    lines.push('');
    lines.push('## Presence');
    lines.push(`- Listed in /api/devices: ${fmtBool(fromListed)} -> ${fmtBool(toListed)}`);
    lines.push(`- Online: ${fmtBool(fromStatus.online)} -> ${fmtBool(toStatus.online)}`);
    lines.push(`- Active path: ${fmtChange(fromStatus.activePath, toStatus.activePath)}`);
    lines.push('');
    lines.push('## Wi-Fi');
    lines.push(`- Connected: ${fmtBool(fromStatus.wifi?.connected)} -> ${fmtBool(toStatus.wifi?.connected)}`);
    lines.push(`- SSID: ${fmtChange(fromStatus.wifi?.ssid, toStatus.wifi?.ssid)}`);
    lines.push(`- IP: ${fmtChange(fromStatus.wifi?.ipAddress, toStatus.wifi?.ipAddress)}`);
    lines.push(`- RSSI: ${fmtChange(fromStatus.wifi?.rssi, toStatus.wifi?.rssi)}`);
    lines.push('');
    lines.push('## MQTT / Sync');
    lines.push(`- MQTT connected: ${fmtBool(fromStatus.mqtt?.connected)} -> ${fmtBool(toStatus.mqtt?.connected)}`);
    lines.push(`- MQTT subscribed: ${fmtBool(fromStatus.mqtt?.subscribed)} -> ${fmtBool(toStatus.mqtt?.subscribed)}`);
    lines.push(`- MQTT reconnect count: ${fmtNumberDelta(fromStatus.mqtt?.reconnectCount, toStatus.mqtt?.reconnectCount)}`);
    lines.push(`- MQTT published count: ${fmtNumberDelta(fromStatus.mqtt?.publishedCount, toStatus.mqtt?.publishedCount)}`);
    lines.push(`- MQTT publish failures: ${fmtNumberDelta(fromStatus.mqtt?.publishFailures, toStatus.mqtt?.publishFailures)}`);
    lines.push(`- In sync: ${fmtBool(fromStatus.sync?.inSync)} -> ${fmtBool(toStatus.sync?.inSync)}`);
    lines.push(`- Dashboard ack age ms: ${fmtNumberDelta(fromStatus.sync?.dashboardAckAgeMs, toStatus.sync?.dashboardAckAgeMs)}`);
    lines.push(`- Desired/applied version: ${fmt(fromStatus.sync?.desiredVersion)}/${fmt(fromStatus.sync?.appliedVersion)} -> ${fmt(toStatus.sync?.desiredVersion)}/${fmt(toStatus.sync?.appliedVersion)}`);
    lines.push('');
    lines.push('## Storage / Runtime');
    lines.push(`- Storage mounted: ${fmtBool(fromStatus.storage?.mounted)} -> ${fmtBool(toStatus.storage?.mounted)}`);
    lines.push(`- Storage queue depth: ${fmtNumberDelta(fromStatus.storage?.queueDepth, toStatus.storage?.queueDepth)}`);
    lines.push(`- Storage dropped count: ${fmtNumberDelta(fromStatus.storage?.dropped, toStatus.storage?.dropped)}`);
    lines.push(`- Heap bytes: ${fmtNumberDelta(fromStatus.systemRuntime?.freeHeap, toStatus.systemRuntime?.freeHeap)}`);
    lines.push(`- PSRAM bytes: ${fmtNumberDelta(fromStatus.systemRuntime?.freePsram, toStatus.systemRuntime?.freePsram)}`);
    lines.push(`- Largest free block: ${fmtNumberDelta(fromStatus.systemRuntime?.largestFreeBlock, toStatus.systemRuntime?.largestFreeBlock)}`);
    lines.push(`- Reboot reason: ${fmtChange(fromStatus.systemRuntime?.rebootReason, toStatus.systemRuntime?.rebootReason)}`);
    lines.push(`- Degraded reason: ${fmtChange(fromStatus.systemRuntime?.degradedReason, toStatus.systemRuntime?.degradedReason)}`);
    lines.push('');
    lines.push('## SMS Snapshot');
    lines.push(`- Recent rows returned: ${fmtNumberDelta(Array.isArray(fromSms?.data) ? fromSms.data.length : null, Array.isArray(toSms?.data) ? toSms.data.length : null)}`);
    lines.push(`- Incoming rows in recent window: ${fmtNumberDelta(countSmsByType(fromSms, 'incoming'), countSmsByType(toSms, 'incoming'))}`);
    lines.push(`- Outgoing rows in recent window: ${fmtNumberDelta(countSmsByType(fromSms, 'outgoing'), countSmsByType(toSms, 'outgoing'))}`);

    lines.push('');
    lines.push('## Warnings');
    if (warnings.length === 0) {
        lines.push('- none');
    } else {
        for (const warning of warnings) {
            lines.push(`- ${warning}`);
        }
    }

    return lines.join('\n') + '\n';
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const result = comparePhase1(args);
    if (!args.quiet && result.outputPath) {
        process.stdout.write(`Saved compare report to ${result.outputPath}\n\n`);
    }
    if (!args.quiet && result.jsonOutputPath) {
        process.stdout.write(`Saved compare analysis to ${result.jsonOutputPath}\n\n`);
    }
    if (!args.quiet) {
        process.stdout.write(result.report);
    }
    if (args.failOnWarning && result.warningCount > 0) {
        process.exitCode = 2;
    }
}

function comparePhase1(options = {}) {
    const args = {
        ...parseArgs([]),
        ...options
    };
    let fromPath = args.from;
    let toPath = args.to;

    if (!fromPath || !toPath) {
        const pair = getLatestCapturePair(args.dir, args.deviceId, args.label);
        fromPath = fromPath || pair.from;
        toPath = toPath || pair.to;
    }

    const fromCapture = readJson(fromPath);
    const toCapture = readJson(toPath);
    const analysis = analyzeCaptures(fromCapture, toCapture);
    const report = summarize(fromCapture, toCapture);
    let outputPath = '';
    let jsonOutputPath = '';
    const stamp = safeFileStamp();
    const outputDeviceId = String(toCapture?.deviceId || fromCapture?.deviceId || 'unknown-device').trim() || 'unknown-device';
    const labelSegment = sanitizeFileSegment(args.label);
    const outputBaseName = labelSegment
        ? `phase1-compare-${outputDeviceId}-${labelSegment}-${stamp}`
        : `phase1-compare-${outputDeviceId}-${stamp}`;

    if (args.save || args.saveJson) {
        fs.mkdirSync(args.outDir, { recursive: true });
    }

    if (args.save) {
        outputPath = path.join(args.outDir, `${outputBaseName}.md`);
        fs.writeFileSync(outputPath, report, 'utf8');
    }

    if (args.saveJson) {
        jsonOutputPath = path.join(args.outDir, `${outputBaseName}.json`);
        fs.writeFileSync(jsonOutputPath, JSON.stringify({
            generatedAt: new Date().toISOString(),
            deviceId: analysis.deviceId,
            status: analysis.status,
            warningCount: analysis.warningCount,
            warnings: analysis.warnings,
            durationMinutes: analysis.durationMinutes,
            fromLabel: analysis.fromLabel,
            toLabel: analysis.toLabel,
            fromNote: analysis.fromNote,
            toNote: analysis.toNote,
            fromPath,
            toPath,
            fromCapturedAt: fromCapture?.capturedAt || '',
            toCapturedAt: toCapture?.capturedAt || ''
        }, null, 2), 'utf8');
    }

    return {
        report,
        analysis,
        warnings: analysis.warnings,
        warningCount: analysis.warningCount,
        status: analysis.status,
        deviceId: analysis.deviceId,
        outputPath,
        jsonOutputPath,
        fromPath,
        toPath,
        fromCapture,
        toCapture
    };
}

module.exports = {
    comparePhase1,
    parseArgs,
    summarize,
    analyzeCaptures
};

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`Phase 1 compare failed: ${error.message}\n`);
        process.exit(1);
    }
}
