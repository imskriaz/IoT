'use strict';

const { formatPhoneNumber, getPhoneLookupKeys, normalizePhoneDigits } = require('../utils/phoneNumber');
const {
    getSmsSenderDisplayName,
    looksLikeShiftedNibbleString
} = require('../utils/smsUnicode');

function isGenericServiceTitle(title) {
    const value = String(title || '').trim().toLowerCase();
    return !value || value === 'service sender' || value === 'service messages';
}

function buildServiceConversationKey(raw, title) {
    const displayTitle = String(title || '').trim();
    const stableSource = isGenericServiceTitle(displayTitle) ? String(raw || '').trim() : displayTitle;
    const normalized = stableSource.toLowerCase().replace(/\s+/g, '-');
    return `service:${normalized || 'inbox'}`;
}

function normalizeServiceParticipant(raw, message) {
    const title = getSmsSenderDisplayName(raw, message);
    if (!String(raw || '').trim()) {
        return {
            number: 'service-inbox',
            key: 'service:inbox',
            title: 'Service messages'
        };
    }
    return {
        number: raw,
        key: buildServiceConversationKey(raw, title),
        title
    };
}

function toTimestampMs(value) {
    const parsed = value ? new Date(value).getTime() : 0;
    return Number.isFinite(parsed) ? parsed : 0;
}

function getConversationCounterpart(row) {
    const outgoing = String(row?.type || '').toLowerCase() === 'outgoing';
    return String(outgoing ? (row?.to_number || row?.from_number || '') : (row?.from_number || row?.to_number || '')).trim();
}

function normalizeConversationParticipant(number, options = {}) {
    const raw = String(number || '').trim();
    const message = options && typeof options === 'object' ? options.message : '';
    if (!raw) {
        return {
            number: 'service-inbox',
            key: 'service:inbox',
            title: 'Service messages'
        };
    }

    const rawDigits = normalizePhoneDigits(raw);
    if (/[*#]/.test(raw) || looksLikeShiftedNibbleString(raw) || (rawDigits.length > 0 && rawDigits.length < 10)) {
        return normalizeServiceParticipant(raw, message);
    }

    const formatted = formatPhoneNumber(raw);
    if (formatted) {
        const lookup = getPhoneLookupKeys(formatted);
        return {
            number: formatted,
            key: String(lookup.last10 || lookup.digits || formatted).toLowerCase(),
            title: formatted
        };
    }

    if (/[A-Za-z0-9]/.test(raw)) {
        return normalizeServiceParticipant(raw, message);
    }

    return {
        number: 'service-inbox',
        key: 'service:inbox',
        title: 'Service messages'
    };
}

function getConversationKey(number, options = {}) {
    return normalizeConversationParticipant(number, options).key;
}

function buildMessagePreview(message) {
    const text = String(message || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

async function ensureSmsConversation(db, { deviceId, participantNumber, title = null }) {
    const normalized = normalizeConversationParticipant(participantNumber, { message: title });
    const primaryNumber = normalized.number;
    const conversationKey = normalized.key;
    if (!db || !deviceId || !primaryNumber || !conversationKey) return null;
    const normalizedTitle = normalizeConversationParticipant(title, { message: title }).title;
    const safeTitle = normalizedTitle === primaryNumber ? title || normalized.title : normalized.title;

    let existing = await db.get(
        `SELECT id
         FROM sms_conversations
         WHERE device_id = ?
           AND conversation_key = ?`,
        [deviceId, conversationKey]
    );

    if (!existing && conversationKey.startsWith('service:')) {
        const sameSenderConversation = await db.get(
            `SELECT id, conversation_key, title
             FROM sms_conversations
             WHERE device_id = ?
               AND primary_number = ?
               AND conversation_key LIKE 'service:%'
             ORDER BY CASE
                    WHEN LOWER(COALESCE(title, '')) IN ('service sender', 'service messages') THEN 1
                    ELSE 0
                 END,
                 id ASC
             LIMIT 1`,
            [deviceId, primaryNumber]
        );

        if (sameSenderConversation) {
            existing = sameSenderConversation;
            if (!isGenericServiceTitle(normalized.title) && sameSenderConversation.conversation_key !== conversationKey) {
                const keyOwner = await db.get(
                    `SELECT id
                     FROM sms_conversations
                     WHERE device_id = ?
                       AND conversation_key = ?`,
                    [deviceId, conversationKey]
                );
                if (!keyOwner) {
                    await db.run(
                        `UPDATE sms_conversations
                         SET conversation_key = ?,
                             title = ?,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?`,
                        [conversationKey, normalized.title, sameSenderConversation.id]
                    );
                    existing = { ...sameSenderConversation, conversation_key: conversationKey, title: normalized.title };
                }
            }
        }
    }

    const conversationId = existing?.id || (await db.run(
        `INSERT INTO sms_conversations
            (device_id, conversation_key, primary_number, title, participant_count)
         VALUES (?, ?, ?, ?, 1)`,
        [deviceId, conversationKey, primaryNumber, safeTitle]
    )).lastID;

    await db.run(
        `INSERT OR IGNORE INTO sms_conversation_participants
            (conversation_id, phone_number, lookup_key, display_name, is_self)
         VALUES (?, ?, ?, ?, 0)`,
        [conversationId, primaryNumber, conversationKey, safeTitle]
    );

    return conversationId;
}

async function refreshSmsConversation(db, conversationId) {
    if (!db || !conversationId) return null;

    const aggregate = await db.get(
        `SELECT COUNT(*) AS total_count,
                SUM(CASE WHEN type != 'outgoing' AND read = 0 THEN 1 ELSE 0 END) AS unread_count
         FROM sms
         WHERE conversation_id = ?`,
        [conversationId]
    );

    const latest = await db.get(
        `SELECT id, message, timestamp, type, status
         FROM sms
         WHERE conversation_id = ?
         ORDER BY datetime(timestamp) DESC, id DESC
         LIMIT 1`,
        [conversationId]
    );

    if (!latest) {
        await db.run('DELETE FROM sms_conversations WHERE id = ?', [conversationId]);
        return null;
    }

    await db.run(
        `UPDATE sms_conversations
         SET message_count = ?,
             unread_count = ?,
             last_message_id = ?,
             last_message_preview = ?,
             last_message_direction = ?,
             last_message_status = ?,
             last_message_at = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
            Number(aggregate?.total_count || 0),
            Number(aggregate?.unread_count || 0),
            latest.id,
            buildMessagePreview(latest.message),
            String(latest.type || '').toLowerCase() === 'outgoing' ? 'outgoing' : 'incoming',
            latest.status || null,
            latest.timestamp || null,
            conversationId
        ]
    );

    return conversationId;
}

async function attachSmsToConversation(db, smsRow) {
    if (!db || !smsRow?.id || !smsRow?.device_id) return null;

    const participantNumber = getConversationCounterpart(smsRow);
    let displayTitle = getSmsSenderDisplayName(participantNumber, smsRow.message);
    let conversationParticipantNumber = participantNumber;
    const normalized = normalizeConversationParticipant(participantNumber, { message: smsRow.message });
    if (normalized.key.startsWith('service:') && isGenericServiceTitle(normalized.title)) {
        const recentServiceConversation = await findRecentNamedServiceConversation(db, smsRow);
        if (recentServiceConversation) {
            conversationParticipantNumber = recentServiceConversation.primary_number || participantNumber;
            displayTitle = recentServiceConversation.title || displayTitle;
        }
    }

    const conversationId = await ensureSmsConversation(db, {
        deviceId: smsRow.device_id,
        participantNumber: conversationParticipantNumber,
        title: displayTitle
    });

    if (!conversationId) return null;

    await db.run(
        'UPDATE sms SET conversation_id = ? WHERE id = ?',
        [conversationId, smsRow.id]
    );
    await refreshSmsConversation(db, conversationId);
    return conversationId;
}

async function findRecentNamedServiceConversation(db, smsRow) {
    const deviceId = String(smsRow?.device_id || '').trim();
    const timestampMs = toTimestampMs(smsRow?.timestamp);
    if (!db || !deviceId || !timestampMs) return null;

    const rows = await db.all(
        `SELECT s.id,
                s.timestamp,
                s.conversation_id,
                sc.primary_number,
                sc.title
         FROM sms s
         JOIN sms_conversations sc ON sc.id = s.conversation_id
         WHERE s.device_id = ?
           AND s.id != ?
           AND sc.conversation_key LIKE 'service:%'
         ORDER BY datetime(s.timestamp) DESC, s.id DESC
         LIMIT 20`,
        [deviceId, smsRow.id]
    );

    return (Array.isArray(rows) ? rows : []).find((row) => {
        if (isGenericServiceTitle(row.title)) return false;
        const gapMs = timestampMs - toTimestampMs(row.timestamp);
        return gapMs >= 0 && gapMs <= 45000;
    }) || null;
}

async function refreshSmsConversationBySmsId(db, smsId) {
    if (!db || !smsId) return null;
    const row = await db.get('SELECT conversation_id FROM sms WHERE id = ?', [smsId]);
    if (!row?.conversation_id) return null;
    return refreshSmsConversation(db, row.conversation_id);
}

async function refreshSmsConversationsForDevice(db, deviceId) {
    if (!db || !deviceId) return;
    const rows = await db.all(
        'SELECT id FROM sms_conversations WHERE device_id = ?',
        [deviceId]
    );
    for (const row of (Array.isArray(rows) ? rows : [])) {
        await refreshSmsConversation(db, row.id);
    }
}

async function rebuildSmsConversationIndex(db, deviceId = null) {
    if (!db) return;

    const params = deviceId ? [deviceId] : [];
    const where = deviceId ? 'WHERE device_id = ?' : '';

    await db.run(
        `UPDATE sms SET conversation_id = NULL ${where}`,
        params
    );

    if (deviceId) {
        await db.run('DELETE FROM sms_conversation_participants WHERE conversation_id IN (SELECT id FROM sms_conversations WHERE device_id = ?)', [deviceId]);
        await db.run('DELETE FROM sms_conversations WHERE device_id = ?', [deviceId]);
    } else {
        await db.run('DELETE FROM sms_conversation_participants');
        await db.run('DELETE FROM sms_conversations');
    }

    await backfillSmsConversations(db, { repairLegacy: false });
}

async function repairStaleSmsConversationIndexes(db) {
    if (!db) return;

    const rows = await db.all(
        `SELECT s.device_id,
                s.from_number,
                s.to_number,
                s.message,
                s.type,
                sc.conversation_key
         FROM sms s
         JOIN sms_conversations sc ON sc.id = s.conversation_id
         WHERE COALESCE(s.device_id, '') != ''
           AND COALESCE(sc.conversation_key, '') != ''`
    );

    const staleDeviceIds = new Set();
    for (const row of (Array.isArray(rows) ? rows : [])) {
        const participantNumber = getConversationCounterpart(row);
        if (!participantNumber) continue;
        const expected = normalizeConversationParticipant(participantNumber, { message: row.message });
        if (
            expected.key
            && expected.key !== row.conversation_key
            && !(isGenericServiceTitle(expected.title) && String(row.conversation_key || '').startsWith('service:'))
        ) {
            staleDeviceIds.add(row.device_id);
        }
    }

    for (const deviceId of staleDeviceIds) {
        await rebuildSmsConversationIndex(db, deviceId);
    }
}

async function backfillSmsConversations(db, options = {}) {
    if (!db) return;
    if (options.repairLegacy !== false) {
        await repairStaleSmsConversationIndexes(db);
    }

    const rows = await db.all(
        `SELECT id, device_id, from_number, to_number, message, timestamp, type
         FROM sms
         WHERE COALESCE(device_id, '') != ''
           AND COALESCE(conversation_id, 0) = 0
         ORDER BY datetime(timestamp) ASC, id ASC`
    );

    if (!Array.isArray(rows) || !rows.length) {
        return;
    }

    const conversationCache = new Map();
    const touchedConversationIds = new Set();
    const recentNamedServiceByDevice = new Map();
    const recentGenericServiceByDevice = new Map();

    for (const row of rows) {
        const participantNumber = getConversationCounterpart(row);
        const normalized = normalizeConversationParticipant(participantNumber, { message: row.message });
        const timestampMs = toTimestampMs(row.timestamp);
        let conversationParticipantNumber = participantNumber;
        let displayTitle = getSmsSenderDisplayName(participantNumber, row.message);
        let conversationKey = `${row.device_id}:${normalized.key}`;
        const recentNamedService = recentNamedServiceByDevice.get(row.device_id);
        const serviceContinuation = normalized.key.startsWith('service:')
            && isGenericServiceTitle(normalized.title)
            && recentNamedService
            && timestampMs
            && timestampMs - recentNamedService.timestampMs >= 0
            && timestampMs - recentNamedService.timestampMs <= 45000;
        if (serviceContinuation) {
            conversationParticipantNumber = recentNamedService.participantNumber;
            displayTitle = recentNamedService.title;
            conversationKey = `${row.device_id}:${recentNamedService.key}`;
        }
        if (!participantNumber || conversationKey.endsWith(':')) continue;

        let conversationId = conversationCache.get(conversationKey);
        if (!conversationId) {
            conversationId = await ensureSmsConversation(db, {
                deviceId: row.device_id,
                participantNumber: conversationParticipantNumber,
                title: displayTitle
            });
            if (!conversationId) continue;
            conversationCache.set(conversationKey, conversationId);
        }

        await db.run(
            'UPDATE sms SET conversation_id = ? WHERE id = ?',
            [conversationId, row.id]
        );
        touchedConversationIds.add(conversationId);

        const serviceThread = normalized.key.startsWith('service:');
        const namedServiceThread = serviceThread && (!isGenericServiceTitle(normalized.title) || serviceContinuation);
        if (namedServiceThread) {
            const recentGenericRows = recentGenericServiceByDevice.get(row.device_id) || [];
            const rowsToMove = recentGenericRows.filter((item) => (
                timestampMs
                && timestampMs - item.timestampMs >= 0
                && timestampMs - item.timestampMs <= 45000
            ));
            if (rowsToMove.length) {
                await db.run(
                    `UPDATE sms
                     SET conversation_id = ?
                     WHERE id IN (${rowsToMove.map(() => '?').join(',')})`,
                    [conversationId, ...rowsToMove.map((item) => item.id)]
                );
                rowsToMove.forEach((item) => touchedConversationIds.add(item.conversationId));
                touchedConversationIds.add(conversationId);
                recentGenericServiceByDevice.set(
                    row.device_id,
                    recentGenericRows.filter((item) => !rowsToMove.some((moved) => moved.id === item.id))
                );
            }
            recentNamedServiceByDevice.set(row.device_id, {
                key: serviceContinuation ? recentNamedService.key : normalized.key,
                participantNumber: conversationParticipantNumber,
                title: displayTitle,
                timestampMs
            });
        } else if (serviceThread && isGenericServiceTitle(normalized.title) && !serviceContinuation && timestampMs) {
            const recentRows = recentGenericServiceByDevice.get(row.device_id) || [];
            recentRows.push({ id: row.id, conversationId, timestampMs });
            recentGenericServiceByDevice.set(
                row.device_id,
                recentRows.filter((item) => timestampMs - item.timestampMs <= 45000)
            );
        }
    }

    for (const conversationId of touchedConversationIds) {
        await refreshSmsConversation(db, conversationId);
    }
}

module.exports = {
    attachSmsToConversation,
    backfillSmsConversations,
    buildMessagePreview,
    ensureSmsConversation,
    normalizeConversationParticipant,
    rebuildSmsConversationIndex,
    refreshSmsConversation,
    refreshSmsConversationBySmsId,
    refreshSmsConversationsForDevice
};
