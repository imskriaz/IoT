'use strict';

const path = require('path');

const {
    categorizePlaceholderWarnings,
    loadEnvFile,
    buildReport,
    determineExitCode,
    renderReport
} = require('./check_env');
const { SAFE_SECRET_SPECS, seedSecrets } = require('./seed_env_secrets');
const { syncEnvFiles } = require('./sync_env');

const dashboardRoot = path.resolve(__dirname, '..');
const envPath = path.join(dashboardRoot, '.env');
const envExamplePath = path.join(dashboardRoot, '.env.example');

function runDoctor({
    strict = false,
    writeSafeSecrets = false,
    envFilePath = envPath,
    envExampleFilePath = envExamplePath,
    dashboardRootPath = dashboardRoot,
    platform = process.platform
} = {}) {
    const syncResult = syncEnvFiles({
        envFilePath,
        envExampleFilePath
    });

    const seedResult = writeSafeSecrets
        ? seedSecrets({
            envFilePath,
            write: true
        })
        : { mode: 'skipped', replacements: [], skipped: [], safetyCopyPath: null };

    const localEnv = loadEnvFile(envFilePath);
    const exampleEnv = loadEnvFile(envExampleFilePath);
    const report = buildReport({
        localEnv,
        exampleEnv,
        platform,
        dashboardRootPath
    });
    const placeholderGroups = categorizePlaceholderWarnings(localEnv.values || {});
    const fixableCritical = placeholderGroups.critical.filter((key) => Object.prototype.hasOwnProperty.call(SAFE_SECRET_SPECS, key));
    const exitCode = determineExitCode(report, { strict });

    return {
        strict,
        writeSafeSecrets,
        syncResult,
        seedResult,
        report,
        fixableCritical,
        exitCode
    };
}

function renderDoctor(result, writeLine = console.log) {
    writeLine('IoT dashboard env doctor');
    writeLine(`Sync action                ${result.syncResult.action}`);
    writeLine(`Missing keys handled       ${result.syncResult.missingKeys.length}`);
    writeLine(`Strict mode                ${result.strict ? 'true' : 'false'}`);
    writeLine(`Safe secret repair         ${result.writeSafeSecrets ? 'true' : 'false'}`);
    if (result.writeSafeSecrets) {
        writeLine(`Secrets replaced           ${result.seedResult.replacements.length}`);
        if (result.seedResult.safetyCopyPath) {
            writeLine(`Safety copy path           ${result.seedResult.safetyCopyPath}`);
        }
        if (result.seedResult.replacements.length) {
            writeLine(result.seedResult.replacements.join(', '));
        }
    }
    if (result.syncResult.missingKeys.length) {
        writeLine(result.syncResult.missingKeys.join(', '));
    }
    writeLine('');

    renderReport(result.report, writeLine);
    if (result.fixableCritical.length) {
        writeLine('');
        writeLine('Suggested fix');
        writeLine(`  Preview                 npm run env:secrets -- --keys=${result.fixableCritical.join(',')}`);
        writeLine(`  Apply                   npm run env:secrets:write -- --keys=${result.fixableCritical.join(',')}`);
    }
    writeLine('');
    writeLine(`Doctor status              ${result.report.summary.status}`);
}

function main() {
    const strict = process.argv.includes('--strict');
    const writeSafeSecrets = process.argv.includes('--write-safe-secrets');
    const result = runDoctor({ strict, writeSafeSecrets });
    renderDoctor(result);
    process.exitCode = result.exitCode;
}

module.exports = {
    renderDoctor,
    runDoctor
};

if (require.main === module) {
    main();
}
