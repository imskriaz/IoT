'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const logger = require('../utils/logger');
const { queueSmsForDelivery } = require('../services/smsQueue');
const {
    attachSmsToConversation,
    refreshSmsConversationBySmsId
} = require('../services/smsConversations');
const {
    formatPhoneNumber,
    getPhoneLookupKeys,
    sqlNormalizePhone,
    sqlPhoneLastDigits
} = require('../utils/phoneNumber');
const { persistDeviceStatusCache } = require('../utils/deviceStatusCache');
const { extractSimScope } = require('../utils/simScope');
const { isRegisteredDevice, noteUnregisteredDevice } = require('../utils/unregisteredDevices');

function clean(value) {
    return String(value || '').trim();
}

function normalizeTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        const millis = value > 100000000000 ? value : value * 1000;
        return new Date(millis).toISOString();
    }
    const text = clean(value);
    if (!text) return new Date().toISOString();
    if (/^\d+$/.test(text)) {
        const numeric = Number(text);
        return new Date(numeric > 100000000000 ? numeric : numeric * 1000).toISOString();
    }
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function parseDeviceIds(req) {
    try {
        const parsed = JSON.parse(req.apiKey?.device_ids || '[]');
        return Array.isArray(parsed) ? parsed.map((item) => clean(item)).filter(Boolean) : [];
    } catch (_) {
        return [];
    }
}

function normalizeSimSlot(value) {
    const raw = clean(value).toUpperCase();
    if (!raw || raw === 'DEFAULT') return null;
    if (raw === 'SIM1') return 0;
    if (raw === 'SIM2') return 1;
    const numeric = Number(value);
    if (!Number.isInteger(numeric)) return null;
    return numeric > 0 && numeric <= 2 ? numeric - 1 : Math.max(0, numeric);
}

function boolFromPayload(value, fallback = false) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    const text = clean(value).toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
    return fallback;
}

function unwrapCloudEvent(payload = {}) {
    if (payload?.data && typeof payload.data === 'object') {
        return payload.data;
    }
    return payload || {};
}

function cloudEventType(payload = {}) {
    return clean(payload?.type || payload?.event_type || payload?.eventType || payload?.event_name || payload?.eventName).toLowerCase();
}

function messageEventStatus(payload = {}) {
    const raw = clean(payload?.event_name || payload?.eventName || payload?.status || payload?.type).toUpperCase();
    const type = cloudEventType(payload);
    if (raw === 'DELIVERED' || type === 'message.phone.delivered') return 'delivered';
    if (raw === 'SENT' || type === 'message.phone.sent') return 'sent';
    if (raw === 'FAILED' || type === 'message.send.failed') return 'failed';
    if (raw === 'EXPIRED' || type === 'message.send.expired') return 'expired';
    return '';
}

function stableUuid(...parts) {
    const hash = crypto.createHash('sha1').update(parts.map((part) => clean(part)).join('|')).digest('hex');
    return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        `4${hash.slice(13, 16)}`,
        `${(parseInt(hash.slice(16, 17), 16) & 0x3 | 0x8).toString(16)}${hash.slice(17, 20)}`,
        hash.slice(20, 32)
    ].join('-');
}

function httpSmsUserId(req) {
    return String(req.user?.id || req.session?.user?.id || req.apiKey?.id || 'dashboard');
}

function httpSmsType(direction) {
    return direction === 'incoming' ? 'mobile-originated' : 'mobile-terminated';
}

function httpSmsStatus(status, direction) {
    const normalized = clean(status).toLowerCase();
    if (direction === 'incoming' && (!normalized || normalized === 'received')) return 'received';
    if (['queued', 'pending'].includes(normalized)) return 'pending';
    if (['sending', 'sent', 'delivered', 'failed', 'expired', 'deleted', 'received'].includes(normalized)) {
        return normalized;
    }
    return direction === 'incoming' ? 'received' : 'pending';
}

function toHttpSmsMessage(row = {}, owner = null) {
    const direction = clean(row.type).toLowerCase() === 'incoming' ? 'incoming' : 'outgoing';
    const timestamp = normalizeTimestamp(row.timestamp || row.created_at || new Date().toISOString());
    const contact = direction === 'incoming'
        ? clean(row.from_number)
        : clean(row.to_number || row.from_number);
    const ownerNumber = owner || (direction === 'incoming' ? clean(row.to_number) : clean(row.from_number));
    const id = clean(row.external_id) || String(row.id || '');

    return {
        id,
        request_id: clean(row.request_id) || null,
        owner: ownerNumber || null,
        contact,
        content: row.message || '',
        attachments: [],
        encrypted: boolFromPayload(row.encrypted, false),
        type: httpSmsType(direction),
        status: httpSmsStatus(row.status, direction),
        sim: Number.isInteger(Number(row.sim_slot)) ? `SIM${Number(row.sim_slot) + 1}` : 'DEFAULT',
        request_received_at: timestamp,
        scheduled_at: row.scheduled_at ? normalizeTimestamp(row.scheduled_at) : null,
        scheduled_send_time: row.scheduled_at ? normalizeTimestamp(row.scheduled_at) : null,
        created_at: timestamp,
        updated_at: normalizeTimestamp(row.delivered_at || row.updated_at || row.timestamp || timestamp),
        order_timestamp: normalizeTimestamp(row.delivered_at || row.timestamp || timestamp),
        sent_at: row.status === 'sent' || row.status === 'delivered' ? normalizeTimestamp(row.delivered_at || row.timestamp) : null,
        delivered_at: row.delivered_at ? normalizeTimestamp(row.delivered_at) : null,
        received_at: direction === 'incoming' ? timestamp : null,
        failed_at: row.status === 'failed' ? normalizeTimestamp(row.timestamp) : null,
        failure_reason: row.error || null,
        send_attempt_count: 0,
        max_send_attempts: 1
    };
}

function toHttpSmsPhone(req, { deviceId, phoneNumber, simSlot = null, fcmToken = null, updatedAt = null } = {}) {
    const timestamp = normalizeTimestamp(updatedAt || new Date().toISOString());
    const normalizedPhone = formatPhoneNumber(phoneNumber) || clean(phoneNumber);
    return {
        id: stableUuid(deviceId, normalizedPhone, simSlot ?? 'default'),
        device_id: deviceId || null,
        user_id: httpSmsUserId(req),
        fcm_token: fcmToken || null,
        phone_number: normalizedPhone,
        messages_per_minute: 60,
        sim: Number.isInteger(Number(simSlot)) ? `SIM${Number(simSlot) + 1}` : 'SIM1',
        max_send_attempts: 2,
        message_expiration_seconds: 600,
        missed_call_auto_reply: null,
        message_send_schedule_id: null,
        created_at: timestamp,
        updated_at: timestamp
    };
}

function toHttpSmsHeartbeat(req, { deviceId, owner, charging = false, version = '', timestamp = null } = {}) {
    const normalizedOwner = formatPhoneNumber(owner) || clean(owner);
    const normalizedTimestamp = normalizeTimestamp(timestamp || new Date().toISOString());
    return {
        id: stableUuid('heartbeat', deviceId, normalizedOwner, normalizedTimestamp),
        owner: normalizedOwner,
        version: clean(version),
        charging: Boolean(charging),
        user_id: httpSmsUserId(req),
        timestamp: normalizedTimestamp
    };
}

function collectPhoneNumbers(payload = {}) {
    const body = unwrapCloudEvent(payload);
    const source = body.phone_numbers ?? body.phoneNumbers ?? body.phone_number ?? body.phoneNumber ?? body.owner ?? body.from ?? body.to;
    const values = Array.isArray(source) ? source : [source];
    return Array.from(new Set(values.map((value) => formatPhoneNumber(value) || clean(value)).filter(Boolean)));
}

function respondOk(res, message, data) {
    return res.json({
        status: 'success',
        message,
        data
    });
}

function emitDevice(deviceId, eventName, payload) {
    if (!global.io || !deviceId) return;
    const room = global.io.to?.(`device:${deviceId}`);
    if (room?.emit) room.emit(eventName, payload);
    else global.io.emit?.(eventName, payload);
}

async function setHttpSmsDeviceOnlineState(db, req, { deviceId, owner, online = true, timestamp = null } = {}) {
    const normalizedOwner = formatPhoneNumber(owner) || clean(owner);
    const normalizedTimestamp = normalizeTimestamp(timestamp || new Date().toISOString());
    if (!db || !deviceId) return;

    await db.run(
        `UPDATE devices
         SET status = ?,
             last_seen = CASE WHEN ? = 'online' THEN CURRENT_TIMESTAMP ELSE last_seen END
         WHERE id = ?`,
        [online ? 'online' : 'offline', online ? 'online' : 'offline', deviceId]
    );
    const statusPayload = {
        deviceId,
        online: Boolean(online),
        bridge_transport: 'http',
        transport_mode: 'http',
        active_path: 'http',
        app: 'httpSMS',
        simNumber: normalizedOwner,
        lastSeen: normalizedTimestamp
    };
    if (online) {
        global.modemService?.updateDeviceStatus?.(deviceId, statusPayload);
    }
    await persistDeviceStatusCache(db, deviceId, statusPayload).catch(() => {});
    emitDevice(deviceId, 'device:status', statusPayload);
    return toHttpSmsHeartbeat(req, {
        deviceId,
        owner: normalizedOwner,
        timestamp: normalizedTimestamp
    });
}

async function findDeviceByPhone(db, phone) {
    const formatted = formatPhoneNumber(phone) || clean(phone);
    if (!db || !formatted) return null;
    const lookup = getPhoneLookupKeys(formatted);
    const row = await db.get(
        `SELECT d.id
         FROM devices d
         LEFT JOIN device_profiles dp ON dp.device_id = d.id
         LEFT JOIN sims s ON s.device_id = d.id
         WHERE ${sqlNormalizePhone('dp.last_sim_number')} = ?
            OR ${sqlPhoneLastDigits('dp.last_sim_number')} = ?
            OR ${sqlNormalizePhone('s.sim_number')} = ?
            OR ${sqlPhoneLastDigits('s.sim_number')} = ?
         ORDER BY d.last_seen DESC
         LIMIT 1`,
        [lookup.digits, lookup.last10, lookup.digits, lookup.last10]
    );
    return row?.id || null;
}

async function resolveHttpSmsDevice(db, req, payload = {}) {
    const explicit = clean(
        payload.device_id ||
        payload.deviceId ||
        req.query.device_id ||
        req.query.deviceId ||
        req.headers['x-device-id']
    );
    const boundDeviceIds = parseDeviceIds(req);
    const owner = clean(payload.from || payload.owner || payload.to || req.query.owner);

    let deviceId = explicit;
    if (!deviceId && boundDeviceIds.length === 1) {
        deviceId = boundDeviceIds[0];
    }
    if (!deviceId && owner) {
        deviceId = await findDeviceByPhone(db, owner);
    }

    if (!deviceId) {
        const error = new Error('device_id required or bind this API key to one device');
        error.statusCode = 400;
        throw error;
    }
    if (boundDeviceIds.length && !boundDeviceIds.includes(deviceId)) {
        const error = new Error('Device not allowed for this API key');
        error.statusCode = 403;
        throw error;
    }
    if (!await isRegisteredDevice(db, deviceId)) {
        await noteUnregisteredDevice(db, deviceId, payload.event_name || 'httpsms', {
            ...payload,
            bridge: 'httpsms',
            transport_mode: 'http'
        }, 'httpsms');
        const error = new Error('Device not registered');
        error.statusCode = 202;
        error.unregistered = true;
        error.deviceId = deviceId;
        throw error;
    }
    return deviceId;
}

async function upsertHttpSmsPhoneState(db, req, { deviceId, phoneNumber, sim = null, charging = null, fcmToken = null } = {}) {
    const normalizedPhone = formatPhoneNumber(phoneNumber) || clean(phoneNumber);
    if (!db || !deviceId || !normalizedPhone) return null;
    const simSlot = normalizeSimSlot(sim);
    const slotIndex = simSlot === null ? 0 : simSlot;
    const timestamp = new Date().toISOString();

    await db.run(
        `UPDATE devices
         SET status = 'online',
             last_seen = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [deviceId]
    );
    await db.run(
        `INSERT INTO sims (device_id, slot_index, sim_number, is_ready, is_registered, last_seen_at, updated_at)
         VALUES (?, ?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(device_id, slot_index) DO UPDATE SET
             sim_number = COALESCE(excluded.sim_number, sims.sim_number),
             is_ready = 1,
             is_registered = 1,
             last_seen_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP`,
        [deviceId, slotIndex, normalizedPhone]
    );
    await db.run(
        `UPDATE device_profiles
         SET last_sim_number = COALESCE(?, last_sim_number),
             updated_at = CURRENT_TIMESTAMP
         WHERE device_id = ?`,
        [normalizedPhone, deviceId]
    );
    if (fcmToken) {
        await db.run(
            `INSERT INTO device_push_tokens
                (device_id, push_token, platform, app_id, is_active, last_seen_at, updated_at)
             VALUES (?, ?, 'android', 'httpsms', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(device_id, push_token) DO UPDATE SET
                platform = 'android',
                app_id = 'httpsms',
                is_active = 1,
                last_seen_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP`,
            [deviceId, fcmToken]
        );
    }

    const statusPayload = {
        deviceId,
        online: true,
        bridge_transport: 'http',
        transport_mode: 'http',
        active_path: 'http',
        app: 'httpSMS',
        sim: {
            number: normalizedPhone,
            simNumber: normalizedPhone,
            slot: slotIndex,
            charging: charging === null ? undefined : Boolean(charging)
        },
        simNumber: normalizedPhone,
        simSlot: slotIndex,
        charging: charging === null ? undefined : Boolean(charging),
        fcmTokenSet: Boolean(fcmToken),
        lastSeen: timestamp
    };
    global.modemService?.updateDeviceStatus?.(deviceId, statusPayload);
    await persistDeviceStatusCache(db, deviceId, statusPayload).catch(() => {});
    emitDevice(deviceId, 'device:status', statusPayload);

    return toHttpSmsPhone(req, {
        deviceId,
        phoneNumber: normalizedPhone,
        simSlot: slotIndex,
        fcmToken,
        updatedAt: timestamp
    });
}

async function listHttpSmsPhones(db, req, payload = {}) {
    const boundDeviceIds = parseDeviceIds(req);
    const explicitDeviceId = clean(payload.device_id || payload.deviceId || req.headers['x-device-id']);
    const owner = formatPhoneNumber(payload.owner || payload.phone_number || payload.phoneNumber) || clean(payload.owner || payload.phone_number || payload.phoneNumber);
    let deviceIds = boundDeviceIds;

    if (explicitDeviceId) {
        if (boundDeviceIds.length && !boundDeviceIds.includes(explicitDeviceId)) {
            const error = new Error('Device not allowed for this API key');
            error.statusCode = 403;
            throw error;
        }
        deviceIds = [explicitDeviceId];
    } else if (!deviceIds.length && owner) {
        const deviceId = await findDeviceByPhone(db, owner);
        deviceIds = deviceId ? [deviceId] : [];
    }

    if (!deviceIds.length) {
        const error = new Error('device_id required or bind this API key to one device');
        error.statusCode = 400;
        throw error;
    }

    const placeholders = deviceIds.map(() => '?').join(',');
    const rows = await db.all(
        `SELECT d.id AS device_id,
                d.last_seen,
                s.slot_index,
                s.sim_number,
                s.updated_at,
                dp.last_sim_number
         FROM devices d
         LEFT JOIN device_profiles dp ON dp.device_id = d.id
         LEFT JOIN sims s ON s.device_id = d.id
         WHERE d.id IN (${placeholders})
         ORDER BY d.id ASC, s.slot_index ASC`,
        deviceIds
    );

    const fallbackByDevice = new Set();
    return rows
        .map((row) => {
            const phoneNumber = row.sim_number || row.last_sim_number;
            if (!phoneNumber) {
                if (fallbackByDevice.has(row.device_id)) return null;
                fallbackByDevice.add(row.device_id);
            }
            return toHttpSmsPhone(req, {
                deviceId: row.device_id,
                phoneNumber: phoneNumber || owner || row.device_id,
                simSlot: Number.isInteger(Number(row.slot_index)) ? Number(row.slot_index) : 0,
                updatedAt: row.updated_at || row.last_seen
            });
        })
        .filter(Boolean);
}

async function queueHttpSmsMessage(req, payload, index = null) {
    const db = req.app.locals.db;
    const body = unwrapCloudEvent(payload || {});
    if (Array.isArray(body.attachments) && body.attachments.length) {
        const error = new Error('MMS attachments are not supported by this dashboard execution lane yet');
        error.statusCode = 422;
        throw error;
    }

    const to = body.to;
    const content = clean(body.content ?? body.message ?? body.text);
    if (!to || !content) {
        const error = new Error('to and content required');
        error.statusCode = 400;
        throw error;
    }

    const deviceId = await resolveHttpSmsDevice(db, req, body);
    const encrypted = boolFromPayload(body.encrypted, false);
    const sendAtText = clean(body.send_at || body.sendAt || body.scheduled_at || body.scheduledAt);
    if (sendAtText) {
        const sendAt = new Date(sendAtText);
        if (Number.isNaN(sendAt.getTime())) {
            const error = new Error('send_at must be a valid date-time');
            error.statusCode = 422;
            throw error;
        }
        const maxScheduleAt = Date.now() + (20 * 24 * 60 * 60 * 1000);
        if (sendAt.getTime() > maxScheduleAt) {
            const error = new Error('send_at cannot be more than 20 days in the future');
            error.statusCode = 422;
            throw error;
        }
        if (sendAt.getTime() > Date.now()) {
            const formattedTo = formatPhoneNumber(to) || clean(to);
            const result = await db.run(
                `INSERT INTO scheduled_sms (device_id, to_number, message, send_at, sim_slot, user_id)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [deviceId, formattedTo, content, sendAt.toISOString(), normalizeSimSlot(body.sim), req.user?.id || req.session?.user?.id || null]
            );
            const messageId = clean(body.request_id) || `httpsms_sched_${result?.lastID || Date.now()}`;
            emitDevice(deviceId, 'sms:scheduled-created', {
                deviceId,
                id: result?.lastID || null,
                to: formattedTo,
                message: content,
                send_at: sendAt.toISOString(),
                source: 'httpsms'
            });
            return toHttpSmsMessage({
                id: result?.lastID || null,
                external_id: messageId,
                from_number: formatPhoneNumber(body.from) || body.from || 'self',
                to_number: formattedTo,
                message: content,
                type: 'outgoing',
                status: 'pending',
                timestamp: new Date().toISOString(),
                sim_slot: normalizeSimSlot(body.sim),
                encrypted,
                request_id: index === null ? clean(body.request_id) : `${clean(body.request_id) || 'bulk'}:${index}`,
                scheduled_at: sendAt.toISOString()
            }, formatPhoneNumber(body.from) || clean(body.from) || null);
        }
    }

    const queued = await queueSmsForDelivery({
        db,
        mqttService: global.mqttService,
        deviceId,
        to,
        message: content,
        simSlot: normalizeSimSlot(body.sim),
        userId: req.user?.id || req.session?.user?.id || null,
        source: 'httpsms',
        batchId: index === null ? null : clean(body.request_id) || `httpsms_bulk_${Date.now()}`,
        encrypted
    });

    return toHttpSmsMessage({
        id: queued.id,
        external_id: queued.messageId,
        from_number: formatPhoneNumber(body.from) || body.from || 'self',
        to_number: queued.to,
        message: content,
        type: 'outgoing',
        status: queued.status === 'queued' ? 'pending' : queued.status,
        timestamp: new Date().toISOString(),
        sim_slot: queued.simSlot,
        encrypted,
        request_id: index === null ? clean(body.request_id) : `${clean(body.request_id) || 'bulk'}:${index}`
    }, formatPhoneNumber(body.from) || clean(body.from) || null);
}

router.post('/messages/send', async (req, res) => {
    try {
        const data = await queueHttpSmsMessage(req, req.body || null);
        return respondOk(res, 'message added to queue', data);
    } catch (error) {
        if (error.unregistered) {
            return res.status(202).json({ status: 'success', message: 'device not registered', ignored: true, data: null });
        }
        logger.error('httpSMS send adapter error:', error);
        return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Failed to queue message' });
    }
});

router.post('/messages/bulk-send', async (req, res) => {
    try {
        const recipients = Array.isArray(req.body?.to) ? req.body.to : [];
        if (!recipients.length) {
            return res.status(400).json({ status: 'error', message: 'to must contain at least one recipient' });
        }
        const results = [];
        for (let index = 0; index < recipients.length; index += 1) {
            results.push(await queueHttpSmsMessage(req, { ...req.body, to: recipients[index] }, index));
        }
        return respondOk(res, `${results.length} messages processed successfully`, results);
    } catch (error) {
        if (error.unregistered) {
            return res.status(202).json({ status: 'success', message: 'device not registered', ignored: true, data: [] });
        }
        logger.error('httpSMS bulk-send adapter error:', error);
        return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Failed to queue messages' });
    }
});

router.get('/messages/outstanding', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = await resolveHttpSmsDevice(db, req, req.query);
        const messageId = clean(req.query.message_id || req.query.messageID || req.query.id);
        const params = [deviceId];
        let filter = '';
        if (messageId) {
            filter = 'AND (external_id = ? OR id = ?)';
            params.push(messageId, Number(messageId) || -1);
        }
        const row = await db.get(
            `SELECT id, external_id, from_number, to_number, message, timestamp, status, sim_slot, encrypted
             FROM sms
             WHERE device_id = ?
               AND type = 'outgoing'
               AND status IN ('queued', 'pending', 'sending')
               ${filter}
             ORDER BY timestamp ASC, id ASC
             LIMIT 1`,
            params
        );
        if (!row) {
            return res.status(messageId ? 404 : 200).json({ status: messageId ? 'error' : 'success', message: 'no outstanding message', data: null });
        }
        await db.run(
            `UPDATE sms SET status = 'sending' WHERE device_id = ? AND id = ? AND status IN ('queued', 'pending')`,
            [deviceId, row.id]
        );
        return respondOk(res, 'outstanding message fetched successfully', toHttpSmsMessage({ ...row, status: 'sending' }));
    } catch (error) {
        if (error.unregistered) {
            return res.status(202).json({ status: 'success', message: 'device not registered', ignored: true, data: null });
        }
        logger.error('httpSMS outstanding adapter error:', error);
        return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Failed to load outstanding message' });
    }
});

router.post('/messages/receive', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const body = unwrapCloudEvent(req.body || {});
        const fromValue = body.from || body.contact;
        const toValue = body.to || body.owner;
        const from = formatPhoneNumber(fromValue) || clean(fromValue);
        const to = formatPhoneNumber(toValue) || clean(toValue);
        const content = clean(body.content ?? body.message ?? body.text);
        if (!from || !to || !content) {
            return res.status(400).json({ status: 'error', message: 'from, to and content required' });
        }
        const deviceId = await resolveHttpSmsDevice(db, req, { ...body, owner: to });
        const timestamp = normalizeTimestamp(body.timestamp);
        const simSlot = normalizeSimSlot(body.sim);
        const externalId = clean(body.message_id || body.messageId || body.id || body.request_id) || null;
        const encrypted = boolFromPayload(body.encrypted, false);
        const result = await db.run(
            `INSERT OR IGNORE INTO sms
                (device_id, from_number, to_number, message, type, status, timestamp, read, source, sim_slot, external_id, encrypted)
             VALUES (?, ?, ?, ?, 'incoming', 'received', ?, 0, 'httpsms', ?, ?, ?)`,
            [deviceId, from, to, content, timestamp, simSlot, externalId, encrypted ? 1 : 0]
        );

        let smsId = result?.lastID || null;
        if (!smsId && externalId) {
            const existing = await db.get(
                `SELECT id FROM sms WHERE device_id = ? AND external_id = ? LIMIT 1`,
                [deviceId, externalId]
            );
            smsId = existing?.id || null;
        }
        if (smsId) {
            const conversationId = await attachSmsToConversation(db, {
                id: smsId,
                device_id: deviceId,
                from_number: from,
                to_number: to,
                type: 'incoming'
            });
            emitDevice(deviceId, 'sms:received', {
                deviceId,
                id: smsId,
                conversationId: Number(conversationId || 0) || null,
                from,
                from_number: from,
                to_number: to,
                message: content,
                text: content,
                status: 'received',
                source: 'httpsms',
                sim_slot: simSlot,
                encrypted,
                timestamp
            });
        }

        return respondOk(res, 'message received successfully', toHttpSmsMessage({
            id: smsId,
            external_id: externalId,
            from_number: from,
            to_number: to,
            message: content,
            type: 'incoming',
            status: 'received',
            timestamp,
            sim_slot: simSlot,
            encrypted
        }, to));
    } catch (error) {
        if (error.unregistered) {
            return res.status(202).json({ status: 'success', message: 'device not registered', ignored: true, data: null });
        }
        logger.error('httpSMS receive adapter error:', error);
        return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Failed to store received message' });
    }
});

router.post('/messages/:messageId/events', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const body = unwrapCloudEvent(req.body || {});
        const deviceId = await resolveHttpSmsDevice(db, req, body);
        const messageId = clean(req.params.messageId || body.id || body.message_id || body.messageId);
        const timestamp = normalizeTimestamp(body.timestamp);
        const reason = clean(body.reason || body.error_message || body.error || body.failure_reason);
        const status = messageEventStatus(req.body || {});
        if (!messageId || !status) {
            return res.status(400).json({ status: 'error', message: 'Unsupported event' });
        }

        await db.run(
            `UPDATE sms
             SET status = ?,
                 delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
                 error = CASE WHEN ? IN ('failed', 'expired') THEN ? ELSE NULL END
             WHERE device_id = ?
               AND (external_id = ? OR id = ?)`,
            [status, status, timestamp, status, reason || `httpSMS ${status}`, deviceId, messageId, Number(messageId) || -1]
        );
        const row = await db.get(
            `SELECT id, external_id, from_number, to_number, message, timestamp, status, delivered_at, error, sim_slot, conversation_id, encrypted
             FROM sms
             WHERE device_id = ?
               AND (external_id = ? OR id = ?)
             LIMIT 1`,
            [deviceId, messageId, Number(messageId) || -1]
        );
        if (row?.id) {
            await refreshSmsConversationBySmsId(db, row.id).catch(() => {});
            emitDevice(deviceId, status === 'failed' ? 'sms:send-failed' : `sms:${status}`, {
                deviceId,
                id: Number(row.id || 0) || null,
                conversationId: Number(row.conversation_id || 0) || null,
                messageId,
                to: row.to_number,
                sim_slot: row.sim_slot ?? null,
                status,
                error: status === 'failed' || status === 'expired' ? reason || `httpSMS ${status}` : null,
                timestamp
            });
        }
        return respondOk(res, 'message event stored successfully', row ? toHttpSmsMessage(row) : { id: messageId, status });
    } catch (error) {
        if (error.unregistered) {
            return res.status(202).json({ status: 'success', message: 'device not registered', ignored: true, data: null });
        }
        logger.error('httpSMS event adapter error:', error);
        return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Failed to store message event' });
    }
});

router.post('/messages/calls/missed', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const body = unwrapCloudEvent(req.body || {});
        const fromValue = body.from || body.contact;
        const toValue = body.to || body.owner;
        const from = formatPhoneNumber(fromValue) || clean(fromValue);
        const to = formatPhoneNumber(toValue) || clean(toValue);
        if (!from || !to) {
            return res.status(400).json({ status: 'error', message: 'from and to required' });
        }
        const deviceId = await resolveHttpSmsDevice(db, req, { ...body, owner: to });
        const timestamp = normalizeTimestamp(body.timestamp);
        const simSlot = normalizeSimSlot(body.sim);
        await db.run(
            `INSERT INTO calls (device_id, phone_number, type, status, start_time, end_time, duration, missed, sim_slot, user_id)
             VALUES (?, ?, 'incoming', 'missed', ?, ?, 0, 1, ?, ?)`,
            [deviceId, from, timestamp, timestamp, simSlot, req.user?.id || req.session?.user?.id || null]
        );
        emitDevice(deviceId, 'call:missed', { deviceId, number: from, from, to, sim_slot: simSlot, timestamp });
        return respondOk(res, 'missed call stored successfully', {
            id: `missed:${deviceId}:${Date.now()}`,
            owner: to,
            contact: from,
            type: 'call/missed',
            status: 'received',
            sim: simSlot === null ? 'DEFAULT' : `SIM${simSlot + 1}`,
            received_at: timestamp,
            created_at: timestamp,
            updated_at: timestamp
        });
    } catch (error) {
        if (error.unregistered) {
            return res.status(202).json({ status: 'success', message: 'device not registered', ignored: true, data: null });
        }
        logger.error('httpSMS missed call adapter error:', error);
        return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Failed to store missed call' });
    }
});

router.post('/heartbeats', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const body = unwrapCloudEvent(req.body || {});
        const phoneNumbers = collectPhoneNumbers(body);
        if (!phoneNumbers.length) {
            return res.status(400).json({ status: 'error', message: 'phone_numbers required' });
        }

        const results = [];
        const heartbeatType = cloudEventType(req.body || {});
        const online = heartbeatType === 'phone.heartbeat.offline' ? false : true;
        for (let index = 0; index < phoneNumbers.length; index += 1) {
            const phoneNumber = phoneNumbers[index];
            const sim = body.sim || body.sim_slot || body.simSlot || `SIM${Math.min(index + 1, 2)}`;
            const deviceId = await resolveHttpSmsDevice(db, req, { ...body, owner: phoneNumber });
            if (online) {
                await upsertHttpSmsPhoneState(db, req, {
                    deviceId,
                    phoneNumber,
                    sim,
                    charging: body.charging
                });
                results.push(toHttpSmsHeartbeat(req, {
                    deviceId,
                    owner: phoneNumber,
                    charging: body.charging,
                    version: req.headers['x-client-version'] || body.version || body.app_version,
                    timestamp: body.timestamp
                }));
            } else {
                results.push(await setHttpSmsDeviceOnlineState(db, req, {
                    deviceId,
                    owner: phoneNumber,
                    online: false,
                    timestamp: body.timestamp || body.last_heartbeat_timestamp
                }));
            }
        }

        return res.status(201).json({
            status: 'success',
            message: `${results.length} heartbeats received successfully`,
            data: results
        });
    } catch (error) {
        if (error.unregistered) {
            return res.status(202).json({ status: 'success', message: 'device not registered', ignored: true, data: [] });
        }
        logger.error('httpSMS heartbeat adapter error:', error);
        return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Failed to store heartbeat' });
    }
});

router.get('/heartbeats', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const phones = await listHttpSmsPhones(db, req, req.query || {});
        const heartbeats = phones.map((phone) => toHttpSmsHeartbeat(req, {
            deviceId: phone.device_id || req.query.device_id || req.query.deviceId || phone.id,
            owner: phone.phone_number,
            timestamp: phone.updated_at
        }));
        return respondOk(res, 'heartbeats fetched successfully', heartbeats);
    } catch (error) {
        logger.error('httpSMS heartbeat index adapter error:', error);
        return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Failed to fetch heartbeats' });
    }
});

router.get('/phones', async (req, res) => {
    try {
        const phones = await listHttpSmsPhones(req.app.locals.db, req, req.query || {});
        return respondOk(res, 'phones fetched successfully', phones);
    } catch (error) {
        logger.error('httpSMS phone index adapter error:', error);
        return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Failed to fetch phones' });
    }
});

router.put('/phones', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const body = req.body || {};
        const phoneNumber = formatPhoneNumber(body.phone_number || body.phoneNumber || body.owner) || clean(body.phone_number || body.phoneNumber || body.owner);
        if (!phoneNumber) {
            return res.status(400).json({ status: 'error', message: 'phone_number required' });
        }
        const deviceId = await resolveHttpSmsDevice(db, req, { ...body, owner: phoneNumber });
        const phone = await upsertHttpSmsPhoneState(db, req, {
            deviceId,
            phoneNumber,
            sim: body.sim || body.sim_slot || body.simSlot,
            charging: body.charging,
            fcmToken: body.fcm_token || body.fcmToken
        });
        return respondOk(res, 'phone updated successfully', phone);
    } catch (error) {
        if (error.unregistered) {
            return res.status(202).json({ status: 'success', message: 'device not registered', ignored: true, data: null });
        }
        logger.error('httpSMS phone update adapter error:', error);
        return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Failed to update phone' });
    }
});

router.put('/phones/fcm-token', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const body = req.body || {};
        const phoneNumber = formatPhoneNumber(body.phone_number || body.phoneNumber || body.owner) || clean(body.phone_number || body.phoneNumber || body.owner);
        const fcmToken = clean(body.fcm_token || body.fcmToken);
        if (!phoneNumber || !fcmToken) {
            return res.status(400).json({ status: 'error', message: 'phone_number and fcm_token required' });
        }
        const deviceId = await resolveHttpSmsDevice(db, req, { ...body, owner: phoneNumber });
        const phone = await upsertHttpSmsPhoneState(db, req, {
            deviceId,
            phoneNumber,
            sim: body.sim || body.sim_slot || body.simSlot,
            fcmToken
        });
        return respondOk(res, 'phone FCM token updated successfully', phone);
    } catch (error) {
        if (error.unregistered) {
            return res.status(202).json({ status: 'success', message: 'device not registered', ignored: true, data: null });
        }
        logger.error('httpSMS FCM token adapter error:', error);
        return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Failed to update FCM token' });
    }
});

router.get('/messages/:messageId', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = await resolveHttpSmsDevice(db, req, req.query);
        const messageId = clean(req.params.messageId);
        const row = await db.get(
            `SELECT id, external_id, from_number, to_number, message, type, status, timestamp, delivered_at, error, sim_slot, encrypted
             FROM sms
             WHERE device_id = ?
               AND (external_id = ? OR id = ?)
             LIMIT 1`,
            [deviceId, messageId, Number(messageId) || -1]
        );
        if (!row) {
            return res.status(404).json({ status: 'error', message: 'message not found' });
        }
        return respondOk(res, 'message fetched successfully', toHttpSmsMessage(row, formatPhoneNumber(req.query.owner) || clean(req.query.owner) || null));
    } catch (error) {
        if (error.unregistered) {
            return res.status(202).json({ status: 'success', message: 'device not registered', ignored: true, data: null });
        }
        logger.error('httpSMS get adapter error:', error);
        return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Failed to fetch message' });
    }
});

router.delete('/messages/:messageId', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = await resolveHttpSmsDevice(db, req, req.query);
        const messageId = clean(req.params.messageId);
        const row = await db.get(
            `SELECT id
             FROM sms
             WHERE device_id = ?
               AND (external_id = ? OR id = ?)
             LIMIT 1`,
            [deviceId, messageId, Number(messageId) || -1]
        );
        if (!row) {
            return res.status(404).json({ status: 'error', message: 'message not found' });
        }
        await db.run(
            `UPDATE sms SET status = 'deleted', device_deleted_at = CURRENT_TIMESTAMP WHERE device_id = ? AND id = ?`,
            [deviceId, row.id]
        );
        await refreshSmsConversationBySmsId(db, row.id).catch(() => {});
        emitDevice(deviceId, 'sms:deleted', { deviceId, id: Number(row.id || 0) || null, messageId });
        return respondOk(res, 'message deleted successfully', { id: messageId, status: 'deleted' });
    } catch (error) {
        if (error.unregistered) {
            return res.status(202).json({ status: 'success', message: 'device not registered', ignored: true, data: null });
        }
        logger.error('httpSMS delete adapter error:', error);
        return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Failed to delete message' });
    }
});

router.get('/messages', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = await resolveHttpSmsDevice(db, req, req.query);
        const owner = formatPhoneNumber(req.query.owner) || clean(req.query.owner);
        const contact = formatPhoneNumber(req.query.contact) || clean(req.query.contact);
        const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20) || 20));
        const skip = Math.max(0, Number(req.query.skip || 0) || 0);
        const params = [deviceId];
        const conditions = ['device_id = ?'];
        if (contact) {
            conditions.push('(from_number = ? OR to_number = ?)');
            params.push(contact, contact);
        }
        if (clean(req.query.query)) {
            conditions.push('message LIKE ?');
            params.push(`%${clean(req.query.query)}%`);
        }
        params.push(limit, skip);
        const rows = await db.all(
            `SELECT id, external_id, from_number, to_number, message, type, status, timestamp, delivered_at, error, sim_slot, encrypted
             FROM sms
             WHERE ${conditions.join(' AND ')}
             ORDER BY timestamp DESC, id DESC
             LIMIT ? OFFSET ?`,
            params
        );
        return respondOk(res, 'messages fetched successfully', rows.map((row) => toHttpSmsMessage(row, owner)));
    } catch (error) {
        if (error.unregistered) {
            return res.status(202).json({ status: 'success', message: 'device not registered', ignored: true, data: [] });
        }
        logger.error('httpSMS index adapter error:', error);
        return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Failed to fetch messages' });
    }
});

module.exports = router;
