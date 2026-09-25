'use strict';

const DEFAULT_SETUP_AP_IP = '192.168.4.1';
const DEFAULT_SETUP_AP_PREFIX = 'cfg';
const DEFAULT_BLE_NAME_PREFIXES = ['Device-Setup', 'ESP32-Setup'];

function parseBleNamePrefixes(rawValue) {
    return String(rawValue || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}

const setupApIp = (process.env.DEVICE_SETUP_AP_IP || DEFAULT_SETUP_AP_IP).trim();
const setupApPrefix = (process.env.DEVICE_SETUP_AP_PREFIX || DEFAULT_SETUP_AP_PREFIX).trim();
const bleNamePrefixes = parseBleNamePrefixes(process.env.DEVICE_BLE_NAME_PREFIXES);
const normalizedSetupApPrefix = setupApPrefix || DEFAULT_SETUP_AP_PREFIX;

module.exports = {
    setupApIp: setupApIp || DEFAULT_SETUP_AP_IP,
    setupApPrefix: normalizedSetupApPrefix,
    setupApLabel: `${normalizedSetupApPrefix}-<MAC4>`,
    setupApExampleLabel: `${normalizedSetupApPrefix}-XXXX`,
    bleNamePrefixes: bleNamePrefixes.length ? bleNamePrefixes : DEFAULT_BLE_NAME_PREFIXES
};
