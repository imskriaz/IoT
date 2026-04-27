'use strict';

const zlib = require('zlib');

const DEFAULT_MQTT_PORT = 1883;
const DEFAULT_TOPIC_PREFIX = 'device';
function clean(value) {
    return String(value || '').trim();
}

function normalizeTopicPrefix(value) {
    return clean(value)
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\/+/g, '/') || DEFAULT_TOPIC_PREFIX;
}

function normalizeTransportMode(value) {
    const mode = clean(value).toLowerCase();
    if (mode === 'http') return 'http';
    if (mode === 'auto') return 'auto';
    return 'mqtt';
}

function normalizeProtocol(value) {
    return clean(value).toLowerCase() === 'mqtts' ? 'mqtts' : 'mqtt';
}

function positiveInt(value, fallback) {
    const parsed = parseInt(value, 10);
    return parsed > 0 ? parsed : fallback;
}

function compactProvisioningPayload(payload) {
    const mqtt = payload?.mqtt || {};
    const device = payload?.device || {};
    const transportMode = normalizeTransportMode(payload?.transport?.mode || payload?.transport_mode || 'mqtt');

    const compact = {
        tm: transportMode,
        di: clean(device.id || payload?.device_id || '')
    };

    const topicPrefix = normalizeTopicPrefix(device.topic_prefix || payload?.topic_prefix || DEFAULT_TOPIC_PREFIX);
    if (topicPrefix !== DEFAULT_TOPIC_PREFIX) {
        compact.tp = topicPrefix;
    }

    const serverUrl = clean(payload?.server_url);
    const apiKey = String(payload?.api_key || '');
    if ((transportMode === 'http' || transportMode === 'auto') && serverUrl) {
        compact.su = serverUrl;
    }
    if ((transportMode === 'http' || transportMode === 'auto') && apiKey) {
        compact.ak = apiKey;
    }
    if (transportMode === 'http') {
        return compact;
    }

    const mqttHost = clean(mqtt.host || mqtt.ip || payload?.mqtt_host || payload?.broker_host || '');
    const mqttPort = positiveInt(mqtt.port || payload?.mqtt_port || payload?.broker_port, DEFAULT_MQTT_PORT);
    const mqttProtocol = normalizeProtocol(mqtt.protocol || payload?.broker_protocol || 'mqtt');
    const mqttUsername = clean(mqtt.username || payload?.mqtt_user || payload?.username || '');
    const mqttPassword = String(mqtt.password ?? payload?.mqtt_pass ?? payload?.password ?? '');

    if (mqttHost) compact.mh = mqttHost;
    if (mqttPort !== DEFAULT_MQTT_PORT) compact.mp = mqttPort;
    if (mqttProtocol !== 'mqtt') compact.ml = mqttProtocol;
    if (mqttUsername) compact.mu = mqttUsername;
    if (mqttPassword) compact.mw = mqttPassword;

    return compact;
}

function encodeProvisioningToken(payload) {
    const compact = compactProvisioningPayload(payload);
    const compressed = zlib.deflateRawSync(Buffer.from(JSON.stringify(compact), 'utf8'), { level: 9 });
    return compressed.toString('base64url');
}

module.exports = {
    encodeProvisioningToken
};
