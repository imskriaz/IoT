const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');
const { getPhoneLookupKeys } = require('../utils/phoneNumber');
const { hasRole, withEffectiveRole } = require('../middleware/auth');
const { decodeSmsRecord, decodeUcs2Hex } = require('../utils/smsUnicode');
const {
    resolveRequestSimScope,
    appendSimScopeCondition,
    hasSimScope
} = require('../utils/simScope');
const dashboardStatusUtils = require('../utils/dashboardStatus');
const {
    inferCapabilitiesFromStatus,
    getDeviceCapabilities,
    mergeCapabilities
} = require('../utils/deviceCapabilities');
const { readStoredSimRows, applyStoredSimFallback } = require('../services/storedSimService');
const fs = require('fs');
const path = require('path');

const DEVICE_REQUIRED_PAGE_PATHS = new Set([
    '/sms',
    '/calls',
    '/contacts',
    '/ussd',
    '/modem',
    '/intercom',
    '/webcam',
    '/storage',
    '/location',
    '/gpio',
    '/queue-manager',
    '/devices/queue',
    '/devices/queue-manager',
    '/devices/capabilities',
    '/automation',
    '/device-about',
    '/devices/about',
    '/test',
    '/display',
    '/nfc',
    '/rfid',
    '/touch',
    '/keyboard',
    '/devices/settings'
]);

function sortDashboardHomeDevices(devices, activeDeviceId = '') {
    const activeId = String(activeDeviceId || '').trim();

    return (Array.isArray(devices) ? devices : []).sort((left, right) => {
        if (activeId) {
            if (left.id === activeId && right.id !== activeId) return -1;
            if (right.id === activeId && left.id !== activeId) return 1;
        }

        if (Boolean(left.online) !== Boolean(right.online)) {
            return left.online ? -1 : 1;
        }

        const leftSeen = Date.parse(left.lastSeen || left.last_seen || '') || 0;
        const rightSeen = Date.parse(right.lastSeen || right.last_seen || '') || 0;
        if (leftSeen !== rightSeen) {
            return rightSeen - leftSeen;
        }

        const leftName = String(left.name || left.id || '').toLowerCase();
        const rightName = String(right.name || right.id || '').toLowerCase();
        return leftName.localeCompare(rightName);
    });
}

async function persistResolvedDeviceId(req, deviceId) {
    const normalizedDeviceId = String(deviceId || '').trim();
    if (!req?.session) {
        return normalizedDeviceId;
    }

    if (!normalizedDeviceId) {
        delete req.session.deviceId;
        if (typeof req.session.save === 'function') {
            await new Promise((resolve) => {
                req.session.save(() => resolve());
            });
        }
        return '';
    }

    if (req.session.deviceId === normalizedDeviceId) {
        return normalizedDeviceId;
    }

    req.session.deviceId = normalizedDeviceId;
    if (typeof req.session.save === 'function') {
        await new Promise((resolve) => {
            req.session.save(() => resolve());
        });
    }
    return normalizedDeviceId;
}

function getViewUser(req) {
    return withEffectiveRole(req.user || req.session?.user || null);
}

async function resolvePreferredDeviceId(req, db) {
    const requestedDeviceId = String(resolveDeviceId(req, DEFAULT_DEVICE_ID) || '').trim();
    if (requestedDeviceId) {
        return requestedDeviceId;
    }

    if (!db) {
        return requestedDeviceId;
    }

    const row = await db.get(`
        SELECT id
        FROM devices
        ORDER BY
            CASE WHEN status = 'online' THEN 0 ELSE 1 END,
            COALESCE(last_seen, created_at) DESC,
            created_at ASC
        LIMIT 1
    `);
    const deviceId = String(row?.id || '').trim();
    await persistResolvedDeviceId(req, deviceId);
    return deviceId;
}

router.use(async (req, res, next) => {
    if (!DEVICE_REQUIRED_PAGE_PATHS.has(req.path)) {
        return next();
    }

    try {
        const db = req.app.locals.db;
        if (!db) {
            return next();
        }

        const devices = await db.all(`SELECT id FROM devices ORDER BY id ASC`);
        if (!devices.length) {
            return res.redirect('/onboard');
        }

        const activeDeviceId = await resolvePreferredDeviceId(req, db);
        const hasActiveDevice = devices.some(device => String(device.id) === String(activeDeviceId));
        if (!hasActiveDevice) {
            return res.redirect('/');
        }
    } catch (error) {
        logger.warn('Active-device page gate skipped:', error.message);
    }

    return next();
});

function buildDeviceScopedRedirect(req, nextPath) {
    const query = new URLSearchParams();
    const requestedDevice = String(
        req?.query?.device ||
        req?.query?.deviceId ||
        req?.body?.device ||
        req?.body?.deviceId ||
        ''
    ).trim();

    if (requestedDevice) {
        query.set('device', requestedDevice);
    }

    const simScope = resolveRequestSimScope(req);
    if (simScope.simSlot !== null) {
        query.set('simSlot', String(simScope.simSlot));
    }

    const queryString = query.toString();
    return queryString ? `${nextPath}?${queryString}` : nextPath;
}

function inferOwnNumberCode(operatorName) {
    const operator = String(operatorName || '').trim().toLowerCase();
    if (!operator) {
        return null;
    }

    // Inference from common Bangladesh carrier USSD usage, used only when the
    // dashboard has no configured own-number code for the active device.
    if (operator.includes('robi') || operator.includes('airtel')) {
        return '*2#';
    }

    return null;
}

function getDashboardThreadNumber(row) {
    const isOutgoing = String(row?.type || '').toLowerCase() === 'outgoing';
    return String(
        isOutgoing
            ? (row?.to_number || row?.from_number || '')
            : (row?.from_number || row?.to_number || '')
    ).trim();
}

function getDashboardThreadKey(number) {
    const raw = String(number || '').trim();
    if (!raw) return '';
    const lookup = getPhoneLookupKeys(raw);
    return String(lookup.last10 || lookup.digits || raw).toLowerCase();
}

function toDashboardTimestampMs(value) {
    const parsed = value ? new Date(value).getTime() : 0;
    return Number.isFinite(parsed) ? parsed : 0;
}

function buildDashboardConversationSummaries(rows) {
    const threads = new Map();

    (Array.isArray(rows) ? rows : []).forEach((row) => {
        const threadNumber = getDashboardThreadNumber(row);
        const threadKey = getDashboardThreadKey(threadNumber);
        if (!threadNumber || !threadKey) return;

        const isOutgoing = String(row?.type || '').toLowerCase() === 'outgoing';
        const existing = threads.get(threadKey) || {
            latest: null,
            total_count: 0,
            unread_count: 0
        };
        const latest = existing.latest;
        const isNewer = !latest
            || toDashboardTimestampMs(row.timestamp) > toDashboardTimestampMs(latest.timestamp)
            || (
                toDashboardTimestampMs(row.timestamp) === toDashboardTimestampMs(latest.timestamp)
                && Number(row.id || 0) > Number(latest.id || 0)
            );

        existing.total_count += 1;
        if (!isOutgoing && !row.read) {
            existing.unread_count += 1;
        }
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
        .sort((left, right) => {
            const delta = toDashboardTimestampMs(right.latest.timestamp) - toDashboardTimestampMs(left.latest.timestamp);
            if (delta !== 0) return delta;
            return Number(right.latest.id || 0) - Number(left.latest.id || 0);
        })
        .map((thread) => {
            const latest = decodeSmsRecord(thread.latest);
            const primaryNumber = latest.thread_number || thread.latest.thread_number || '';
            const title = decodeUcs2Hex(primaryNumber || 'Conversation');
            return {
                conversation_id: null,
                primary_number: primaryNumber,
                title,
                unread_count: thread.unread_count,
                message_count: thread.total_count,
                last_message_preview: decodeUcs2Hex(latest.message || ''),
                last_message_direction: thread.latest.last_direction,
                last_message_status: latest.status || '',
                last_message_at: latest.timestamp || thread.latest.timestamp || ''
            };
        });
}

async function renderDashboardPage(req, res) {
    try {
        const db = req.app.locals.db;
        const deviceId = await resolvePreferredDeviceId(req, db);
        const simScope = resolveRequestSimScope(req);
        const viewUser = getViewUser(req);
        
        if (!db) {
            throw new Error('Database not available');
        }

        // Check device connection status
        const isDeviceConnected = !!(global.modemService &&
                                  global.modemService.isDeviceOnline(deviceId));

        // Keep recent SMS for legacy dashboard capture/tools while the UI reads conversations.
        const recentSmsConditions = ['device_id = ?'];
        const recentSmsParams = [deviceId];
        appendSimScopeCondition(recentSmsConditions, recentSmsParams, simScope, { includeUnknown: true });
        let recentSms = await db.all(`
            SELECT id, from_number, to_number, message, timestamp, read, type
            FROM sms
            WHERE ${recentSmsConditions.join(' AND ')}
            ORDER BY timestamp DESC
            LIMIT 5
        `, recentSmsParams);
        recentSms = (recentSms || []).map(decodeSmsRecord);

        let recentConversations = [];
        if (hasSimScope(simScope)) {
            const rawConversationConditions = ['device_id = ?'];
            const rawConversationParams = [deviceId];
            appendSimScopeCondition(rawConversationConditions, rawConversationParams, simScope, { includeUnknown: true });
            const conversationRows = await db.all(`
                SELECT id, from_number, to_number, message, timestamp, read, type, status
                FROM sms
                WHERE ${rawConversationConditions.join(' AND ')}
                ORDER BY timestamp DESC, id DESC
                LIMIT 250
            `, rawConversationParams);
            recentConversations = buildDashboardConversationSummaries(conversationRows).slice(0, 5);
        } else {
            try {
                recentConversations = await db.all(`
                    SELECT id AS conversation_id,
                           primary_number,
                           COALESCE(title, primary_number) AS title,
                           unread_count,
                           message_count,
                           last_message_preview,
                           last_message_direction,
                           last_message_status,
                           last_message_at
                    FROM sms_conversations
                    WHERE device_id = ?
                    ORDER BY datetime(last_message_at) DESC, id DESC
                    LIMIT 5
                `, [deviceId]);
            } catch (error) {
                const message = String(error?.message || '');
                if (!/no such table:\s*sms_conversations/i.test(message)) {
                    throw error;
                }
            }
            recentConversations = (recentConversations || []).map((row) => ({
                ...row,
                title: decodeUcs2Hex(row.title || row.primary_number || 'Conversation'),
                primary_number: decodeUcs2Hex(row.primary_number || ''),
                last_message_preview: decodeUcs2Hex(row.last_message_preview || '')
            }));
        }

        // Get unread SMS count
        const unreadConditions = ['device_id = ?', 'read = 0', "type = 'incoming'"];
        const unreadParams = [deviceId];
        appendSimScopeCondition(unreadConditions, unreadParams, simScope, { includeUnknown: true });
        const unreadCount = await db.get(`
            SELECT COUNT(*) as count FROM sms 
            WHERE ${unreadConditions.join(' AND ')}
        `, unreadParams);

        // Get recent calls
        const recentCallConditions = ['device_id = ?'];
        const recentCallParams = [deviceId];
        appendSimScopeCondition(recentCallConditions, recentCallParams, simScope);
        const recentCalls = await db.all(`
            SELECT id, phone_number, contact_name, type, status, start_time, duration
            FROM calls
            WHERE ${recentCallConditions.join(' AND ')}
            ORDER BY start_time DESC
            LIMIT 5
        `, recentCallParams);

        // Get contact count
        const contactCount = await db.get('SELECT COUNT(*) as count FROM contacts');

        // Get USSD history count
        const ussdConditions = ['device_id = ?'];
        const ussdParams = [deviceId];
        appendSimScopeCondition(ussdConditions, ussdParams, simScope);
        const ussdCount = await db.get(
            `SELECT COUNT(*) as count FROM ussd WHERE ${ussdConditions.join(' AND ')}`,
            ussdParams
        );

        // Get real storage info
        const INTERNAL_PATH = path.join(__dirname, '../storage');
        const SD_CARD_PATH = process.env.SD_CARD_PATH || '/media/sd';
        
        let storageInfo = {
            internal: { total: 0, used: 0, free: 0, available: false },
            sd: { total: 0, used: 0, free: 0, available: false, type: 'SSD' }
        };

        try {
            // Node's core fs module doesn't expose statfs/statvfs on all platforms,
            // so guard access to any non-standard API to avoid crashes (especially on Windows).
            const hasStatfs =
                typeof fs.statfsSync === 'function' || typeof fs.statvfsSync === 'function';

            if (hasStatfs) {
                const statFn = fs.statfsSync || fs.statvfsSync;

                // Check internal storage
                if (fs.existsSync(INTERNAL_PATH)) {
                    const stats = statFn(INTERNAL_PATH);
                    storageInfo.internal = {
                        total: stats.blocks * stats.bsize,
                        free: stats.bfree * stats.bsize,
                        used: (stats.blocks - stats.bfree) * stats.bsize,
                        available: true
                    };
                }

                // Check SD card (path is OS / env specific; may not exist on Windows)
                if (fs.existsSync(SD_CARD_PATH)) {
                    const sdStats = statFn(SD_CARD_PATH);
                    storageInfo.sd = {
                        total: sdStats.blocks * sdStats.bsize,
                        free: sdStats.bfree * sdStats.bsize,
                        used: (sdStats.blocks - sdStats.bfree) * sdStats.bsize,
                        available: true,
                        type: 'SSD'
                    };
                }
            }
        } catch (storageError) {
            logger.error('Error getting storage info:', storageError);
        }

        // Get device status from modem service
        let deviceStatus = Object.assign(dashboardStatusUtils.buildDashboardDeviceStatus(null, false), {
            network: 'No Device',
            operator: 'Not Connected'
        });
        
        if (isDeviceConnected && global.modemService && typeof global.modemService.getDeviceStatus === 'function') {
            try {
                const status = global.modemService.getDeviceStatus(deviceId);
                deviceStatus = dashboardStatusUtils.buildDashboardDeviceStatus({
                    ...status,
                    lastSeen: status.lastSeen || new Date().toISOString()
                }, true);
                const storedSimRows = await readStoredSimRows(db, deviceId).catch(() => []);
                deviceStatus = applyStoredSimFallback(deviceStatus, storedSimRows);

                if (status.storage) {
                    storageInfo.sd = {
                        total: Number(status.storage.totalBytes || 0),
                        used: Number(status.storage.usedBytes || 0),
                        free: Number(status.storage.freeBytes || 0),
                        available: !!(status.storage.mediaAvailable || status.storage.mounted),
                        mounted: !!status.storage.mounted,
                        deviceBacked: true,
                        type: status.storage.type || status.storage.label || 'SSD',
                        queueDepth: Number(status.storage.queueDepth || 0),
                        pendingUploads: Number(status.storage.pendingUploads || 0),
                        bufferedOnly: !!status.storage.bufferedOnly
                    };
                }
            } catch (statusError) {
                logger.error('Error getting modem status:', statusError);
            }
        } else {
            logger.debug('Device not connected, showing offline status');
        }

        if (!deviceStatus.simNumber) {
            try {
                const profile = await db.get(
                    `SELECT last_sim_number
                     FROM device_profiles
                     WHERE device_id = ?`,
                    [deviceId]
                );
                const storedSimNumber = String(profile?.last_sim_number || '').trim();
                if (storedSimNumber) {
                    deviceStatus.simNumber = storedSimNumber;
                    deviceStatus.subscriberNumber = deviceStatus.subscriberNumber || storedSimNumber;
                    deviceStatus.sim = {
                        ...(deviceStatus.sim || {}),
                        number: deviceStatus.sim?.number || storedSimNumber,
                        subscriberNumber: deviceStatus.sim?.subscriberNumber || storedSimNumber
                    };
                }
            } catch (profileError) {
                logger.warn('Could not load stored SIM number:', profileError.message);
            }
        }

        let dashboardQueue = {
            summary: {
                pending: 0,
                active: 0,
                failed: 0,
                ambiguous: 0,
                totalOpen: 0
            },
            recent: []
        };
        try {
            if (deviceId && global.mqttService?.getDeviceQueueState) {
                const liveQueue = await global.mqttService.getDeviceQueueState(deviceId);
                if (liveQueue && typeof liveQueue === 'object') {
                    dashboardQueue = {
                        summary: {
                            ...dashboardQueue.summary,
                            ...(liveQueue.summary || {})
                        },
                        recent: Array.isArray(liveQueue.recent) ? liveQueue.recent : []
                    };
                }
            }
        } catch (queueError) {
            logger.warn('Could not load dashboard queue state:', queueError.message);
        }

        const queueState = {
            dashboard: dashboardQueue,
            device: deviceStatus.queues || null
        };
        deviceStatus.queueState = queueState;

        // Get data usage stats
        let dataUsage = {
            sent: 0,
            received: 0,
            smsSent: 0,
            smsReceived: 0,
            callDuration: 0
        };

        try {
            // Get SMS sent count
            const smsSentConditions = ['device_id = ?', "type = 'outgoing'"];
            const smsSentParams = [deviceId];
            appendSimScopeCondition(smsSentConditions, smsSentParams, simScope);
            const smsSent = await db.get(`
                SELECT COUNT(*) as count FROM sms WHERE ${smsSentConditions.join(' AND ')}
            `, smsSentParams);
            
            // Get SMS received count
            const smsReceivedConditions = ['device_id = ?', "type = 'incoming'"];
            const smsReceivedParams = [deviceId];
            appendSimScopeCondition(smsReceivedConditions, smsReceivedParams, simScope);
            const smsReceived = await db.get(`
                SELECT COUNT(*) as count FROM sms WHERE ${smsReceivedConditions.join(' AND ')}
            `, smsReceivedParams);

            // Get total call duration
            const callDurationConditions = ['device_id = ?', "status = 'answered'"];
            const callDurationParams = [deviceId];
            appendSimScopeCondition(callDurationConditions, callDurationParams, simScope);
            const callDuration = await db.get(`
                SELECT SUM(duration) as total FROM calls WHERE ${callDurationConditions.join(' AND ')}
            `, callDurationParams);

            dataUsage = {
                smsSent: smsSent?.count || 0,
                smsReceived: smsReceived?.count || 0,
                callDuration: Math.floor((callDuration?.total || 0) / 60) // Convert to minutes
            };
        } catch (dbError) {
            logger.error('Error getting data usage:', dbError);
        }

        // ── Device health score (0–100) ──────────────────────────────────────
        // Composite: signal 40%, battery 40%, uptime 20%
        let healthScore = null;
        if (deviceStatus.online) {
            let score = 0;
            let factors = 0;
            if (deviceStatus.signal !== null && deviceStatus.signal !== undefined) {
                // Signal: 0–31 dBm scale → 0–100
                score += Math.min(100, Math.round((deviceStatus.signal / 31) * 100)) * 0.4;
                factors += 0.4;
            }
            if (deviceStatus.battery !== null && deviceStatus.battery !== undefined) {
                score += deviceStatus.battery * 0.4;
                factors += 0.4;
            }
            if (deviceStatus.uptime && deviceStatus.uptime !== '0s') {
                // Parse uptime string (e.g. "3h 20m") to seconds
                const uptimeStr = String(deviceStatus.uptime);
                const dMatch = uptimeStr.match(/(\d+)d/); const hMatch = uptimeStr.match(/(\d+)h/);
                const mMatch = uptimeStr.match(/(\d+)m/); const sMatch = uptimeStr.match(/^(\d+)s?$/);
                const totalSec = (dMatch ? parseInt(dMatch[1]) * 86400 : 0)
                               + (hMatch ? parseInt(hMatch[1]) * 3600 : 0)
                               + (mMatch ? parseInt(mMatch[1]) * 60 : 0)
                               + (sMatch && !dMatch && !hMatch && !mMatch ? parseInt(sMatch[1]) : 0);
                // 24h continuous uptime = 100%, cap at 24h
                score += Math.min(100, Math.round((totalSec / 86400) * 100)) * 0.2;
                factors += 0.2;
            }
            healthScore = factors > 0 ? Math.round(score / factors) : null;
        }
        healthScore = dashboardStatusUtils.computeHealthScore(deviceStatus);
        let caps = inferCapabilitiesFromStatus(deviceStatus);
        try {
            if (db && deviceId) {
                const capabilityData = await getDeviceCapabilities(db, deviceId);
                caps = mergeCapabilities(capabilityData.caps, caps);
            }
        } catch (_) {}

        // Fetch all devices with online status for the device grid
        let allDevices = [];
        try {
            const rows = await db.all(`SELECT id, name, type, description FROM devices ORDER BY name ASC`);
            allDevices = rows.map(d => {
                const online = global.modemService && global.modemService.isDeviceOnline(d.id);
                const st = (global.modemService && typeof global.modemService.getDeviceStatus === 'function')
                    ? global.modemService.getDeviceStatus(d.id) : {};
                return {
                    id: d.id,
                    name: d.name || d.id,
                    type: d.type || 'esp32',
                    description: d.description || '',
                    online: !!online,
                    ...dashboardStatusUtils.buildDashboardDeviceStatus(st, online),
                };
            });
            allDevices = sortDashboardHomeDevices(allDevices, deviceId);
        } catch (devErr) { logger.warn('Could not load device grid:', devErr.message); }

        const hasRegisteredDevices = allDevices.length > 0;
        const hasActiveDevice = hasRegisteredDevices && allDevices.some(device => device.id === deviceId);
        const renderDeviceId = hasActiveDevice ? deviceId : '';

        res.render('pages/index', {
            title: 'Dashboard',
            deviceId: renderDeviceId,
            recentSms: recentSms || [],
            recentConversations: recentConversations || [],
            recentCalls: recentCalls || [],
            unreadCount: unreadCount?.count || 0,
            contactCount: contactCount?.count || 0,
            ussdCount: ussdCount?.count || 0,
            deviceStatus,
            storageInfo,
            dataUsage,
            allDevices,
            healthScore,
            caps,
            queueState,
            mqttHost: process.env.MQTT_HOST || 'localhost',
            mqttPort: process.env.MQTT_PORT || '1883',
            user: viewUser,
            moment: require('moment'),
            isDeviceConnected,
            mqttConnected: !!(global.mqttService && global.mqttService.connected),
            hasRegisteredDevices,
            hasActiveDevice
        });
    } catch (error) {
        logger.error('Dashboard page error:', error);
        
        // Still render the page with empty data rather than crashing
        res.render('pages/index', {
            title: 'Dashboard',
            deviceId: '',
            recentSms: [],
            recentConversations: [],
            recentCalls: [],
            unreadCount: 0,
            contactCount: 0,
            ussdCount: 0,
            deviceStatus: Object.assign(dashboardStatusUtils.buildDashboardDeviceStatus(null, false), {
                network: 'No Device',
                operator: 'Not Connected'
            }),
            storageInfo: {
                internal: { total: 0, used: 0, free: 0, available: false },
                sd: { total: 0, used: 0, free: 0, available: false }
            },
            dataUsage: {
                sent: 0,
                received: 0,
                smsSent: 0,
                callDuration: 0
            },
            allDevices: [],
            healthScore: null,
            caps: {},
            queueState: {
                dashboard: {
                    summary: {
                        pending: 0,
                        active: 0,
                        failed: 0,
                        ambiguous: 0,
                        totalOpen: 0
                    },
                    recent: []
                },
                device: null
            },
            mqttHost: process.env.MQTT_HOST || 'localhost',
            mqttPort: process.env.MQTT_PORT || '1883',
            user: viewUser,
            moment: require('moment'),
            isDeviceConnected: false,
            mqttConnected: !!(global.mqttService && global.mqttService.connected),
            hasRegisteredDevices: false,
            hasActiveDevice: false
        });
    }
}

router.get('/sms', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 20;
        const offset = (page - 1) * limit;

        // Get total count
        const totalConditions = ['device_id = ?'];
        const totalParams = [deviceId];
        appendSimScopeCondition(totalConditions, totalParams, simScope);
        const totalCount = await db.get(
            `SELECT COUNT(*) as count FROM sms WHERE ${totalConditions.join(' AND ')}`,
            totalParams
        );
        
        // Get SMS messages
        const messageConditions = ['device_id = ?'];
        const messageParams = [deviceId];
        appendSimScopeCondition(messageConditions, messageParams, simScope);
        const messages = await db.all(`
            SELECT id, from_number, to_number, message, timestamp, read, type, status, sim_slot
            FROM sms
            WHERE ${messageConditions.join(' AND ')}
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `, [...messageParams, limit, offset]);

        // Get unread count for badge
        const unreadConditions = ['device_id = ?', 'read = 0', "type = 'incoming'"];
        const unreadParams = [deviceId];
        appendSimScopeCondition(unreadConditions, unreadParams, simScope);
        const unreadCount = await db.get(`
            SELECT COUNT(*) as count FROM sms 
            WHERE ${unreadConditions.join(' AND ')}
        `, unreadParams);

        res.render('pages/sms', {
            title: 'SMS Management',
            messages: (messages || []).map(decodeSmsRecord),
            unreadCount: unreadCount?.count || 0,
            pagination: {
                page,
                totalPages: Math.ceil((totalCount?.count || 0) / limit),
                totalItems: totalCount?.count || 0
            },
            deviceId,
            user: getViewUser(req)
        });
    } catch (error) {
        logger.error('SMS page error:', error);
        req.flash('error', 'Failed to load SMS messages');
        res.render('pages/sms', {
            title: 'SMS Management',
            messages: [],
            unreadCount: 0,
            pagination: {
                page: 1,
                totalPages: 1,
                totalItems: 0
            },
            deviceId: resolveDeviceId(req, DEFAULT_DEVICE_ID),
            user: getViewUser(req)
        });
    }
});

// Calls page
router.get('/calls', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        
        // Check device connection status
        const isDeviceConnected = !!(global.modemService &&
                                  global.modemService.isDeviceOnline(deviceId));

        // Get call stats
        const queryCallCount = async (suffix = '') => {
            const conditions = ['device_id = ?'];
            const params = [deviceId];
            if (suffix) {
                conditions.push(suffix);
            }
            appendSimScopeCondition(conditions, params, simScope);
            return db.get(`SELECT COUNT(*) as count FROM calls WHERE ${conditions.join(' AND ')}`, params);
        };
        const totalCalls = await queryCallCount();
        const answeredCalls = await queryCallCount("status = 'answered'");
        const missedCalls = await queryCallCount("status = 'missed'");

        res.render('pages/calls', {
            title: 'Call Management',
            stats: {
                total: totalCalls?.count || 0,
                answered: answeredCalls?.count || 0,
                missed: missedCalls?.count || 0
            },
            user: getViewUser(req),
            isDeviceConnected: isDeviceConnected // Pass connection state
        });
    } catch (error) {
        logger.error('Calls page error:', error);
        req.flash('error', 'Failed to load calls page');
        res.redirect('/');
    }
});

router.get('/contacts', async (req, res) => {
    try {
        res.render('pages/contacts', {
            title: 'Contact Management',
            user: getViewUser(req)
        });
    } catch (error) {
        logger.error('Contacts page error:', error);
        req.flash('error', 'Failed to load contacts page');
        res.redirect('/');
    }
});

router.get('/modem', async (req, res) => {
    try {
        res.render('pages/modem', {
            title: 'Modem Control',
            user: getViewUser(req)
        });
    } catch (error) {
        logger.error('Modem page error:', error);
        req.flash('error', 'Failed to load modem page');
        res.redirect('/');
    }
});

router.get('/ussd', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        
        // Get recent USSD history
        const conditions = ['device_id = ?'];
        const params = [deviceId];
        appendSimScopeCondition(conditions, params, simScope);
        const recentUssd = await db.all(`
            SELECT * FROM ussd 
            WHERE ${conditions.join(' AND ')}
            ORDER BY timestamp DESC 
            LIMIT 10
        `, params);

        res.render('pages/ussd', {
            title: 'USSD Services',
            recentUssd: recentUssd || [],
            deviceId,
            user: getViewUser(req)
        });
    } catch (error) {
        logger.error('USSD page error:', error);
        req.flash('error', 'Failed to load USSD page');
        res.redirect('/');
    }
});

router.get('/intercom', async (req, res) => {
    try {
        res.render('pages/intercom', {
            title: 'Intercom',
            user: getViewUser(req)
        });
    } catch (error) {
        logger.error('Intercom page error:', error);
        req.flash('error', 'Failed to load intercom page');
        res.redirect('/');
    }
});

router.get('/webcam', async (req, res) => {
    try {
        res.render('pages/webcam', {
            title: 'Camera',
            user: getViewUser(req)
        });
    } catch (error) {
        logger.error('Camera page error:', error);
        req.flash('error', 'Failed to load camera page');
        res.redirect('/');
    }
});

router.get('/storage', async (req, res) => {
    try {
        res.render('pages/storage', {
            title: 'Storage Manager',
            user: getViewUser(req)
        });
    } catch (error) {
        logger.error('Storage page error:', error);
        req.flash('error', 'Failed to load storage page');
        res.redirect('/');
    }
});

router.get('/settings', async (req, res) => {
    try {
        if (req.query.device) {
            return res.redirect(`/devices/settings?device=${encodeURIComponent(req.query.device)}`);
        }

        res.render('pages/settings', {
            title: 'System Settings',
            user: getViewUser(req),
            pageScript: 'system-settings.js'
        });
    } catch (error) {
        logger.error('Settings page error:', error);
        req.flash('error', 'Failed to load settings page');
        res.redirect('/');
    }
});

// Real balance check via USSD
router.post('/api/quick/balance', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const configuredBalance = await db.get(
            `SELECT ussd_code FROM ussd_settings
             WHERE service_key = 'balance' AND enabled = 1
             ORDER BY sort_order ASC, id ASC
             LIMIT 1`
        );
        const balanceCode = String(configuredBalance?.ussd_code || '').trim();
        if (!balanceCode) {
            return res.status(400).json({
                success: false,
                message: 'No balance USSD code is configured for this device yet'
            });
        }
        
        const result = await db.run(`
            INSERT INTO ussd (device_id, code, description, status, timestamp, user_id, sim_slot)
            VALUES (?, ?, 'Balance Check', 'pending', CURRENT_TIMESTAMP, ?, ?)
        `, [deviceId, balanceCode, req.session.user?.id || null, simScope.simSlot]);

        // Send via MQTT if connected — response will arrive via MQTT and update the DB row
        if (global.mqttService && global.mqttService.connected) {
            global.mqttService.publishCommand(deviceId, 'send-ussd', {
                code: balanceCode,
                ...(simScope.simSlot !== null ? { sim_slot: simScope.simSlot } : {})
            }, false, 60000, {
                source: 'dashboard:quick-ussd',
                domain: 'telephony',
                skipPersistentQueue: true
            }).catch(err => {
                logger.error('MQTT send USSD error:', err);
            });
        }

        res.json({
            success: true,
            message: 'Balance check initiated',
            id: result.lastID,
            code: balanceCode
        });
    } catch (error) {
        logger.error('Balance check error:', error);
        res.status(500).json({ success: false, message: 'Failed to check balance' });
    }
});

router.post('/api/quick/sim-number', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const simScope = resolveRequestSimScope(req);
        const configuredOwnNumber = await db.get(
            `SELECT ussd_code
             FROM ussd_settings
             WHERE service_key = 'ownNumber'
             ORDER BY sort_order ASC, id ASC
             LIMIT 1`
        );
        const configuredCode = String(configuredOwnNumber?.ussd_code || '').trim();
        const liveStatus = global.modemService?.getDeviceStatus?.(deviceId) || {};
        const inferredCode = inferOwnNumberCode(
            liveStatus.operator
            || liveStatus.sim?.operatorName
            || liveStatus.sim?.operator
            || liveStatus.mobile?.operatorName
            || liveStatus.mobile?.operator
        );
        const ownNumberCode = configuredCode || inferredCode;

        if (!ownNumberCode) {
            return res.status(400).json({
                success: false,
                message: 'No SIM Number USSD code is configured for this device yet'
            });
        }

        const result = await db.run(`
            INSERT INTO ussd (device_id, code, description, status, timestamp, user_id, sim_slot)
            VALUES (?, ?, 'SIM Number Check', 'pending', CURRENT_TIMESTAMP, ?, ?)
        `, [deviceId, ownNumberCode, req.session.user?.id || null, simScope.simSlot]);

        if (global.mqttService && global.mqttService.connected) {
            global.mqttService.publishCommand(deviceId, 'send-ussd', {
                code: ownNumberCode,
                ...(simScope.simSlot !== null ? { sim_slot: simScope.simSlot } : {})
            }, false, 60000, {
                source: 'dashboard:quick-ussd',
                domain: 'telephony',
                skipPersistentQueue: true
            }).catch(err => {
                logger.error('MQTT send SIM number USSD error:', err);
            });
        } else {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        res.json({
            success: true,
            message: configuredCode
                ? 'SIM number check initiated'
                : `SIM number check initiated using inferred ${ownNumberCode} for the active carrier`,
            id: result.lastID,
            code: ownNumberCode,
            inferred: !configuredCode
        });
    } catch (error) {
        logger.error('SIM number check error:', error);
        res.status(500).json({ success: false, message: 'Failed to check SIM number' });
    }
});

// Restart modem
router.post('/api/quick/restart-modem', async (req, res) => {
    try {
        if (global.mqttService && global.mqttService.restartModem) {
            const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
            global.mqttService.restartModem(deviceId).catch(err => {
                logger.error('MQTT restart error:', err);
            });
            
            // Log the action
            const db = req.app.locals.db;
            if (db) {
                await db.run(`
                    INSERT INTO ussd (code, description, status, timestamp) 
                    VALUES ('RESTART', 'Modem Restart', 'sent', CURRENT_TIMESTAMP)
                `);
            }
            
            res.json({
                success: true,
                message: 'Modem restart command sent'
            });
        } else {
            res.status(503).json({
                success: false,
                message: 'MQTT service unavailable'
            });
        }
    } catch (error) {
        logger.error('Restart modem error:', error);
        res.status(500).json({ success: false, message: 'Failed to restart modem' });
    }
});
router.get('/location', async (req, res) => {
    try {
        res.render('pages/location', {
            title: 'GPS Location',
            user: getViewUser(req),
            googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || ''
        });
    } catch (error) {
        logger.error('Location page error:', error);
        req.flash('error', 'Failed to load location page');
        res.redirect('/');
    }
});

router.get('/gpio', async (req, res) => {
    try {
        res.render('pages/gpio', {
            title: 'GPIO',
            user: getViewUser(req)
        });
    } catch (error) {
        logger.error('GPIO page error:', error);
        req.flash('error', 'Failed to load GPIO page');
        res.redirect('/');
    }
});

router.get('/queue-manager', async (req, res) => {
    return res.redirect(buildDeviceScopedRedirect(req, '/devices/queue'));
});

router.get('/', renderDashboardPage);
router.get('/dashboard', renderDashboardPage);

router.get('/devices/queue-manager', async (req, res) => {
    return res.redirect(buildDeviceScopedRedirect(req, '/devices/queue'));
});

router.get('/devices/queue', async (req, res) => {
    try {
        res.render('pages/queue-manager', {
            title: 'Queue Manager',
            user: getViewUser(req)
        });
    } catch (error) {
        logger.error('Queue Manager page error:', error);
        req.flash('error', 'Failed to load queue manager');
        res.redirect('/');
    }
});

router.get('/automation', async (req, res) => {
    try {
        res.render('pages/automation', {
            title: 'Automation',
            user: getViewUser(req)
        });
    } catch (error) {
        logger.error('Automation page error:', error);
        req.flash('error', 'Failed to load automation page');
        res.redirect('/');
    }
});

// Hardware capability pages
const HW_PAGES = {
    display:  'Display',
    nfc:      'NFC',
    rfid:     'RFID',
    touch:    'Touch',
    keyboard: 'Keyboard'
};
Object.entries(HW_PAGES).forEach(([cap, title]) => {
    router.get('/' + cap, (req, res) => {
        try {
            res.render('pages/' + cap, { title, user: getViewUser(req) });
        } catch (error) {
            logger.error(`${cap} page render error:`, error);
            res.redirect('/');
        }
    });
});

router.get('/devices/settings', async (req, res) => {
    try {
        res.render('pages/device-settings', {
            title: 'Device Settings',
            user: getViewUser(req),
            isAdmin: hasRole(getViewUser(req)?.role, 'admin')
        });
    } catch (error) {
        logger.error('Device Settings page error:', error);
        req.flash('error', 'Failed to load device settings page');
        res.redirect('/devices');
    }
});

router.get('/devices', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const currentUser = getViewUser(req);
        const userRole = currentUser?.role;
        const userId   = currentUser?.id;
        const isAdmin  = hasRole(userRole, 'admin');

        const devices = isAdmin
            ? await db.all(`
                SELECT d.*, dp.location, dp.firmware_version, dp.model, dp.board,
                       (SELECT COUNT(*) FROM device_users du WHERE du.device_id = d.id) AS assigned_users
                FROM devices d
                LEFT JOIN device_profiles dp ON dp.device_id = d.id
                ORDER BY d.created_at ASC
              `)
            : await db.all(`
                SELECT d.*, dp.location, dp.firmware_version, dp.model, dp.board, du.can_write
                FROM devices d
                INNER JOIN device_users du ON du.device_id = d.id AND du.user_id = ?
                LEFT JOIN device_profiles dp ON dp.device_id = d.id
                ORDER BY d.created_at ASC
              `, [userId]);

        res.render('pages/devices', {
            title: 'Device Manager',
            devices: devices || [],
            user: currentUser,
            isAdmin
        });
    } catch (error) {
        logger.error('Devices page error:', error);
        req.flash('error', 'Failed to load devices page');
        res.redirect('/');
    }
});

router.get('/device-about', async (req, res) => {
    return res.redirect(buildDeviceScopedRedirect(req, '/devices/about'));
});

router.get('/devices/about', async (req, res) => {
    try {
        res.render('pages/device-about', {
            title: 'Device About',
            user: getViewUser(req)
        });
    } catch (error) {
        logger.error('Device About page error:', error);
        req.flash('error', 'Failed to load device about page');
        res.redirect('/');
    }
});

router.get('/devices/capabilities', async (req, res) => {
    try {
        res.render('pages/capabilities', {
            title: 'Capability Editor',
            user: getViewUser(req)
        });
    } catch (error) {
        logger.error('Capabilities page error:', error);
        req.flash('error', 'Failed to load capabilities page');
        res.redirect('/devices');
    }
});

router.get('/logs', (req, res) => {
    res.render('pages/logs', {
        title: 'System Logs',
        user: getViewUser(req)
    });
});

router.get('/ota', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const devices = await db.all(`SELECT id, name FROM devices ORDER BY name ASC`);
        const configuredOtaBaseUrl = (process.env.OTA_BASE_URL || process.env.PUBLIC_BASE_URL || '').trim();
        res.render('pages/ota', {
            title: 'OTA Firmware Manager',
            user: getViewUser(req),
            devices: devices || [],
            otaBaseUrl: configuredOtaBaseUrl || null
        });
    } catch (error) {
        logger.error('OTA page error:', error);
        req.flash('error', 'Failed to load OTA page');
        res.redirect('/');
    }
});

router.get('/test', async (req, res) => {
    try {
        res.render('pages/test', {
            title: 'Device Test Center',
            user: getViewUser(req),
            layout: 'layouts/main',
            pageScript: 'test.js'
        });
    } catch (error) {
        logger.error('Test page error:', error);
        req.flash('error', 'Failed to load test page');
        res.redirect('/');
    }
});


module.exports = router;
