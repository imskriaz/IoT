const logger = require('../utils/logger');
const { formatPhoneNumber } = require('../utils/phoneNumber');
const { attachSmsToConversation } = require('./smsConversations');
const { assertSmsWithinPackageLimit } = require('./packageService');
const { assertUserSmsWithinLimits } = require('./userAccessService');
const { resolveSmsCommandForRecipient } = require('../utils/smsLimits');
const { buildSmsSubmitPdus } = require('../utils/smsPdu');

const MODEM_MQTT_UNICODE_PDU_SEGMENT_SIZE = 67;
const MODEM_MQTT_GSM7_PDU_SEGMENT_SIZE = 153;

function buildSmsCommandMessageId(command = 'send-sms') {
    const normalized = String(command || 'send-sms').trim().toLowerCase();
    const prefix = normalized === 'send-sms' || normalized === 'send-sms-multipart' ? 'sms' : 'cmd';
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
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

    const resolvedSmsCommand = resolveSmsCommandForRecipient(formattedNumber, message);
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
        const pduParts = buildSmsSubmitPdus(formattedNumber, message, {
            requestStatusReport: true,
            encoding: smsTransport.sms_transport_encoding === 'ucs2' ? 'ucs2' : 'gsm7',
            segmentSize: smsTransport.sms_transport_encoding === 'ucs2'
                ? MODEM_MQTT_UNICODE_PDU_SEGMENT_SIZE
                : MODEM_MQTT_GSM7_PDU_SEGMENT_SIZE
        });
        const queueResults = [];

        if (pduParts.length > 1) {
            for (let index = 0; index < pduParts.length; index++) {
                queueResults.push(await mqttService.publishCommand(
                    deviceId,
                    'send-sms',
                    {
                        to: formattedNumber,
                        message: '',
                        smsId,
                        sim_slot: normalizedSimSlot,
                        sms_pdu: pduParts[index].pdu,
                        sms_pdu_encoding: pduParts[index].encoding,
                        sms_status_report_requested: pduParts[index].statusReportRequested,
                        sms_base_message_id: messageId,
                        sms_part_index: index + 1,
                        sms_part_count: pduParts.length
                    },
                    false,
                    smsTimeoutMs,
                    {
                        source: `${source}-sms`,
                        userId,
                        messageId: `${messageId}_p${index + 1}`,
                        priority: 50 + index
                    }
                ));
            }
        } else {
            queueResults.push(await mqttService.publishCommand(
                deviceId,
                'send-sms',
                {
                    to: formattedNumber,
                    message: '',
                    smsId,
                    sim_slot: normalizedSimSlot,
                    timeout: smsTimeoutMs,
                    sms_pdu: pduParts[0].pdu,
                    sms_pdu_encoding: pduParts[0].encoding,
                    sms_status_report_requested: pduParts[0].statusReportRequested
                },
                false,
                smsTimeoutMs,
                {
                    source: `${source}-sms`,
                    userId,
                    messageId,
                    priority: 50
                }
            ));
        }

        const queueResult = queueResults[0] || {};
        const smsStatus = queueResults.some((result) => normalizeQueuedSmsRowStatus(result) === 'sending')
            ? 'sending'
            : normalizeQueuedSmsRowStatus(queueResult);
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
            segmentedPdu: pduParts.length > 1,
            queueId: queueResult?.queueId || null,
            queueIds: queueResults.map((result) => result?.queueId).filter(Boolean),
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
