'use strict';

const { formatPhoneNumber, getPhoneLookupKeys } = require('../utils/phoneNumber');
const {
    inferServiceSender,
    looksLikeShiftedNibbleString
} = require('../utils/smsUnicode');

const GENERIC_SERVICE_TITLES = new Set([
    'service sender',
    'service messages',
    'system sender'
]);

function getConversationCounterpart(row) {
    const outgoing = String(row?.type || '').toLowerCase() === 'outgoing';
    return String(outgoing ? (row?.to_number || row?.from_number || '') : (row?.from_number || row?.to_number || '')).trim();
}

function normalizeServiceKey(title) {
    const normalized = String(title || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized || '';
}

function isGenericServiceTitle(title) {
    return GENERIC_SERVICE_TITLES.has(String(title || '').trim().toLowerCase());
}

function getEncodedServiceLookupKey(value) {
    const raw = String(value || '').trim().toLowerCase();
    return raw ? `encoded-service:${raw}` : '';
}

function normalizeConversationParticipant(number, options = {}) {
    const raw = String(number || '').trim();
    if (!raw) {
        return {
            number: 'service-inbox',
            key: 'service:inbox',
            title: 'Service messages'
        };
    }

    if (/[*#]/.test(raw)) {
        return {
            number: raw,
            key: `service:${raw.toLowerCase()}`,
            title: raw
        };
    }

    if (looksLikeShiftedNibbleString(raw)) {
        const inferredTitle = inferServiceSender(options.message || options.title || '');
        const specificServiceKey = !isGenericServiceTitle(inferredTitle) ? normalizeServiceKey(inferredTitle) : '';
        return {
            number: raw,
            key: specificServiceKey ? `service:${specificServiceKey}` : `service:${raw.toLowerCase()}`,
            title: inferredTitle || 'Service Sender',
            encodedService: true,
            encodedLookupKey: getEncodedServiceLookupKey(raw)
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
            title: raw
        };
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

async function findConversationByParticipantLookup(db, deviceId, lookupKey) {
    if (!db || !deviceId || !lookupKey) return null;
    return db.get(
        `SELECT c.id, c.title
         FROM sms_conversations c
         INNER JOIN sms_conversation_participants p ON p.conversation_id = c.id
         WHERE c.device_id = ?
           AND p.lookup_key = ?
         ORDER BY CASE
                    WHEN lower(COALESCE(c.title, '')) IN ('service sender', 'service messages', 'system sender') THEN 1
                    ELSE 0
                  END ASC,
                  datetime(COALESCE(c.last_message_at, c.updated_at, c.created_at)) DESC,
                  c.id DESC
         LIMIT 1`,
        [deviceId, lookupKey]
    );
}

async function ensureSmsConversation(db, { deviceId, participantNumber, title = null, message = '' }) {
    const normalized = normalizeConversationParticipant(participantNumber, { title, message });
    const primaryNumber = normalized.number;
    const conversationKey = normalized.key;
    if (!db || !deviceId || !primaryNumber || !conversationKey) return null;
    const normalizedTitle = normalizeConversationParticipant(title, { message }).title;
    const safeTitle = normalized.encodedService
        ? normalized.title
        : (normalizedTitle === primaryNumber ? title || normalized.title : normalized.title);

    const existingByKey = await db.get(
        `SELECT id
         FROM sms_conversations
         WHERE device_id = ?
           AND conversation_key = ?`,
        [deviceId, conversationKey]
    );
    const existingBySender = normalized.encodedService
        ? await findConversationByParticipantLookup(db, deviceId, normalized.encodedLookupKey)
        : null;
    const existing = normalized.encodedService
        && isGenericServiceTitle(normalized.title)
        && existingBySender
        && !isGenericServiceTitle(existingBySender.title)
        ? existingBySender
        : (existingByKey || existingBySender);

    const conversationId = existing?.id || (await db.run(
        `INSERT INTO sms_conversations
            (device_id, conversation_key, primary_number, title, participant_count)
         VALUES (?, ?, ?, ?, 1)`,
        [deviceId, conversationKey, primaryNumber, safeTitle]
    )).lastID;

    if (existingBySender && !existingByKey && normalized.encodedService && !isGenericServiceTitle(normalized.title)) {
        try {
            await db.run(
                `UPDATE sms_conversations
                 SET conversation_key = ?,
                     title = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [conversationKey, safeTitle, conversationId]
            );
        } catch (_) {}
    }

    await db.run(
        `INSERT OR IGNORE INTO sms_conversation_participants
            (conversation_id, phone_number, lookup_key, display_name, is_self)
         VALUES (?, ?, ?, ?, 0)`,
        [conversationId, primaryNumber, conversationKey, safeTitle]
    );

    if (normalized.encodedService && normalized.encodedLookupKey) {
        await db.run(
            `INSERT OR IGNORE INTO sms_conversation_participants
                (conversation_id, phone_number, lookup_key, display_name, is_self)
             VALUES (?, ?, ?, ?, 0)`,
            [conversationId, primaryNumber, normalized.encodedLookupKey, safeTitle]
        );
        if (!isGenericServiceTitle(safeTitle)) {
            await db.run(
                `UPDATE sms_conversation_participants
                 SET display_name = ?
                 WHERE conversation_id = ?
                   AND lookup_key IN (?, ?)
                   AND lower(COALESCE(display_name, '')) IN ('', 'service sender', 'service messages', 'system sender')`,
                [safeTitle, conversationId, conversationKey, normalized.encodedLookupKey]
            );
        }
    }

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
    const conversationId = await ensureSmsConversation(db, {
        deviceId: smsRow.device_id,
        participantNumber,
        title: participantNumber,
        message: smsRow.message
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

async function repairEncodedServiceConversations(db, deviceId = null) {
    if (!db) return;

    const params = deviceId ? [deviceId] : [];
    const deviceWhere = deviceId ? 'AND device_id = ?' : '';
    const rows = await db.all(
        `SELECT id, device_id, from_number, to_number, message, type, conversation_id
         FROM sms
         WHERE COALESCE(device_id, '') != ''
           ${deviceWhere}
         ORDER BY datetime(timestamp) ASC, id ASC`,
        params
    );

    const encodedRows = (Array.isArray(rows) ? rows : []).filter((row) => {
        const participantNumber = getConversationCounterpart(row);
        return looksLikeShiftedNibbleString(participantNumber);
    });
    if (!encodedRows.length) return;

    const touchedConversationIds = new Set();
    for (const row of encodedRows) {
        if (row.conversation_id) {
            touchedConversationIds.add(row.conversation_id);
        }
        const conversationId = await ensureSmsConversation(db, {
            deviceId: row.device_id,
            participantNumber: getConversationCounterpart(row),
            title: getConversationCounterpart(row),
            message: row.message
        });
        if (!conversationId) continue;
        touchedConversationIds.add(conversationId);
        if (Number(row.conversation_id || 0) !== Number(conversationId || 0)) {
            await db.run(
                'UPDATE sms SET conversation_id = ? WHERE id = ?',
                [conversationId, row.id]
            );
        }
    }

    for (const conversationId of touchedConversationIds) {
        await refreshSmsConversation(db, conversationId);
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
        const conversationKey = `${row.device_id}:${getConversationKey(participantNumber, {
            title: participantNumber,
            message: row.message
        })}`;
        if (!participantNumber || conversationKey.endsWith(':')) continue;

        let conversationId = conversationCache.get(conversationKey);
        if (!conversationId) {
            conversationId = await ensureSmsConversation(db, {
                deviceId: row.device_id,
                participantNumber,
                title: participantNumber,
                message: row.message
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
    repairEncodedServiceConversations,
    rebuildSmsConversationIndex,
    refreshSmsConversation,
    refreshSmsConversationBySmsId,
    refreshSmsConversationsForDevice
};
