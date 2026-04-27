'use strict';

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');

// Legacy cleanup filter only. Interactive telephony is runtime-only and must
// not be introduced as new durable queue work.
const INTERACTIVE_TELEPHONY_COMMANDS = [
    'make-call',
    'call-dial',
    'answer-call',
    'reject-call',
    'end-call',
    'hold-call',
    'mute-call'
];

const ACTIVE_STATUSES = ['dispatching'];
const OPEN_STATUSES = ['pending', 'dispatching', 'waiting_response', 'failed', 'ambiguous'];
const CLEARABLE_BULK_STATUSES = ['pending', 'waiting_response', 'failed', 'ambiguous', 'completed'];
const FILTERABLE_STATUSES = ['all', 'open', ...OPEN_STATUSES, 'completed'];
const SORT_FIELDS = {
    command: {
        expression: 'LOWER(command)',
        fallback: 'datetime(updated_at) DESC, datetime(created_at) DESC'
    },
    status: {
        expression: 'LOWER(status)',
        fallback: 'datetime(updated_at) DESC, datetime(created_at) DESC'
    },
    attempts: {
        expression: 'attempt_count',
        fallback: (direction) => `max_attempts ${direction}, datetime(updated_at) DESC, datetime(created_at) DESC`
    },
    created: {
        expression: 'datetime(created_at)',
        fallback: 'datetime(updated_at) DESC'
    },
    updated: {
        expression: 'datetime(updated_at)',
        fallback: 'datetime(created_at) DESC'
    }
};

function normalizeDeviceId(value) {
    return String(value || '').trim();
}

function sqlPlaceholders(count) {
    return new Array(count).fill('?').join(',');
}

function clamp(value, min, max, fallback) {
    const num = Number.parseInt(value, 10);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
}

function normalizeScope(value) {
    const scope = String(value || 'device').trim().toLowerCase();
    if (scope === 'call') return 'call';
    if (scope === 'all') return 'all';
    return 'device';
}

function normalizeStatusFilter(value) {
    const status = String(value || 'all').trim().toLowerCase();
    return FILTERABLE_STATUSES.includes(status) ? status : 'all';
}

function normalizeSortField(value) {
    const sort = String(value || 'updated').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(SORT_FIELDS, sort) ? sort : 'updated';
}

function defaultSortDirection(sort) {
    return sort === 'command' || sort === 'status' ? 'ASC' : 'DESC';
}

function normalizeSortDirection(value, sort) {
    const direction = String(value || '').trim().toLowerCase();
    if (direction === 'asc') return 'ASC';
    if (direction === 'desc') return 'DESC';
    return defaultSortDirection(sort);
}

function buildOrderBy(sort, direction) {
    const sortSpec = SORT_FIELDS[sort] || SORT_FIELDS.updated;
    const fallback = typeof sortSpec.fallback === 'function' ? sortSpec.fallback(direction) : sortSpec.fallback;
    return `ORDER BY ${sortSpec.expression} ${direction}, ${fallback}, id DESC`;
}

function clearableStatusesForFilter(status) {
    if (status === 'open') {
        return CLEARABLE_BULK_STATUSES.filter(clearable => OPEN_STATUSES.includes(clearable));
    }
    if (status === 'all') {
        return CLEARABLE_BULK_STATUSES;
    }
    return CLEARABLE_BULK_STATUSES.includes(status) ? [status] : [];
}

async function emitQueueState(deviceId) {
    try {
        if (global.mqttService && typeof global.mqttService._emitDeviceQueueState === 'function') {
            await global.mqttService._emitDeviceQueueState(deviceId);
        }
    } catch (_) {}
}

function buildScopeWhere(scope, params) {
    if (scope === 'call') {
        params.push(...INTERACTIVE_TELEPHONY_COMMANDS);
        return ` AND command IN (${sqlPlaceholders(INTERACTIVE_TELEPHONY_COMMANDS.length)})`;
    }
    if (scope === 'device') {
        params.push(...INTERACTIVE_TELEPHONY_COMMANDS);
        return ` AND (command IS NULL OR command NOT IN (${sqlPlaceholders(INTERACTIVE_TELEPHONY_COMMANDS.length)}))`;
    }
    return '';
}

router.get('/', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database unavailable' });
        }

        const deviceId = normalizeDeviceId(resolveDeviceId(req, DEFAULT_DEVICE_ID));
        if (!deviceId) {
            return res.json({
                success: true,
                data: { deviceId: '', summary: null, recent: [], items: [] }
            });
        }

        const scope = normalizeScope(req.query.scope);
        const status = normalizeStatusFilter(req.query.status);
        const limit = clamp(req.query.limit, 10, 200, 60);
        const sort = normalizeSortField(req.query.sort);
        const direction = normalizeSortDirection(req.query.direction, sort);
        const params = [deviceId];
        let whereSql = 'WHERE device_id = ?';
        whereSql += buildScopeWhere(scope, params);

        if (status === 'open') {
            params.push(...OPEN_STATUSES);
            whereSql += ` AND status IN (${sqlPlaceholders(OPEN_STATUSES.length)})`;
        } else if (status && status !== 'all') {
            params.push(status);
            whereSql += ' AND status = ?';
        }

        params.push(limit);

        const items = await db.all(
            `SELECT id,
                    device_id AS deviceId,
                    command,
                    payload,
                    message_id AS messageId,
                    status,
                    requires_response AS requiresResponse,
                    replay_safe AS replaySafe,
                    attempt_count AS attemptCount,
                    max_attempts AS maxAttempts,
                    timeout_ms AS timeoutMs,
                    priority,
                    next_attempt_at AS nextAttemptAt,
                    published_at AS publishedAt,
                    completed_at AS completedAt,
                    last_error AS lastError,
                    response_payload AS responsePayload,
                    source,
                    user_id AS userId,
                    created_at AS createdAt,
                    updated_at AS updatedAt
             FROM device_command_queue
             ${whereSql}
             ${buildOrderBy(sort, direction)}
             LIMIT ?`,
            params
        );

        let queueState = null;
        try {
            if (global.mqttService?.getDeviceQueueState) {
                queueState = await global.mqttService.getDeviceQueueState(deviceId);
            }
        } catch (_) {}

        res.json({
            success: true,
            data: {
                deviceId,
                scope,
                status,
                sort,
                direction: direction.toLowerCase(),
                summary: queueState?.summary || null,
                domains: queueState?.domains || {},
                runtime: queueState?.runtime || null,
                recent: queueState?.recent || [],
                items
            }
        });
    } catch (error) {
        logger.error('Queue list error:', error);
        res.status(500).json({ success: false, message: 'Failed to load queue data' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database unavailable' });
        }

        const queueId = String(req.params.id || '').trim();
        const deviceId = normalizeDeviceId(resolveDeviceId(req, DEFAULT_DEVICE_ID));
        const row = await db.get(
            `SELECT id, device_id AS deviceId, command, status
             FROM device_command_queue
             WHERE id = ? AND device_id = ?`,
            [queueId, deviceId]
        );

        if (!row) {
            return res.status(404).json({ success: false, message: 'Queue item not found' });
        }
        if (ACTIVE_STATUSES.includes(row.status)) {
            return res.status(409).json({ success: false, message: 'Active queue item cannot be cleared' });
        }

        await db.run(`DELETE FROM device_command_queue WHERE id = ?`, [queueId]);
        await emitQueueState(deviceId);

        res.json({
            success: true,
            message: 'Queue item cleared',
            data: row
        });
    } catch (error) {
        logger.error('Queue item delete error:', error);
        res.status(500).json({ success: false, message: 'Failed to clear queue item' });
    }
});

router.post('/clear', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            return res.status(503).json({ success: false, message: 'Database unavailable' });
        }

        const deviceId = normalizeDeviceId(resolveDeviceId(req, DEFAULT_DEVICE_ID));
        if (!deviceId) {
            return res.status(400).json({ success: false, message: 'No active device selected' });
        }

        const scope = normalizeScope(req.body?.scope);
        const status = normalizeStatusFilter(req.body?.status);
        const clearableStatuses = clearableStatusesForFilter(status);

        if (!clearableStatuses.length) {
            return res.json({
                success: true,
                message: 'Nothing to clear',
                data: { deleted: 0, deviceId, scope, status }
            });
        }

        const params = [deviceId, ...clearableStatuses];
        let whereSql = `WHERE device_id = ? AND status IN (${sqlPlaceholders(clearableStatuses.length)})`;
        whereSql += buildScopeWhere(scope, params);

        const countRow = await db.get(
            `SELECT COUNT(*) AS count FROM device_command_queue ${whereSql}`,
            params
        );
        const count = Number(countRow?.count || 0);

        if (!count) {
            return res.json({
                success: true,
                message: 'Nothing to clear',
                data: { deleted: 0, deviceId, scope, status }
            });
        }

        await db.run(`DELETE FROM device_command_queue ${whereSql}`, params);
        await emitQueueState(deviceId);

        res.json({
            success: true,
            message: `${count} queue item(s) cleared`,
            data: { deleted: count, deviceId, scope, status }
        });
    } catch (error) {
        logger.error('Queue bulk clear error:', error);
        res.status(500).json({ success: false, message: 'Failed to clear queue' });
    }
});

router.post('/actions/restart-device', async (req, res) => {
    try {
        const deviceId = normalizeDeviceId(resolveDeviceId(req, DEFAULT_DEVICE_ID));
        if (!deviceId) {
            return res.status(400).json({ success: false, message: 'No active device selected' });
        }
        if (!global.mqttService?.restartDevice) {
            return res.status(503).json({ success: false, message: 'MQTT service unavailable' });
        }

        const result = await global.mqttService.restartDevice(deviceId);
        res.json({
            success: true,
            message: 'Device restart queued',
            data: { deviceId, result: result || null }
        });
    } catch (error) {
        logger.error('Queue restart-device error:', error);
        res.status(500).json({ success: false, message: 'Failed to restart device' });
    }
});

router.post('/actions/restart-modem', async (req, res) => {
    try {
        const deviceId = normalizeDeviceId(resolveDeviceId(req, DEFAULT_DEVICE_ID));
        if (!deviceId) {
            return res.status(400).json({ success: false, message: 'No active device selected' });
        }
        if (!global.mqttService?.restartModem) {
            return res.status(503).json({ success: false, message: 'MQTT service unavailable' });
        }

        const result = await global.mqttService.restartModem(deviceId);
        res.json({
            success: true,
            message: 'Modem restart queued',
            data: { deviceId, result: result || null }
        });
    } catch (error) {
        logger.error('Queue restart-modem error:', error);
        res.status(500).json({ success: false, message: 'Failed to restart modem' });
    }
});

module.exports = router;
