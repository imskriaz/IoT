'use strict';

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const {
    attachSmsToConversation,
    refreshSmsConversationBySmsId
} = require('../services/smsConversations');
const { formatPhoneNumber } = require('../utils/phoneNumber');
const { syncDeviceSimInventory } = require('../services/simInventoryService');
const { extractSimScope } = require('../utils/simScope');
const {
    isRegisteredDevice,
    noteUnregisteredDevice
} = require('../utils/unregisteredDevices');

const lastCallSnapshotKeyByDevice = new Map();
let mqttHandlerUtils = null;

function getMqttHandlerUtils() {
    if (!mqttHandlerUtils) {
        mqttHandlerUtils = require('../services/mqttHandlers');
    }
    return mqttHandlerUtils;
}

function clean(value) {
    return String(value || '').trim();
}

function normalizeTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        const millis = value > 100000000000 ? value : value * 1000;
        return new Date(millis).toISOString();
    }
    const raw = clean(value);
    if (!raw) return new Date().toISOString();
    if (/^\d+$/.test(raw)) {
        const numeric = Number(raw);
        const millis = numeric > 100000000000 ? numeric : numeric * 1000;
        return new Date(millis).toISOString();
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function isSyncPayload(payload = {}) {
    return payload.sync === true || clean(payload.sync).toLowerCase() === 'true';
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

function extractCallStatusPayload(payload = {}) {
    const nested = payload.call && typeof payload.call === 'object' ? payload.call : {};
    const status = getMqttHandlerUtils().normalizeCallStatus(nested.status || payload.call_status || payload.status);
    if (!status) {
        return null;
    }

    const direction = clean(nested.direction || payload.call_direction || payload.direction).toLowerCase();
    const number = formatPhoneNumber(nested.number || payload.call_number || '')
        || clean(nested.number || payload.call_number)
        || null;
    const updatedAtRaw = nested.updatedAt ?? nested.timestamp ?? payload.call_updated_at ?? payload.timestamp;
    const timestamp = normalizeTimestamp(updatedAtRaw);
    const duration = Number(nested.duration ?? payload.duration ?? payload.duration_seconds ?? 0);
    const contactName = clean(nested.name || nested.contact_name || payload.name || payload.contact_name);
    const simScope = extractSimScope({
        ...payload,
        sim_slot: nested.sim_slot ?? payload.sim_slot,
        simSlot: nested.simSlot ?? payload.simSlot
    });

    return {
        status,
        direction,
        number,
        timestamp,
        sync: isSyncPayload(payload),
        duration: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0,
        contact_name: contactName,
        sim_slot: simScope.simSlot,
        simSlot: simScope.simSlot
    };
}

function hasExplicitInactiveCallState(payload = {}) {
    const nested = payload.call && typeof payload.call === 'object' ? payload.call : {};
    if (nested.active === false) return true;

    const activeValue = nested.active ?? payload.call_active;
    if (activeValue === false) return true;
    if (clean(activeValue).toLowerCase() === 'false') return true;

    return false;
}

function callSnapshotKey(call = {}) {
    return [
        clean(call.status).toLowerCase(),
        clean(call.direction).toLowerCase(),
        clean(call.number),
        clean(call.timestamp)
    ].join('|');
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
        const syncPayload = isSyncPayload(payload);

        await db.run(
            `UPDATE devices
             SET status = 'online',
                 last_seen = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [deviceId]
        );

        if (!syncPayload) {
            global.modemService?.updateDeviceStatus?.(deviceId, payload);
            await syncDeviceSimInventory(db, deviceId, payload).catch(() => {});
            emitDevice(deviceId, 'device:status', { deviceId, ...payload });
        }
        const callStatus = extractCallStatusPayload(payload);
        if (callStatus) {
            const snapshotKey = callSnapshotKey(callStatus);
            if (lastCallSnapshotKeyByDevice.get(deviceId) !== snapshotKey) {
                lastCallSnapshotKeyByDevice.set(deviceId, snapshotKey);
                await getMqttHandlerUtils().updateLatestActiveCall(db, deviceId, callStatus).catch((error) => {
                    logger.error('android bridge HTTP call status update error:', error);
                });
                if (!callStatus.sync && callStatus.status === 'ringing' && callStatus.direction === 'incoming') {
                    emitDevice(deviceId, 'call:incoming', {
                        deviceId,
                        number: callStatus.number,
                        sim_slot: callStatus.sim_slot,
                        simSlot: callStatus.simSlot,
                        timestamp: callStatus.timestamp
                    });
                }
                if (!callStatus.sync) {
                    emitDevice(deviceId, 'call:status', {
                        deviceId,
                        ...callStatus
                    });
                }
                if (!callStatus.sync && ['ended', 'missed', 'rejected', 'busy', 'no_answer'].includes(callStatus.status)) {
                    emitDevice(deviceId, 'call:ended', {
                        deviceId,
                        ...callStatus
                    });
                }
            }
        } else if (hasExplicitInactiveCallState(payload)) {
            const nested = payload.call && typeof payload.call === 'object' ? payload.call : {};
            const fallbackStatus = {
                status: 'ended',
                direction: clean(nested.direction || payload.call_direction || payload.direction).toLowerCase(),
                number: formatPhoneNumber(nested.number || payload.call_number || '')
                    || clean(nested.number || payload.call_number)
                    || null,
                timestamp: normalizeTimestamp(nested.updatedAt ?? nested.timestamp ?? payload.call_updated_at ?? payload.timestamp),
                sync: syncPayload,
                duration: Number(nested.duration ?? payload.duration ?? payload.duration_seconds ?? 0) || 0,
                sim_slot: extractSimScope({
                    ...payload,
                    sim_slot: nested.sim_slot ?? payload.sim_slot,
                    simSlot: nested.simSlot ?? payload.simSlot
                }).simSlot
            };
            fallbackStatus.simSlot = fallbackStatus.sim_slot;
            const changes = await getMqttHandlerUtils().updateLatestActiveCall(db, deviceId, fallbackStatus).catch((error) => {
                logger.error('android bridge HTTP inactive call reconciliation error:', error);
                return 0;
            });
            if (!fallbackStatus.sync && changes > 0) {
                emitDevice(deviceId, 'call:status', {
                    deviceId,
                    ...fallbackStatus
                });
                emitDevice(deviceId, 'call:ended', {
                    deviceId,
                    ...fallbackStatus
                });
            }
        }
        res.json({ success: true, device_id: deviceId });
    } catch (error) {
        logger.error('android bridge status adapter error:', error);
        res.status(500).json({ success: false, message: 'Failed to store Android bridge status' });
    }
});

router.post('/messages/receive', requireBoundDevice, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const syncType = String(req.body.type || '').trim().toLowerCase();
        if (syncType === 'sms_sync_start' || syncType === 'sms_sync_complete') {
            const deviceId = await resolveRegisteredAndroidHttpDevice(db, req, req.body, syncType);
            if (!deviceId) {
                return res.status(202).json({ success: true, ignored: true, unregistered: true });
            }
            emitDevice(deviceId, syncType === 'sms_sync_start' ? 'sms:sync-started' : 'sms:sync-completed', {
                deviceId,
                device_id: deviceId,
                total: Number(req.body.total || 0),
                synced: Number(req.body.synced || 0),
                timestamp: req.body.timestamp || new Date().toISOString()
            });
            return res.json({ success: true, device_id: deviceId, sync: true });
        }
        const isOutgoing = req.body.outgoing === true || String(req.body.direction || req.body.type || '').toLowerCase() === 'outgoing';
        const from = clean(req.body.from || req.body.from_number);
        const to = clean(req.body.to || req.body.to_number);
        const content = String(req.body.content || req.body.text || '');
        if ((!isOutgoing && !from) || (isOutgoing && !to) || !content) {
            return res.status(400).json({ success: false, message: isOutgoing ? 'to and content required' : 'from and content required' });
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
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                deviceId,
                isOutgoing ? null : from,
                isOutgoing ? to : (to || null),
                content,
                isOutgoing ? 'outgoing' : 'incoming',
                isOutgoing ? 'sent' : 'received',
                timestamp,
                isOutgoing ? 1 : 0,
                req.body.sync ? 'android-http-sync' : 'android-http',
                simScope.simSlot
            ]
        );

        if (Number(result?.changes || 0) > 0) {
            const conversationId = await attachSmsToConversation(db, {
                id: result.lastID,
                device_id: deviceId,
                from_number: isOutgoing ? null : from,
                to_number: isOutgoing ? to : (to || null),
                message: content,
                type: isOutgoing ? 'outgoing' : 'incoming'
            });
            emitDevice(deviceId, 'sms:received', {
                deviceId,
                id: result.lastID,
                conversationId: Number(conversationId || 0) || null,
                sync: Boolean(req.body.sync),
                from: isOutgoing ? null : from,
                from_number: isOutgoing ? null : from,
                to_number: isOutgoing ? to : (to || null),
                type: isOutgoing ? 'outgoing' : 'incoming',
                status: isOutgoing ? 'sent' : 'received',
                sim_slot: simScope.simSlot,
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
            `SELECT id, device_id, to_number, conversation_id, sim_slot
             FROM sms
             WHERE external_id = ?
               AND device_id = ?
             LIMIT 1`,
            [messageId, boundDeviceId]
        );
        if (row?.device_id) {
            await refreshSmsConversationBySmsId(db, row.id).catch(() => {});
            emitDevice(row.device_id, status === 'failed' ? 'sms:send-failed' : `sms:${status}`, {
                deviceId: row.device_id,
                id: Number(row.id || 0) || null,
                conversationId: Number(row.conversation_id || 0) || null,
                messageId,
                to: row.to_number,
                sim_slot: row.sim_slot ?? null,
                status,
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
