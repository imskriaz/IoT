const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');
const { parseUssdMenuOptions } = require('../utils/ussdSession');
const {
    resolveRequestSimScope,
    appendSimScopeCondition
} = require('../utils/simScope');

const USSD_CANCEL_POST_ACK_MS = 250;

function buildUssdSimPayload(scope = {}) {
    const payload = {};
    if (scope.simSlot !== null && scope.simSlot !== undefined) {
        payload.sim_slot = scope.simSlot;
    }
    return payload;
}

function isRootUssdCode(code) {
    return /[*#]/.test(String(code || ''));
}

function isSessionReplyCode(code) {
    return /^\d{1,2}$/.test(String(code || '').trim());
}

function buildExpandedSessionCode(baseCode, replyCode) {
    const normalizedBase = String(baseCode || '').trim();
    const normalizedReply = String(replyCode || '').trim();

    if (!normalizedBase || !normalizedReply || !isSessionReplyCode(normalizedReply)) {
        return normalizedReply;
    }

    if (!/^[*#0-9]+#?$/.test(normalizedBase)) {
        return normalizedReply;
    }

    const trimmedBase = normalizedBase.endsWith('#')
        ? normalizedBase.slice(0, -1)
        : normalizedBase;
    if (!trimmedBase || (!trimmedBase.includes('*') && !trimmedBase.includes('#'))) {
        return normalizedReply;
    }

    return `${trimmedBase}*${normalizedReply}#`;
}

function waitForUssdCancelAckDrain() {
    if (process.env.NODE_ENV === 'test') {
        return Promise.resolve();
    }
    return new Promise(resolve => setTimeout(resolve, USSD_CANCEL_POST_ACK_MS));
}

async function requestRuntimeUssdCancel(deviceId, simScope = {}) {
    if (!global.mqttService || !global.mqttService.connected) {
        return null;
    }

    const response = await global.mqttService.publishCommand(
        deviceId,
        'cancel-ussd',
        buildUssdSimPayload(simScope),
        true,
        15000,
        {
            source: 'dashboard:ussd',
            domain: 'telephony',
            skipPersistentQueue: true
        }
    );

    if (response && response.success === false) {
        throw new Error(response.error || response.message || 'USSD cancel rejected');
    }

    return response;
}

async function cancelOpenUssdRows(db, deviceId, simScope = {}) {
    if (!db || !deviceId) {
        return;
    }

    const conditions = ['device_id = ?', "status IN ('pending', 'active')"];
    const params = [deviceId];
    appendSimScopeCondition(conditions, params, simScope);
    await db.run(
        `UPDATE ussd SET status = 'cancelled' WHERE ${conditions.join(' AND ')}`,
        params
    );
}

async function getLatestOpenUssdRow(db, deviceId, simScope = {}) {
    if (!db || !deviceId) {
        return null;
    }

    const conditions = ['device_id = ?', "status IN ('pending', 'active')"];
    const params = [deviceId];
    appendSimScopeCondition(conditions, params, simScope);
    return db.get(
        `SELECT id, code, response, timestamp, status, session_id, menu_level, sim_slot
         FROM ussd
         WHERE ${conditions.join(' AND ')}
         ORDER BY id DESC
         LIMIT 1`,
        params
    );
}

async function buildUssdSessionSnapshot(db, deviceId, simScope = {}) {
    const openRow = await getLatestOpenUssdRow(db, deviceId, simScope);
    let responseRow = openRow;
    let responseText = '';

    if (!openRow) {
        return {
            active: false,
            currentCode: null,
            lastRequest: null,
            menuLevel: 0,
            sessionId: null,
            pending: false,
            lastResponse: '',
            menuOptions: []
        };
    }

    if ((!String(openRow.response || '').trim() || openRow.status === 'pending') && openRow.session_id) {
        const responseConditions = ['device_id = ?', 'session_id = ?', "status = 'active'"];
        const responseParams = [deviceId, openRow.session_id];
        appendSimScopeCondition(responseConditions, responseParams, simScope);
        responseRow = await db.get(
            `SELECT response
             FROM ussd
             WHERE ${responseConditions.join(' AND ')}
             ORDER BY id DESC
             LIMIT 1`,
            responseParams
        ) || openRow;
    }

    responseText = String(responseRow?.response || '').trim();

    return {
        active: true,
        currentCode: openRow.code,
        lastRequest: openRow.timestamp,
        menuLevel: Number(openRow.menu_level || 0),
        sessionId: String(openRow.session_id || openRow.id),
        pending: openRow.status === 'pending',
        lastResponse: responseText,
        menuOptions: parseUssdMenuOptions(responseText)
    };
}

// Get all USSD history
router.get('/history', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        if (!db) {
            throw new Error('Database not available');
        }

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 500);
        const offset = (page - 1) * limit;
        const simScope = resolveRequestSimScope(req);
        const conditions = ['u.device_id = ?'];
        const params = [deviceId];
        appendSimScopeCondition(conditions, params, simScope, { alias: 'u' });

        const history = await db.all(`
            SELECT u.*, usr.username as sent_by
            FROM ussd u
            LEFT JOIN users usr ON u.user_id = usr.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY u.timestamp DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        const totalConditions = ['device_id = ?'];
        const totalParams = [deviceId];
        appendSimScopeCondition(totalConditions, totalParams, simScope);
        const total = await db.get(`SELECT COUNT(*) as count FROM ussd WHERE ${totalConditions.join(' AND ')}`, totalParams);

        res.json({
            success: true,
            data: history,
            pagination: {
                page,
                limit,
                total: total.count,
                pages: Math.ceil(total.count / limit)
            }
        });
    } catch (error) {
        logger.error('API USSD history error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch USSD history'
        });
    }
});

// Send USSD request
router.post('/send', [
    body('code').notEmpty().withMessage('USSD code is required')
        .matches(/^[*#0-9]+$/).withMessage('Invalid USSD code format'),
    body('description').optional()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const db = req.app.locals.db;
        const simScope = resolveRequestSimScope(req);
        const requestedCode = String(req.body.code || '').trim();
        const description = String(req.body.description || '').trim();
        let openRow = await getLatestOpenUssdRow(db, deviceId, simScope);
        let code = requestedCode;
        const requestedIsRootCode = isRootUssdCode(requestedCode);
        let restartExpandedSession = false;

        if (openRow && isSessionReplyCode(requestedCode)) {
            code = buildExpandedSessionCode(openRow.code, requestedCode);
            restartExpandedSession = code !== requestedCode;
        }

        if (openRow && (requestedIsRootCode || restartExpandedSession)) {
            await cancelOpenUssdRows(db, deviceId, simScope);
            try {
                await requestRuntimeUssdCancel(deviceId, simScope);
                await waitForUssdCancelAckDrain();
            } catch (cancelError) {
                logger.warn(`USSD runtime cancel before new request failed for ${deviceId}: ${cancelError.message}`);
            }
            if (requestedIsRootCode) {
                openRow = null;
            }
        }

        const sessionId = openRow ? String(openRow.session_id || openRow.id) : null;
        const menuLevel = openRow ? (Number(openRow.menu_level || 0) + 1) : 0;
        const resolvedDescription = description || (openRow ? `USSD Option ${requestedCode}` : 'USSD Request');
        
        if (!db) {
            throw new Error('Database not available');
        }

        // Save initial request
        const result = await db.run(`
            INSERT INTO ussd (device_id, code, description, status, timestamp, user_id, session_id, menu_level, sim_slot)
            VALUES (?, ?, ?, 'pending', CURRENT_TIMESTAMP, ?, ?, ?, ?)
        `, [deviceId, code, resolvedDescription, req.session.user?.id || null, sessionId, menuLevel, simScope.simSlot]);

        // Send via MQTT if connected
        if (global.mqttService && global.mqttService.connected) {
            try {
                const commandResult = await global.mqttService.publishCommand(
                    deviceId,
                    'send-ussd',
                    { code, ...buildUssdSimPayload(simScope) },
                    false,
                    60000,
                    {
                        source: 'dashboard:ussd',
                        domain: 'telephony',
                        skipPersistentQueue: true
                    }
                );
                logger.info(`USSD request dispatched at runtime: ${code}`);

                res.json({
                    success: true,
                    message: 'USSD request dispatched',
                    data: {
                        id: result.lastID,
                        code,
                        requestedCode,
                        status: 'pending',
                        queued: false,
                        messageId: commandResult?.messageId || null,
                        sessionId: sessionId || String(result.lastID),
                        menuLevel,
                        simSlot: simScope.simSlot
                    }
                });
            } catch (mqttError) {
                logger.error('MQTT error sending USSD:', mqttError);

                // Update database to failed
                await db.run(`
                    UPDATE ussd SET status = 'failed', response = ? WHERE id = ?
                `, [mqttError.message, result.lastID]);

                res.status(500).json({
                    success: false,
                    message: 'Failed to send USSD request'
                });
            }
        } else {
            await db.run(`
                UPDATE ussd SET status = 'failed', response = ? WHERE id = ?
            `, ['MQTT not connected', result.lastID]);

            res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }
    } catch (error) {
        logger.error('API USSD send error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send USSD request'
        });
    }
});

// Get USSD session status from the currently open request/session
router.get('/session', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const session = db
            ? await buildUssdSessionSnapshot(db, deviceId, simScope)
            : {
                active: false,
                currentCode: null,
                lastRequest: null,
                menuLevel: 0,
                sessionId: null,
                pending: false,
                lastResponse: '',
                menuOptions: []
            };

        res.json({
            success: true,
            data: session
        });
    } catch (error) {
        logger.error('API USSD session error:', error);
        res.status(500).json({ success: false, message: 'Failed to get session status' });
    }
});

// End USSD session — mark pending and active requests as cancelled
router.post('/session/end', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);

        if (db) {
            await cancelOpenUssdRows(db, deviceId, simScope);
        }

        try {
            await requestRuntimeUssdCancel(deviceId, simScope);
            await waitForUssdCancelAckDrain();
        } catch (cancelError) {
            logger.warn(`USSD runtime cancel failed for ${deviceId}: ${cancelError.message}`);
        }

        res.json({ success: true, message: 'USSD session ended' });
    } catch (error) {
        logger.error('API USSD end session error:', error);
        res.status(500).json({ success: false, message: 'Failed to end USSD session' });
    }
});

// Delete USSD history entry
router.delete('/history/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        if (!/^[0-9]+$/.test(id)) {
            return res.status(400).json({ success: false, message: 'Invalid USSD id' });
        }
        const db = req.app.locals.db;
        
        if (!db) {
            throw new Error('Database not available');
        }

        const conditions = ['id = ?', 'device_id = ?'];
        const params = [id, deviceId];
        appendSimScopeCondition(conditions, params, simScope);
        const result = await db.run(`DELETE FROM ussd WHERE ${conditions.join(' AND ')}`, params);

        if (result.changes === 0) {
            return res.status(404).json({
                success: false,
                message: 'USSD entry not found'
            });
        }

        res.json({
            success: true,
            message: 'USSD history deleted'
        });
    } catch (error) {
        logger.error('API USSD delete error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete USSD history'
        });
    }
});

// Clear all USSD history
router.delete('/history', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        
        if (!db) {
            throw new Error('Database not available');
        }
        
        const conditions = ['device_id = ?'];
        const params = [deviceId];
        appendSimScopeCondition(conditions, params, simScope);
        await db.run(`DELETE FROM ussd WHERE ${conditions.join(' AND ')}`, params);

        res.json({
            success: true,
            message: 'All USSD history cleared'
        });
    } catch (error) {
        logger.error('API USSD clear error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to clear USSD history'
        });
    }
});

// ==================== USSD SETTINGS MANAGEMENT ====================

// Get all USSD settings
router.get('/settings', async (req, res) => {
    try {
        const db = req.app.locals.db;
        
        if (!db) {
            throw new Error('Database not available');
        }
        
        const settings = await db.all(`
            SELECT * FROM ussd_settings 
            ORDER BY sort_order ASC
        `);

        res.json({
            success: true,
            data: settings
        });
    } catch (error) {
        logger.error('API USSD settings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch USSD settings'
        });
    }
});

// Get enabled USSD settings
router.get('/settings/enabled', async (req, res) => {
    try {
        const db = req.app.locals.db;
        
        if (!db) {
            throw new Error('Database not available');
        }
        
        const settings = await db.all(`
            SELECT * FROM ussd_settings 
            WHERE enabled = 1 
            ORDER BY sort_order ASC
        `);

        res.json({
            success: true,
            data: settings
        });
    } catch (error) {
        logger.error('API USSD enabled settings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch enabled USSD settings'
        });
    }
});

// Update USSD setting
router.put('/settings/:key', [
    body('service_name').optional().notEmpty(),
    body('ussd_code').optional().notEmpty().matches(/^[*#0-9]+$/),
    body('description').optional(),
    body('icon').optional(),
    body('enabled').optional().isBoolean(),
    body('sort_order').optional().isInt()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { key } = req.params;
        const { service_name, ussd_code, description, icon, enabled, sort_order } = req.body;
        const db = req.app.locals.db;
        
        if (!db) {
            throw new Error('Database not available');
        }

        // Build update query
        let updates = [];
        let params = [];

        if (service_name !== undefined) {
            updates.push('service_name = ?');
            params.push(service_name);
        }
        if (ussd_code !== undefined) {
            updates.push('ussd_code = ?');
            params.push(ussd_code);
        }
        if (description !== undefined) {
            updates.push('description = ?');
            params.push(description);
        }
        if (icon !== undefined) {
            updates.push('icon = ?');
            params.push(icon);
        }
        if (enabled !== undefined) {
            updates.push('enabled = ?');
            params.push(enabled ? 1 : 0);
        }
        if (sort_order !== undefined) {
            updates.push('sort_order = ?');
            params.push(sort_order);
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update'
            });
        }

        params.push(key);
        const result = await db.run(`
            UPDATE ussd_settings 
            SET ${updates.join(', ')}
            WHERE service_key = ?
        `, params);

        if (result.changes === 0) {
            return res.status(404).json({
                success: false,
                message: 'USSD setting not found'
            });
        }

        logger.info(`USSD setting updated: ${key}`);

        const updated = await db.get('SELECT * FROM ussd_settings WHERE service_key = ?', [key]);

        // Emit socket event
        try {
            if (global.io) {
                global.io.emit('ussd:settings-updated', updated);
            }
        } catch (socketError) {
            logger.error('Error emitting socket event:', socketError);
        }

        res.json({
            success: true,
            message: 'USSD setting updated successfully',
            data: updated
        });
    } catch (error) {
        logger.error('API USSD settings update error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update USSD setting'
        });
    }
});

// Create new USSD setting
router.post('/settings', [
    body('service_key').notEmpty().withMessage('Service key is required')
        .matches(/^[a-z0-9-]+$/).withMessage('Service key must be lowercase letters, numbers, and hyphens only'),
    body('service_name').notEmpty().withMessage('Service name is required'),
    body('ussd_code').notEmpty().withMessage('USSD code is required')
        .matches(/^[*#0-9]+$/).withMessage('Invalid USSD code format'),
    body('description').optional(),
    body('icon').optional(),
    body('enabled').optional().isBoolean(),
    body('sort_order').optional().isInt()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { service_key, service_name, ussd_code, description, icon, enabled, sort_order } = req.body;
        const db = req.app.locals.db;
        
        if (!db) {
            throw new Error('Database not available');
        }

        // Check if key already exists
        const existing = await db.get('SELECT id FROM ussd_settings WHERE service_key = ?', [service_key]);
        if (existing) {
            return res.status(400).json({
                success: false,
                message: 'Service key already exists'
            });
        }

        // Get max sort order
        const maxOrder = await db.get('SELECT MAX(sort_order) as max FROM ussd_settings');
        const newSortOrder = sort_order !== undefined ? sort_order : ((maxOrder.max || 0) + 1);

        await db.run(`
            INSERT INTO ussd_settings (service_key, service_name, ussd_code, description, icon, enabled, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [service_key, service_name, ussd_code, description || null, icon || 'question', enabled ? 1 : 0, newSortOrder]);

        logger.info(`New USSD setting created: ${service_key}`);

        const newSetting = await db.get('SELECT * FROM ussd_settings WHERE service_key = ?', [service_key]);

        // Emit socket event
        try {
            if (global.io) {
                global.io.emit('ussd:settings-created', newSetting);
            }
        } catch (socketError) {
            logger.error('Error emitting socket event:', socketError);
        }

        res.json({
            success: true,
            message: 'USSD setting created successfully',
            data: newSetting
        });
    } catch (error) {
        logger.error('API USSD settings create error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create USSD setting'
        });
    }
});

// Delete USSD setting
router.delete('/settings/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const db = req.app.locals.db;
        
        if (!db) {
            throw new Error('Database not available');
        }

        const result = await db.run('DELETE FROM ussd_settings WHERE service_key = ?', [key]);

        if (result.changes === 0) {
            return res.status(404).json({
                success: false,
                message: 'USSD setting not found'
            });
        }

        logger.info(`USSD setting deleted: ${key}`);

        // Emit socket event
        try {
            if (global.io) {
                global.io.emit('ussd:settings-deleted', { key });
            }
        } catch (socketError) {
            logger.error('Error emitting socket event:', socketError);
        }

        res.json({
            success: true,
            message: 'USSD setting deleted successfully'
        });
    } catch (error) {
        logger.error('API USSD settings delete error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete USSD setting'
        });
    }
});

// Reorder settings
router.post('/settings/reorder', [
    body('order').isArray().withMessage('Order must be an array')
], async (req, res) => {
    try {
        const { order } = req.body;
        const db = req.app.locals.db;
        
        if (!db) {
            throw new Error('Database not available');
        }

        // Update sort order for each item
        for (let i = 0; i < order.length; i++) {
            await db.run(`
                UPDATE ussd_settings 
                SET sort_order = ?, updated_at = CURRENT_TIMESTAMP 
                WHERE service_key = ?
            `, [i, order[i]]);
        }

        logger.info('USSD settings reordered');

        // Get updated settings
        const settings = await db.all('SELECT * FROM ussd_settings ORDER BY sort_order ASC');

        // Emit socket event
        try {
            if (global.io) {
                global.io.emit('ussd:settings-reordered', settings);
            }
        } catch (socketError) {
            logger.error('Error emitting socket event:', socketError);
        }

        res.json({
            success: true,
            message: 'Settings reordered successfully',
            data: settings
        });
    } catch (error) {
        logger.error('API USSD reorder error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reorder settings'
        });
    }
});

module.exports = router;
