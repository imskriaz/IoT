'use strict';

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '../logs');
const FILE_LOG_PREFIXES = Object.freeze({
    app: 'app-',
    mqtt: 'mqtt-',
    error: 'error-'
});

const DATABASE_LOG_TABLES = Object.freeze({
    system: 'system_logs',
    mqtt: 'mqtt_logs',
    automation: 'automation_logs',
    gpio: 'flow_execution_log',
    auth: 'login_audit'
});

function listLogFiles(source) {
    const prefix = FILE_LOG_PREFIXES[source];
    if (!prefix || !fs.existsSync(LOGS_DIR)) {
        return [];
    }

    return fs.readdirSync(LOGS_DIR)
        .filter((fileName) => fileName.startsWith(prefix) && fileName.endsWith('.log'))
        .map((fileName) => path.join(LOGS_DIR, fileName));
}

function clearFileLogs(source) {
    const files = listLogFiles(source);
    let cleared = 0;
    for (const filePath of files) {
        fs.writeFileSync(filePath, '');
        cleared += 1;
    }
    return { source, cleared };
}

async function clearDatabaseLogs(db, targets = []) {
    if (!db) {
        return [];
    }

    const results = [];
    for (const target of targets) {
        const tableName = DATABASE_LOG_TABLES[target];
        if (!tableName) {
            continue;
        }
        const result = await db.run(`DELETE FROM ${tableName}`);
        results.push({
            target,
            table: tableName,
            cleared: Number(result?.changes || 0)
        });
    }
    return results;
}

async function clearAllDashboardLogs(db) {
    const fileResults = Object.keys(FILE_LOG_PREFIXES).map((source) => clearFileLogs(source));
    const databaseResults = await clearDatabaseLogs(db, Object.keys(DATABASE_LOG_TABLES));

    return {
        files: fileResults,
        database: databaseResults
    };
}

module.exports = {
    LOGS_DIR,
    FILE_LOG_PREFIXES,
    DATABASE_LOG_TABLES,
    clearFileLogs,
    clearDatabaseLogs,
    clearAllDashboardLogs
};
