'use strict';

require('dotenv').config();

const mqtt = require('mqtt');

const MQTT_PROTOCOL = (process.env.MQTT_PROTOCOL || 'mqtt').trim();
const MQTT_HOST = (process.env.MQTT_HOST || 'localhost').trim();
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883', 10);
const MQTT_URL = `${MQTT_PROTOCOL}://${MQTT_HOST}:${MQTT_PORT}`;
const MQTT_USER = process.env.MQTT_USER || undefined;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || undefined;

const DEVICE_ID = (process.env.DEVICE_ID || process.argv[2] || '').trim();
const TARGET_PHONE = (process.env.TARGET_PHONE || '').trim();
const USSD_CODE = (process.env.USSD_CODE || '').trim();
const WIFI_SSID = (process.env.WIFI_SSID || '').trim();
const WIFI_PASSWORD = process.env.WIFI_PASSWORD || '';
const HOTSPOT_SSID = (process.env.HOTSPOT_SSID || '').trim();
const HOTSPOT_PASSWORD = process.env.HOTSPOT_PASSWORD || '';

const results = {};

function buildCommands() {
    const commands = [
        {
            name: 'GPS',
            topic: `device/${DEVICE_ID}/command/gps-location`,
            payload: {}
        }
    ];

    if (TARGET_PHONE) {
        commands.push(
            {
                name: 'SMS',
                topic: `device/${DEVICE_ID}/command/send-sms`,
                payload: { to: TARGET_PHONE, message: 'IoT Dashboard test - SMS OK' }
            },
            {
                name: 'DIAL',
                topic: `device/${DEVICE_ID}/command/make-call`,
                payload: { number: TARGET_PHONE }
            }
        );
    }

    if (USSD_CODE) {
        commands.push({
            name: 'USSD',
            topic: `device/${DEVICE_ID}/command/send-ussd`,
            payload: { code: USSD_CODE }
        });
    }

    if (WIFI_SSID) {
        commands.push({
            name: 'WIFI',
            topic: `device/${DEVICE_ID}/command/wifi-config`,
            payload: { ssid: WIFI_SSID, password: WIFI_PASSWORD, mode: 'sta' }
        });
    }

    if (HOTSPOT_SSID && HOTSPOT_PASSWORD) {
        commands.push({
            name: 'HOTSPOT',
            topic: `device/${DEVICE_ID}/command/hotspot`,
            payload: { enabled: true, ssid: HOTSPOT_SSID, password: HOTSPOT_PASSWORD }
        });
    }

    return commands;
}

function main() {
    const commands = buildCommands();
    const client = mqtt.connect(MQTT_URL, {
        clientId: `iot-test-cli-${Date.now()}`,
        username: MQTT_USER,
        password: MQTT_PASSWORD,
        connectTimeout: 8000
    });

    client.on('connect', () => {
        if (!DEVICE_ID) {
            console.error('Missing device ID. Set DEVICE_ID or pass it as the first CLI argument.');
            client.end(true);
            process.exit(1);
        }

        if (!commands.length) {
            console.error('No commands enabled. Set TARGET_PHONE, USSD_CODE, WIFI_SSID, or HOTSPOT_SSID/HOTSPOT_PASSWORD.');
            client.end(true);
            process.exit(1);
        }

        console.log(`MQTT connected to ${MQTT_URL}`);
        client.subscribe(`device/${DEVICE_ID}/command/response`);
        client.subscribe(`device/${DEVICE_ID}/gps/location`);
        client.subscribe(`device/${DEVICE_ID}/ussd/response`);
        client.subscribe(`device/${DEVICE_ID}/sms/status`);

        commands.forEach((command, index) => {
            setTimeout(() => {
                const messageId = `cli-${index}-${Date.now().toString(36)}`;
                const payload = { ...command.payload, messageId };
                client.publish(command.topic, JSON.stringify(payload), { qos: 1 });
                console.log(`[${command.name}] -> ${command.topic}`);
                console.log(`  payload: ${JSON.stringify(payload)}`);
            }, index * 800);
        });

        setTimeout(() => {
            console.log('\nSummary');
            for (const [key, value] of Object.entries(results)) {
                console.log(`${key}: ${value}`);
            }
            client.end();
        }, 25000);
    });

    client.on('message', (topic, message) => {
        const key = topic.split('/').slice(-2).join('/');
        const body = message.toString();
        results[key] = body.slice(0, 120);
        console.log(`\n[${topic}]`);
        try {
            const parsed = JSON.parse(body);
            console.log(JSON.stringify(parsed, null, 2).split('\n').slice(0, 8).join('\n'));
        } catch (_) {
            console.log(body.slice(0, 200));
        }
    });

    client.on('error', (error) => {
        console.error(`MQTT error: ${error.message}`);
        process.exit(1);
    });
}

if (require.main === module) {
    main();
}

module.exports = { buildCommands };
