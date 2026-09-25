const logger = require('../utils/logger');
const crypto = require('crypto');
const { formatPhoneNumber } = require('../utils/phoneNumber');
const { attachSmsToConversation } = require('./smsConversations');
const { assertSmsWithinPackageLimit } = require('./packageService');
const { assertUserSmsWithinLimits } = require('./userAccessService');
const { resolveSmsCommandForRecipient } = require('../utils/smsLimits');
const { buildSmsSubmitPdus } = require('../utils/smsPdu');
const pushNotificationService = require('./pushNotificationService');

const MODEM_MQTT_UNICODE_PDU_SEGMENT_SIZE = 17;
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

function stageModemMultipartSms(db, details) {
    const raw = db?._raw;
    if (!raw || typeof raw.transaction !== 'function') {
        throw new Error('Atomic SMS queue requires the SQLite database');
    }

    const {
        deviceId, formattedNumber, message, simSlot, userId, source, batchId,
        existingSmsId, messageId, timeoutMs, expiresAt, pduParts
    } = details;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const insert = raw.transaction(() => {
        let smsId = existingSmsId;
        let conversationId = null;
        let baseMessageId = messageId;
        if (smsId) {
            const existing = raw.prepare(
                'SELECT id, device_id, to_number, message, sim_slot, status, external_id, conversation_id FROM sms WHERE id = ?'
            ).get(smsId);
            if (!existing) throw new Error('Existing SMS not found');
            conversationId = existing.conversation_id || null;
            const prior = raw.prepare(
                `SELECT id, message_id, status, payload FROM device_command_queue
                 WHERE command IN ('send-sms', 'send-sms-multipart')
                   AND CAST(json_extract(payload, '$.smsId') AS INTEGER) = ?
                 ORDER BY priority ASC, created_at ASC`
            ).all(smsId);
            if (prior.length) {
                if (existing.device_id !== deviceId || existing.to_number !== formattedNumber ||
                    existing.message !== message || Number(existing.sim_slot ?? -1) !== Number(simSlot ?? -1)) {
                    const error = new Error('Existing SMS command belongs to a different message');
                    error.code = 'SMS_RETRY_PAYLOAD_CONFLICT';
                    throw error;
                }
                const parsed = prior.map((row) => ({ ...row, part: JSON.parse(row.payload) }));
                const base = parsed[0].part.sms_base_message_id;
                const complete = parsed.length === pduParts.length && base &&
                    parsed.every((row, index) => row.part.sms_base_message_id === base &&
                        Number(row.part.sms_part_index) === index + 1 &&
                        Number(row.part.sms_part_count) === pduParts.length &&
                        row.message_id === `${base}_p${index + 1}`);
                if (!complete) {
                    const error = new Error('Existing SMS has an incomplete or conflicting command queue; manual reconciliation required');
                    error.code = 'SMS_PARTIAL_QUEUE_AMBIGUOUS';
                    throw error;
                }
                return {
                    smsId, conversationId, messageId: base,
                    queueIds: prior.map((row) => row.id),
                    status: existing.status || 'queued', existing: true
                };
            }
            if (!['draft', 'scheduled'].includes(String(existing.status || '').toLowerCase())) {
                const error = new Error('Existing SMS has no command history but may already have executed; manual reconciliation required');
                error.code = 'SMS_QUEUE_HISTORY_MISSING';
                throw error;
            }
            raw.prepare(
                `UPDATE sms SET device_id = ?, from_number = 'self', to_number = ?, message = ?,
                 type = 'outgoing', status = 'queued', timestamp = strftime('%Y-%m-%dT%H:%M:%f', 'now'),
                 user_id = ?, source = ?, batch_id = ?, sim_slot = ?, external_id = ?, encrypted = 0,
                 error = NULL WHERE id = ?`
            ).run(deviceId, formattedNumber, message, userId, source, batchId, simSlot, baseMessageId, smsId);
        } else {
            const result = raw.prepare(
                `INSERT INTO sms
                    (device_id, from_number, to_number, message, type, status, timestamp,
                     user_id, source, batch_id, sim_slot, external_id, encrypted)
                 VALUES (?, 'self', ?, ?, 'outgoing', 'queued',
                         strftime('%Y-%m-%dT%H:%M:%f', 'now'), ?, ?, ?, ?, ?, 0)`
            ).run(deviceId, formattedNumber, message, userId, source, batchId, simSlot, baseMessageId);
            smsId = Number(result.lastInsertRowid);
        }

        const queueIds = [];
        const queueInsert = raw.prepare(
            `INSERT INTO device_command_queue (
                id, device_id, command, payload, message_id, status,
                requires_response, replay_safe, attempt_count, max_attempts,
                timeout_ms, priority, next_attempt_at, expires_at, source, user_id,
                created_at, updated_at
            ) VALUES (?, ?, 'send-sms', ?, ?, 'pending', 1, 0, 0, 6, ?, ?, NULL, ?, ?, ?, ?, ?)`
        );
        for (let index = 0; index < pduParts.length; index++) {
            const part = pduParts[index];
            const queueId = `dcq_${crypto.randomBytes(16).toString('hex')}`;
            queueInsert.run(
                queueId, deviceId,
                JSON.stringify({
                    to: formattedNumber, message: '', smsId, sim_slot: simSlot,
                    sms_pdu: part.pdu,
                    sms_pdu_encoding: part.encoding,
                    sms_status_report_requested: part.statusReportRequested,
                    sms_base_message_id: baseMessageId,
                    sms_part_index: index + 1,
                    sms_part_count: pduParts.length
                }),
                `${baseMessageId}_p${index + 1}`, timeoutMs, 50 + index, expiresAt,
                `${source}-sms`, userId, now, now
            );
            queueIds.push(queueId);
        }
        return { smsId, conversationId, messageId: baseMessageId, queueIds, status: 'queued', existing: false };
    });
    try {
        return insert.immediate();
    } catch (error) {
        if (/device command queue capacity reached/i.test(String(error?.message || error))) {
            error.code = 'DURABLE_QUEUE_FULL';
        }
        throw error;
    }
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

async function notifyHttpSmsQueued(db, deviceId, payload = {}) {
    if (!db?.all || !deviceId || !payload.messageId) {
        return { sent: 0, failed: 0, skipped: 0, results: [] };
    }

    const rows = await db.all(
        `SELECT push_token, platform, app_id
         FROM device_push_tokens
         WHERE device_id = ?
           AND is_active = 1
         ORDER BY last_seen_at DESC, id DESC`,
        [deviceId]
    );

    if (!rows?.length) {
        return { sent: 0, failed: 0, skipped: 0, results: [] };
    }

    return pushNotificationService.sendToTokens(rows, {
        title: 'New SMS',
        body: 'A queued SMS is ready to send.',
        data: {
            KEY_MESSAGE_ID: payload.messageId,
            message_id: payload.messageId,
            sms_id: String(payload.id || ''),
            device_id: deviceId,
            to: payload.to || '',
            sim: Number.isInteger(Number(payload.simSlot)) ? `SIM${Number(payload.simSlot) + 1}` : 'DEFAULT'
        }
    });
}

function boolFlag(value) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0 || value === null || value === undefined) return false;
    const text = String(value || '').trim().toLowerCase();
    return ['true', '1', 'yes', 'y', 'on'].includes(text);
}

async function resolveDeviceRow(db, deviceId) {
    return db.get(
        `SELECT d.type, dp.capabilities
         FROM devices d
         LEFT JOIN device_profiles dp ON dp.device_id = d.id
         WHERE d.id = ?
         LIMIT 1`,
        [deviceId]
    );
}

/** SMS-01: Android-family devices execute send_sms with {number,text} and
 * split the message themselves (SmsManager.divideMessage). They have no PDU
 * lane, so the dashboard must never emit modem PDUs to them — regardless of
 * whether their transport is HTTP or MQTT. */
function isAndroidFamilyDevice(row) {
    if (!row) return false;
    try {
        const caps = row.capabilities ? JSON.parse(row.capabilities) : {};
        const family = String(caps.device_family || caps.family || '').trim().toLowerCase();
        if (family === 'android' || family === 'android_bridge') return true;
    } catch (_) {
    }
    const deviceType = String(row.type || '').toLowerCase();
    return deviceType.includes('android')
        || deviceType.includes('httpsms')
        || (deviceType.includes('http') && deviceType.includes('sms'));
}

async function resolveDeviceTransportMode(db, deviceId) {
    if (!db || !deviceId) {
        return 'mqtt';
    }

    const row = await resolveDeviceRow(db, deviceId);
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

    const deviceType = String(row.type || '').toLowerCase();
    if (
        deviceType.includes('android') ||
        deviceType.includes('httpsms') ||
        (deviceType.includes('http') && deviceType.includes('sms'))
    ) {
        return 'http';
    }

    return 'mqtt';
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
    batchId = null,
    encrypted = false
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
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 19).replace('T', ' ');
    const messageId = buildSmsCommandMessageId(smsCommand);
    let smsId = existingSmsId;
    const normalizedSimSlot = Number.isInteger(Number(simSlot)) ? Number(simSlot) : null;
    const encryptedFlag = boolFlag(encrypted) ? 1 : 0;

    const transportMode = await resolveDeviceTransportMode(db, deviceId);
    const deviceRow = transportMode === 'http' ? null : await resolveDeviceRow(db, deviceId);
    if (transportMode !== 'http' && !isAndroidFamilyDevice(deviceRow)) {
        const pduParts = buildSmsSubmitPdus(formattedNumber, message, {
            requestStatusReport: true,
            encoding: smsTransport.sms_transport_encoding === 'ucs2' ? 'ucs2' : 'gsm7',
            segmentSize: smsTransport.sms_transport_encoding === 'ucs2'
                ? MODEM_MQTT_UNICODE_PDU_SEGMENT_SIZE
                : MODEM_MQTT_GSM7_PDU_SEGMENT_SIZE,
            forceSegmentSize: smsTransport.sms_transport_encoding === 'ucs2'
        });
        if (pduParts.length > 1) {
            if (encryptedFlag) throw new Error('Encrypted SMS requires HTTP Android/httpSMS transport');
            if (!mqttService || typeof mqttService.processPersistentQueue !== 'function') {
                throw new Error('Durable MQTT command queue unavailable');
            }
            const staged = stageModemMultipartSms(db, {
                deviceId, formattedNumber, message, simSlot: normalizedSimSlot,
                userId, source, batchId, existingSmsId, messageId,
                timeoutMs: smsTimeoutMs, expiresAt, pduParts
            });
            smsId = staged.smsId;
            let conversationId = staged.conversationId;
            if (!conversationId) {
                try {
                    conversationId = await attachSmsToConversation(db, {
                        id: smsId, device_id: deviceId, from_number: 'self',
                        to_number: formattedNumber, type: 'outgoing'
                    });
                } catch (error) {
                    logger.error('SMS conversation refresh failed after durable queue commit:', error);
                }
            }
            if (!staged.existing) {
                Promise.resolve().then(() => mqttService._emitDeviceQueueState?.(deviceId)).catch((error) => {
                    logger.warn('SMS queue state notification failed:', error);
                });
                Promise.resolve().then(() => mqttService.processPersistentQueue()).catch((error) => {
                    logger.error('Failed to kick persistent SMS queue:', error);
                });
            }
            const payload = {
                success: true, queued: true, id: smsId, to: formattedNumber,
                conversationId, status: staged.status, command: smsCommand,
                simSlot: normalizedSimSlot, sms: smsTransport, segmentedPdu: true,
                queueId: staged.queueIds[0], queueIds: staged.queueIds,
                messageId: staged.messageId, encrypted: false
            };
            await emitSmsQueued(deviceId, {
                deviceId, ...payload, message, timestamp: new Date().toISOString()
            }).catch((error) => {
                logger.warn('SMS queued notification failed:', error);
            });
            return payload;
        }
    }

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
                 encrypted = ?,
                 error = NULL
             WHERE id = ?`,
            [deviceId, 'self', formattedNumber, message, userId, source, batchId, normalizedSimSlot, messageId, encryptedFlag, smsId]
        );
    } else {
        const result = await db.run(
            `INSERT INTO sms
                (device_id, from_number, to_number, message, type, status, timestamp, user_id, source, batch_id, sim_slot, external_id, encrypted)
             VALUES (?, ?, ?, ?, 'outgoing', 'queued', strftime('%Y-%m-%dT%H:%M:%f', 'now'), ?, ?, ?, ?, ?, ?)`,
            [deviceId, 'self', formattedNumber, message, userId, source, batchId, normalizedSimSlot, messageId, encryptedFlag]
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
            messageId,
            encrypted: Boolean(encryptedFlag)
        };

        await emitSmsQueued(deviceId, {
            deviceId,
            ...payload,
            message,
            timestamp: new Date().toISOString()
        });
        await notifyHttpSmsQueued(db, deviceId, payload).catch((error) => {
            logger.warn('HTTP SMS push notification skipped:', error.message || error);
        });

        return payload;
    }

    if (encryptedFlag) {
        const detail = 'Encrypted SMS requires HTTP Android/httpSMS transport';
        await db.run(
            'UPDATE sms SET status = ?, error = ? WHERE id = ?',
            ['failed', detail, smsId]
        );
        throw new Error(detail);
    }

    if (!mqttService || typeof mqttService.publishCommand !== 'function') {
        throw new Error('MQTT service unavailable');
    }

    // SMS-01 (device family): Android bridge devices receive ONE plain-text
    // send_sms command (the app splits it via SmsManager.divideMessage and
    // reports terminal per-message results). Modem firmware keeps the PDU path.
    if (isAndroidFamilyDevice(deviceRow)) {
        const queueResult = await mqttService.publishCommand(
            deviceId,
            'send-sms',
            {
                to: formattedNumber,
                message,
                smsId,
                sim_slot: normalizedSimSlot,
                timeout: smsTimeoutMs,
                // Payload-level contract flag: keeps the MQTT envelope
                // plain-text (number/text) instead of a dashboard-built PDU,
                // including after durable-queue retries.
                sms_plain_text: true,
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
            command: 'send_sms',
            simSlot: normalizedSimSlot,
            sms: smsTransport,
            segmentedPdu: false,
            deviceFamily: 'android',
            messageId,
            encrypted: Boolean(encryptedFlag)
        };

        await emitSmsQueued(deviceId, {
            deviceId,
            ...payload,
            message,
            timestamp: new Date().toISOString()
        });

        return payload;
    }

    try {
        const pduParts = buildSmsSubmitPdus(formattedNumber, message, {
            requestStatusReport: true,
            encoding: smsTransport.sms_transport_encoding === 'ucs2' ? 'ucs2' : 'gsm7',
            segmentSize: smsTransport.sms_transport_encoding === 'ucs2'
                ? MODEM_MQTT_UNICODE_PDU_SEGMENT_SIZE
                : MODEM_MQTT_GSM7_PDU_SEGMENT_SIZE,
            forceSegmentSize: smsTransport.sms_transport_encoding === 'ucs2'
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
            messageId,
            encrypted: Boolean(encryptedFlag)
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
