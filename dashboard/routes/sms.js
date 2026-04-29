const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const logger = require('../utils/logger');
const {
    formatPhoneNumber,
    isShortCode,
    getPhoneLookupKeys,
    sqlNormalizePhone,
    sqlPhoneLastDigits
} = require('../utils/phoneNumber');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');
const {
    decodeSmsRecord,
    getSmsSenderDisplayName,
    isSmsSenderReplyable,
    looksLikeShiftedNibbleString
} = require('../utils/smsUnicode');
const { validateSmsMessageSize } = require('../utils/smsLimits');
const smsCache = require('../services/smsCache');
const { createRateLimiter } = require('../utils/rateLimiter');
const { queueSmsForDelivery } = require('../services/smsQueue');
const {
    attachSmsToConversation,
    buildMessagePreview,
    refreshSmsConversation,
    refreshSmsConversationBySmsId,
    refreshSmsConversationsForDevice
} = require('../services/smsConversations');
const {
    resolveRequestSimScope,
    appendSimScopeCondition,
    hasSimScope
} = require('../utils/simScope');

const smsRateLimit = createRateLimiter({ windowMs: 60000, max: 10, message: 'SMS rate limit exceeded. Max 10 per minute.' });
const scheduleImportUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
});

function isValidNumericId(id) {
    return /^[0-9]+$/.test(String(id));
}

function setNoStoreHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
}

function emitDeviceEvent(deviceId, event, payload) {
    const normalizedDeviceId = String(deviceId || '').trim();
    if (!global.io) return;
    if (normalizedDeviceId) {
        const room = global.io.to?.('device:' + normalizedDeviceId);
        if (room?.emit) room.emit(event, payload);
        else global.io.emit?.(event, payload);
    } else {
        global.io.emit?.(event, payload);
    }
}

function splitRecipientInput(value) {
    if (Array.isArray(value)) {
        return value.flatMap((item) => splitRecipientInput(item));
    }
    return String(value || '')
        .split(/[\n,;]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function normalizeSmsRecipients(value) {
    const seen = new Set();
    const recipients = [];
    const invalid = [];

    splitRecipientInput(value).forEach((entry) => {
        const formatted = formatPhoneNumber(entry);
        if (!formatted) {
            invalid.push(entry);
            return;
        }
        if (seen.has(formatted)) return;
        seen.add(formatted);
        recipients.push(formatted);
    });

    return { recipients, invalid };
}

function parseDelimitedLine(line) {
    const cells = [];
    let current = '';
    let quoted = false;
    const raw = String(line || '');
    for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        if (ch === '"') {
            if (quoted && raw[i + 1] === '"') {
                current += '"';
                i += 1;
            } else {
                quoted = !quoted;
            }
        } else if ((ch === ',' || ch === '\t') && !quoted) {
            cells.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    cells.push(current.trim());
    return cells;
}

function csvColumnIndex(columns, names) {
    const allowed = new Set(names.map((name) => String(name).trim().toLowerCase()));
    return columns.findIndex((column) => allowed.has(String(column || '').trim().toLowerCase()));
}

function parseScheduleImport(buffer) {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) return { rows: [], errors: ['Template is empty'] };
    const columns = parseDelimitedLine(lines[0]);
    const phoneIndex = csvColumnIndex(columns, ['phone', 'number', 'to', 'recipient']);
    const messageIndex = csvColumnIndex(columns, ['message', 'body', 'text']);
    const sendAtIndex = csvColumnIndex(columns, ['send_at', 'send at', 'schedule_at', 'scheduled_at']);
    const simIndex = csvColumnIndex(columns, ['sim_slot', 'sim', 'sim slot']);
    const errors = [];
    if (phoneIndex < 0) errors.push('Missing phone column');
    if (messageIndex < 0) errors.push('Missing message column');
    if (sendAtIndex < 0) errors.push('Missing send_at column');
    if (errors.length) return { rows: [], errors };

    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
        const cells = parseDelimitedLine(lines[i]);
        const phone = cells[phoneIndex] || '';
        const message = cells[messageIndex] || '';
        const sendAtRaw = cells[sendAtIndex] || '';
        const sendAt = new Date(sendAtRaw);
        const simRaw = simIndex >= 0 ? cells[simIndex] : '';
        const simSlot = simRaw === '' || simRaw == null ? null : Number.parseInt(simRaw, 10);
        if (!phone.trim() && !message.trim()) continue;
        if (!phone.trim() || !message.trim() || !Number.isFinite(sendAt.getTime())) {
            errors.push(`Row ${i + 1} is invalid`);
            continue;
        }
        rows.push({
            phone: phone.trim(),
            message: message.trim(),
            sendAt,
            simSlot: Number.isFinite(simSlot) ? Math.max(0, simSlot > 0 && simSlot <= 2 ? simSlot - 1 : simSlot) : null
        });
    }
    return { rows, errors };
}

async function getSmsTemplateById(db, id) {
    return db.get(
        `SELECT t.id, t.title, t.message, t.created_at, u.username as created_by
         FROM sms_templates t
         LEFT JOIN users u ON t.created_by = u.id
         WHERE t.id = ?`,
        [id]
    );
}

async function getUnreadCountForDevice(db, deviceId, simScope = {}) {
    const conditions = ['device_id = ?', 'read = 0', "type = 'incoming'"];
    const params = [deviceId];
    appendSimScopeCondition(conditions, params, simScope);
    const row = await db.get(
        `SELECT COUNT(*) as count
         FROM sms
         WHERE ${conditions.join(' AND ')}`,
        params
    );
    const count = Number(row?.count || 0);
    smsCache.set(count, deviceId);
    return count;
}

const COUNTERPART_EXPR = `CASE WHEN type = 'outgoing' THEN COALESCE(to_number, from_number) ELSE from_number END`;
const COUNTERPART_NORM_SQL = sqlNormalizePhone(COUNTERPART_EXPR);
const COUNTERPART_LAST10_SQL = sqlPhoneLastDigits(COUNTERPART_EXPR);

function getSmsThreadNumber(row) {
    const isOutgoing = String(row?.type || '').toLowerCase() === 'outgoing';
    return String(isOutgoing ? (row?.to_number || row?.from_number || '') : (row?.from_number || row?.to_number || '')).trim();
}

function getSmsThreadKey(number) {
    const raw = String(number || '').trim();
    if (!raw) return '';
    const lookup = getPhoneLookupKeys(raw);
    return String(lookup.last10 || lookup.digits || raw).toLowerCase();
}

function toTimestampMs(value) {
    const parsed = value ? new Date(value).getTime() : 0;
    return Number.isFinite(parsed) ? parsed : 0;
}

function buildSmsConversationSummaries(rows) {
    const threads = new Map();

    (Array.isArray(rows) ? rows : []).forEach((row) => {
        const threadNumber = getSmsThreadNumber(row);
        const threadKey = getSmsThreadKey(threadNumber);
        if (!threadNumber || !threadKey) return;

        const isOutgoing = String(row?.type || '').toLowerCase() === 'outgoing';
        const existing = threads.get(threadKey) || {
            latest: null,
            total_count: 0,
            unread_count: 0
        };
        const latest = existing.latest;
        const isNewer = !latest
            || toTimestampMs(row.timestamp) > toTimestampMs(latest.timestamp)
            || (toTimestampMs(row.timestamp) === toTimestampMs(latest.timestamp) && Number(row.id || 0) > Number(latest.id || 0));

        existing.total_count += 1;
        if (!isOutgoing && !row.read) existing.unread_count += 1;
        if (isNewer) {
            existing.latest = {
                ...row,
                thread_number: threadNumber,
                last_direction: isOutgoing ? 'outgoing' : 'incoming'
            };
        }
        threads.set(threadKey, existing);
    });

    return Array.from(threads.values())
        .filter((thread) => thread.latest)
        .sort((a, b) => {
            const delta = toTimestampMs(b.latest.timestamp) - toTimestampMs(a.latest.timestamp);
            if (delta !== 0) return delta;
            return Number(b.latest.id || 0) - Number(a.latest.id || 0);
        })
        .map((thread) => ({
            ...decodeSmsRecord(thread.latest),
            thread_number: thread.latest.thread_number,
            total_count: thread.total_count,
            unread_count: thread.unread_count,
            last_direction: thread.latest.last_direction
        }));
}

function normalizeSmsConversationRow(row) {
    if (!row || typeof row !== 'object') return row;
    const titleSource = String(row.display_from || row.title || '').trim();
    const numberSource = String(row.thread_number || row.primary_number || '').trim();
    const displaySource = titleSource || numberSource;
    const displayFrom = getSmsSenderDisplayName(displaySource, row.sender_context || row.message);
    const titleLooksSystem = Boolean(titleSource && looksLikeShiftedNibbleString(titleSource));
    const senderIsPhone = !titleLooksSystem && isSmsSenderReplyable(numberSource || displaySource);

    return {
        ...row,
        display_from: displayFrom,
        sender_is_phone: senderIsPhone,
        replyable: senderIsPhone
    };
}

function isSmsThreadReplyable(messages, fallbackNumber = '') {
    const list = Array.isArray(messages) ? messages : [];
    const incoming = list.filter((message) => String(message?.type || '').toLowerCase() !== 'outgoing');
    if (incoming.length) {
        return incoming.some((message) => message?.sender_is_phone === true);
    }
    return list.some((message) => isSmsSenderReplyable(message?.to_number || message?.from_number)) || isSmsSenderReplyable(fallbackNumber);
}

/**
 * @swagger
 * tags:
 *   name: SMS
 *   description: SMS message management
 */

/**
 * @swagger
 * /sms:
 *   get:
 *     summary: List SMS messages with pagination
 *     tags: [SMS]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 500 }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [incoming, outgoing] }
 *         description: Filter by message direction
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: Return only messages after this timestamp
 *     responses:
 *       200:
 *         description: Paginated SMS list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/SMS' }
 *                 pagination: { $ref: '#/components/schemas/Pagination' }
 */
router.get('/', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }

        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 500);
        const offset = (page - 1) * limit;
        const since = req.query.since || null;
        const type = req.query.type || null; // 'incoming' | 'outgoing' | null (all)
        const simScope = resolveRequestSimScope(req);

        const conditions = [];
        const baseParams = [];
        conditions.push('device_id = ?');
        baseParams.push(deviceId);
        if (since) { conditions.push('timestamp > ?'); baseParams.push(since); }
        if (type === 'incoming') { conditions.push("type != 'outgoing'"); }
        else if (type === 'outgoing') { conditions.push("type = 'outgoing'"); }
        appendSimScopeCondition(conditions, baseParams, simScope);
        const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

        const messages = await db.all(
            `SELECT s.id, s.device_id, s.from_number, s.to_number, s.message, s.timestamp, s.read, s.type, s.status, s.sim_slot, u.username as sent_by FROM sms s LEFT JOIN users u ON s.user_id = u.id ${where} ORDER BY s.timestamp DESC LIMIT ? OFFSET ?`,
            [...baseParams, limit, offset]
        );

        const total = await db.get(
            `SELECT COUNT(*) as count FROM sms ${where}`,
            baseParams
        );

        res.json({
            success: true,
            data: messages.map(decodeSmsRecord),
            pagination: {
                page,
                limit,
                total: total.count,
                pages: Math.ceil(total.count / limit)
            }
        });
    } catch (error) {
        logger.error('API SMS list error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch SMS messages'
        });
    }
});

router.get('/thread', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const db = req.app.locals.db;
        if (!db) throw new Error('Database not available');

        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const number = String(req.query.number || '').trim();
        const conversationId = Math.max(0, parseInt(req.query.conversationId, 10) || 0);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 100), 500);
        const simScope = resolveRequestSimScope(req);
        const simFilter = [];
        const simParams = [];
        appendSimScopeCondition(simFilter, simParams, simScope, { alias: 's' });

        if (!number && !conversationId) {
            return res.status(400).json({
                success: false,
                message: 'number or conversationId is required'
            });
        }

        let rows;
        if (conversationId) {
            rows = await db.all(`
                SELECT s.id,
                       s.device_id,
                       s.from_number,
                       s.to_number,
                       s.message,
                       s.timestamp,
                       s.read,
                       s.type,
                       s.status,
                       s.user_id,
                       s.conversation_id,
                       s.source,
                       s.error,
                       s.external_id,
                       s.sim_slot,
                       u.username AS sent_by
                FROM sms s
                LEFT JOIN users u ON s.user_id = u.id
                WHERE s.device_id = ?
                  AND s.conversation_id = ?
                  ${simFilter.length ? `AND ${simFilter.join(' AND ')}` : ''}
                ORDER BY s.timestamp DESC
                LIMIT ?
            `, [deviceId, conversationId, ...simParams, limit]);
        } else {
            const lookup = getPhoneLookupKeys(number);
            let phoneWhere = `${COUNTERPART_EXPR} = ?`;
            const params = [deviceId, number];

            if (lookup.digits) {
                phoneWhere = `(${COUNTERPART_NORM_SQL} = ? OR ${COUNTERPART_LAST10_SQL} = ? OR ${COUNTERPART_EXPR} = ?)`;
                params.length = 0;
                params.push(deviceId, lookup.digits, lookup.last10 || lookup.digits, number);
            }

            rows = await db.all(`
                SELECT s.id,
                       s.device_id,
                       s.from_number,
                       s.to_number,
                       s.message,
                       s.timestamp,
                       s.read,
                       s.type,
                       s.status,
                       s.user_id,
                       s.conversation_id,
                       s.source,
                       s.error,
                       s.external_id,
                       s.sim_slot,
                       u.username AS sent_by
                FROM sms s
                LEFT JOIN users u ON s.user_id = u.id
                WHERE s.device_id = ?
                  AND ${phoneWhere}
                  ${simFilter.length ? `AND ${simFilter.join(' AND ')}` : ''}
                ORDER BY s.timestamp DESC
                LIMIT ?
            `, [...params, ...simParams, limit]);
        }

        const messages = rows.map(decodeSmsRecord).reverse();
        const resolvedNumber = number || String(messages[messages.length - 1]?.to_number || messages[messages.length - 1]?.from_number || '').trim();
        const displayName = getSmsSenderDisplayName(
            messages.find((message) => String(message?.type || '').toLowerCase() !== 'outgoing')?.from_number || resolvedNumber,
            messages[messages.length - 1]?.message || ''
        );
        const replyable = isSmsThreadReplyable(messages, resolvedNumber);

        res.json({
            success: true,
            data: messages,
            meta: {
                deviceId,
                simSlot: simScope.simSlot,
                number: resolvedNumber,
                displayName,
                replyable,
                conversationId: conversationId || Number(messages[0]?.conversation_id || 0) || null,
                count: messages.length
            }
        });
    } catch (error) {
        logger.error('API SMS thread error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch SMS thread'
        });
    }
});

router.get('/conversations', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const db = req.app.locals.db;
        if (!db) throw new Error('Database not available');

        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 100), 500);
        const simScope = resolveRequestSimScope(req);
        let conversations = [];
        let total = { count: 0 };
        if (!hasSimScope(simScope)) {
            try {
                conversations = await db.all(`
                    SELECT id AS conversation_id,
                           device_id,
                           primary_number AS thread_number,
                           COALESCE(title, primary_number) AS display_from,
                           last_message_preview AS message,
                           COALESCE((
                               SELECT s.message
                               FROM sms s
                               WHERE s.conversation_id = sms_conversations.id
                                 AND (
                                    LOWER(COALESCE(s.message, '')) LIKE '%robi%'
                                    OR COALESCE(s.message, '') LIKE '%রবি%'
                                    OR LOWER(COALESCE(s.message, '')) LIKE '%airtel%'
                                    OR COALESCE(s.message, '') LIKE '%এয়ারটেল%'
                                    OR COALESCE(s.message, '') LIKE '%এয়ারটেল%'
                                    OR LOWER(COALESCE(s.message, '')) LIKE '%banglalink%'
                                    OR COALESCE(s.message, '') LIKE '%বাংলালিংক%'
                                    OR LOWER(COALESCE(s.message, '')) LIKE '%grameenphone%'
                                    OR COALESCE(s.message, '') LIKE '%গ্রামীণফোন%'
                                    OR LOWER(COALESCE(s.message, '')) LIKE '%bkash%'
                                    OR COALESCE(s.message, '') LIKE '%বিকাশ%'
                                    OR LOWER(COALESCE(s.message, '')) LIKE '%nagad%'
                                    OR COALESCE(s.message, '') LIKE '%নগদ%'
                                 )
                               ORDER BY datetime(s.timestamp) DESC, s.id DESC
                               LIMIT 1
                           ), last_message_preview) AS sender_context,
                           last_message_at AS timestamp,
                           unread_count,
                           message_count AS total_count,
                           last_message_direction AS last_direction,
                           last_message_status AS status
                    FROM sms_conversations
                    WHERE device_id = ?
                    ORDER BY datetime(last_message_at) DESC, id DESC
                    LIMIT ?
                `, [deviceId, limit]);
                conversations = conversations.map(normalizeSmsConversationRow);

                total = await db.get(
                    'SELECT COUNT(*) AS count FROM sms_conversations WHERE device_id = ?',
                    [deviceId]
                );
            } catch (error) {
                const message = String(error?.message || '');
                if (!/no such table:\s*sms_conversations/i.test(message)) {
                    throw error;
                }
            }
        }

        if (!conversations.length) {
            const scanLimit = Math.min(Math.max(limit * 10, 250), 2000);
            const conditions = [
                'device_id = ?',
                "(COALESCE(NULLIF(TRIM(from_number), ''), NULLIF(TRIM(to_number), '')) IS NOT NULL)"
            ];
            const params = [deviceId];
            appendSimScopeCondition(conditions, params, simScope);
            const rows = await db.all(`
                SELECT id, device_id, from_number, to_number, message, timestamp, read, type, status, user_id, conversation_id
                FROM sms
                WHERE ${conditions.join(' AND ')}
                ORDER BY datetime(timestamp) DESC, id DESC
                LIMIT ?
            `, [...params, scanLimit]);
            const allConversations = buildSmsConversationSummaries(rows);
            conversations = allConversations.slice(0, limit).map((row) => normalizeSmsConversationRow({
                ...row,
                conversation_id: hasSimScope(simScope) ? null : (row.conversation_id || null)
            }));
            total = { count: allConversations.length };
        }

        res.json({
            success: true,
            data: conversations,
            meta: {
                deviceId,
                simSlot: simScope.simSlot,
                total: Number(total?.count || 0),
                limit
            }
        });
    } catch (error) {
        logger.error('API SMS conversations error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch SMS conversations'
        });
    }
});

/**
 * @swagger
 * /sms/unread:
 *   get:
 *     summary: Get unread SMS count
 *     tags: [SMS]
 *     responses:
 *       200:
 *         description: Unread count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 count: { type: integer }
 */
router.get('/unread', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const db = req.app.locals.db;
        if (!db) throw new Error('Database not available');
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const unreadCount = await getUnreadCountForDevice(db, deviceId, simScope);

        res.json({
            success: true,
            deviceId,
            simSlot: simScope.simSlot,
            count: unreadCount
        });
    } catch (error) {
        logger.error('API unread count error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch unread count'
        });
    }
});

router.post('/bulk-import', [
    body('deviceId').optional().trim().isLength({ max: 64 }),
    body('messages').isArray({ min: 1, max: 500 }).withMessage('messages must be an array with 1-500 entries')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0]?.msg || 'Validation failed' });
        }

        const db = req.app.locals.db;
        if (!db) throw new Error('Database not available');

        const deviceId = String(req.body.deviceId || resolveDeviceId(req, DEFAULT_DEVICE_ID) || '').trim();
        const actorId = req.user?.id || req.session?.user?.id || null;
        const messages = Array.isArray(req.body.messages) ? req.body.messages : [];

        await db.run('BEGIN');

        let imported = 0;
        let skipped = 0;

        for (const entry of messages) {
            const message = String(entry?.message || '').trim();
            if (!message) {
                skipped++;
                continue;
            }

            const from = String(entry?.from || entry?.from_number || '').trim();
            const to = String(entry?.to || entry?.to_number || '').trim();
            const direction = String(entry?.type || entry?.direction || '').trim().toLowerCase();
            const type = direction === 'outgoing' ? 'outgoing' : 'incoming';
            const status = String(entry?.status || (type === 'outgoing' ? 'sent' : 'received')).trim() || (type === 'outgoing' ? 'sent' : 'received');
            const rawTimestamp = entry?.timestamp;
            const parsedTimestamp = rawTimestamp ? new Date(rawTimestamp) : new Date();
            if (Number.isNaN(parsedTimestamp.getTime())) {
                skipped++;
                continue;
            }
            const timestamp = parsedTimestamp.toISOString();
            const externalId = entry?.externalId != null ? String(entry.externalId).trim() : (entry?.id != null ? String(entry.id).trim() : null);

            const result = await db.run(
                `INSERT OR IGNORE INTO sms
                    (device_id, from_number, to_number, message, timestamp, read, type, status, user_id, source, external_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    deviceId || null,
                    from || (type === 'outgoing' ? 'self' : 'unknown'),
                    to || null,
                    message,
                    timestamp,
                    entry?.read ? 1 : 0,
                    type,
                    status,
                    actorId,
                    'bulk-import',
                    externalId || null
                ]
            );

            if (result.changes > 0) {
                imported++;
                await attachSmsToConversation(db, {
                    id: result.lastID,
                    device_id: deviceId || null,
                    from_number: from || (type === 'outgoing' ? 'self' : 'unknown'),
                    to_number: to || null,
                    message,
                    type
                });
            } else skipped++;
        }

        await db.run('COMMIT');
        smsCache.set(null, deviceId || null);
        if (deviceId) {
            await refreshSmsConversationsForDevice(db, deviceId);
        }

        emitDeviceEvent(deviceId, 'sms:bulk-imported', {
            deviceId: deviceId || null,
            imported,
            skipped
        });

        res.status(201).json({
            success: true,
            imported,
            skipped
        });
    } catch (error) {
        try { await req.app.locals.db?.run('ROLLBACK'); } catch (_) {}
        logger.error('POST /api/sms/bulk-import error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to import SMS messages'
        });
    }
});

router.post('/sync', async (req, res) => {
    try {
        const deviceId = String(req.body?.deviceId || req.query?.deviceId || resolveDeviceId(req, DEFAULT_DEVICE_ID)).trim();
        if (!deviceId) {
            return res.status(400).json({ success: false, message: 'No active device selected' });
        }
        if (!global.mqttService?.publishCommand) {
            return res.status(503).json({ success: false, message: 'Device command service unavailable' });
        }

        await global.mqttService.publishCommand(
            deviceId,
            'sync-sms',
            {
                reason: 'dashboard_pull',
                requestedAt: new Date().toISOString()
            },
            false,
            90000,
            { source: 'dashboard' }
        );

        emitDeviceEvent(deviceId, 'sms:sync-started', {
            deviceId,
            total: 0,
            requested: true
        });
        res.json({ success: true, message: 'Message pull requested' });
    } catch (error) {
        logger.error('POST /api/sms/sync error:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to request message pull' });
    }
});

/**
 * @swagger
 * /sms/send:
 *   post:
 *     summary: Send an SMS via the device
 *     tags: [SMS]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [to, message]
 *             properties:
 *               to:      { type: string, example: '+15551234567' }
 *               message: { type: string, maxLength: 160 }
 *     responses:
 *       200:
 *         description: SMS queued for delivery
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/send', smsRateLimit, [
    body('message').custom(validateSmsMessageSize),
    body('simSlot').optional({ values: 'falsy' }).isInt({ min: 0, max: 7 }).withMessage('simSlot must be a valid SIM slot')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { message } = req.body;
        const simScope = resolveRequestSimScope(req);
        const requestedDeviceId = String(req.body.deviceId || '').trim();
        const deviceId = requestedDeviceId || resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const db = req.app.locals.db;
        const actorId = req.user?.id || req.session?.user?.id || null;
        const { recipients, invalid } = normalizeSmsRecipients(req.body.recipients ?? req.body.to);

        if (!db) {
            throw new Error('Database not available');
        }
        if (!recipients.length) {
            return res.status(400).json({ success: false, message: invalid.length ? `Invalid phone number format: ${invalid[0]}` : 'Phone number is required' });
        }
        if (invalid.length) {
            return res.status(400).json({ success: false, message: `Invalid phone number format: ${invalid[0]}` });
        }
        if (!deviceId) {
            return res.status(400).json({ success: false, message: 'No active device selected' });
        }
        const deviceRow = await db.get('SELECT id FROM devices WHERE id = ?', [deviceId]);
        if (!deviceRow) {
            return res.status(400).json({ success: false, message: 'Device not registered' });
        }

        const batchId = recipients.length > 1 ? `sms_batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : null;
        const results = [];
        for (const recipient of recipients) {
            logger.info(`Queueing SMS to ${recipient}`);
            const queued = await queueSmsForDelivery({
                db,
                mqttService: global.mqttService,
                deviceId,
                to: recipient,
                message,
                simSlot: simScope.simSlot,
                userId: actorId,
                source: 'dashboard',
                batchId
            });
            results.push(queued);
        }

        if (results.length === 1) {
            const queued = results[0];
            return res.json({
                success: true,
                queued: queued.status !== 'sent',
                message: 'SMS queued for delivery',
                id: queued.id,
                to: queued.to,
                conversationId: queued.conversationId || null,
                simSlot: queued.simSlot,
                queueId: queued.queueId,
                messageId: queued.messageId,
                status: queued.status
            });
        }

        res.json({
            success: true,
            queued: true,
            multiRecipient: true,
            batchId,
            count: results.length,
            recipients,
            results,
            message: `${results.length} SMS queued for delivery`
        });
    } catch (error) {
        logger.error('API send SMS error:', error);
        const statusCode = /invalid phone/i.test(error.message) ? 400
            : (/unavailable|required|not connected/i.test(error.message) ? 503 : 500);
        res.status(statusCode).json({
            success: false,
            message: error.message || 'Failed to send SMS'
        });
    }
});

// ── Clear all messages of a given type ─────────────────────────────────────
// NOTE: must be defined BEFORE DELETE /:id to avoid the wildcard swallowing it.

/**
 * @swagger
 * /sms/clear:
 *   delete:
 *     summary: Delete all messages of a given type (inbox or sent)
 *     tags: [SMS]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type]
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [incoming, outgoing]
 *     responses:
 *       200:
 *         description: Messages deleted
 *       400:
 *         description: Invalid type
 */
router.delete('/clear', async (req, res) => {
    try {
        const type = req.body.type;
        if (type !== 'incoming' && type !== 'outgoing') {
            return res.status(400).json({ success: false, message: 'type must be "incoming" or "outgoing"' });
        }
        const db = req.app.locals.db;
        if (!db) throw new Error('Database not available');
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);

        const condition = type === 'incoming' ? "type != 'outgoing'" : "type = 'outgoing'";
        const conditions = ['device_id = ?', condition];
        const params = [deviceId];
        appendSimScopeCondition(conditions, params, simScope);
        const result = await db.run(
            `DELETE FROM sms WHERE ${conditions.join(' AND ')}`,
            params
        );

        smsCache.set(null, deviceId);
        await refreshSmsConversationsForDevice(db, deviceId);
        const unreadCount = await getUnreadCountForDevice(db, deviceId, simScope);
        logger.info(`Cleared ${result.changes} ${type} SMS messages for ${deviceId}`);
        emitDeviceEvent(deviceId, 'sms:bulk-deleted', {
            deviceId,
            count: result.changes,
            unreadCount
        });
        res.json({ success: true, deviceId, message: `Cleared ${result.changes} messages`, deleted: result.changes });
    } catch (error) {
        logger.error('API SMS clear error:', error);
        res.status(500).json({ success: false, message: 'Failed to clear messages' });
    }
});

// Delete SMS
router.delete('/:id(\\d+)', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidNumericId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid SMS id' });
        }
        const db = req.app.locals.db;
        
        if (!db) {
            throw new Error('Database not available');
        }
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);

        const conditions = ['id = ?', 'device_id = ?'];
        const params = [id, deviceId];
        appendSimScopeCondition(conditions, params, simScope);
        const whereSql = conditions.join(' AND ');

        const existing = await db.get(`SELECT conversation_id FROM sms WHERE ${whereSql}`, params);
        const result = await db.run(`DELETE FROM sms WHERE ${whereSql}`, params);

        if (result.changes === 0) {
            return res.status(404).json({
                success: false,
                message: 'SMS not found'
            });
        }

        logger.info(`SMS deleted: ${id}`);
        if (existing?.conversation_id) {
            await refreshSmsConversation(db, existing.conversation_id);
        }

        // Emit socket event
        try {
            if (global.io) {
                smsCache.set(null, deviceId);
                const unreadCount = await getUnreadCountForDevice(db, deviceId, simScope);
                emitDeviceEvent(deviceId, 'sms:deleted', { id, deviceId, unreadCount });
            }
        } catch (socketError) {
            logger.error('Error emitting socket event:', socketError);
        }

        res.json({
            success: true,
            message: 'SMS deleted successfully'
        });
    } catch (error) {
        logger.error('API delete SMS error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete SMS'
        });
    }
});

// Mark SMS as read
router.put('/:id(\\d+)/read', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidNumericId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid SMS id' });
        }
        const db = req.app.locals.db;
        
        if (!db) {
            throw new Error('Database not available');
        }
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);

        const conditions = ['id = ?', 'device_id = ?', 'read = 0'];
        const params = [id, deviceId];
        appendSimScopeCondition(conditions, params, simScope);
        const result = await db.run(
            `UPDATE sms SET read = 1 WHERE ${conditions.join(' AND ')}`,
            params
        );

        if (result.changes > 0) {
            logger.info(`SMS marked as read: ${id}`);
            smsCache.set(null, deviceId);
            await refreshSmsConversationBySmsId(db, id);
            const unreadCount = await getUnreadCountForDevice(db, deviceId, simScope);

            // Emit socket event
            emitDeviceEvent(deviceId, 'sms:read', { id, deviceId, unreadCount });
        }

        res.json({
            success: true,
            message: 'SMS marked as read'
        });
    } catch (error) {
        logger.error('API mark read error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to mark SMS as read'
        });
    }
});

// ── SMS Templates ──────────────────────────────────────────────────────────
// NOTE: must be before GET /:id to avoid the wildcard swallowing /templates.

router.get('/templates', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const db = req.app.locals.db;
        if (!db) throw new Error('Database not available');
        const templates = await db.all(`
            SELECT t.id, t.title, t.message, t.created_at, u.username as created_by
            FROM sms_templates t LEFT JOIN users u ON t.created_by = u.id
            ORDER BY t.created_at DESC
        `);
        res.json({ success: true, data: templates });
    } catch (error) {
        logger.error('API SMS templates error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch templates' });
    }
});

// ==================== SCHEDULED SMS ====================
// NOTE: must be before GET /:id to avoid the wildcard swallowing /scheduled.

// GET /api/sms/scheduled — list scheduled messages for a device
router.get('/scheduled', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const conditions = ['s.device_id = ?'];
        const params = [deviceId];
        appendSimScopeCondition(conditions, params, simScope, { alias: 's' });
        const rows = await db.all(
            `SELECT s.*, u.username AS created_by FROM scheduled_sms s
             LEFT JOIN users u ON s.user_id = u.id
             WHERE ${conditions.join(' AND ')}
             ORDER BY s.send_at ASC`,
            params
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        logger.error('API SMS scheduled list error:', error);
        res.status(500).json({ success: false, message: 'Failed to list scheduled SMS' });
    }
});

// ── CSV Export ─────────────────────────────────────────────────────────────
// NOTE: must be before GET /:id to avoid the wildcard swallowing /export.

router.get('/export/csv', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) throw new Error('Database not available');
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const conditions = ['s.device_id = ?'];
        const params = [deviceId];
        appendSimScopeCondition(conditions, params, simScope, { alias: 's' });
        const rows = await db.all(`
            SELECT s.id, s.device_id, s.from_number, s.to_number, s.message,
                   s.type, s.status, s.timestamp, s.sim_slot, u.username as sent_by
            FROM sms s LEFT JOIN users u ON s.user_id = u.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY s.timestamp DESC LIMIT 10000
        `, params);
        const header = 'id,device_id,from_number,to_number,message,type,status,timestamp,sim_slot,sent_by';
        const csvRows = rows.map(r =>
            [r.id, r.device_id || '', r.from_number, r.to_number || '', `"${(r.message || '').replace(/"/g,'""')}"`,
             r.type, r.status, r.timestamp, r.sim_slot ?? '', r.sent_by || ''].join(',')
        );
        const safeDeviceId = String(deviceId || 'device').replace(/[^a-zA-Z0-9_-]/g, '_');
        setNoStoreHeaders(res);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="sms-export-${safeDeviceId}-${Date.now()}.csv"`);
        res.send([header, ...csvRows].join('\r\n'));
    } catch (error) {
        logger.error('SMS CSV export error:', error);
        res.status(500).json({ success: false, message: 'Export failed' });
    }
});

// Get single SMS
router.get('/:id(\\d+)', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const { id } = req.params;
        if (!isValidNumericId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid SMS id' });
        }
        const db = req.app.locals.db;
        
        if (!db) {
            throw new Error('Database not available');
        }
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);

        const conditions = ['id = ?', 'device_id = ?'];
        const params = [id, deviceId];
        appendSimScopeCondition(conditions, params, simScope);
        const sms = await db.get(`SELECT * FROM sms WHERE ${conditions.join(' AND ')}`, params);

        if (!sms) {
            return res.status(404).json({
                success: false,
                message: 'SMS not found'
            });
        }

        res.json({
            success: true,
            data: decodeSmsRecord(sms)
        });
    } catch (error) {
        logger.error('API get SMS error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch SMS'
        });
    }
});

// Bulk delete SMS
router.post('/bulk-delete', async (req, res) => {
    try {
        const { ids } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No SMS IDs provided'
            });
        }

        if (!ids.every(id => Number.isInteger(Number(id)) && Number(id) > 0)) {
            return res.status(400).json({
                success: false,
                message: 'All IDs must be positive integers'
            });
        }

        if (ids.length > 500) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete more than 500 messages at once'
            });
        }

        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);

        const placeholders = ids.map(() => '?').join(',');
        const conditions = [`device_id = ?`, `id IN (${placeholders})`];
        const params = [deviceId, ...ids];
        appendSimScopeCondition(conditions, params, simScope);

        const result = await db.run(
            `DELETE FROM sms WHERE ${conditions.join(' AND ')}`,
            params
        );

        logger.info(`Bulk deleted ${result.changes} SMS messages`);
        await refreshSmsConversationsForDevice(db, deviceId);

        // Emit socket event
        try {
            if (global.io) {
                smsCache.set(null, deviceId);
                const unreadCount = await getUnreadCountForDevice(db, deviceId, simScope);
                emitDeviceEvent(deviceId, 'sms:bulk-deleted', { deviceId, count: result.changes, unreadCount });
            }
        } catch (socketError) {
            logger.error('Error emitting socket event:', socketError);
        }

        res.json({
            success: true,
            message: `Successfully deleted ${result.changes} messages`,
            deleted: result.changes
        });
    } catch (error) {
        logger.error('API bulk delete error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete messages'
        });
    }
});

// Mark multiple SMS as read
router.post('/bulk-read', async (req, res) => {
    try {
        const { ids } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No SMS IDs provided'
            });
        }

        if (!ids.every(id => Number.isInteger(Number(id)) && Number(id) > 0)) {
            return res.status(400).json({
                success: false,
                message: 'All IDs must be positive integers'
            });
        }

        if (ids.length > 500) {
            return res.status(400).json({
                success: false,
                message: 'Cannot mark more than 500 messages at once'
            });
        }

        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);

        const placeholders = ids.map(() => '?').join(',');
        const conditions = ['device_id = ?', `id IN (${placeholders})`, 'read = 0'];
        const params = [deviceId, ...ids];
        appendSimScopeCondition(conditions, params, simScope);

        const result = await db.run(
            `UPDATE sms SET read = 1 WHERE ${conditions.join(' AND ')}`,
            params
        );

        smsCache.set(null, deviceId);
        await refreshSmsConversationsForDevice(db, deviceId);
        const unreadCount = await getUnreadCountForDevice(db, deviceId, simScope);
        logger.info(`Marked ${result.changes} SMS as read`);

        // Emit socket event
        try {
            emitDeviceEvent(deviceId, 'sms:bulk-read', {
                deviceId,
                count: result.changes,
                unreadCount
            });
        } catch (socketError) {
            logger.error('Error emitting socket event:', socketError);
        }

        res.json({
            success: true,
            message: `Marked ${result.changes} messages as read`,
            marked: result.changes,
            unreadCount
        });
    } catch (error) {
        logger.error('API bulk read error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to mark messages as read'
        });
    }
});

router.post('/mark-all-read', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const conditions = ['device_id = ?', 'read = 0', "type != 'outgoing'"];
        const params = [deviceId];
        appendSimScopeCondition(conditions, params, simScope);

        const result = await db.run(
            `UPDATE sms
             SET read = 1
             WHERE ${conditions.join(' AND ')}`,
            params
        );

        smsCache.set(null, deviceId);
        await refreshSmsConversationsForDevice(db, deviceId);
        const unreadCount = await getUnreadCountForDevice(db, deviceId, simScope);
        logger.info(`Marked all unread SMS as read for ${deviceId}: ${result.changes}`);

        try {
            emitDeviceEvent(deviceId, 'sms:bulk-read', {
                deviceId,
                count: result.changes,
                unreadCount
            });
        } catch (socketError) {
            logger.error('Error emitting socket event:', socketError);
        }

        res.json({
            success: true,
            message: `Marked ${result.changes} messages as read`,
            marked: result.changes,
            unreadCount
        });
    } catch (error) {
        logger.error('API mark all read error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to mark all messages as read'
        });
    }
});

router.post('/templates', [
    body('title').trim().notEmpty().isLength({ max: 80 }).withMessage('Title required (max 80 chars)'),
    body('message').custom(validateSmsMessageSize)
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });
        const { title, message } = req.body;
        const db = req.app.locals.db;
        if (!db) throw new Error('Database not available');
        const result = await db.run(
            `INSERT INTO sms_templates (title, message, created_by) VALUES (?, ?, ?)`,
            [title, message, req.session?.user?.id || null]
        );
        const tpl = await getSmsTemplateById(db, result.lastID);
        if (global.io) global.io.emit('sms:template-added', tpl);
        res.json({ success: true, data: tpl });
    } catch (error) {
        logger.error('API SMS template create error:', error);
        res.status(500).json({ success: false, message: 'Failed to create template' });
    }
});

router.put('/templates/:id', [
    body('title').trim().notEmpty().isLength({ max: 80 }).withMessage('Title required (max 80 chars)'),
    body('message').custom(validateSmsMessageSize)
], async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidNumericId(id)) return res.status(400).json({ success: false, message: 'Invalid ID' });
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });
        const { title, message } = req.body;
        const db = req.app.locals.db;
        if (!db) throw new Error('Database not available');
        const result = await db.run(
            'UPDATE sms_templates SET title = ?, message = ? WHERE id = ?',
            [title, message, id]
        );
        if (result.changes === 0) return res.status(404).json({ success: false, message: 'Template not found' });
        const tpl = await getSmsTemplateById(db, id);
        if (global.io) global.io.emit('sms:template-updated', tpl);
        res.json({ success: true, data: tpl });
    } catch (error) {
        logger.error('API SMS template update error:', error);
        res.status(500).json({ success: false, message: 'Failed to update template' });
    }
});

router.delete('/templates/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidNumericId(id)) return res.status(400).json({ success: false, message: 'Invalid ID' });
        const db = req.app.locals.db;
        if (!db) throw new Error('Database not available');
        const result = await db.run('DELETE FROM sms_templates WHERE id = ?', [id]);
        if (result.changes === 0) return res.status(404).json({ success: false, message: 'Template not found' });
        if (global.io) global.io.emit('sms:template-deleted', { id: parseInt(id) });
        res.json({ success: true, message: 'Template deleted' });
    } catch (error) {
        logger.error('API SMS template delete error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete template' });
    }
});

// POST /api/sms/scheduled — create a scheduled SMS
router.post('/scheduled', [
    body('message').custom(validateSmsMessageSize),
    body('send_at').isISO8601().withMessage('send_at must be a valid ISO date-time'),
    body('deviceId').optional().trim(),
    body('simSlot').optional({ values: 'falsy' }).isInt({ min: 0, max: 7 }).withMessage('simSlot must be a valid SIM slot')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0]?.msg || 'Validation failed', errors: errors.array() });

        const { message, send_at } = req.body;
        const simScope = resolveRequestSimScope(req);
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const { recipients, invalid } = normalizeSmsRecipients(req.body.recipients ?? req.body.to);
        if (!recipients.length) {
            return res.status(400).json({ success: false, message: invalid.length ? `Invalid phone number format: ${invalid[0]}` : 'Recipient required' });
        }
        if (invalid.length) {
            return res.status(400).json({ success: false, message: `Invalid phone number format: ${invalid[0]}` });
        }
        const sendAt = new Date(send_at);
        if (sendAt <= new Date()) {
            return res.status(400).json({ success: false, message: 'send_at must be in the future' });
        }

        const db = req.app.locals.db;
        const created = [];
        for (const recipient of recipients) {
            const result = await db.run(
                `INSERT INTO scheduled_sms (device_id, to_number, message, send_at, sim_slot, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
                [deviceId, recipient, message, sendAt.toISOString(), simScope.simSlot, req.session?.user?.id || null]
            );
            logger.info(`Scheduled SMS created id=${result.lastID} to ${recipient} at ${sendAt.toISOString()}`);
            const item = {
                id: result.lastID,
                deviceId,
                to_number: recipient,
                message,
                send_at: sendAt.toISOString(),
                sim_slot: simScope.simSlot,
                status: 'pending',
                created_by: req.session?.user?.username || null
            };
            created.push(item);
            emitDeviceEvent(deviceId, 'sms:scheduled-created', item);
        }

        if (created.length === 1) {
            return res.json({ success: true, message: 'SMS scheduled', id: created[0].id });
        }
        res.json({
            success: true,
            multiRecipient: true,
            count: created.length,
            ids: created.map((item) => item.id),
            recipients,
            message: `${created.length} SMS scheduled`
        });
    } catch (error) {
        logger.error('API SMS scheduled create error:', error);
        res.status(500).json({ success: false, message: 'Failed to schedule SMS' });
    }
});

// POST /api/sms/scheduled/import - upload an Excel-compatible CSV/TSV schedule template
router.post('/scheduled/import', scheduleImportUpload.single('file'), async (req, res) => {
    try {
        if (!req.file?.buffer) {
            return res.status(400).json({ success: false, message: 'Upload a CSV template first' });
        }
        const originalName = String(req.file.originalname || '').toLowerCase();
        if (originalName.endsWith('.xlsx') || originalName.endsWith('.xls')) {
            return res.status(400).json({ success: false, message: 'Export the Excel template as CSV, then upload it here.' });
        }
        const parsed = parseScheduleImport(req.file.buffer);
        if (parsed.errors.length && !parsed.rows.length) {
            return res.status(400).json({ success: false, message: parsed.errors[0], errors: parsed.errors.slice(0, 20) });
        }

        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const db = req.app.locals.db;
        const created = [];
        const rowErrors = [...parsed.errors];
        for (const row of parsed.rows) {
            const { recipients, invalid } = normalizeSmsRecipients(row.phone);
            if (!recipients.length || invalid.length) {
                rowErrors.push(`Invalid phone number: ${row.phone}`);
                continue;
            }
            if (row.sendAt <= new Date()) {
                rowErrors.push(`Past send_at skipped for ${row.phone}`);
                continue;
            }
            try {
                validateSmsMessageSize(row.message);
            } catch (error) {
                rowErrors.push(`Message too large for ${row.phone}`);
                continue;
            }
            for (const recipient of recipients) {
                const result = await db.run(
                    `INSERT INTO scheduled_sms (device_id, to_number, message, send_at, sim_slot, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
                    [deviceId, recipient, row.message, row.sendAt.toISOString(), row.simSlot, req.session?.user?.id || null]
                );
                const item = {
                    id: result.lastID,
                    deviceId,
                    to_number: recipient,
                    message: row.message,
                    send_at: row.sendAt.toISOString(),
                    sim_slot: row.simSlot,
                    status: 'pending',
                    created_by: req.session?.user?.username || null
                };
                created.push(item);
                emitDeviceEvent(deviceId, 'sms:scheduled-created', item);
            }
        }

        if (!created.length) {
            return res.status(400).json({ success: false, message: rowErrors[0] || 'No valid schedule rows found', errors: rowErrors.slice(0, 20) });
        }
        res.json({
            success: true,
            count: created.length,
            ids: created.map((item) => item.id),
            errors: rowErrors.slice(0, 20),
            message: `${created.length} SMS scheduled from template`
        });
    } catch (error) {
        logger.error('API SMS scheduled import error:', error);
        res.status(500).json({ success: false, message: 'Failed to import schedule template' });
    }
});

// DELETE /api/sms/scheduled/:id - cancel a pending scheduled SMS
router.delete('/scheduled/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidNumericId(id)) return res.status(400).json({ success: false, message: 'Invalid ID' });
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const conditions = ['id = ?', 'device_id = ?', "status = 'pending'"];
        const params = [id, deviceId];
        appendSimScopeCondition(conditions, params, simScope);
        const result = await db.run(
            `DELETE FROM scheduled_sms WHERE ${conditions.join(' AND ')}`,
            params
        );
        if (result.changes === 0) return res.status(404).json({ success: false, message: 'Scheduled SMS not found or already sent' });
        emitDeviceEvent(deviceId, 'sms:scheduled-cancelled', {
            id: Number(id),
            deviceId
        });
        res.json({ success: true, message: 'Scheduled SMS cancelled' });
    } catch (error) {
        logger.error('API SMS scheduled delete error:', error);
        res.status(500).json({ success: false, message: 'Failed to cancel scheduled SMS' });
    }
});

// ==================== SCHEDULED SMS PROCESSOR ====================
// Runs every 30 seconds. Sends any pending SMS whose send_at has passed.

function startScheduledSmsProcessor(app) {
    const interval = setInterval(async () => {
        try {
            const db = app.locals.db;
            if (!db) return;

            const due = await db.all(
                `SELECT * FROM scheduled_sms WHERE status = 'pending' AND datetime(send_at) <= datetime('now') LIMIT 20`
            );

            for (const sms of due) {
                try {
                    const queued = await queueSmsForDelivery({
                        db,
                        mqttService: global.mqttService,
                        deviceId: sms.device_id,
                        to: sms.to_number,
                        message: sms.message,
                        simSlot: sms.sim_slot,
                        userId: sms.user_id,
                        source: 'scheduled'
                    });
                    await db.run(
                        `UPDATE scheduled_sms SET status = 'queued', sent_at = CURRENT_TIMESTAMP, error = NULL WHERE id = ?`,
                        [sms.id]
                    );
                    emitDeviceEvent(sms.device_id, 'sms:scheduled-queued', {
                        id: sms.id,
                        deviceId: sms.device_id,
                        smsId: queued.id,
                        to: queued.to,
                        queueId: queued.queueId,
                        messageId: queued.messageId
                    });
                    logger.info(`Scheduled SMS id=${sms.id} queued to ${sms.to_number}`);
                } catch (err) {
                    await db.run(
                        `UPDATE scheduled_sms SET status = 'failed', error = ? WHERE id = ?`,
                        [err.message, sms.id]
                    );
                    emitDeviceEvent(sms.device_id, 'sms:scheduled-failed', {
                        id: sms.id,
                        deviceId: sms.device_id,
                        to: sms.to_number,
                        error: err.message || 'Failed to queue scheduled SMS'
                    });
                    logger.error(`Scheduled SMS id=${sms.id} failed:`, err.message);
                }
            }
        } catch (err) {
            logger.error('Scheduled SMS processor error:', err);
        }
    }, 30000);
    interval.unref();
    return interval;
}

module.exports = router;
module.exports.startScheduledSmsProcessor = startScheduledSmsProcessor;
