const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const logger = require('../utils/logger');
const {
    formatPhoneNumber,
    isShortCode,
    sqlNormalizePhone,
    sqlPhoneLastDigits
} = require('../utils/phoneNumber');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');
const { createRateLimiter } = require('../utils/rateLimiter');
const {
    resolveRequestSimScope,
    appendSimScopeCondition
} = require('../utils/simScope');

const dialRateLimit = createRateLimiter({ windowMs: 60000, max: 5, message: 'Call rate limit exceeded. Max 5 dials per minute.' });
const CONTACT_NORM_SQL = sqlNormalizePhone('phone_number');
const CONTACT_LAST10_SQL = sqlPhoneLastDigits('phone_number');
const CALL_NORM_SQL = sqlNormalizePhone('c.phone_number');
const CALL_LAST10_SQL = sqlPhoneLastDigits('c.phone_number');
const CONTACTS_CTE = `
    WITH norm_contacts AS (
        SELECT
            MIN(name) as name,
            MIN(company) as company,
            ${CONTACT_NORM_SQL} as norm_phone,
            ${CONTACT_LAST10_SQL} as last10
        FROM contacts
        GROUP BY ${CONTACT_LAST10_SQL}
    )
`;

function isValidNumericId(id) {
    return /^[0-9]+$/.test(String(id));
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

function runRuntimeDeviceOperation(deviceId, task) {
    if (global.mqttService && typeof global.mqttService.runDeviceOperation === 'function') {
        return global.mqttService.runDeviceOperation(deviceId, task);
    }
    return task();
}

function publishInteractiveTelephonyCommand(deviceId, command, payload, timeout) {
    if (!global.mqttService) {
        return Promise.resolve(null);
    }

    return runRuntimeDeviceOperation(deviceId, () => global.mqttService.publishCommand(
        deviceId,
        command,
        payload,
        false,
        timeout,
        {
            source: 'dashboard:calls',
            domain: 'telephony',
            skipPersistentQueue: true
        }
    ));
}

function publishCallHistorySyncCommand(deviceId, payload, timeout) {
    if (!global.mqttService) {
        return Promise.resolve(null);
    }

    return runRuntimeDeviceOperation(deviceId, () => global.mqttService.publishCommand(
        deviceId,
        'sync-calls',
        payload,
        false,
        timeout,
        {
            source: 'dashboard:calls',
            domain: 'telephony'
        }
    ));
}

function buildCallSimMeta(scope = {}) {
    const payload = {};
    if (scope.simSlot !== null && scope.simSlot !== undefined) {
        payload.sim_slot = scope.simSlot;
    }
    return payload;
}

async function reconcileInactiveCallRows(db, deviceId, simScope = {}) {
    if (!db || !deviceId) {
        return 0;
    }

    const conditions = ['device_id = ?', "status IN ('dialing', 'ringing', 'connected', 'answered', 'ending', 'online')"];
    const params = ['ended', deviceId];
    appendSimScopeCondition(conditions, params, simScope);

    const result = await db.run(`
        UPDATE calls
        SET status = ?,
            end_time = COALESCE(end_time, CURRENT_TIMESTAMP)
        WHERE ${conditions.join(' AND ')}
    `, params);

    return Number(result?.changes || 0);
}

/**
 * @swagger
 * tags:
 *   name: Calls
 *   description: Call log management and dialing
 */

/**
 * @swagger
 * /calls/logs:
 *   get:
 *     summary: Get paginated call logs with contact name resolution
 *     tags: [Calls]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10, maximum: 500 }
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Paginated call list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Call' }
 *                 pagination: { $ref: '#/components/schemas/Pagination' }
 */
router.get('/logs', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }

        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 10), 500);
        const offset = (page - 1) * limit;
        const since = req.query.since || null;
        const simScope = resolveRequestSimScope(req);
        const simConditions = ['c.device_id = ?'];
        const simParams = [deviceId];
        appendSimScopeCondition(simConditions, simParams, simScope, { alias: 'c' });

        // Get total count
        const totalConditions = ['device_id = ?'];
        const totalParams = [deviceId];
        if (since) {
            totalConditions.push('start_time > ?');
            totalParams.push(since);
        }
        appendSimScopeCondition(totalConditions, totalParams, simScope);
        const totalCount = await db.get(
            `SELECT COUNT(*) as count FROM calls WHERE ${totalConditions.join(' AND ')}`,
            totalParams
        );

        // Get calls with contact information using CTE to avoid N+1 correlated subqueries
        const calls = await db.all(`
            ${CONTACTS_CTE}
            SELECT
                c.id, c.device_id, c.phone_number, c.type, c.status,
                c.start_time, c.end_time, c.duration, c.notes, c.missed,
                COALESCE(nc.name,
                    CASE
                        WHEN c.type = 'incoming' THEN 'Incoming Call'
                        WHEN c.type = 'outgoing' THEN 'Outgoing Call'
                        ELSE 'Unknown'
                    END
                ) as contact_name,
                COALESCE(nc.company, '') as contact_company,
                COALESCE(u.username, '') as dialed_by
            FROM calls c
            LEFT JOIN users u ON u.id = c.user_id
            LEFT JOIN norm_contacts nc ON (
                nc.norm_phone = ${CALL_NORM_SQL}
                OR nc.last10 = ${CALL_LAST10_SQL}
            )
            WHERE ${simConditions.join(' AND ')}
            ${since ? 'AND c.start_time > ?' : ''}
            ORDER BY c.start_time DESC
            LIMIT ? OFFSET ?
        `, since ? [...simParams, since, limit, offset] : [...simParams, limit, offset]);

        res.json({
            success: true,
            data: calls,
            pagination: {
                page,
                limit,
                total: totalCount.count,
                pages: Math.ceil(totalCount.count / limit)
            }
        });
    } catch (error) {
        logger.error('API call logs error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch call logs'
        });
    }
});

// Get call stats
router.get('/stats', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }

        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const queryCount = (suffix = '') => {
            const conditions = ['device_id = ?'];
            const params = [deviceId];
            if (suffix) {
                conditions.push(suffix);
            }
            appendSimScopeCondition(conditions, params, simScope);
            return db.get(`SELECT COUNT(*) as count FROM calls WHERE ${conditions.join(' AND ')}`, params);
        };
        const total = await queryCount();
        const answered = await queryCount("status = 'answered'");
        const missed = await queryCount("status = 'missed'");
        const outgoing = await queryCount("type = 'outgoing'");
        const incoming = await queryCount("type = 'incoming'");

        res.json({
            success: true,
            data: {
                total: total.count,
                answered: answered.count,
                missed: missed.count,
                outgoing: outgoing.count,
                incoming: incoming.count
            }
        });
    } catch (error) {
        logger.error('API call stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch call stats'
        });
    }
});

// Get recent calls for dashboard
router.get('/recent', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }

        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 5), 100);
        const simScope = resolveRequestSimScope(req);
        const conditions = ['c.device_id = ?'];
        const params = [deviceId];
        appendSimScopeCondition(conditions, params, simScope, { alias: 'c' });

        const calls = await db.all(`
            ${CONTACTS_CTE}
            SELECT
                c.*,
                COALESCE(nc.name, SUBSTR(c.phone_number, -10)) as contact_name,
                COALESCE(u.username, '') as dialed_by
            FROM calls c
            LEFT JOIN users u ON u.id = c.user_id
            LEFT JOIN norm_contacts nc ON (
                nc.norm_phone = ${CALL_NORM_SQL}
                OR nc.last10 = ${CALL_LAST10_SQL}
            )
            WHERE ${conditions.join(' AND ')}
            ORDER BY c.start_time DESC
            LIMIT ?
        `, [...params, limit]);

        res.json({
            success: true,
            data: calls
        });
    } catch (error) {
        logger.error('API recent calls error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch recent calls'
        });
    }
});

router.post('/sync', async (req, res) => {
    try {
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);

        if (!global.mqttService) {
            return res.status(503).json({
                success: false,
                message: 'Call history sync requires the live device command service'
            });
        }

        const commandResult = await publishCallHistorySyncCommand(deviceId, {
            mode: 'new',
            ...buildCallSimMeta(simScope)
        }, 90000);

        res.json({
            success: true,
            message: commandResult?.queued
                ? 'Call history sync queued'
                : 'Call history sync requested',
            queued: Boolean(commandResult?.queued),
            queueId: commandResult?.queueId || null,
            messageId: commandResult?.messageId || null
        });
    } catch (error) {
        logger.error('API call sync error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to request call history sync'
        });
    }
});

// Get single call
router.get('/logs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidNumericId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid call id' });
        }
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        
        if (!db) {
            throw new Error('Database not available');
        }

        const conditions = ['c.id = ?', 'c.device_id = ?'];
        const params = [id, deviceId];
        appendSimScopeCondition(conditions, params, simScope, { alias: 'c' });
        const call = await db.get(`
            ${CONTACTS_CTE}
            SELECT
                c.*,
                nc.name as contact_name,
                COALESCE(nc.company, '') as contact_company,
                COALESCE(u.username, '') as dialed_by
            FROM calls c
            LEFT JOIN users u ON u.id = c.user_id
            LEFT JOIN norm_contacts nc ON (
                nc.norm_phone = ${CALL_NORM_SQL}
                OR nc.last10 = ${CALL_LAST10_SQL}
            )
            WHERE ${conditions.join(' AND ')}
        `, params);

        if (!call) {
            return res.status(404).json({
                success: false,
                message: 'Call not found'
            });
        }

        res.json({
            success: true,
            data: call
        });
    } catch (error) {
        logger.error('API get call error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch call'
        });
    }
});

/**
 * @swagger
 * /calls/dial:
 *   post:
 *     summary: Dial a phone number via the device
 *     tags: [Calls]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [number]
 *             properties:
 *               number: { type: string, example: '+15551234567' }
 *     responses:
 *       200:
 *         description: Call initiated
 *       400:
 *         description: Validation error
 *       503:
 *         description: Device offline
 */
router.post('/dial', dialRateLimit, [
    body('number').notEmpty().withMessage('Phone number is required')
        .custom((value) => {
            const formatted = formatPhoneNumber(String(value || ''));
            if (!formatted) throw new Error('Invalid phone number format');
            if (isShortCode(formatted) || /^\+[1-9]\d{5,14}$/.test(formatted)) return true;
            throw new Error('Invalid phone number format');
        }),
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

        const { number } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const db = req.app.locals.db;
        
        if (!db) {
            throw new Error('Database not available');
        }
        
        // Format number
        const formattedNumber = formatPhoneNumber(number);

        // Save initial call record
        const result = await db.run(`
            INSERT INTO calls (device_id, phone_number, type, status, start_time, user_id, sim_slot)
            VALUES (?, ?, 'outgoing', 'dialing', CURRENT_TIMESTAMP, ?, ?)
        `, [deviceId, formattedNumber, req.session.user?.id || null, simScope.simSlot]);

        // Send via MQTT if connected. The real call lifecycle is driven by async
        // call-status events, so don't block the HTTP request on a modem ACK.
        let commandResult = null;
        if (global.mqttService) {
            try {
                commandResult = await publishInteractiveTelephonyCommand(deviceId, 'make-call', {
                    number: formattedNumber,
                    ...buildCallSimMeta(simScope)
                }, 45000);
            } catch (mqttError) {
                logger.error('MQTT error making call:', mqttError);
            }
        }

        // Emit socket event
        try {
            emitDeviceEvent(deviceId, 'call:started', {
                id: result.lastID,
                deviceId,
                number: formattedNumber,
                status: 'dialing'
            });
        } catch (socketError) {
            logger.error('Error emitting socket event:', socketError);
        }

        res.json({
            success: true,
            message: 'Call initiated',
            callId: result.lastID,
            number: formattedNumber,
            queued: Boolean(commandResult?.queued),
            queueId: commandResult?.queueId || null,
            messageId: commandResult?.messageId || null
        });
    } catch (error) {
        logger.error('API dial call error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to initiate call'
        });
    }
});

// End current call
router.post('/end', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        if (!db) {
            throw new Error('Database not available');
        }
        
        const modemStatus = global.modemService?.getStatus?.(deviceId) || {};
        const callTransportSuspended = Boolean(
            modemStatus?.call?.transportSuspended ||
            modemStatus?.transport?.voiceSessionActive
        );

        let commandResult = null;
        if (global.mqttService) {
            try {
                commandResult = await publishInteractiveTelephonyCommand(deviceId, 'end-call', buildCallSimMeta(simScope), 45000);
            } catch (mqttError) {
                logger.error('MQTT error ending call:', mqttError);
            }
        }
        
        // Update the most recent active call for this device
        const activeConditions = ['device_id = ?', "status IN ('dialing', 'ringing', 'connected', 'answered')"];
        const activeParams = [deviceId];
        appendSimScopeCondition(activeConditions, activeParams, simScope);
        const result = await db.run(`
            UPDATE calls
            SET status = 'ending'
            WHERE rowid = (
                SELECT rowid FROM calls
                WHERE ${activeConditions.join(' AND ')}
                ORDER BY start_time DESC LIMIT 1
            )
        `, activeParams);

        if (result.changes > 0) {
            logger.info('Call ended');
            
            try {
                emitDeviceEvent(deviceId, 'call:ended', { deviceId, status: 'ended' });
            } catch (socketError) {
                logger.error('Error emitting socket event:', socketError);
            }
        }

        res.json({
            success: true,
            message: callTransportSuspended
                ? 'Call end requested while voice transport is busy'
                : 'Call end requested',
            queued: Boolean(commandResult?.queued),
            queueId: commandResult?.queueId || null,
            messageId: commandResult?.messageId || null,
            transportSuspended: callTransportSuspended
        });
    } catch (error) {
        logger.error('API end call error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to end call'
        });
    }
});

// Answer incoming call
router.post('/answer', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        if (!db) throw new Error('Database not available');

        let commandResult = null;
        if (global.mqttService) {
            try {
                commandResult = await publishInteractiveTelephonyCommand(deviceId, 'answer-call', buildCallSimMeta(simScope), 15000);
            } catch (mqttError) {
                logger.error('MQTT error answering call:', mqttError);
            }
        }

        // Mark the most recent ringing call as answered and record who answered
        const ringingConditions = ['device_id = ?', "status = 'ringing'"];
        const ringingParams = [deviceId];
        appendSimScopeCondition(ringingConditions, ringingParams, simScope);
        await db.run(`
            UPDATE calls
            SET status = 'answered', user_id = ?
            WHERE rowid = (
                SELECT rowid FROM calls
                WHERE ${ringingConditions.join(' AND ')}
                ORDER BY start_time DESC LIMIT 1
            )
        `, [req.session.user?.id || null, ...ringingParams]);

        res.json({
            success: true,
            message: 'Call answer requested',
            queued: Boolean(commandResult?.queued),
            queueId: commandResult?.queueId || null,
            messageId: commandResult?.messageId || null
        });
    } catch (error) {
        logger.error('API answer call error:', error);
        res.status(500).json({ success: false, message: 'Failed to answer call' });
    }
});

// Reject incoming call
router.post('/reject', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        if (!db) throw new Error('Database not available');

        let commandResult = null;
        if (global.mqttService) {
            try {
                commandResult = await publishInteractiveTelephonyCommand(deviceId, 'reject-call', buildCallSimMeta(simScope), 15000);
            } catch (mqttError) {
                logger.error('MQTT error rejecting call:', mqttError);
            }
        }

        const ringingConditions = ['device_id = ?', "status = 'ringing'"];
        const ringingParams = [deviceId];
        appendSimScopeCondition(ringingConditions, ringingParams, simScope);
        await db.run(`
            UPDATE calls
            SET status = 'rejected', end_time = CURRENT_TIMESTAMP, user_id = ?
            WHERE rowid = (
                SELECT rowid FROM calls
                WHERE ${ringingConditions.join(' AND ')}
                ORDER BY start_time DESC LIMIT 1
            )
        `, [req.session.user?.id || null, ...ringingParams]);

        res.json({
            success: true,
            message: 'Call reject requested',
            queued: Boolean(commandResult?.queued),
            queueId: commandResult?.queueId || null,
            messageId: commandResult?.messageId || null
        });
    } catch (error) {
        logger.error('API reject call error:', error);
        res.status(500).json({ success: false, message: 'Failed to reject call' });
    }
});

// Get current call status
router.get('/status', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }
        
        // Check if there's an active call
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const activeConditions = ['device_id = ?', "status IN ('dialing', 'ringing', 'connected', 'answered')"];
        const activeParams = [deviceId];
        appendSimScopeCondition(activeConditions, activeParams, simScope);
        const activeCall = await db.get(`
            SELECT * FROM calls 
            WHERE ${activeConditions.join(' AND ')}
            ORDER BY start_time DESC
            LIMIT 1
        `, activeParams);

        if (activeCall) {
            const duration = activeCall.status === 'connected' || activeCall.status === 'answered' ? 
                Math.floor((new Date() - new Date(activeCall.start_time)) / 1000) : 0;
            
            res.json({
                success: true,
                data: {
                    active: true,
                    id: activeCall.id,
                    number: activeCall.phone_number,
                    status: activeCall.status,
                    startTime: activeCall.start_time,
                    duration
                }
            });
        } else {
            const modemStatus = global.modemService?.getStatus?.(deviceId) || {};
            const callExplicitlyInactive = modemStatus?.call?.active === false;
            if (callExplicitlyInactive) {
                const reconciled = await reconcileInactiveCallRows(db, deviceId, simScope);
                if (reconciled > 0) {
                    emitDeviceEvent(deviceId, 'call:ended', {
                        deviceId,
                        status: 'ended',
                        reconciled
                    });
                }
            }
            res.json({
                success: true,
                data: { active: false }
            });
        }
    } catch (error) {
        logger.error('API call status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get call status'
        });
    }
});

// Delete call log
router.delete('/logs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidNumericId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid call id' });
        }
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        
        if (!db) {
            throw new Error('Database not available');
        }

        const conditions = ['id = ?', 'device_id = ?'];
        const params = [id, deviceId];
        appendSimScopeCondition(conditions, params, simScope);
        const result = await db.run(`DELETE FROM calls WHERE ${conditions.join(' AND ')}`, params);

        if (result.changes === 0) {
            return res.status(404).json({
                success: false,
                message: 'Call log not found'
            });
        }

        logger.info(`Call log deleted: ${id}`);
        
        try {
            emitDeviceEvent(deviceId, 'call:log-deleted', { id, deviceId });
        } catch (socketError) {
            logger.error('Error emitting socket event:', socketError);
        }

        res.json({
            success: true,
            message: 'Call log deleted successfully'
        });
    } catch (error) {
        logger.error('API delete call log error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete call log'
        });
    }
});

// Update call notes
router.patch('/logs/:id/notes', [
    body('notes').optional()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { id } = req.params;
        if (!isValidNumericId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid call id' });
        }
        const { notes } = req.body;
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);

        if (!db) {
            throw new Error('Database not available');
        }

        const conditions = ['id = ?', 'device_id = ?'];
        const params = [id, deviceId];
        appendSimScopeCondition(conditions, params, simScope);
        const result = await db.run(
            `UPDATE calls SET notes = ? WHERE ${conditions.join(' AND ')}`,
            [notes || null, ...params]
        );

        if (result.changes === 0) {
            return res.status(404).json({ success: false, message: 'Call not found' });
        }

        res.json({
            success: true,
            message: 'Call notes updated'
        });
    } catch (error) {
        logger.error('API update call notes error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update call notes'
        });
    }
});

// Bulk delete call logs
router.post('/logs/bulk-delete', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, message: 'ids array is required' });
        }
        if (ids.length > 500) {
            return res.status(400).json({ success: false, message: 'Cannot delete more than 500 at once' });
        }
        if (!ids.every(id => isValidNumericId(id))) {
            return res.status(400).json({ success: false, message: 'Invalid call id in list' });
        }

        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const placeholders = ids.map(() => '?').join(',');
        const conditions = ['device_id = ?', `id IN (${placeholders})`];
        const params = [deviceId, ...ids];
        appendSimScopeCondition(conditions, params, simScope);
        const result = await db.run(`DELETE FROM calls WHERE ${conditions.join(' AND ')}`, params);

        logger.info(`Bulk deleted ${result.changes} call logs`);
        res.json({ success: true, message: `Deleted ${result.changes} call logs`, deleted: result.changes });
    } catch (error) {
        logger.error('API bulk delete calls error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete call logs' });
    }
});

// Clear all call logs for the active device
router.delete('/clear', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) throw new Error('Database not available');

        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const conditions = ['device_id = ?'];
        const params = [deviceId];
        appendSimScopeCondition(conditions, params, simScope);
        const result = await db.run(`DELETE FROM calls WHERE ${conditions.join(' AND ')}`, params);

        logger.info(`Cleared ${result.changes} call logs for device ${deviceId}`);
        res.json({
            success: true,
            message: `Cleared ${result.changes} call logs`,
            deleted: result.changes,
            deviceId
        });
    } catch (error) {
        logger.error('API clear calls error:', error);
        res.status(500).json({ success: false, message: 'Failed to clear call logs' });
    }
});

// Toggle call hold
router.post('/hold', [
    body('hold').isBoolean()
], async (req, res) => {
    try {
        const { hold } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        
        let commandResult = null;
        if (global.mqttService) {
            try {
                commandResult = await publishInteractiveTelephonyCommand(deviceId, 'hold-call', { hold, ...buildCallSimMeta(simScope) }, 15000);
            } catch (mqttError) {
                logger.error('MQTT error toggling hold:', mqttError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to send hold command'
                });
            }
        } else {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }
        
        logger.info(`Call ${hold ? 'held' : 'resumed'}`);
        
        try {
            emitDeviceEvent(deviceId, 'call:hold', { deviceId, onHold: hold });
        } catch (socketError) {
            logger.error('Error emitting socket event:', socketError);
        }
        
        res.json({
            success: true,
            message: hold ? 'Call hold requested' : 'Call resume requested',
            queued: Boolean(commandResult?.queued),
            queueId: commandResult?.queueId || null,
            messageId: commandResult?.messageId || null
        });
    } catch (error) {
        logger.error('API hold call error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to toggle hold'
        });
    }
});

// Mute call
router.post('/mute', [
    body('mute').isBoolean()
], async (req, res) => {
    try {
        const { mute } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        
        let commandResult = null;
        if (global.mqttService) {
            try {
                commandResult = await publishInteractiveTelephonyCommand(deviceId, 'mute-call', { mute, ...buildCallSimMeta(simScope) }, 15000);
            } catch (mqttError) {
                logger.error('MQTT error toggling mute:', mqttError);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to send mute command'
                });
            }
        } else {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }
        
        res.json({
            success: true,
            message: mute ? 'Call mute requested' : 'Call unmute requested',
            queued: Boolean(commandResult?.queued),
            queueId: commandResult?.queueId || null,
            messageId: commandResult?.messageId || null
        });
    } catch (error) {
        logger.error('API mute call error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to toggle mute'
        });
    }
});

// CSV Export
router.get('/export/csv', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) throw new Error('Database not available');
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const conditions = ['c.device_id = ?'];
        const params = [deviceId];
        appendSimScopeCondition(conditions, params, simScope, { alias: 'c' });
        const rows = await db.all(`
            SELECT c.id, c.device_id, c.phone_number, c.type, c.status,
                   c.start_time, c.end_time, c.duration, c.missed, c.sim_slot,
                   u.username as dialed_by
            FROM calls c LEFT JOIN users u ON c.user_id = u.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY c.start_time DESC LIMIT 10000
        `, params);
        const header = 'id,device_id,phone_number,type,status,start_time,end_time,duration_sec,missed,sim_slot,dialed_by';
        const csvRows = rows.map(r =>
            [r.id, r.device_id || '', r.phone_number, r.type, r.status,
             r.start_time || '', r.end_time || '', r.duration || 0,
             r.missed ? 1 : 0, r.sim_slot ?? '', r.dialed_by || ''].join(',')
        );
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="calls-export-${Date.now()}.csv"`);
        res.send([header, ...csvRows].join('\r\n'));
    } catch (error) {
        logger.error('Calls CSV export error:', error);
        res.status(500).json({ success: false, message: 'Export failed' });
    }
});

module.exports = router;
