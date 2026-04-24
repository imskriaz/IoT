const logger = require('../utils/logger');
const { formatPhoneNumber } = require('../utils/phoneNumber');
const { attachSmsToConversation } = require('./smsConversations');
const { assertSmsWithinPackageLimit } = require('./packageService');
const { assertUserSmsWithinLimits } = require('./userAccessService');
const { resolveSmsCommand } = require('../utils/smsLimits');

function buildSmsCommandMessageId(command = 'send-sms') {
    const normalized = String(command || 'send-sms').trim().toLowerCase();
    return `${normalized}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeQueuedSmsRowStatus(queueResult) {
    const state = String(queueResult?.status || '').trim().toLowerCase();
    if (state === 'dispatching' || state === 'waiting_response') {
        return 'sending';
    }
    return 'queued';
}

async function emitSmsQueued(deviceId, payload) {
    if (!global.io) return;
    if (deviceId) {
        const room = global.io.to?.(`device:${deviceId}`);
        if (room?.emit) room.emit('sms:queued', payload);
        else global.io.emit?.('sms:queued', payload);
        return;
    }
    global.io.emit?.('sms:queued', payload);
}

async function resolveDeviceTransportMode(db, deviceId) {
    if (!db || !deviceId) {
        return 'mqtt';
    }

    const row = await db.get(
        `SELECT d.type, dp.capabilities
         FROM devices d
         LEFT JOIN device_profiles dp ON dp.device_id = d.id
         WHERE d.id = ?
         LIMIT 1`,
        [deviceId]
    );
    if (!row) {
        return 'mqtt';
    }

    try {
        const caps = row.capabilities ? JSON.parse(row.capabilities) : {};
        if (String(caps.transport_mode || '').trim().toLowerCase() === 'http') {
            return 'http';
        }
    } catch (_) {
    }

    return String(row.type || '').toLowerCase().includes('android')
        ? 'mqtt'
        : 'mqtt';
}

async function queueSmsForDelivery({
    db,
    mqttService,
    deviceId,
    to,
    message,
    simSlot = null,
    userId = null,
    source = 'dashboard',
    existingSmsId = null,
    batchId = null
}) {
    if (!db) {
        throw new Error('Database not available');
    }
    const formattedNumber = formatPhoneNumber(to);
    if (!formattedNumber) {
        throw new Error('Invalid phone number format');
    }

    await assertSmsWithinPackageLimit(db, deviceId, 1);
    await assertUserSmsWithinLimits(db, userId, source, 1);

    const resolvedSmsCommand = resolveSmsCommand(message);
    const smsCommand = resolvedSmsCommand.command;
    const smsTransport = resolvedSmsCommand.metadata || {};
    const smsTimeoutMs = resolvedSmsCommand.timeoutMs || 60000;
    const messageId = buildSmsCommandMessageId(smsCommand);
    let smsId = existingSmsId;
    const normalizedSimSlot = Number.isInteger(Number(simSlot)) ? Number(simSlot) : null;

    if (smsId) {
        await db.run(
            `UPDATE sms
             SET device_id = ?,
                 from_number = ?,
                 to_number = ?,
                 message = ?,
                 type = 'outgoing',
                 status = 'queued',
                 timestamp = strftime('%Y-%m-%dT%H:%M:%f', 'now'),
                 user_id = ?,
                 source = ?,
                 batch_id = ?,
                 sim_slot = ?,
                 external_id = ?,
                 error = NULL
             WHERE id = ?`,
            [deviceId, 'self', formattedNumber, message, userId, source, batchId, normalizedSimSlot, messageId, smsId]
        );
    } else {
        const result = await db.run(
            `INSERT INTO sms
                (device_id, from_number, to_number, message, type, status, timestamp, user_id, source, batch_id, sim_slot, external_id)
             VALUES (?, ?, ?, ?, 'outgoing', 'queued', strftime('%Y-%m-%dT%H:%M:%f', 'now'), ?, ?, ?, ?, ?)`,
            [deviceId, 'self', formattedNumber, message, userId, source, batchId, normalizedSimSlot, messageId]
        );
        smsId = result.lastID;
    }

    const conversationId = await attachSmsToConversation(db, {
        id: smsId,
        device_id: deviceId,
        from_number: 'self',
        to_number: formattedNumber,
        type: 'outgoing'
    });

    const transportMode = await resolveDeviceTransportMode(db, deviceId);
    if (transportMode === 'http') {
        const payload = {
            success: true,
            queued: true,
            id: smsId,
            to: formattedNumber,
            conversationId,
            status: 'queued',
            transport: 'http',
            simSlot: normalizedSimSlot,
            sms: smsTransport,
            messageId
        };

        await emitSmsQueued(deviceId, {
            deviceId,
            ...payload,
            message,
            timestamp: new Date().toISOString()
        });

        return payload;
    }

    if (!mqttService || typeof mqttService.publishCommand !== 'function') {
        throw new Error('MQTT service unavailable');
    }

    try {
        const queueResult = await mqttService.publishCommand(
            deviceId,
            smsCommand,
            {
                to: formattedNumber,
                message,
                smsId,
                sim_slot: normalizedSimSlot,
                timeout: smsTimeoutMs,
                ...smsTransport
            },
            false,
            smsTimeoutMs,
            {
                source: `${source}-sms`,
                userId,
                messageId,
                priority: 50
            }
        );

        const smsStatus = normalizeQueuedSmsRowStatus(queueResult);
        await db.run(
            'UPDATE sms SET status = ?, error = NULL WHERE id = ?',
            [smsStatus, smsId]
        );

        const payload = {
            success: true,
            queued: true,
            id: smsId,
            to: formattedNumber,
            conversationId,
            status: smsStatus,
            command: smsCommand,
            simSlot: normalizedSimSlot,
            sms: smsTransport,
            queueId: queueResult?.queueId || null,
            messageId
        };

        await emitSmsQueued(deviceId, {
            deviceId,
            ...payload,
            message,
            timestamp: new Date().toISOString()
        });

        return payload;
    } catch (error) {
        logger.error('SMS queue failed:', error.message || error);
        await db.run(
            'UPDATE sms SET status = ?, error = ? WHERE id = ?',
            ['failed', error.message || 'Failed to queue SMS', smsId]
        );
        throw error;
    }
}

module.exports = { queueSmsForDelivery };
