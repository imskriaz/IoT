'use strict';

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { attachSmsToConversation } = require('../services/smsConversations');
const { syncDeviceSimInventory } = require('../services/simInventoryService');
const { extractSimScope } = require('../utils/simScope');
const {
    isRegisteredDevice,
    noteUnregisteredDevice
} = require('../utils/unregisteredDevices');

function clean(value) {
    return String(value || '').trim();
}

function normalizeTimestamp(value) {
    const raw = clean(value);
    if (!raw) return new Date().toISOString();
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function parseDeviceIds(req) {
    try {
        return JSON.parse(req.apiKey?.device_ids || '[]');
    } catch (_) {
        return [];
    }
}

function requireBoundDevice(req, res, next) {
    const deviceId = clean(req.body.device_id || req.query.device_id || req.headers['x-device-id']);
    const boundDeviceIds = parseDeviceIds(req);
    if (boundDeviceIds.length && deviceId && !boundDeviceIds.includes(deviceId)) {
        return res.status(403).json({ success: false, message: 'Device not allowed for this API key' });
    }
    req.boundDeviceId = deviceId;
    next();
}

function emitDevice(deviceId, eventName, payload) {
    if (!global.io || !deviceId) return;
    const room = global.io.to?.(`device:${deviceId}`);
    if (room?.emit) room.emit(eventName, payload);
    else global.io.emit?.(eventName, payload);
}

async function resolveRegisteredAndroidHttpDevice(db, req, details = {}, eventType = 'android-http') {
    const deviceId = clean(details.device_id || req.boundDeviceId || req.headers['x-device-id']);
    if (!deviceId) {
        throw new Error('device_id required');
    }

    const registered = await isRegisteredDevice(db, deviceId);
    if (!registered) {
        await noteUnregisteredDevice(db, deviceId, eventType, {
            ...details,
            bridge: 'android',
            transport_mode: 'http',
            app: clean(details.app || 'Device Bridge')
        }, 'android-http');
        return null;
    }

    return deviceId;
}

router.post('/status', requireBoundDevice, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = await resolveRegisteredAndroidHttpDevice(db, req, req.body, 'status');
        if (!deviceId) {
            return res.status(202).json({ success: true, ignored: true, unregistered: true });
        }
        const payload = typeof req.body.status === 'object' && req.body.status
            ? { ...req.body.status }
            : { ...req.body };

        delete payload.name;
        delete payload.device_id;
        payload.transport_mode = 'http';
        payload.bridge_transport = 'http';
        payload.active_path = payload.active_path || 'http';

        await db.run(
            `UPDATE devices
             SET status = 'online',
                 last_seen = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [deviceId]
        );

        global.modemService?.updateDeviceStatus?.(deviceId, payload);
        await syncDeviceSimInventory(db, deviceId, payload).catch(() => {});
        emitDevice(deviceId, 'device:status', { deviceId, ...payload });
        res.json({ success: true, device_id: deviceId });
    } catch (error) {
        logger.error('android bridge status adapter error:', error);
        res.status(500).json({ success: false, message: 'Failed to store Android bridge status' });
    }
});

router.post('/messages/receive', requireBoundDevice, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const from = clean(req.body.from);
        const to = clean(req.body.to);
        const content = String(req.body.content || req.body.text || '');
        if (!from || !content) {
            return res.status(400).json({ success: false, message: 'from and content required' });
        }

        const deviceId = await resolveRegisteredAndroidHttpDevice(db, req, req.body, 'sms:incoming');
        if (!deviceId) {
            return res.status(202).json({ success: true, ignored: true, unregistered: true });
        }
        const timestamp = normalizeTimestamp(req.body.timestamp);
        const simScope = extractSimScope(req.body);
        const result = await db.run(
            `INSERT OR IGNORE INTO sms
                (device_id, from_number, to_number, message, type, status, timestamp, read, source, sim_slot)
             VALUES (?, ?, ?, ?, 'incoming', 'received', ?, 0, 'android-http', ?)`,
            [deviceId, from, to || null, content, timestamp, simScope.simSlot]
        );

        if (Number(result?.changes || 0) > 0) {
            await attachSmsToConversation(db, {
                id: result.lastID,
                device_id: deviceId,
                from_number: from,
                to_number: to || null,
                type: 'incoming'
            });
            emitDevice(deviceId, 'sms:received', {
                deviceId,
                id: result.lastID,
                from,
                from_number: from,
                to_number: to || null,
                message: content,
                text: content,
                timestamp
            });
        }

        res.json({ success: true, id: result?.lastID || null, device_id: deviceId });
    } catch (error) {
        logger.error('android bridge receive adapter error:', error);
        res.status(500).json({ success: false, message: 'Failed to receive SMS' });
    }
});

router.get('/messages/outstanding', requireBoundDevice, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = clean(req.boundDeviceId);
        if (!deviceId) {
            return res.status(400).json({ success: false, message: 'device_id required' });
        }
        if (!await isRegisteredDevice(db, deviceId)) {
            await noteUnregisteredDevice(db, deviceId, 'sms:outstanding', {
                device_id: deviceId,
                bridge: 'android',
                transport_mode: 'http'
            }, 'android-http');
            return res.status(202).json({ success: true, ignored: true, unregistered: true, device_id: deviceId, messages: [] });
        }

        const rows = await db.all(
            `SELECT id, external_id, to_number, message, timestamp, sim_slot
             FROM sms
             WHERE device_id = ?
               AND type = 'outgoing'
               AND status = 'queued'
             ORDER BY timestamp ASC
             LIMIT 10`,
            [deviceId]
        );

        if (rows.length) {
            await db.run(
                `UPDATE sms
                 SET status = 'sending'
                 WHERE device_id = ?
                   AND type = 'outgoing'
                   AND status = 'queued'
                   AND id IN (${rows.map(() => '?').join(',')})`,
                [deviceId, ...rows.map((row) => row.id)]
            );
        }

        res.json({
            success: true,
            device_id: deviceId,
            messages: rows.map((row) => ({
                id: row.external_id || String(row.id),
                sms_id: row.id,
                to: row.to_number,
                content: row.message,
                sim_slot: Number.isInteger(Number(row.sim_slot)) ? Number(row.sim_slot) : null,
                timeout_ms: 90000,
                created_at: row.timestamp
            }))
        });
    } catch (error) {
        logger.error('android bridge outstanding adapter error:', error);
        res.status(500).json({ success: false, message: 'Failed to load queued messages' });
    }
});

router.post('/messages/:messageId/events', requireBoundDevice, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const boundDeviceId = clean(req.boundDeviceId || req.body.device_id || req.headers['x-device-id']);
        if (!boundDeviceId) {
            return res.status(400).json({ success: false, message: 'device_id required' });
        }
        if (!await isRegisteredDevice(db, boundDeviceId)) {
            await noteUnregisteredDevice(db, boundDeviceId, 'sms:event', {
                ...req.body,
                device_id: boundDeviceId,
                bridge: 'android',
                transport_mode: 'http'
            }, 'android-http');
            return res.status(202).json({ success: true, ignored: true, unregistered: true, device_id: boundDeviceId });
        }
        const messageId = clean(req.params.messageId);
        const eventName = clean(req.body.event_name).toUpperCase();
        const reason = clean(req.body.reason || req.body.detail);
        const timestamp = normalizeTimestamp(req.body.timestamp);
        const status = eventName === 'DELIVERED'
            ? 'delivered'
            : eventName === 'SENT'
                ? 'sent'
                : eventName === 'FAILED'
                    ? 'failed'
                    : '';

        if (!messageId || !status) {
            return res.status(400).json({ success: false, message: 'Unsupported event' });
        }

        await db.run(
            `UPDATE sms
             SET status = ?,
                 delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
                 error = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
             WHERE external_id = ?
               AND device_id = ?`,
            [status, status, timestamp, status, reason || 'Android bridge failed', messageId, boundDeviceId]
        );

        const row = await db.get(
            'SELECT device_id, to_number FROM sms WHERE external_id = ? AND device_id = ? LIMIT 1',
            [messageId, boundDeviceId]
        );
        if (row?.device_id) {
            emitDevice(row.device_id, status === 'failed' ? 'sms:send-failed' : `sms:${status}`, {
                deviceId: row.device_id,
                messageId,
                to: row.to_number,
                error: status === 'failed' ? reason || 'Android bridge failed' : null,
                timestamp
            });
        }

        res.json({ success: true, id: messageId, status });
    } catch (error) {
        logger.error('android bridge message event adapter error:', error);
        res.status(500).json({ success: false, message: 'Failed to store SMS event' });
    }
});

module.exports = router;
