'use strict';

const fs = require('fs');
const path = require('path');

const dashboardRoot = path.resolve(__dirname, '..');
const envPath = path.join(dashboardRoot, '.env');
const envExamplePath = path.join(dashboardRoot, '.env.example');

function detectEol(content) {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

function parseEnvKeys(content) {
    const keys = new Set();
    for (const line of String(content || '').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
        if (match) {
            keys.add(match[1]);
        }
    }
    return keys;
}

function extractExampleEntries(content) {
    const entries = [];
    for (const line of String(content || '').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
        if (!match) {
            continue;
        }

        entries.push({
            key: match[1],
            line
        });
    }
    return entries;
}

function buildSyncPlan(exampleContent, localContent) {
    const exampleEntries = extractExampleEntries(exampleContent);
    const localKeys = parseEnvKeys(localContent);
    const missingEntries = exampleEntries.filter((entry) => !localKeys.has(entry.key));

    return {
        missingEntries,
        missingKeys: missingEntries.map((entry) => entry.key)
    };
}

function appendMissingEntries(localContent, missingEntries, eol, timestamp) {
    if (!missingEntries.length) {
        return localContent;
    }

    const hasContent = String(localContent || '').length > 0;
    const normalizedLocal = String(localContent || '');
    const needsLeadingBreak = hasContent && !normalizedLocal.endsWith('\n') && !normalizedLocal.endsWith('\r');
    const header = `# Added from .env.example by env:sync on ${timestamp}`;
    const lines = [
        ...(needsLeadingBreak ? [''] : []),
        '',
        header,
        ...missingEntries.map((entry) => entry.line)
    ];

    return `${normalizedLocal}${lines.join(eol)}${eol}`;
}

function syncEnvFiles({
    envFilePath = envPath,
    envExampleFilePath = envExamplePath,
    timestamp = new Date().toISOString()
} = {}) {
    if (!fs.existsSync(envExampleFilePath)) {
        throw new Error(`Missing .env.example at ${envExampleFilePath}`);
    }

    const exampleContent = fs.readFileSync(envExampleFilePath, 'utf8');
    const exampleEol = detectEol(exampleContent);

    if (!fs.existsSync(envFilePath)) {
        fs.writeFileSync(envFilePath, exampleContent, 'utf8');
        return {
            action: 'created',
            missingKeys: extractExampleEntries(exampleContent).map((entry) => entry.key)
        };
    }

    const localContent = fs.readFileSync(envFilePath, 'utf8');
    const eol = detectEol(localContent || exampleContent || '\n') || exampleEol;
    const plan = buildSyncPlan(exampleContent, localContent);

    if (!plan.missingEntries.length) {
        return {
            action: 'unchanged',
            missingKeys: []
        };
    }

    const nextContent = appendMissingEntries(localContent, plan.missingEntries, eol, timestamp);
    fs.writeFileSync(envFilePath, nextContent, 'utf8');

    return {
        action: 'updated',
        missingKeys: plan.missingKeys
    };
}

function main() {
    const result = syncEnvFiles();

    if (result.action === 'created') {
        console.log('Created dashboard/.env from .env.example');
        console.log(`Added keys: ${result.missingKeys.length}`);
        return;
    }

    if (result.action === 'unchanged') {
        console.log('dashboard/.env already contains all keys from .env.example');
        return;
    }

    console.log(`Appended ${result.missingKeys.length} missing keys to dashboard/.env`);
    console.log(result.missingKeys.join(', '));
}

module.exports = {
    appendMissingEntries,
    buildSyncPlan,
    detectEol,
    extractExampleEntries,
    parseEnvKeys,
    syncEnvFiles
};

if (require.main === module) {
    main();
}
