'use strict';

const { formatPhoneNumber, getPhoneLookupKeys, normalizePhoneDigits } = require('../utils/phoneNumber');
const {
    getSmsSenderDisplayName,
    looksLikeShiftedNibbleString
} = require('../utils/smsUnicode');

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
        return {
            number: raw,
            key: `service:${raw.toLowerCase()}`,
            title: getSmsSenderDisplayName(raw, message)
        };
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
        return {
            number: raw,
            key: `service:${raw.toLowerCase()}`,
            title: getSmsSenderDisplayName(raw, message)
        };
    }

    return {
        number: 'service-inbox',
        key: 'service:inbox',
        title: 'Service messages'
    };
}

function getConversationKey(number) {
    return normalizeConversationParticipant(number).key;
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

    const existing = await db.get(
        `SELECT id
         FROM sms_conversations
         WHERE device_id = ?
           AND conversation_key = ?`,
        [deviceId, conversationKey]
    );

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
    const displayTitle = getSmsSenderDisplayName(participantNumber, smsRow.message);
    const conversationId = await ensureSmsConversation(db, {
        deviceId: smsRow.device_id,
        participantNumber,
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

    await backfillSmsConversations(db);
}

async function backfillSmsConversations(db) {
    if (!db) return;

    const rows = await db.all(
        `SELECT id, device_id, from_number, to_number, message, type
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

    for (const row of rows) {
        const participantNumber = getConversationCounterpart(row);
        const conversationKey = `${row.device_id}:${getConversationKey(participantNumber)}`;
        if (!participantNumber || conversationKey.endsWith(':')) continue;

        let conversationId = conversationCache.get(conversationKey);
        if (!conversationId) {
            const displayTitle = getSmsSenderDisplayName(participantNumber, row.message);
            conversationId = await ensureSmsConversation(db, {
                deviceId: row.device_id,
                participantNumber,
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
