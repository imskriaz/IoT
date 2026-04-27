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

function validate(payload) {
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
}

const payloadPath = process.argv[2];
if (!payloadPath) {
    fail('usage: verify-status-payload.js <payload.json>');
}

const payload = readPayload(payloadPath);
validate(payload);
process.stdout.write('VALID PAYLOAD\n');
