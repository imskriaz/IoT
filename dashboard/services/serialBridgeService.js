/**
 * USB Serial Bridge Service
 *
 * Polls the ESP32 provisioning console over USB serial and translates the
 * console status commands into the dashboard runtime model when MQTT status is
 * absent or stale.
 */

'use strict';

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const modemService = require('./modemService');
const { buildDashboardDeviceStatus } = require('../utils/dashboardStatus');
const { DEFAULT_DEVICE_ID } = require('../config/device');

const POLL_INTERVAL_MS = 20_000;
const COMMAND_DEFAULT_WAIT_MS = 2200;
const SHOW_WAIT_MS = 3600;
const MODEM_WAIT_MS = 2600;
const IMEI_WAIT_MS = 3500;
const BATTERY_WAIT_MS = 2600;
const TEMP_WAIT_MS = 2600;
const OPERATOR_WAIT_MS = 3200;
const SMS_WAIT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const STATUS_FALLBACK_ENABLED = String(process.env.SERIAL_BRIDGE_STATUS_FALLBACK || '').toLowerCase() === 'true';
const CONFIG_WAIT_MS = 3200;
const STATUS_JSON_WAIT_MS = 6000;

function yesNoToBool(value) {
    if (value === 'yes') return true;
    if (value === 'no') return false;
    return undefined;
}

function numberOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function cleanValue(value) {
    if (value == null) return '';
    const text = String(value).trim();
    if (text === '<unset>' || text === '<none>' || text === '<unknown>') {
        return '';
    }
    return text;
}

function parseConsoleStatusLine(prefix, line) {
    if (!line || !line.startsWith(prefix)) return null;

    let body = line.slice(prefix.length).trim();
    const parsed = {};

    if (body.startsWith('last_response=')) {
        parsed.last_response = cleanValue(body.slice('last_response='.length));
        return parsed;
    }

    const trailingKeys = ['last_response'];
    for (const key of trailingKeys) {
        const marker = ` ${key}=`;
        const index = body.indexOf(marker);
        if (index >= 0) {
            parsed[key] = cleanValue(body.slice(index + marker.length));
            body = body.slice(0, index).trim();
        }
    }

    for (const token of body.split(/\s+/)) {
        const eqIndex = token.indexOf('=');
        if (eqIndex <= 0) continue;
        const key = token.slice(0, eqIndex);
        const value = token.slice(eqIndex + 1);
        parsed[key] = cleanValue(value);
    }

    return parsed;
}

function parseStatusJsonLine(line) {
    const text = String(line || '').trim();
    if (!text.startsWith('STATUS_JSON ')) {
        return null;
    }

    try {
        const parsed = JSON.parse(text.slice('STATUS_JSON '.length));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
        return null;
    }
}

function findStatusJsonLine(...lineSets) {
    for (const lines of lineSets) {
        if (!Array.isArray(lines)) continue;
        for (let index = lines.length - 1; index >= 0; index--) {
            if (String(lines[index] || '').trim().startsWith('STATUS_JSON ')) {
                return lines[index];
            }
        }
    }
    return '';
}

function parseBatteryAtLines(lines) {
    if (!Array.isArray(lines)) return null;

    for (const line of lines) {
        const match = String(line || '').match(/\+CBC:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (!match) continue;

        const chargeState = Number(match[1]);
        const percent = Number(match[2]);
        const voltageMv = Number(match[3]);

        return {
            battery: Number.isFinite(percent) ? percent : null,
            voltageMv: Number.isFinite(voltageMv) ? voltageMv : null,
            charging: chargeState === 1
        };
    }

    return null;
}

function parseTemperatureAtLines(lines) {
    if (!Array.isArray(lines)) return null;

    for (const line of lines) {
        const match = String(line || '').match(/\+CPMUTEMP:\s*(-?\d+(?:\.\d+)?)/i);
        if (!match) continue;

        const temperature = Number(match[1]);
        return Number.isFinite(temperature) ? temperature : null;
    }

    return null;
}

function parseOperatorAtLines(lines) {
    if (!Array.isArray(lines)) return null;

    for (const line of lines) {
        const text = String(line || '');
        const match = text.match(/\+COPS:\s*\d+\s*,\s*(\d+)\s*,\s*(?:"([^\"]+)"|([^,\s]+))(?:\s*,\s*(\d+))?/i);
        if (!match) continue;

        const format = Number(match[1]);
        const quotedValue = cleanValue(match[2]);
        const bareValue = cleanValue(match[3]);
        const operator = quotedValue || bareValue;

        if (!operator) {
            continue;
        }

        return {
            operatorName: /[A-Za-z]/.test(operator) ? operator : null,
            operatorCode: format === 2 ? operator : null
        };
    }

    return null;
}

function encodeConfigValue(value) {
    return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

function decodeConfigValue(value) {
    if (!value) return '';
    try {
        return Buffer.from(String(value), 'base64').toString('utf8');
    } catch (_) {
        return '';
    }
}

class SerialBridgeService extends EventEmitter {
    constructor() {
        super();
        this._app = null;
        this._port = null;
        this._parser = null;
        this._fallbackDeviceId = '';
        this._pollTimer = null;
        this._heartbeatTimer = null;
        this._retryTimer = null;
        this._intentionalClose = false;
        this._collector = null;
        this._commandQueue = Promise.resolve();
        this._cachedImei = '';
        this._retryOnIntentionalClose = true;
        this._activePortPath = '';
        this._commandModeDepth = 0;
        this._forcePollOnce = false;
    }

    async start(app) {
        this._app = app;
        await this._refreshFallbackDeviceId();

        const portPath = process.env.SERIAL_PORT;
        const baud = parseInt(process.env.SERIAL_BAUD || '115200', 10);

        if (!portPath) {
            logger.info('[SerialBridge] SERIAL_PORT not set; bridge disabled');
            return;
        }

        if (!STATUS_FALLBACK_ENABLED) {
            logger.info('[SerialBridge] Passive USB status fallback disabled; MQTT remains the only online source');
            return;
        }

        if (!this._forcePollOnce && !this._bridgeNeeded()) {
            logger.debug('[SerialBridge] MQTT/device healthy; bridge idle and serial port left free');
            this._scheduleRetry(120_000);
            return;
        }

        if (this._port?.isOpen) {
            return;
        }

        try {
            await this._openPort({ enablePolling: true, allowRetry: true });
        } catch (err) {
            const message = String(err?.message || err || 'unknown error');
            const code = String(err?.code || '').toUpperCase();
            const unavailable = code === 'EACCES'
                || code === 'ENOENT'
                || /access denied/i.test(message)
                || /file not found/i.test(message);

            logger[unavailable ? 'warn' : 'error']('[SerialBridge] Failed to start:', message);
        }
    }

    isStatusFallbackEnabled() {
        return STATUS_FALLBACK_ENABLED;
    }

    stop() {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
        clearTimeout(this._retryTimer);
        this._retryTimer = null;

        if (this._port?.isOpen) {
            this._intentionalClose = true;
            this._port.close();
        }
    }

    async sendSms(to, message) {
        if (!this._port?.isOpen) {
            throw new Error('Serial bridge unavailable');
        }

        const lines = await this._runConsoleCommand(`sms_send ${to} ${message}`, SMS_WAIT_MS);
        const resultLine = lines.find(line => line.startsWith('sms_send '));
        if (!resultLine) {
            throw new Error('No SMS response from device');
        }

        const parsed = parseConsoleStatusLine('sms_send', resultLine) || {};
        const detail = cleanValue(parsed.detail) || 'SMS send failed';
        const result = numberOrNull(parsed.result);
        if (result === 0 || /timeout|failed|rejected/i.test(detail)) {
            throw new Error(detail);
        }

        return true;
    }

    async applyRuntimeConfig(config = {}, options = {}) {
        const parts = ['cfg_set'];

        if (config.deviceIdOverride !== undefined) {
            parts.push(`device_id_override_b64=${encodeConfigValue(config.deviceIdOverride)}`);
        }
        if (config.wifiSsid !== undefined) {
            parts.push(`wifi_ssid_b64=${encodeConfigValue(config.wifiSsid)}`);
        }
        if (config.wifiPassword !== undefined) {
            parts.push(`wifi_password_b64=${encodeConfigValue(config.wifiPassword)}`);
        }
        if (config.modemApn !== undefined) {
            parts.push(`modem_apn_b64=${encodeConfigValue(config.modemApn)}`);
        }
        if (config.mqttUri !== undefined) {
            parts.push(`mqtt_uri_b64=${encodeConfigValue(config.mqttUri)}`);
        }
        if (config.mqttUsername !== undefined) {
            parts.push(`mqtt_username_b64=${encodeConfigValue(config.mqttUsername)}`);
        }
        if (config.mqttPassword !== undefined) {
            parts.push(`mqtt_password_b64=${encodeConfigValue(config.mqttPassword)}`);
        }
        if (config.mqttEnabled !== undefined) {
            parts.push(`mqtt_enabled=${config.mqttEnabled ? 'yes' : 'no'}`);
        }
        if (config.modemFallbackEnabled !== undefined) {
            parts.push(`modem_fallback_enabled=${config.modemFallbackEnabled ? 'yes' : 'no'}`);
        }

        if (parts.length === 1) {
            throw new Error('No runtime config fields supplied');
        }

        return this._withCommandPort(async () => {
            const lines = await this._runConsoleCommand(parts.join(' '), CONFIG_WAIT_MS);
            const resultLine = lines.find(line => line.startsWith('cfg_apply '));

            if (!resultLine) {
                throw new Error('No config apply response from device');
            }

            const parsed = parseConsoleStatusLine('cfg_apply', resultLine) || {};
            if (yesNoToBool(parsed.ok) !== true) {
                throw new Error(cleanValue(parsed.detail) || cleanValue(parsed.code) || 'Device rejected config update');
            }

            return {
                ok: true,
                restartRequired: yesNoToBool(parsed.restart_required) === true,
                applied: cleanValue(parsed.applied)
                    .split(',')
                    .map(value => value.trim())
                    .filter(Boolean)
            };
        }, options);
    }

    async getRuntimeConfig(options = {}) {
        return this._withCommandPort(async () => {
            const lines = await this._runConsoleCommand('cfg_get', CONFIG_WAIT_MS);
            const resultLine = lines.find(line => line.startsWith('cfg_status '));

            if (!resultLine) {
                throw new Error('No config status response from device');
            }

            const parsed = parseConsoleStatusLine('cfg_status', resultLine) || {};
            if (yesNoToBool(parsed.ok) !== true) {
                throw new Error(cleanValue(parsed.detail) || cleanValue(parsed.code) || 'Device rejected config status request');
            }

            return {
                schemaVersion: numberOrNull(parsed.schema),
                deviceIdOverride: decodeConfigValue(parsed.device_id_override_b64),
                wifiSsid: decodeConfigValue(parsed.wifi_ssid_b64),
                wifiPasswordSet: yesNoToBool(parsed.wifi_password_set) === true,
                modemApn: decodeConfigValue(parsed.modem_apn_b64),
                mqttEnabled: yesNoToBool(parsed.mqtt_enabled),
                modemFallbackEnabled: yesNoToBool(parsed.modem_fallback_enabled),
                mqttUri: decodeConfigValue(parsed.mqtt_uri_b64),
                mqttUsername: decodeConfigValue(parsed.mqtt_username_b64),
                mqttPasswordSet: yesNoToBool(parsed.mqtt_password_set) === true
            };
        }, options);
    }

    _bridgeNeeded() {
        if (!STATUS_FALLBACK_ENABLED) {
            return false;
        }

        const deviceId = this._getTargetDeviceId();
        const mqttHealthy = !!global.mqttService?.connected;
        const mqttDeviceOnline = deviceId ? !!global.mqttService?.isDeviceOnline?.(deviceId) : false;
        const deviceBusy = !!global.mqttService?.isDeviceBusy?.(deviceId);
        if (deviceBusy) return false;
        return !(mqttHealthy && mqttDeviceOnline);
    }

    _getTargetDeviceId() {
        const devices = modemService.getAllDevices();
        const online = devices.find(device => device.online);
        if (online?.id) return online.id;
        if (devices.length === 1 && devices[0]?.id) return devices[0].id;
        return this._fallbackDeviceId || process.env.DEVICE_ID || process.env.DEFAULT_DEVICE_ID || DEFAULT_DEVICE_ID || '';
    }

    async _refreshFallbackDeviceId() {
        const db = this._app?.locals?.db;
        if (!db) return;

        try {
            const rows = await db.all(`
                SELECT id, status, last_seen
                FROM devices
                ORDER BY
                    CASE WHEN status = 'online' THEN 0 ELSE 1 END,
                    datetime(last_seen) DESC,
                    id ASC
                LIMIT 2
            `);

            if (!Array.isArray(rows) || rows.length === 0) {
                this._fallbackDeviceId = '';
                return;
            }

            if (rows.length === 1) {
                this._fallbackDeviceId = String(rows[0].id || '').trim();
                return;
            }

            const onlineRows = rows.filter(row => String(row.status || '').toLowerCase() === 'online');
            if (onlineRows.length === 1) {
                this._fallbackDeviceId = String(onlineRows[0].id || '').trim();
            }
        } catch (error) {
            logger.warn('[SerialBridge] Failed to resolve fallback device id:', error.message);
        }
    }

    async _ensureTargetDeviceId() {
        let deviceId = this._getTargetDeviceId();
        if (deviceId) {
            return deviceId;
        }

        await this._refreshFallbackDeviceId();
        return this._getTargetDeviceId();
    }

    _scheduleRetry(delayMs) {
        clearTimeout(this._retryTimer);
        this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            if (!this._app) return;
            this.start(this._app).catch(err => logger.warn('[SerialBridge] Restart error:', err.message));
        }, delayMs);
    }

    _writeLine(text) {
        if (this._port?.isOpen) {
            this._port.write(text + '\r\n');
        }
    }

    async _withCommandPort(callback, options = {}) {
        const requestedPortPath = options.portPath || process.env.SERIAL_PORT;
        let alreadyOpen = !!this._port?.isOpen;
        const pollingWasActive = alreadyOpen && (!!this._pollTimer || !!this._heartbeatTimer);

        if (alreadyOpen && requestedPortPath && this._activePortPath && requestedPortPath !== this._activePortPath) {
            throw new Error(`Serial bridge already open on ${this._activePortPath}`);
        }

        this._commandModeDepth += 1;

        if (pollingWasActive) {
            await this._releasePort('switching to command mode');
            alreadyOpen = false;
        }

        if (!alreadyOpen) {
            await this._openPort({ enablePolling: false, allowRetry: false, portPath: requestedPortPath });
        }

        try {
            return await callback();
        } finally {
            this._commandModeDepth = Math.max(0, this._commandModeDepth - 1);

            if (!alreadyOpen) {
                await this._releasePort('command complete');
            }

            if (pollingWasActive && STATUS_FALLBACK_ENABLED && this._app) {
                this._forcePollOnce = true;
                this._scheduleRetry(1500);
            }
        }
    }

    async _openPort({ enablePolling = false, allowRetry = false, portPath = process.env.SERIAL_PORT } = {}) {
        const baud = parseInt(process.env.SERIAL_BAUD || '115200', 10);

        if (!portPath) {
            throw new Error('SERIAL_PORT not set');
        }
        if (this._port?.isOpen) {
            return;
        }

        clearTimeout(this._retryTimer);
        this._retryTimer = null;
        this._retryOnIntentionalClose = enablePolling;

        logger.info(`[SerialBridge] Opening ${portPath} @ ${baud} baud`);

        try {
            this._port = new SerialPort({ path: portPath, baudRate: baud, autoOpen: false });
            this._parser = this._port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

            this._parser.on('data', line => this._onLine(line));
            this._port.on('error', err => logger.error('[SerialBridge] Port error:', err.message));
            this._port.on('close', () => {
                logger.warn('[SerialBridge] Port closed');
                const intentional = this._intentionalClose;
                const retryOnIntentionalClose = this._retryOnIntentionalClose;
                this._intentionalClose = false;
                this._collector = null;
                clearInterval(this._pollTimer);
                this._pollTimer = null;
                clearInterval(this._heartbeatTimer);
                this._heartbeatTimer = null;
                this._port = null;
                this._parser = null;
                this._activePortPath = '';
                this._commandQueue = Promise.resolve();
                if (!intentional || retryOnIntentionalClose) {
                    this._scheduleRetry(intentional ? 30_000 : 10_000);
                }
            });

            await new Promise((resolve, reject) => this._port.open(err => err ? reject(err) : resolve()));
            this._activePortPath = portPath;
            logger.info('[SerialBridge] Port open');

            await this._sleep(1500);
            await this._primeConsole();

            if (enablePolling) {
                await this._pollDeviceSnapshot();
                this._heartbeatTimer = setInterval(() => {
                    this._markDeviceAlive('serial_console_heartbeat');
                }, HEARTBEAT_INTERVAL_MS);
                this._pollTimer = setInterval(() => {
                    this._pollDeviceSnapshot().catch(err => logger.warn('[SerialBridge] Poll error:', err.message));
                }, POLL_INTERVAL_MS);
                this._heartbeatTimer.unref?.();
                this._pollTimer.unref?.();
            }
        } catch (error) {
            if (allowRetry) {
                const message = String(error?.message || error || 'unknown error');
                const code = String(error?.code || '').toUpperCase();
                const unavailable = code === 'EACCES'
                    || code === 'ENOENT'
                    || /access denied/i.test(message)
                    || /file not found/i.test(message);
                this._scheduleRetry(unavailable ? 60_000 : 10_000);
            }
            throw error;
        }
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async _primeConsole() {
        this._writeLine('');
        await this._sleep(500);
    }

    _sanitizeLine(line, command) {
        let text = String(line || '')
            .replace(/\u001b\[[0-9;]*m/g, '')
            .replace(/\r/g, '')
            .trim();

        if (!text) return '';
        text = text.replace(/^cfg>\s*/g, '').trim();
        if (!text) return '';
        if (command && text === command) return '';
        return text;
    }

    _onLine(line) {
        if (!this._collector) return;

        const text = this._sanitizeLine(line, this._collector.command);
        if (!text) return;
        this._collector.lines.push(text);
    }

    _runConsoleCommand(command, waitMs = COMMAND_DEFAULT_WAIT_MS) {
        const run = this._commandQueue.then(async () => {
            if (!this._port?.isOpen) {
                throw new Error('Serial port is not open');
            }

            this._collector = { command, lines: [] };
            this._writeLine(command);
            await this._sleep(waitMs);
            const lines = [...(this._collector?.lines || [])];
            this._collector = null;
            return lines;
        });

        this._commandQueue = run.catch(() => {});
        return run;
    }

    async refreshStatusSnapshot(options = {}) {
        if (!STATUS_FALLBACK_ENABLED) {
            throw new Error('Serial status fallback disabled');
        }

        const deviceId = options.deviceId || await this._ensureTargetDeviceId();
        if (!deviceId) {
            throw new Error('No target device id resolved yet');
        }

        return this._withCommandPort(async () => this._captureSnapshot(deviceId), options);
    }

    async _captureSnapshot(deviceId) {
        if (!deviceId) {
            throw new Error('Device id required for snapshot capture');
        }

        const initialStatusJsonLines = await this._runConsoleCommand('status_json', STATUS_JSON_WAIT_MS).catch(() => []);
        const fastStatusJsonLine = findStatusJsonLine(initialStatusJsonLines);
        if (fastStatusJsonLine) {
            const snapshot = this._buildSnapshot({
                statusJsonLine: fastStatusJsonLine,
                showLines: [],
                wifiLine: '',
                mqttLine: '',
                modemLine: '',
                storageLine: '',
                imeiLine: '',
                batteryLines: [],
                temperatureLines: [],
                operatorLines: []
            });

            modemService.updateDeviceStatus(deviceId, snapshot);
            logger.info('[SerialBridge] Snapshot updated', {
                deviceId,
                wifiConnected: snapshot.wifi_connected ?? snapshot.wifi?.connected ?? null,
                activePath: snapshot.active_path || snapshot.status?.active_path || null,
                operator: snapshot.modem_operator_name || snapshot.mobile?.operator || null,
                ip: snapshot.modem_data_ip || snapshot.mobile?.ipAddress || snapshot.wifi_ip_address || snapshot.wifi?.ipAddress || null
            });
            this._markDeviceAlive('serial_console_status');
            return snapshot;
        }

        const [statusJsonLines, showLines, wifiLines, mqttLines, modemLines, storageLines, batteryLines, temperatureLines] = await Promise.all([
            this._runConsoleCommand('status_json', STATUS_JSON_WAIT_MS).catch(() => []),
            this._runConsoleCommand('show', SHOW_WAIT_MS),
            this._runConsoleCommand('wifi_status'),
            this._runConsoleCommand('mqtt_status'),
            this._runConsoleCommand('modem_status', MODEM_WAIT_MS),
            this._runConsoleCommand('storage_status'),
            this._runConsoleCommand('modem_at AT+CBC', BATTERY_WAIT_MS),
            this._runConsoleCommand('modem_at AT+CPMUTEMP', TEMP_WAIT_MS)
        ]);

        const operatorFormatLines = await this._runConsoleCommand('modem_at AT+COPS=3,0', OPERATOR_WAIT_MS).catch(() => []);
        const operatorLines = await this._runConsoleCommand('modem_at AT+COPS?', OPERATOR_WAIT_MS).catch(() => []);

        let imeiLine = '';
        if (!this._cachedImei) {
            const imeiLines = await this._runConsoleCommand('modem_at AT+GSN', IMEI_WAIT_MS);
            imeiLine = imeiLines.find(line => line.startsWith('modem_at ')) || '';
        }

        const snapshot = this._buildSnapshot({
            statusJsonLine: findStatusJsonLine(statusJsonLines, showLines, wifiLines, mqttLines, modemLines, storageLines),
            showLines,
            wifiLine: wifiLines.find(line => line.startsWith('wifi_status ')),
            mqttLine: mqttLines.find(line => line.startsWith('mqtt_status ')),
            modemLine: modemLines.find(line => line.startsWith('modem_status ')),
            storageLine: storageLines.find(line => line.startsWith('storage_status ')),
            imeiLine,
            batteryLines,
            temperatureLines,
            operatorLines: [...operatorFormatLines, ...operatorLines]
        });

        if (!snapshot.active_path && !snapshot.status?.active_path && !snapshot.wifi && !snapshot.status?.mqtt && !snapshot.mobile) {
            throw new Error('No usable serial status data');
        }

        modemService.updateDeviceStatus(deviceId, snapshot);
        logger.info('[SerialBridge] Snapshot updated', {
            deviceId,
            wifiConnected: snapshot.wifi?.connected ?? null,
            activePath: snapshot.status?.active_path || null,
            operator: snapshot.mobile?.operator || null,
            ip: snapshot.mobile?.ipAddress || snapshot.wifi?.ipAddress || null
        });
        this._markDeviceAlive('serial_console_status');
        return snapshot;
    }

    async _pollDeviceSnapshot() {
        if (this._commandModeDepth > 0) {
            return;
        }

        const forcePoll = this._forcePollOnce;
        this._forcePollOnce = false;

        if (!forcePoll && !this._bridgeNeeded()) {
            await this._releasePort('MQTT/device healthy');
            return;
        }

        const deviceId = await this._ensureTargetDeviceId();
        if (!deviceId) {
            logger.warn('[SerialBridge] No target device id resolved yet; skipping poll');
            return;
        }

        await this._captureSnapshot(deviceId);
    }

    _buildSnapshot({ statusJsonLine, showLines, wifiLine, mqttLine, modemLine, storageLine, imeiLine, batteryLines, temperatureLines, operatorLines }) {
        const statusJson = parseStatusJsonLine(statusJsonLine);
        const snapshot = statusJson ? { ...statusJson } : {};

        const showJsonLine = (showLines || []).find(line => line.startsWith('{') && line.endsWith('}'));
        if (showJsonLine) {
            try {
                const parsed = JSON.parse(showJsonLine);
                const meta = parsed.meta || {};
                const runtime = parsed.runtime || {};

                snapshot.wifi = {
                    connected: !!meta.wifi_connected,
                    ssid: cleanValue(meta.wifi_seen_ssid),
                    ipAddress: cleanValue(meta.wifi_ip),
                    configured: !!meta.wifi_configured,
                    lastDisconnectReason: Number(meta.wifi_disconnect_reason || 0),
                    lastDisconnectReasonText: cleanValue(meta.wifi_disconnect_reason_text)
                };

                snapshot.status = {
                    active_path: meta.wifi_connected
                        ? 'wifi'
                        : (runtime.modem_ip_bearer_ready ? 'modem' : null),
                    mqtt: {
                        configured: !!runtime.mqtt_configured,
                        running: !!runtime.mqtt_running,
                        connected: !!runtime.mqtt_connected,
                        subscribed: !!runtime.mqtt_subscribed,
                        reconnectCount: Number(runtime.mqtt_reconnect_count || 0),
                        publishedCount: Number(runtime.mqtt_published_count || 0),
                        publishFailures: Number(runtime.mqtt_publish_failures || 0),
                        commandMessages: Number(runtime.mqtt_command_messages || 0),
                        commandRejects: Number(runtime.mqtt_command_rejects || 0),
                        actionResultsPublished: Number(runtime.mqtt_action_results_published || 0),
                        actionResultFailures: Number(runtime.mqtt_action_result_failures || 0),
                        lastError: Number(runtime.mqtt_last_error || 0),
                        lastErrorText: cleanValue(runtime.mqtt_last_error_text)
                    }
                };
            } catch (error) {
                logger.warn('[SerialBridge] Failed to parse show JSON:', error.message);
            }
        }

        const wifi = parseConsoleStatusLine('wifi_status', wifiLine || '');
        if (wifi) {
            snapshot.wifi = {
                ...(snapshot.wifi || {}),
                mode: wifi.started === 'yes' ? 'sta' : (wifi.configured === 'yes' ? 'configured' : 'off'),
                configured: yesNoToBool(wifi.configured),
                started: yesNoToBool(wifi.started),
                connected: yesNoToBool(wifi.connected),
                ssid: cleanValue(wifi.ssid),
                ipAddress: cleanValue(wifi.ip),
                ipAssigned: cleanValue(wifi.ip) !== '',
                connectAttemptCount: Number(wifi.attempts || 0),
                reconnectCount: Number(wifi.reconnects || 0),
                lastDisconnectReason: Number(wifi.reason || 0),
                lastDisconnectReasonText: cleanValue(wifi.reason_text)
            };
        }

        const mqtt = parseConsoleStatusLine('mqtt_status', mqttLine || '');
        if (mqtt) {
            snapshot.status = {
                ...(snapshot.status || {}),
                mqtt: {
                    configured: yesNoToBool(mqtt.configured),
                    running: yesNoToBool(mqtt.running),
                    connected: yesNoToBool(mqtt.connected),
                    subscribed: yesNoToBool(mqtt.subscribed),
                    reconnectCount: Number(mqtt.reconnects || 0),
                    publishedCount: Number(mqtt.publishes || 0),
                    publishFailures: Number(mqtt.publish_failures || 0),
                    commandMessages: Number(mqtt.command_msgs || 0),
                    commandRejects: Number(mqtt.command_rejects || 0),
                    actionResultsPublished: Number(mqtt.action_results || 0),
                    actionResultFailures: Number(mqtt.action_failures || 0),
                    lastError: Number(mqtt.last_error || 0),
                    lastErrorText: cleanValue(mqtt.last_error_text)
                }
            };
        }

        const modem = parseConsoleStatusLine('modem_status', modemLine || '');
        if (modem) {
            const hasDataSession = yesNoToBool(modem.data_session) === true;
            const hasIpBearer = yesNoToBool(modem.ip_bearer) === true;
            const wifiConnected = snapshot.wifi?.connected === true;

            snapshot.mobile = {
                connected: yesNoToBool(modem.registered) === true,
                signalStrength: numberOrNull(cleanValue(modem.signal)),
                networkType: hasIpBearer ? 'Cellular' : (hasDataSession ? 'Cellular standby' : 'Cellular standby'),
                operator: cleanValue(modem.operator) || null,
                ipAddress: cleanValue(modem.data_ip)
            };

            snapshot.status = {
                ...(snapshot.status || {}),
                active_path: wifiConnected ? 'wifi' : (hasIpBearer ? 'modem' : snapshot.status?.active_path || null),
                transport: {
                    mqttCommandAccepting: !!snapshot.status?.mqtt?.connected && !!snapshot.status?.mqtt?.subscribed,
                    reason: 'usb_serial_console'
                }
            };

            snapshot.sim = {
                ready: yesNoToBool(modem.sim_ready),
                registered: yesNoToBool(modem.registered),
                telephonyEnabled: yesNoToBool(modem.telephony)
            };
        }

        const storage = parseConsoleStatusLine('storage_status', storageLine || '');
        if (storage) {
            snapshot.status = {
                ...(snapshot.status || {}),
                storage: {
                    enabled: yesNoToBool(storage.enabled),
                    running: yesNoToBool(storage.running),
                    mounted: yesNoToBool(storage.media),
                    mediaAvailable: yesNoToBool(storage.media),
                    bufferedOnly: yesNoToBool(storage.buffered_only),
                    queueDepth: Number(storage.records || 0),
                    pendingUploads: Number(storage.records || 0),
                    dropped: Number(storage.dropped || 0),
                    mountFailures: Number(storage.mount_failures || 0),
                    writeFailures: Number(storage.sd_write_failures || 0),
                    flushCount: Number(storage.sd_flushes || 0),
                    totalBytes: Number(storage.total || 0),
                    usedBytes: Number(storage.used || 0),
                    freeBytes: Number(storage.free || 0)
                }
            };
        }

        const battery = parseBatteryAtLines(batteryLines);
        const temperature = parseTemperatureAtLines(temperatureLines);
        const operatorInfo = parseOperatorAtLines(operatorLines);
        if (battery || temperature !== null) {
            snapshot.system = {
                ...(snapshot.system || {}),
                battery: battery?.battery ?? null,
                charging: typeof battery?.charging === 'boolean' ? battery.charging : null,
                voltage_mV: battery?.voltageMv ?? null,
                temperature
            };
        }

        if (!this._cachedImei && imeiLine) {
            const imeiMatch = imeiLine.match(/\b(\d{14,17})\b/);
            if (imeiMatch) {
                this._cachedImei = imeiMatch[1];
            }
        }

        if (this._cachedImei) {
            snapshot.imei = this._cachedImei;
        }

        if (operatorInfo) {
            snapshot.mobile = {
                ...(snapshot.mobile || {}),
                operator: operatorInfo.operatorCode || snapshot.mobile?.operator || null,
                operatorName: operatorInfo.operatorName || snapshot.mobile?.operatorName || null
            };
        }

        return snapshot;
    }

    _markDeviceAlive(reason) {
        const deviceId = this._getTargetDeviceId();
        if (!deviceId) return;
        const timestamp = new Date().toISOString();
        modemService.handleHeartbeat(deviceId);
        const status = modemService.getDeviceStatus(deviceId);
        const presentedStatus = buildDashboardDeviceStatus(status, status?.online);

        this._app?.locals?.db?.run(
            `UPDATE devices
             SET status = 'online',
                 last_seen = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [deviceId]
        ).catch?.(() => {});

        try {
            const room = global.io?.to?.('device:' + deviceId);
            const target = room?.emit ? room : global.io;
            target?.emit?.('device:status', {
                deviceId,
                ...presentedStatus,
                transport: {
                    ...(presentedStatus.transport || {}),
                    reason
                },
                timestamp
            });
        } catch (_) {}
    }

    async _releasePort(reason) {
        if (!this._port?.isOpen) return;
        logger.info(`[SerialBridge] Releasing serial port: ${reason}`);
        this._intentionalClose = true;
        await new Promise(resolve => {
            try {
                this._port.close(() => resolve());
            } catch (_) {
                resolve();
            }
        });
    }
}

module.exports = new SerialBridgeService();
