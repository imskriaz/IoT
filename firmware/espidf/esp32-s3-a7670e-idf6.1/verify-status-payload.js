#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

function readPayload(filePath) {
    const resolved = path.resolve(filePath);
    let raw;
    try {
        raw = fs.readFileSync(resolved, 'utf8');
    } catch (error) {
        fail(`cannot read payload: ${error.message}`);
    }

    try {
        return JSON.parse(raw);
    } catch (error) {
        fail(`invalid JSON payload: ${error.message}`);
    }
}

function hasAnyKey(object, keys) {
    return keys.some((key) => object[key] !== undefined && object[key] !== null && object[key] !== '');
}

function isIpv4(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return false;
    }

    const parts = value.split('.');
    return parts.length === 4 && parts.every((part) =>
        /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255
    );
}

function validate(payload, options = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        fail('payload must be a JSON object');
    }

    const hasIdentity = hasAnyKey(payload, ['device_id', 'deviceId', 'imei']);
    if (!hasIdentity) {
        fail('payload missing device identity fields');
    }

    const hasStatusShape = hasAnyKey(payload, [
        'mobile',
        'wifi',
        'system',
        'modem_signal',
        'modem_operator_name',
        'modem_subscriber_number',
        'active_path',
        'uptime_ms',
        'uptime'
    ]);

    if (!hasStatusShape) {
        fail('payload does not look like a device status message');
    }

    if ((options.requireOtaIdentity || payload.boot_id !== undefined) &&
        !/^[a-f0-9]{16}$/i.test(String(payload.boot_id || ''))) {
        fail('payload has invalid or missing boot_id');
    }
    if ((options.requireOtaIdentity || payload.firmware_elf_sha256 !== undefined) &&
        !/^[a-f0-9]{64}$/.test(String(payload.firmware_elf_sha256 || ''))) {
        fail('payload has invalid or missing firmware_elf_sha256');
    }
    if ((options.requireOtaIdentity || payload.ota_slot !== undefined) &&
        !['ota_0', 'ota_1'].includes(payload.ota_slot)) {
        fail('payload has invalid or missing ota_slot');
    }
    if ((options.requireOtaIdentity || payload.ota_state !== undefined) &&
        !['new', 'pending_verify', 'valid', 'invalid', 'aborted', 'undefined'].includes(payload.ota_state)) {
        fail('payload has invalid or missing ota_state');
    }

    if (payload.status_sequence !== undefined &&
        (!Number.isSafeInteger(payload.status_sequence) || payload.status_sequence < 0)) {
        fail('payload has invalid status_sequence');
    }
    if (payload.uptime_ms !== undefined &&
        (!Number.isFinite(payload.uptime_ms) || payload.uptime_ms < 0)) {
        fail('payload has invalid uptime_ms');
    }

    for (const field of ['modem_data_session_open', 'modem_ip_bearer_ready',
        'wifi_connected', 'wifi_ip_assigned', 'mqtt_connected', 'mqtt_subscribed']) {
        if (payload[field] !== undefined && typeof payload[field] !== 'boolean') {
            fail(`payload has invalid ${field}`);
        }
    }

    for (const field of ['modem_data_ip', 'modem_ip_address', 'modem_pdp_ip_address']) {
        if (payload[field] !== undefined && payload[field] !== '' && !isIpv4(payload[field])) {
            fail(`payload has invalid ${field}`);
        }
    }

    if (payload.modem_ip_bearer_ready === true) {
        if ((options.requireOtaIdentity || payload.modem_data_session_open !== undefined) &&
            payload.modem_data_session_open !== true) {
            fail('modem_ip_bearer_ready requires modem_data_session_open');
        }
        const dataIp = payload.modem_data_ip || payload.modem_ip_address || '';
        if (!isIpv4(dataIp) || dataIp === '0.0.0.0' || dataIp === '255.255.255.255') {
            fail('modem_ip_bearer_ready requires a valid data IP');
        }
    }
    if (payload.mqtt_subscribed === true && payload.mqtt_connected === false) {
        fail('mqtt_subscribed requires mqtt_connected');
    }
}

const args = process.argv.slice(2);
const requireOtaIdentity = args.includes('--require-ota-identity');
const payloadPath = args.find((arg) => !arg.startsWith('--'));
if (!payloadPath) {
    fail('usage: verify-status-payload.js [--require-ota-identity] <payload.json>');
}

const payload = readPayload(payloadPath);
validate(payload, { requireOtaIdentity });
process.stdout.write('VALID PAYLOAD\n');
