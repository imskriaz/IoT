'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const { capturePhase1, sanitizeFileSegment: captureSanitizeFileSegment } = require('./phase1_capture');
const { comparePhase1 } = require('./phase1_compare');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function parseArgs(argv) {
    const args = {
        baseUrl: 'http://127.0.0.1:3001',
        username: process.env.DASHBOARD_USERNAME || process.env.ADMIN_USERNAME || 'admin',
        password: process.env.DASHBOARD_PASSWORD || process.env.ADMIN_PASSWORD || 'admin123',
        deviceId: '',
        label: '',
        note: '',
        captureDir: path.join(__dirname, '..', 'temp', 'phase1-captures'),
        reportDir: path.join(__dirname, '..', 'temp', 'phase1-reports'),
        durationMin: 30,
        intervalSec: 300,
        count: 0,
        failOnWarning: false,
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
            case '--capture-dir':
                if (next) {
                    args.captureDir = next;
                    i++;
                }
                break;
            case '--report-dir':
                if (next) {
                    args.reportDir = next;
                    i++;
                }
                break;
            case '--duration-min':
                if (next) {
                    args.durationMin = Number(next);
                    i++;
                }
                break;
            case '--interval-sec':
                if (next) {
                    args.intervalSec = Number(next);
                    i++;
                }
                break;
            case '--count':
                if (next) {
                    args.count = Number(next);
                    i++;
                }
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
            'Phase 1 soak helper',
            '',
            'Usage:',
            '  node utils/phase1_soak.js [options]',
            '',
            'Options:',
            '  --base-url      Dashboard base URL (default: http://127.0.0.1:3001)',
            '  --username      Dashboard username (default: admin)',
            '  --password      Dashboard password (default: admin123)',
            '  --device        Device ID to monitor',
            '  --label         Optional session label applied to the soak run and capture labels',
            '  --note          Optional session note stored in captures and the soak manifest',
            '  --capture-dir   Output directory for JSON captures',
            '  --report-dir    Output directory for Markdown/JSON soak reports',
            '  --duration-min  Soak duration in minutes (default: 30)',
            '  --interval-sec  Seconds between captures (default: 300)',
            '  --count         Explicit number of captures to take',
            '  --fail-on-warning  Exit with status 2 when final compare warnings are present',
            '  --quiet         Suppress normal stdout output',
            '  --help          Show this help text',
            '',
            'The helper captures immediately, repeats on the chosen interval,',
            'then writes a final compare report between the first and last capture.'
        ].join('\n') + '\n'
    );
}

function safeFileStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeFileSegment(value) {
    if (typeof captureSanitizeFileSegment === 'function') {
        return captureSanitizeFileSegment(value);
    }

    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveCaptureCount(args) {
    if (Number.isFinite(args.count) && args.count > 0) {
        return Math.max(1, Math.floor(args.count));
    }

    if (!Number.isFinite(args.durationMin) || args.durationMin <= 0) {
        return 1;
    }

    if (!Number.isFinite(args.intervalSec) || args.intervalSec <= 0) {
        throw new Error('interval-sec must be a positive number');
    }

    return Math.max(1, Math.floor((args.durationMin * 60) / args.intervalSec) + 1);
}

function buildCaptureLabel(args, index, captureCount) {
    const sampleTag = `${String(index + 1).padStart(2, '0')}-of-${String(captureCount).padStart(2, '0')}`;
    const sessionLabel = String(args.label || '').trim();
    if (sessionLabel) {
        return `${sessionLabel}-${sampleTag}`;
    }
    return `soak-${sampleTag}`;
}

function buildSessionSummary(args, captures, compareResult) {
    const lines = [];
    const first = captures[0] || null;
    const last = captures[captures.length - 1] || null;

    lines.push('# Phase 1 Soak Session');
    lines.push('');
    lines.push(`Device: ${last?.deviceId || first?.deviceId || '(none)'}`);
    if (args.label) {
        lines.push(`Session label: ${args.label}`);
    }
    if (args.note) {
        lines.push(`Session note: ${args.note}`);
    }
    lines.push(`Capture count: ${captures.length}`);
    lines.push(`Interval seconds: ${args.intervalSec}`);
    lines.push(`Requested duration minutes: ${args.durationMin}`);
    lines.push('');
    lines.push('## Captures');

    for (const capture of captures) {
        const label = capture.label ? ` [${capture.label}]` : '';
        lines.push(`- ${capture.capturedAt}${label} :: ${capture.outputPath}`);
    }

    lines.push('');
    lines.push('## Final Compare');

    if (compareResult?.outputPath) {
        lines.push(`- Report: ${compareResult.outputPath}`);
    } else {
        lines.push('- Report: not generated');
    }

    if (compareResult?.jsonOutputPath) {
        lines.push(`- Analysis JSON: ${compareResult.jsonOutputPath}`);
    }

    lines.push(`- Status: ${compareResult?.status || 'not-generated'}`);
    lines.push(`- Warnings: ${Number(compareResult?.warningCount || 0)}`);

    if (compareResult?.fromPath && compareResult?.toPath) {
        lines.push(`- Compared: ${compareResult.fromPath} -> ${compareResult.toPath}`);
    }

    if (Array.isArray(compareResult?.warnings) && compareResult.warnings.length > 0) {
        lines.push('');
        lines.push('## Warning Details');
        for (const warning of compareResult.warnings) {
            lines.push(`- ${warning}`);
        }
    }

    return lines.join('\n') + '\n';
}

async function runSoak(options = {}) {
    const args = {
        ...parseArgs([]),
        ...options
    };
    const captureCount = resolveCaptureCount(args);
    const intervalMs = Math.max(0, Math.floor(Number(args.intervalSec) * 1000));
    const captures = [];
    let compareResult = null;
    const log = args.quiet ? () => {} : (message) => process.stdout.write(message);

    await fs.promises.mkdir(args.captureDir, { recursive: true });
    await fs.promises.mkdir(args.reportDir, { recursive: true });

    for (let index = 0; index < captureCount; index++) {
        const current = await capturePhase1({
            baseUrl: args.baseUrl,
            username: args.username,
            password: args.password,
            deviceId: args.deviceId,
            outDir: args.captureDir,
            label: buildCaptureLabel(args, index, captureCount),
            note: args.note
        });

        captures.push({
            outputPath: current.outputPath,
            capturedAt: current.capture.capturedAt,
            deviceId: current.deviceId,
            label: current.label,
            note: current.note
        });

        log(`[${index + 1}/${captureCount}] Saved Phase 1 capture to ${current.outputPath}\n`);

        if (index < captureCount - 1 && intervalMs > 0) {
            await sleep(intervalMs);
        }
    }

    if (captures.length >= 2) {
        compareResult = comparePhase1({
            from: captures[0].outputPath,
            to: captures[captures.length - 1].outputPath,
            outDir: args.reportDir,
            label: args.label,
            save: true,
            saveJson: true
        });
        log(`Saved soak compare report to ${compareResult.outputPath}\n`);
        if (compareResult.jsonOutputPath) {
            log(`Saved soak compare analysis to ${compareResult.jsonOutputPath}\n`);
        }
    }

    const summary = buildSessionSummary(args, captures, compareResult);
    const deviceId = String(captures[captures.length - 1]?.deviceId || args.deviceId || 'unknown-device').trim() || 'unknown-device';
    const sessionStamp = safeFileStamp();
    const labelSegment = sanitizeFileSegment(args.label);
    const outputBaseName = labelSegment
        ? `phase1-soak-${deviceId}-${labelSegment}-${sessionStamp}`
        : `phase1-soak-${deviceId}-${sessionStamp}`;
    const summaryPath = path.join(args.reportDir, `${outputBaseName}.md`);
    const manifestPath = path.join(args.reportDir, `${outputBaseName}.json`);
    const manifest = {
        generatedAt: new Date().toISOString(),
        deviceId,
        sessionLabel: String(args.label || '').trim(),
        sessionNote: String(args.note || '').trim(),
        captureCount,
        intervalSec: args.intervalSec,
        durationMin: args.durationMin,
        captures,
        compareReportPath: compareResult?.outputPath || '',
        compareAnalysisPath: compareResult?.jsonOutputPath || '',
        compareFromPath: compareResult?.fromPath || '',
        compareToPath: compareResult?.toPath || '',
        compareStatus: compareResult?.status || 'not-generated',
        warningCount: Number(compareResult?.warningCount || 0),
        warnings: Array.isArray(compareResult?.warnings) ? compareResult.warnings : []
    };

    await fs.promises.writeFile(summaryPath, summary, 'utf8');
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    return {
        captures,
        compareResult,
        summaryPath,
        manifestPath
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const result = await runSoak(args);
    if (!args.quiet) {
        process.stdout.write(`Saved soak summary to ${result.summaryPath}\n`);
        process.stdout.write(`Saved soak manifest to ${result.manifestPath}\n`);
    }
    if (args.failOnWarning && Number(result.compareResult?.warningCount || 0) > 0) {
        process.exitCode = 2;
    }
}

module.exports = {
    runSoak,
    parseArgs,
    resolveCaptureCount,
    buildCaptureLabel
};

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`Phase 1 soak failed: ${error.message}\n`);
        process.exit(1);
    });
}
