'use strict';

const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const dashboardRoot = path.join(__dirname, '..');

jest.setTimeout(30000);

async function unusedLoopbackPort() {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
    });
    const port = listener.address().port;
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    return port;
}

async function bootWithEnv(envOverrides, { killOnListening = false } = {}) {
    const mqttPort = await unusedLoopbackPort();
    return new Promise((resolve) => {
        const env = {
            ...process.env,
            // Keep the boot deterministic regardless of any local .env file:
            // dotenv only fills variables that are not already set.
            NODE_ENV: 'production',
            PORT: '0',
            DB_PATH: ':memory:',
            ...envOverrides,
            // Never inherit a real transport or notification target from .env.
            MQTT_HOST: '127.0.0.1',
            MQTT_PORT: String(mqttPort),
            MQTT_PROTOCOL: 'mqtt',
            MQTT_USER: 'boot-gate-test',
            MQTT_CLIENT_ID: `boot-gate-test-${process.pid}-${mqttPort}`,
            SERIAL_BRIDGE_ENABLED: 'false',
            SERIAL_BRIDGE_STATUS_FALLBACK: 'false',
            SERIAL_PORT: '',
            BLUETOOTH_SERIAL_PORT: '',
            AUTOMATION_ALLOW_HTTP: 'false',
            WEBHOOK_ALLOW_HTTP: 'false',
            TELEGRAM_BOT_TOKEN: '',
            TELEGRAM_CHAT_ID: '',
            N8N_WEBHOOK_URL: '',
            EMAIL_HOST: '',
            EMAIL_USER: '',
            EMAIL_PASSWORD: '',
            FCM_SERVER_KEY: '',
            FIREBASE_SERVER_KEY: '',
            APNS_PRIVATE_KEY: '',
            APNS_PRIVATE_KEY_PATH: '',
            APNS_TEAM_ID: '',
            APNS_KEY_ID: '',
            ANDROID_BRIDGE_PUBLIC_URL: '',
            PUBLIC_BRIDGE_BASE_URL: '',
            OTA_BASE_URL: ''
        };
        delete env.JEST_WORKER_ID;

        // Session SQLite ignores DB_PATH in the application. Substitute only its
        // storage adapter; execute the actual server and production secret gate.
        // Also fail closed if an unexpected outbound connection is introduced.
        const bootstrap = `
            const net = require('net');
            const connect = net.Socket.prototype.connect;
            net.Socket.prototype.connect = function (...args) {
                const options = net._normalizeArgs(args)[0];
                if (options.host !== '127.0.0.1' || Number(options.port) !== Number(process.env.MQTT_PORT)) {
                    throw new Error('Boot test blocked unexpected outbound connection');
                }
                return connect.apply(this, args);
            };
            const session = require('express-session');
            const storeModule = require.resolve('connect-sqlite3');
            require.cache[storeModule] = { id: storeModule, filename: storeModule, loaded: true,
                exports: () => session.MemoryStore };
            require(${JSON.stringify(path.join(dashboardRoot, 'server.js'))});
        `;
        const child = spawn(
            process.execPath,
            ['-e', bootstrap],
            { cwd: dashboardRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
        );

        let output = '';
        let settled = false;
        const append = (chunk) => {
            output += chunk.toString('utf8');
            if (killOnListening && !settled && output.includes('Server listening on')) {
                settled = true;
                child.kill('SIGTERM');
            }
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);

        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                child.kill('SIGTERM');
            }
        }, 25000);

        child.on('close', (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal, output });
        });
        child.on('error', () => {
            clearTimeout(timeout);
        });
    });
}

describe('production secret boot gate (OPS-01)', () => {
    test('refuses to boot in production while critical secrets are placeholders', async () => {
        const result = await bootWithEnv({
            SESSION_SECRET: 'change-this-session-secret',
            MQTT_PASSWORD: 'your-mqtt-password',
            ADMIN_PASSWORD: 'change-this-admin-password'
        });

        expect(result.code).toBe(1);
        expect(result.output).toContain('FATAL');
        expect(result.output).toContain('must be rotated');
        expect(result.output).toContain('SESSION_SECRET');
        expect(result.output).toContain('MQTT_PASSWORD');
        expect(result.output).toContain('ADMIN_PASSWORD');
    });

    test('refuses to boot in production when SESSION_SECRET is the insecure default', async () => {
        const result = await bootWithEnv({
            SESSION_SECRET: 'secret-key-change-in-production'
        });

        expect(result.code).toBe(1);
        expect(result.output).toContain('insecure default');
    });

    test('accepts a production boot when critical secrets are real values', async () => {
        const result = await bootWithEnv({
            SESSION_SECRET: 'a'.repeat(96),
            MQTT_PASSWORD: 'b'.repeat(24),
            ADMIN_PASSWORD: 'c'.repeat(24)
        }, { killOnListening: true });

        // The gate must PASS — the server proceeds to start (listener/DB).
        // We only assert it did not die on the secret gate; it must never
        // print the rotation FATAL before the readiness kill.
        expect(result.output).not.toContain('must be rotated');
        expect(result.output).not.toContain('FATAL: deployment secrets');
        expect(result.output).not.toContain('Boot test blocked unexpected outbound connection');
        expect(result.output).toContain('Server listening on');
    });
});
