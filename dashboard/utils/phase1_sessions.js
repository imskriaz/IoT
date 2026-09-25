'use strict';

/**
 * Phase-1 capture session browser.
 *
 * Restored implementation (DASH-01): the previous file was corrupted
 * (12,755 NUL bytes), which broke `sessions:phase1`, `latest:phase1` and
 * `summary:phase1`.
 *
 * Usage:
 *   node utils/phase1_sessions.js [--dir <captures-dir>] [--verbose]
 *   node utils/phase1_sessions.js --latest [--verbose]
 *   node utils/phase1_sessions.js --summary
 *   node utils/phase1_sessions.js --json            (machine-readable list)
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'temp', 'phase1-captures');
const FILE_PREFIX = 'phase1-capture-';
const FILE_SUFFIX = '.json';

function parseArgs(argv) {
    const args = {
        dir: DEFAULT_DIR,
        latest: false,
        summary: false,
        verbose: false,
        json: false
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        switch (arg) {
            case '--dir':
                if (next) { args.dir = next; i++; }
                break;
            case '--latest':
                args.latest = true;
                break;
            case '--summary':
                args.summary = true;
                break;
            case '--verbose':
            case '-v':
                args.verbose = true;
                break;
            case '--json':
                args.json = true;
                break;
            case '--help':
            case '-h':
                args.help = true;
                break;
            default:
                break;
        }
    }
    return args;
}

function listCaptureFiles(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
    return entries
        .filter(name => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
        .map(name => {
            const full = path.join(dir, name);
            let mtimeMs = 0;
            try { mtimeMs = fs.statSync(full).mtimeMs; } catch (_) {}
            return { name, full, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function loadCapture(file) {
    let raw;
    try {
        raw = fs.readFileSync(file.full, 'utf8');
    } catch (err) {
        return { file, parseError: `unreadable: ${err.message}` };
    }
    if (!raw.trim() || raw.includes('\u0000')) {
        return { file, parseError: 'corrupted payload (empty or NUL bytes)' };
    }
    try {
        return { file, capture: JSON.parse(raw) };
    } catch (err) {
        return { file, parseError: `invalid JSON: ${err.message}` };
    }
}

function summarizeCapture(entry) {
    const capture = entry.capture || {};
    const caps = capture.captures || {};
    const statusData = caps.status?.data?.data || {};
    const devices = Array.isArray(capture.devices?.devices) ? capture.devices.devices : null;
    const captureNames = Object.keys(caps);
    const failed = captureNames.filter(name => caps[name] && caps[name].ok === false);
    return {
        file: entry.file.name,
        capturedAt: capture.capturedAt || null,
        deviceId: capture.deviceId || '(unknown)',
        label: capture.label || '',
        note: capture.note || '',
        baseUrl: capture.baseUrl || '',
        statusOk: caps.status?.ok === true,
        httpStatus: caps.status?.status ?? null,
        online: statusData.online === true,
        modules: statusData.modules || null,
        deviceListed: devices
            ? devices.some(device => String(device?.id || '') === String(capture.deviceId))
            : null,
        smsCount: Array.isArray(caps.recentSms?.data) ? caps.recentSms.data.length : 0,
        failedCaptures: failed,
        captureCount: captureNames.length
    };
}

function fmtRow(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return `  ${label}: ${value}`;
}

function printSession(entry, verbose) {
    const summary = summarizeCapture(entry);
    console.log(`\n${summary.file}`);
    for (const line of [
        fmtRow('capturedAt', summary.capturedAt),
        fmtRow('deviceId', summary.deviceId),
        fmtRow('label', summary.label),
        fmtRow('note', summary.note),
        fmtRow('baseUrl', summary.baseUrl),
        fmtRow('online', summary.statusOk ? String(summary.online) : 'unknown'),
        fmtRow('httpStatus', summary.httpStatus),
        fmtRow('sms rows', summary.smsCount),
        fmtRow('capture endpoints', summary.captureCount),
        summary.failedCaptures.length ? `  failed endpoints: ${summary.failedCaptures.join(', ')}` : ''
    ]) {
        if (line) console.log(line);
    }
    if (verbose && entry.capture) {
        console.log('  status payload:');
        console.log(JSON.stringify(entry.capture.captures?.status?.data?.data ?? null, null, 2)
            .split('\n').map(line => `    ${line}`).join('\n'));
    }
    if (entry.parseError) {
        console.log(`  ERROR: ${entry.parseError}`);
    }
}

function printSummary(entries) {
    const total = entries.length;
    if (!total) {
        console.log(`No phase-1 captures found under ${DEFAULT_DIR}`);
        return;
    }
    const summaries = entries.map(summarizeCapture);
    const withTime = summaries.filter(row => row.capturedAt).map(row => Date.parse(row.capturedAt));
    const first = new Date(Math.min(...withTime)).toISOString();
    const last = new Date(Math.max(...withTime)).toISOString();
    const devices = [...new Set(summaries.map(row => row.deviceId))];
    const online = summaries.filter(row => row.online).length;
    const statusFailures = summaries.filter(row => !row.statusOk).length;
    const failedEndpoints = summaries.flatMap(row => row.failedCaptures);
    const labels = summaries.filter(row => row.label).map(row => row.label);

    console.log('Phase-1 capture summary');
    console.log(`  captures: ${total}`);
    console.log(`  devices: ${devices.length} (${devices.slice(0, 5).join(', ')}${devices.length > 5 ? ', ...' : ''})`);
    console.log(`  window: ${first} -> ${last}`);
    console.log(`  online status: ${online}/${total} report online`);
    console.log(`  status endpoint failures: ${statusFailures}/${total}`);
    console.log(`  failed endpoint captures: ${failedEndpoints.length}${failedEndpoints.length ? ` (${[...new Set(failedEndpoints)].join(', ')})` : ''}`);
    if (labels.length) console.log(`  labels: ${labels.slice(0, 10).join(', ')}${labels.length > 10 ? ', ...' : ''}`);
}

function printLatest(entries, verbose) {
    if (!entries.length) {
        console.log(`No phase-1 captures found under ${DEFAULT_DIR}`);
        return;
    }
    const entry = loadCapture(entries[0]);
    printSession(entry, verbose);
}

function printList(entries, verbose) {
    if (!entries.length) {
        console.log(`No phase-1 captures found under ${DEFAULT_DIR}`);
        return;
    }
    console.log(`Phase-1 capture sessions (${entries.length}) — newest first`);
    for (const entry of entries.map(loadCapture)) {
        printSession(entry, verbose);
    }
}

function printJson(entries) {
    const rows = entries.map(loadCapture).map(entry => entry.parseError
        ? { file: entry.file.name, error: entry.parseError }
        : summarizeCapture(entry));
    process.stdout.write(JSON.stringify({ dir: DEFAULT_DIR, count: rows.length, sessions: rows }, null, 2));
}

function main(argv) {
    const args = parseArgs(argv);
    if (args.help) {
        console.log(
            'Usage:\n' +
            '  node utils/phase1_sessions.js [--dir <dir>] [--verbose]\n' +
            '  node utils/phase1_sessions.js --latest [--verbose]\n' +
            '  node utils/phase1_sessions.js --summary\n' +
            '  node utils/phase1_sessions.js --json\n'
        );
        return 0;
    }
    const files = listCaptureFiles(args.dir);
    if (args.json) printJson(files);
    else if (args.summary) printSummary(files);
    else if (args.latest) printLatest(files, args.verbose);
    else printList(files, args.verbose);
    return 0;
}

module.exports = {
    parseArgs,
    listCaptureFiles,
    loadCapture,
    summarizeCapture,
    main
};

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (err) {
        process.stderr.write(`phase1_sessions error: ${err.message}\n`);
        process.exitCode = 1;
    }
}
