'use strict';

const dotenv = require('dotenv');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DASHBOARD_ENV_PATH = path.join(__dirname, '../.env');

function detectSystemTimezone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (_) {
        return 'UTC';
    }
}

function normalizeTimezone(value, fallback = detectSystemTimezone()) {
    const zone = String(value || fallback || 'UTC').trim() || 'UTC';
    try {
        new Intl.DateTimeFormat(undefined, { timeZone: zone }).format(new Date());
        return zone;
    } catch (_) {
        return fallback || 'UTC';
    }
}

const DEFAULTS = Object.freeze({
    deviceStatusRefreshMs: 60000,
    statusWatchIntervalMs: 45000,
    statusWatchTtlMs: 180000,
    statusWatchRefreshMs: 120000,
    logRetentionDays: 30,
    logLevel: 'info',
    timezone: detectSystemTimezone(),
    autoRestart: false,
    restartSchedule: '03:00',
    backupConfig: true
});

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function parseJson(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function parsePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizeStatusWatchSettings(input = {}, fallback = {}) {
    const interval = parsePositiveInt(
        input.statusWatchIntervalMs,
        fallback.statusWatchIntervalMs ?? DEFAULTS.statusWatchIntervalMs,
        { min: 10000, max: 300000 }
    );
    const ttlCandidate = parsePositiveInt(
        input.statusWatchTtlMs,
        fallback.statusWatchTtlMs ?? DEFAULTS.statusWatchTtlMs,
        { min: 60000, max: 900000 }
    );
    const refreshCandidate = parsePositiveInt(
        input.statusWatchRefreshMs,
        fallback.statusWatchRefreshMs ?? DEFAULTS.statusWatchRefreshMs,
        { min: 30000, max: 600000 }
    );
    const ttl = Math.max(ttlCandidate, interval + 30000);
    const refresh = Math.min(refreshCandidate, Math.max(30000, ttl - 30000));

    return {
        statusWatchIntervalMs: interval,
        statusWatchIntervalSeconds: Math.round(interval / 1000),
        statusWatchTtlMs: ttl,
        statusWatchTtlSeconds: Math.round(ttl / 1000),
        statusWatchRefreshMs: refresh,
        statusWatchRefreshSeconds: Math.round(refresh / 1000)
    };
}

function firstEnv(names) {
    for (const name of names) {
        const value = process.env[name];
        if (value !== undefined && String(value).trim() !== '') {
            return { name, value: String(value).trim() };
        }
    }
    return null;
}

function readDashboardEnvMap() {
    try {
        if (!fs.existsSync(DASHBOARD_ENV_PATH)) return {};
        return dotenv.parse(fs.readFileSync(DASHBOARD_ENV_PATH, 'utf8'));
    } catch (_) {
        return {};
    }
}

function firstDashboardEnv(names, dashboardEnv = {}) {
    for (const name of names) {
        if (!Object.prototype.hasOwnProperty.call(dashboardEnv, name)) continue;
        const value = String(dashboardEnv[name] ?? '').trim();
        if (value !== '') {
            return { name, value };
        }
    }
    return null;
}

function normalizeLogLevel(value, fallback = DEFAULTS.logLevel) {
    const level = String(value || '').trim().toLowerCase();
    return LOG_LEVELS.has(level) ? level : fallback;
}

function normalizeCountryCode(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

async function readSettingsMap(db) {
    if (!db || typeof db.all !== 'function') return new Map();
    const rows = await db.all('SELECT key, value FROM settings').catch(() => []);
    return new Map((rows || []).map(row => [row.key, row.value]));
}

function resolveValue({ envNames, storedValue, defaultValue, parser = value => value, dashboardEnv = {} }) {
    const runtimeEnv = firstEnv(envNames);
    const dashboardEnvValue = firstDashboardEnv(envNames, dashboardEnv);

    if (dashboardEnvValue && runtimeEnv && runtimeEnv.name === dashboardEnvValue.name && runtimeEnv.value === dashboardEnvValue.value) {
        return {
            value: parser(dashboardEnvValue.value, defaultValue),
            source: 'dashboard_env',
            envName: dashboardEnvValue.name,
            storedValue,
            defaultValue
        };
    }

    if (runtimeEnv) {
        return {
            value: parser(runtimeEnv.value, defaultValue),
            source: 'env',
            envName: runtimeEnv.name,
            storedValue,
            defaultValue
        };
    }

    if (dashboardEnvValue) {
        return {
            value: parser(dashboardEnvValue.value, defaultValue),
            source: 'dashboard_env',
            envName: dashboardEnvValue.name,
            storedValue,
            defaultValue
        };
    }

    if (storedValue !== undefined && storedValue !== null && storedValue !== '') {
        return {
            value: parser(storedValue, defaultValue),
            source: 'database',
            envName: null,
            storedValue,
            defaultValue
        };
    }

    return {
        value: defaultValue,
        source: 'default',
        envName: null,
        storedValue,
        defaultValue
    };
}

function buildEnvironmentSummary(effective) {
    const monitored = [
        {
            key: 'deviceStatusRefreshMs',
            label: 'Device status refresh interval',
            envNames: ['DASHBOARD_DEVICE_STATUS_REFRESH_MS', 'DEVICE_STATUS_AUTO_REFRESH_MS']
        },
        {
            key: 'logRetentionDays',
            label: 'Log retention days',
            envNames: ['LOG_RETENTION_DAYS']
        },
        {
            key: 'statusWatchIntervalMs',
            label: 'Device status-watch interval',
            envNames: ['DASHBOARD_STATUS_WATCH_INTERVAL_MS']
        },
        {
            key: 'statusWatchTtlMs',
            label: 'Device status-watch TTL',
            envNames: ['DASHBOARD_STATUS_WATCH_TTL_MS']
        },
        {
            key: 'statusWatchRefreshMs',
            label: 'Device status-watch refresh',
            envNames: ['DASHBOARD_STATUS_WATCH_REFRESH_MS']
        },
        {
            key: 'logLevel',
            label: 'Log level',
            envNames: ['LOG_LEVEL']
        },
        {
            key: 'timezone',
            label: 'Timezone',
            envNames: ['TZ']
        },
        {
            key: 'phoneCountryCode',
            label: 'Phone country code',
            envNames: ['PHONE_COUNTRY_CODE']
        },
        {
            key: 'publicBaseUrl',
            label: 'Public base URL',
            envNames: ['PUBLIC_BASE_URL']
        },
        {
            key: 'otaBaseUrl',
            label: 'OTA base URL',
            envNames: ['OTA_BASE_URL']
        },
        {
            key: 'mqttHost',
            label: 'MQTT host',
            envNames: ['MQTT_HOST']
        },
        {
            key: 'mqttPort',
            label: 'MQTT port',
            envNames: ['MQTT_PORT']
        },
        {
            key: 'mqttUser',
            label: 'MQTT user',
            envNames: ['MQTT_USER']
        },
        {
            key: 'mqttPassword',
            label: 'MQTT password',
            envNames: ['MQTT_PASSWORD'],
            secret: true
        },
        {
            key: 'mqttProtocol',
            label: 'MQTT protocol',
            envNames: ['MQTT_PROTOCOL']
        },
        {
            key: 'mqttRejectUnauthorized',
            label: 'MQTT TLS verify',
            envNames: ['MQTT_REJECT_UNAUTHORIZED']
        },
    ];

    return monitored.map(item => {
        const meta = effective[item.key] || {};
        return {
            key: item.key,
            label: item.label,
            envNames: item.envNames,
            active: meta.source === 'env',
            envName: meta.source === 'env' ? (meta.envName || null) : null,
            value: meta.source === 'env' ? (item.secret ? '********' : String(meta.value ?? '')) : '',
            effectiveSource: meta.source || 'unset'
        };
    });
}

async function getEffectiveSystemSettings(db) {
    const rows = await readSettingsMap(db);
    const dashboardEnv = readDashboardEnvMap();
    const system = parseJson(rows.get('system'), {});
    const legacyRefreshMs = rows.has('device_status_refresh_ms')
        ? rows.get('device_status_refresh_ms')
        : undefined;

    const deviceStatusRefresh = resolveValue({
        envNames: ['DASHBOARD_DEVICE_STATUS_REFRESH_MS', 'DEVICE_STATUS_AUTO_REFRESH_MS'],
        storedValue: system.deviceStatusRefreshMs ?? legacyRefreshMs,
        defaultValue: DEFAULTS.deviceStatusRefreshMs,
        parser: (value, fallback) => parsePositiveInt(value, fallback, { min: 5000, max: 3600000 }),
        dashboardEnv
    });
    const statusWatchInterval = resolveValue({
        envNames: ['DASHBOARD_STATUS_WATCH_INTERVAL_MS'],
        storedValue: system.statusWatchIntervalMs ?? rows.get('status_watch_interval_ms'),
        defaultValue: DEFAULTS.statusWatchIntervalMs,
        parser: (value, fallback) => parsePositiveInt(value, fallback, { min: 10000, max: 300000 }),
        dashboardEnv
    });
    const statusWatchTtl = resolveValue({
        envNames: ['DASHBOARD_STATUS_WATCH_TTL_MS'],
        storedValue: system.statusWatchTtlMs ?? rows.get('status_watch_ttl_ms'),
        defaultValue: DEFAULTS.statusWatchTtlMs,
        parser: (value, fallback) => parsePositiveInt(value, fallback, { min: 60000, max: 900000 }),
        dashboardEnv
    });
    const statusWatchRefresh = resolveValue({
        envNames: ['DASHBOARD_STATUS_WATCH_REFRESH_MS'],
        storedValue: system.statusWatchRefreshMs ?? rows.get('status_watch_refresh_ms'),
        defaultValue: DEFAULTS.statusWatchRefreshMs,
        parser: (value, fallback) => parsePositiveInt(value, fallback, { min: 30000, max: 600000 }),
        dashboardEnv
    });
    const normalizedStatusWatch = normalizeStatusWatchSettings({
        statusWatchIntervalMs: statusWatchInterval.value,
        statusWatchTtlMs: statusWatchTtl.value,
        statusWatchRefreshMs: statusWatchRefresh.value
    });
    statusWatchInterval.value = normalizedStatusWatch.statusWatchIntervalMs;
    statusWatchTtl.value = normalizedStatusWatch.statusWatchTtlMs;
    statusWatchRefresh.value = normalizedStatusWatch.statusWatchRefreshMs;

    const logRetention = resolveValue({
        envNames: ['LOG_RETENTION_DAYS'],
        storedValue: system.logRetentionDays ?? rows.get('log_retention_days'),
        defaultValue: DEFAULTS.logRetentionDays,
        parser: (value, fallback) => parsePositiveInt(value, fallback, { min: 1, max: 3650 }),
        dashboardEnv
    });

    const logLevel = resolveValue({
        envNames: ['LOG_LEVEL'],
        storedValue: system.logLevel,
        defaultValue: DEFAULTS.logLevel,
        parser: normalizeLogLevel,
        dashboardEnv
    });

    const timezone = resolveValue({
        envNames: ['TZ'],
        storedValue: system.timezone ?? rows.get('timezone'),
        defaultValue: DEFAULTS.timezone,
        parser: normalizeTimezone,
        dashboardEnv
    });

    const phoneCountryCode = resolveValue({
        envNames: ['PHONE_COUNTRY_CODE'],
        storedValue: undefined,
        defaultValue: '',
        parser: value => normalizeCountryCode(value),
        dashboardEnv
    });

    const publicBaseUrl = resolveValue({
        envNames: ['PUBLIC_BASE_URL'],
        storedValue: undefined,
        defaultValue: '',
        parser: value => normalizeUrl(value),
        dashboardEnv
    });

    const otaBaseUrl = resolveValue({
        envNames: ['OTA_BASE_URL'],
        storedValue: undefined,
        defaultValue: '',
        parser: value => normalizeUrl(value),
        dashboardEnv
    });

    const mqttHost = resolveValue({
        envNames: ['MQTT_HOST'],
        storedValue: '',
        defaultValue: '',
        parser: value => String(value || '').trim(),
        dashboardEnv
    });
    const mqttPort = resolveValue({
        envNames: ['MQTT_PORT'],
        storedValue: '',
        defaultValue: '',
        parser: value => String(value || '').trim(),
        dashboardEnv
    });
    const mqttUser = resolveValue({
        envNames: ['MQTT_USER'],
        storedValue: '',
        defaultValue: '',
        parser: value => String(value || '').trim(),
        dashboardEnv
    });
    const mqttPassword = resolveValue({
        envNames: ['MQTT_PASSWORD'],
        storedValue: '',
        defaultValue: '',
        parser: value => String(value || '').trim(),
        dashboardEnv
    });
    const mqttProtocol = resolveValue({
        envNames: ['MQTT_PROTOCOL'],
        storedValue: '',
        defaultValue: 'mqtt',
        parser: value => String(value || 'mqtt').trim() || 'mqtt',
        dashboardEnv
    });
    const mqttRejectUnauthorized = resolveValue({
        envNames: ['MQTT_REJECT_UNAUTHORIZED'],
        storedValue: '',
        defaultValue: false,
        parser: value => String(value || '').trim().toLowerCase() === 'true',
        dashboardEnv
    });

    const effective = {
        deviceStatusRefreshMs: deviceStatusRefresh,
        statusWatchIntervalMs: statusWatchInterval,
        statusWatchTtlMs: statusWatchTtl,
        statusWatchRefreshMs: statusWatchRefresh,
        logRetentionDays: logRetention,
        logLevel,
        timezone,
        phoneCountryCode,
        publicBaseUrl,
        otaBaseUrl,
        mqttHost,
        mqttPort,
        mqttUser,
        mqttPassword: {
            ...mqttPassword,
            value: mqttPassword.value ? '********' : ''
        },
        mqttProtocol,
        mqttRejectUnauthorized,
        serialPort: { value: process.env.SERIAL_PORT || '', source: process.env.SERIAL_PORT ? 'env' : 'unset' },
        bluetoothSerialPort: { value: process.env.BLUETOOTH_SERIAL_PORT || '', source: process.env.BLUETOOTH_SERIAL_PORT ? 'env' : 'unset' }
    };

    return {
        system: {
            deviceName: system.deviceName || 'Dashboard',
            hostname: os.hostname(),
            timezone: timezone.value,
            phoneCountryCode: phoneCountryCode.value,
            publicBaseUrl: publicBaseUrl.value,
            otaBaseUrl: otaBaseUrl.value,
            logLevel: logLevel.value,
            autoRestart: system.autoRestart ?? DEFAULTS.autoRestart,
            restartSchedule: system.restartSchedule || DEFAULTS.restartSchedule,
            backupConfig: system.backupConfig ?? DEFAULTS.backupConfig,
            deviceStatusRefreshMs: deviceStatusRefresh.value,
            deviceStatusRefreshSeconds: Math.round(deviceStatusRefresh.value / 1000),
            ...normalizedStatusWatch,
            logRetentionDays: logRetention.value,
            platform: process.platform,
            nodeVersion: process.version,
            cpu: os.cpus()?.length || 0,
            memory: process.memoryUsage()
        },
        effective,
        environmentOverrides: buildEnvironmentSummary(effective)
    };
}

async function saveSystemSettings(db, input, userId = null) {
    if (!db || typeof db.run !== 'function') {
        throw new Error('Database not available');
    }

    const current = await getEffectiveSystemSettings(db);
    const next = {
        deviceName: String(input.deviceName || current.system.deviceName || 'Dashboard').trim() || 'Dashboard',
        timezone: normalizeTimezone(input.timezone, current.system.timezone || DEFAULTS.timezone),
        logLevel: normalizeLogLevel(input.logLevel, current.system.logLevel),
        autoRestart: !!input.autoRestart,
        restartSchedule: String(input.restartSchedule || DEFAULTS.restartSchedule).trim(),
        backupConfig: !!input.backupConfig,
        deviceStatusRefreshMs: parsePositiveInt(input.deviceStatusRefreshMs, current.system.deviceStatusRefreshMs, { min: 5000, max: 3600000 }),
        logRetentionDays: parsePositiveInt(input.logRetentionDays, current.system.logRetentionDays, { min: 1, max: 3650 }),
        ...normalizeStatusWatchSettings(input, current.system)
    };

    await db.run(
        `INSERT INTO settings (key, value, type, category, description, updated_at, updated_by)
         VALUES ('system', ?, 'json', 'system', 'Dashboard system settings', CURRENT_TIMESTAMP, ?)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             type = excluded.type,
             category = excluded.category,
             description = excluded.description,
             updated_at = excluded.updated_at,
             updated_by = excluded.updated_by`,
        [JSON.stringify(next), userId]
    );

    await db.run(
        `INSERT INTO settings (key, value, type, category, description, updated_at, updated_by)
         VALUES ('device_status_refresh_ms', ?, 'number', 'performance', 'Device status auto refresh interval in milliseconds', CURRENT_TIMESTAMP, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [String(next.deviceStatusRefreshMs), userId]
    );

    await db.run(
        `INSERT INTO settings (key, value, type, category, description, updated_at, updated_by)
         VALUES ('log_retention_days', ?, 'number', 'system', 'Days to keep log files', CURRENT_TIMESTAMP, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [String(next.logRetentionDays), userId]
    );

    await db.run(
        `INSERT INTO settings (key, value, type, category, description, updated_at, updated_by)
         VALUES ('status_watch_interval_ms', ?, 'number', 'performance', 'Device status-watch interval in milliseconds', CURRENT_TIMESTAMP, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [String(next.statusWatchIntervalMs), userId]
    );

    await db.run(
        `INSERT INTO settings (key, value, type, category, description, updated_at, updated_by)
         VALUES ('status_watch_ttl_ms', ?, 'number', 'performance', 'Device status-watch TTL in milliseconds', CURRENT_TIMESTAMP, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [String(next.statusWatchTtlMs), userId]
    );

    await db.run(
        `INSERT INTO settings (key, value, type, category, description, updated_at, updated_by)
         VALUES ('status_watch_refresh_ms', ?, 'number', 'performance', 'Dashboard status-watch refresh cadence in milliseconds', CURRENT_TIMESTAMP, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [String(next.statusWatchRefreshMs), userId]
    );

    await db.run(
        `INSERT INTO settings (key, value, type, category, description, updated_at, updated_by)
         VALUES ('timezone', ?, 'string', 'general', 'System timezone', CURRENT_TIMESTAMP, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [next.timezone, userId]
    );

    const effectiveSystem = await getEffectiveSystemSettings(db);
    return {
        ...effectiveSystem,
        savedSystem: next
    };
}

function pruneLogFiles(logsDir, retentionDays, logger = null) {
    const safeDays = parsePositiveInt(retentionDays, DEFAULTS.logRetentionDays, { min: 1, max: 3650 });
    const cutoff = Date.now() - (safeDays * 24 * 60 * 60 * 1000);
    if (!fs.existsSync(logsDir)) {
        return { deleted: 0, retentionDays: safeDays };
    }

    let deleted = 0;
    for (const entry of fs.readdirSync(logsDir)) {
        if (!/\.log$/i.test(entry)) continue;
        const fullPath = path.join(logsDir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs >= cutoff) continue;
        fs.unlinkSync(fullPath);
        deleted += 1;
        logger?.info?.(`Deleted expired log file ${entry}`);
    }

    return { deleted, retentionDays: safeDays };
}

module.exports = {
    DEFAULTS,
    getEffectiveSystemSettings,
    normalizeTimezone,
    normalizeStatusWatchSettings,
    saveSystemSettings,
    pruneLogFiles
};
