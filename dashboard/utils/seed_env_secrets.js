'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { isPlaceholder } = require('./check_env');

const dashboardRoot = path.resolve(__dirname, '..');
const envPath = path.join(dashboardRoot, '.env');
const defaultSafetyCopyDir = path.join(dashboardRoot, 'temp', 'env-safety-copies');

const SAFE_SECRET_SPECS = Object.freeze({
    SESSION_SECRET: { kind: 'hex', bytes: 48 },
    ADMIN_PASSWORD: { kind: 'base64url', bytes: 18 },
    SUPER_PASS: { kind: 'base64url', bytes: 18 }
});

function detectEol(content) {
    return String(content || '').includes('\r\n') ? '\r\n' : '\n';
}

function formatSafetyCopyStamp(timestamp = new Date()) {
    const iso = typeof timestamp === 'string' ? timestamp : timestamp.toISOString();
    return iso.replace(/[:.]/g, '-');
}

function parseArgs(argv = process.argv.slice(2)) {
    const options = {
        write: false,
        dryRun: false,
        keys: null
    };

    for (const arg of argv) {
        if (arg === '--write') {
            options.write = true;
            continue;
        }
        if (arg === '--dry-run') {
            options.dryRun = true;
            continue;
        }
        if (arg.startsWith('--keys=')) {
            options.keys = arg
                .slice('--keys='.length)
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean);
        }
    }

    if (!options.write) {
        options.dryRun = true;
    }

    return options;
}

function generateSecret(key) {
    const spec = SAFE_SECRET_SPECS[key];
    if (!spec) {
        throw new Error(`Unsupported secret key: ${key}`);
    }

    const bytes = crypto.randomBytes(spec.bytes);
    if (spec.kind === 'hex') {
        return bytes.toString('hex');
    }
    if (spec.kind === 'base64url') {
        return bytes.toString('base64url');
    }

    throw new Error(`Unsupported secret generator kind: ${spec.kind}`);
}

function shouldReplaceValue(key, value) {
    if (!Object.prototype.hasOwnProperty.call(SAFE_SECRET_SPECS, key)) {
        return false;
    }

    const normalized = String(value || '').trim();
    return normalized === '' || isPlaceholder(normalized);
}

function buildReplacementPlan(content, selectedKeys = null) {
    const allowedKeys = selectedKeys && selectedKeys.length
        ? new Set(selectedKeys)
        : new Set(Object.keys(SAFE_SECRET_SPECS));

    const replacements = [];
    const skipped = [];
    const lines = String(content || '').split(/\r?\n/);

    lines.forEach((line, index) => {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!match) {
            return;
        }

        const key = match[1];
        const value = match[2];

        if (!allowedKeys.has(key)) {
            return;
        }

        if (!Object.prototype.hasOwnProperty.call(SAFE_SECRET_SPECS, key)) {
            skipped.push({ key, reason: 'unsupported key' });
            return;
        }

        if (!shouldReplaceValue(key, value)) {
            skipped.push({ key, reason: 'already set' });
            return;
        }

        replacements.push({
            key,
            lineIndex: index,
            nextValue: generateSecret(key)
        });
    });

    return { replacements, skipped };
}

function applyReplacementPlan(content, replacements, eol) {
    const nextLines = String(content || '').split(/\r?\n/);
    for (const replacement of replacements) {
        nextLines[replacement.lineIndex] = `${replacement.key}=${replacement.nextValue}`;
    }
    return `${nextLines.join(eol)}${String(content || '').match(/\r?\n$/) ? '' : eol}`;
}

function createSafetyCopyFile(envFilePath, content, safetyCopyDir = defaultSafetyCopyDir, timestamp = new Date()) {
    fs.mkdirSync(safetyCopyDir, { recursive: true });
    const safetyCopyFileName = `.env.${formatSafetyCopyStamp(timestamp)}.bak`;
    const safetyCopyPath = path.join(safetyCopyDir, safetyCopyFileName);
    fs.writeFileSync(safetyCopyPath, content, 'utf8');
    return safetyCopyPath;
}

function seedSecrets({
    envFilePath = envPath,
    write = false,
    keys = null,
    safetyCopyDir = defaultSafetyCopyDir,
    timestamp = new Date()
} = {}) {
    if (!fs.existsSync(envFilePath)) {
        throw new Error(`Missing env file at ${envFilePath}`);
    }

    const content = fs.readFileSync(envFilePath, 'utf8');
    const eol = detectEol(content);
    const plan = buildReplacementPlan(content, keys);
    let safetyCopyPath = null;

    if (write && plan.replacements.length) {
        safetyCopyPath = createSafetyCopyFile(envFilePath, content, safetyCopyDir, timestamp);
        const nextContent = applyReplacementPlan(content, plan.replacements, eol);
        fs.writeFileSync(envFilePath, nextContent, 'utf8');
    }

    return {
        mode: write ? 'write' : 'dry-run',
        safetyCopyPath,
        replacements: plan.replacements.map(({ key }) => key),
        skipped: plan.skipped
    };
}

function main() {
    const options = parseArgs();
    const result = seedSecrets({
        envFilePath: envPath,
        write: options.write,
        keys: options.keys
    });

    console.log('IoT dashboard env secrets');
    console.log(`Mode                       ${result.mode}`);
    console.log(`Secrets to replace         ${result.replacements.length}`);
    console.log(`Secrets skipped            ${result.skipped.length}`);
    if (result.safetyCopyPath) {
        console.log(`Safety copy path           ${result.safetyCopyPath}`);
    }

    if (result.replacements.length) {
        console.log(result.replacements.join(', '));
    }

    if (result.skipped.length) {
        const skippedSummary = result.skipped.map((entry) => `${entry.key} (${entry.reason})`);
        console.log(skippedSummary.join(', '));
    }

    if (!options.write) {
        console.log('');
        console.log('Run `npm run env:secrets:write` to apply safe local secret replacements.');
    }
}

module.exports = {
    SAFE_SECRET_SPECS,
    applyReplacementPlan,
    buildReplacementPlan,
    createSafetyCopyFile,
    defaultSafetyCopyDir,
    detectEol,
    formatSafetyCopyStamp,
    generateSecret,
    parseArgs,
    seedSecrets,
    shouldReplaceValue
};

if (require.main === module) {
    main();
}
