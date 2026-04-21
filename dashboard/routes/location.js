const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const https = require('https');
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');

// Simple rate limiter for Nominatim: max 1 req/sec per OSM usage policy
let _lastGeocodeMs = 0;

/**
 * Reverse geocode lat/lon via Nominatim (async, fire-and-forget friendly).
 * Returns a human-readable address string or null on failure.
 */
async function reverseGeocode(lat, lon) {
    const now = Date.now();
    const wait = 1100 - (now - _lastGeocodeMs);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastGeocodeMs = Date.now();

    return new Promise((resolve) => {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=0`;
        const req = https.get(url, {
            headers: { 'User-Agent': 'ESP32-Node-Dashboard/1.0 (github.com/esp32-node-dashboard)' }
        }, (res) => {
            let body = '';
            res.on('data', d => { body += d; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    resolve(json.display_name || null);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    });
}

// In-memory location cache
let locationCache = new Map(); // deviceId -> { locations array }
let lastLocations = new Map(); // deviceId -> latest location
let gpsToggleState = new Map(); // deviceId -> { enabled, changedAt }

function waitForMqttEvent(eventName, deviceId, timeoutMs, predicate = null) {
    return new Promise((resolve, reject) => {
        const mqttService = global.mqttService;
        if (!mqttService || typeof mqttService.on !== 'function') {
            reject(new Error('MQTT service unavailable'));
            return;
        }

        const cleanup = () => {
            clearTimeout(timer);
            if (typeof mqttService.off === 'function') {
                mqttService.off(eventName, onEvent);
            }
        };

        const onEvent = (incomingDeviceId, data) => {
            if (incomingDeviceId !== deviceId) return;
            if (predicate && !predicate(data)) return;
            cleanup();
            resolve(data);
        };

        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for ${eventName}`));
        }, timeoutMs);

        mqttService.on(eventName, onEvent);
    });
}

function runQueuedDeviceOperation(deviceId, task) {
    if (global.mqttService && typeof global.mqttService.runDeviceOperation === 'function') {
        return global.mqttService.runDeviceOperation(deviceId, task);
    }
    return task();
}

function buildLocationCommandOptions(command, options = {}) {
    const normalized = String(command || '').trim().toLowerCase();
    const merged = {
        source: 'dashboard-location',
        ...options
    };

    if (!merged.domain) {
        if (normalized === 'gps-status' || normalized === 'gps-location') {
            merged.domain = 'status';
        } else if (normalized.startsWith('gps-')) {
            merged.domain = 'control';
        }
    }

    return merged;
}

async function publishAndWaitForMqttEvent(deviceId, eventName, command, payload = {}, timeoutMs = 10000, predicate = null, options = {}) {
    const eventPromise = waitForMqttEvent(eventName, deviceId, timeoutMs, predicate);
    try {
        await global.mqttService.publishCommand(
            deviceId,
            command,
            payload,
            false,
            timeoutMs,
            buildLocationCommandOptions(command, options)
        );
        return await eventPromise;
    } catch (error) {
        eventPromise.catch(() => {});
        throw error;
    }
}

function isTimeoutError(error) {
    const message = error?.message || '';
    if (typeof message !== 'string') return false;
    const normalized = message.toLowerCase();
    return normalized.includes('timed out') || normalized.includes('timeout');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getGpsStatusSnapshot(deviceId, timeoutMs = 5000) {
    const status = await runQueuedDeviceOperation(deviceId, () =>
        publishAndWaitForMqttEvent(
            deviceId,
            'gps:status',
            'gps-status',
            {},
            timeoutMs,
            null,
            { skipQueue: true }
        )
    );

    return {
        enabled: status?.enabled ?? status?.powered ?? false,
        fix: status?.fix || false,
        satellites: status?.satellites || 0
    };
}

async function waitForGpsState(deviceId, enabled, attempts = 5, delayMs = 750) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const status = await getGpsStatusSnapshot(deviceId, 3000).catch(() => null);
        if (status && status.enabled === enabled) {
            return status;
        }
        if (attempt < attempts - 1) {
            await sleep(delayMs);
        }
    }

    return null;
}

// ==================== LOCATION API ENDPOINTS ====================

/**
 * @swagger
 * tags:
 *   name: Location
 *   description: GPS tracking and geofencing
 */

/**
 * @swagger
 * /location/current:
 *   get:
 *     summary: Get the latest GPS fix for a device
 *     tags: [Location]
 *     parameters:
 *       - in: query
 *         name: deviceId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Latest GPS location
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/GpsLocation' }
 */
router.get('/current', async (req, res) => {
    const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
    const lastKnown = getLastKnownLocation(deviceId);

    try {
        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected',
                data: lastKnown
            });
        }

        const gpsStatus = await getGpsStatusSnapshot(deviceId, 3000).catch(() => null);
        if (!gpsStatus) {
            return res.json({
                success: Boolean(lastKnown),
                message: lastKnown ? 'Showing last known location' : 'GPS status unavailable, waiting for fix',
                data: lastKnown || null,
                pendingFix: true,
                gps: null
            });
        }
        if (gpsStatus && !gpsStatus.enabled) {
            return res.json({
                success: Boolean(lastKnown),
                message: lastKnown ? 'Showing last known location' : 'GPS is currently disabled on the device',
                data: lastKnown || null,
                gps: gpsStatus
            });
        }
        if (gpsStatus && !gpsStatus.fix) {
            return res.json({
                success: Boolean(lastKnown) || gpsStatus.enabled,
                message: lastKnown
                    ? 'Showing last known location while GPS acquires a fix'
                    : 'GPS enabled but no location fix yet',
                data: lastKnown || null,
                pendingFix: true,
                gps: gpsStatus
            });
        }

        const response = await runQueuedDeviceOperation(deviceId, () =>
            publishAndWaitForMqttEvent(
                deviceId,
                'gps:location',
                'gps-location',
                {},
                12000,
                data => (data?.lat ?? data?.latitude ?? data?.lng ?? data?.longitude) !== undefined,
                { skipQueue: true }
            )
        );
        const locationData = parseLocationData(response);

        cacheLocation(deviceId, locationData);

        res.json({
            success: true,
            data: locationData
        });
    } catch (error) {
        if (isTimeoutError(error)) {
            try {
                const status = await getGpsStatusSnapshot(deviceId, 4000);
                return res.json({
                    success: Boolean(lastKnown) || status.enabled,
                    message: status.enabled
                        ? 'GPS enabled but no location fix yet'
                        : 'GPS is currently disabled on the device',
                    data: lastKnown || null,
                    pendingFix: status.enabled && !lastKnown,
                    gps: status
                });
            } catch (_) {
                return res.json({
                    success: Boolean(lastKnown),
                    message: lastKnown ? 'Showing last known location while GPS acquires a fix' : 'GPS enabled but no location fix yet',
                    data: lastKnown || null,
                    pendingFix: true,
                    gps: null
                });
            }
        } else {
            logger.warn(`Location current error: ${error.message}`);
        }

        // Return last known location on error
        res.json({
            success: lastKnown ? true : false,
            message: lastKnown ? 'Showing last known location' : 'Failed to fetch location',
            data: lastKnown || null
        });
    }
});

/**
 * Get location history
 * GET /api/location/history?deviceId=1&limit=50&start=2026-02-01&end=2026-02-15
 *   &since=<ISO>   — delta sync (takes priority over start/end)
 *   &before=<id>   — cursor-based pagination (stable, no OFFSET)
 */
router.get('/history', async (req, res) => {
    try {
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 50), 1000);
        const startDate = req.query.start;
        const endDate = req.query.end;
        const since = req.query.since || null;
        const before = req.query.before ? parseInt(req.query.before) : null;

        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }

        const cols = 'id, latitude, longitude, altitude, speed, heading, satellites, accuracy, fix_quality, timestamp, address';
        let query = `SELECT ${cols} FROM gps_locations WHERE device_id = ? AND (ABS(latitude) > 0.001 OR ABS(longitude) > 0.001)`;
        let params = [deviceId];

        if (since) {
            query += ` AND timestamp > ?`;
            params.push(since);
        } else if (before && !isNaN(before)) {
            // Cursor-based: fetch rows with id < cursor (stable, no OFFSET drift)
            query += ` AND id < ?`;
            params.push(before);
        } else if (startDate && endDate) {
            query += ` AND timestamp BETWEEN ? AND ?`;
            params.push(startDate, endDate);
        }

        query += ` ORDER BY id DESC LIMIT ?`;
        params.push(limit);

        const locations = await db.all(query, params);

        const nextCursor = locations.length === limit ? locations[locations.length - 1].id : null;

        res.json({
            success: true,
            data: locations,
            nextCursor
        });
    } catch (error) {
        logger.error('Location history error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch location history'
        });
    }
});

/**
 * Get latest location for all devices
 * GET /api/location/devices
 */
router.get('/devices', (req, res) => {
    try {
        const devices = [];
        for (const [deviceId, location] of lastLocations) {
            devices.push({
                deviceId,
                ...location
            });
        }
        
        res.json({
            success: true,
            data: devices
        });
    } catch (error) {
        logger.error('Location devices error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch devices'
        });
    }
});

/**
 * Get location stats
 * GET /api/location/stats?deviceId=1
 */
router.get('/stats', async (req, res) => {
    try {
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const db = req.app.locals.db;
        
        if (!db) {
            throw new Error('Database not available');
        }

        const stats = await db.get(`
            SELECT 
                COUNT(*) as total_fixes,
                MAX(satellites) as max_satellites,
                AVG(accuracy) as avg_accuracy,
                MIN(timestamp) as first_fix,
                MAX(timestamp) as last_fix
            FROM gps_locations 
            WHERE device_id = ?
        `, [deviceId]);

        res.json({
            success: true,
            data: stats || {
                total_fixes: 0,
                max_satellites: 0,
                avg_accuracy: 0,
                first_fix: null,
                last_fix: null
            }
        });
    } catch (error) {
        logger.error('Location stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch stats'
        });
    }
});

/**
 * Toggle GPS power
 * POST /api/location/toggle
 */
router.post('/toggle', [
    body('enabled').isBoolean().withMessage('Enabled status required'),
    body('deviceId').optional()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { enabled } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        
        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const lastToggle = gpsToggleState.get(deviceId);
        if (enabled && lastToggle && lastToggle.enabled === false) {
            const cooldownMs = 6000;
            const elapsed = Date.now() - lastToggle.changedAt;
            if (elapsed < cooldownMs) {
                await sleep(cooldownMs - elapsed);
            }
        }

        await global.mqttService.publishCommand(
            deviceId,
            'gps-set-enabled',
            { enabled },
            false
        );

        const status = await waitForGpsState(deviceId, enabled);
        if (status) {
            gpsToggleState.set(deviceId, { enabled: status.enabled, changedAt: Date.now() });
            logger.info(`GPS ${enabled ? 'enabled' : 'disabled'} for ${deviceId}`);
            
            // Update database
            const db = req.app.locals.db;
            if (db) {
                await db.run(`
                    INSERT INTO settings (key, value, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
                `, [`gps_${deviceId}_enabled`, JSON.stringify(enabled), JSON.stringify(enabled)]);
            }

            res.json({
                success: true,
                message: `GPS ${enabled ? 'enabled' : 'disabled'}`,
                data: { enabled: status.enabled }
            });
        } else {
            res.status(500).json({
                success: false,
                message: `Device did not switch GPS ${enabled ? 'on' : 'off'}`
            });
        }
    } catch (error) {
        const { enabled } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const status = await waitForGpsState(deviceId, enabled, 2, 250).catch(() => null);
        if (status && typeof enabled === 'boolean' && status.enabled === enabled) {
            gpsToggleState.set(deviceId, { enabled: status.enabled, changedAt: Date.now() });
            return res.json({
                success: true,
                message: `GPS ${enabled ? 'enabled' : 'disabled'}`,
                data: { enabled: status.enabled }
            });
        }

        if (!isTimeoutError(error)) {
            logger.warn(`Location toggle error: ${error.message}`);
        }
        res.status(500).json({
            success: false,
            message: isTimeoutError(error)
                ? `Device did not acknowledge GPS ${enabled ? 'enable' : 'disable'}`
                : 'Failed to toggle GPS'
        });
    }
});

/**
 * Configure GPS settings
 * POST /api/location/config
 */
router.post('/config', [
    body('update_rate').optional().isInt({ min: 1, max: 3600 }),
    body('minimum_fix_time').optional().isInt({ min: 0, max: 300 }),
    body('power_save_mode').optional().isBoolean(),
    body('deviceId').optional()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { update_rate, minimum_fix_time, power_save_mode } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        
        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const config = {
            updateRate: update_rate || 10,
            minFixTime: minimum_fix_time || 30,
            powerSave: power_save_mode || false
        };

        const response = await global.mqttService.publishCommand(
            deviceId,
            'gps-configure',
            config,
            true,
            10000
        );

        if (response && response.success) {
            // Save to database
            const db = req.app.locals.db;
            if (db) {
                await db.run(`
                    INSERT INTO settings (key, value, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
                `, [`gps_${deviceId}_config`, JSON.stringify(config), JSON.stringify(config)]);
            }

            res.json({
                success: true,
                message: 'GPS configuration updated',
                data: config
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to configure GPS'
            });
        }
    } catch (error) {
        logger.error('Location config error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to configure GPS'
        });
    }
});

/**
 * Get GPS status
 * GET /api/location/status?deviceId=1
 */
router.get('/status', async (req, res) => {
    try {
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const messageId = `gps-status_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        
        if (!global.mqttService || !global.mqttService.connected) {
            return res.json({
                success: true,
                data: {
                    enabled: false,
                    fix: false,
                    satellites: 0,
                    lastFix: null,
                    powerSave: false,
                    updateRate: 10
                }
            });
        }

        const response = await runQueuedDeviceOperation(deviceId, () =>
            publishAndWaitForMqttEvent(
                deviceId,
                'gps:status',
                'gps-status',
                {},
                10000,
                data => data?.messageId === messageId,
                { skipQueue: true, messageId }
            )
        );

        if (response) {
            res.json({
                success: true,
                data: {
                    enabled: response.enabled ?? response.powered ?? false,
                    fix: response.fix || false,
                    satellites: response.satellites || 0,
                    lastFix: response.lastFix || null,
                    powerSave: response.powerSave || false,
                    updateRate: response.updateRate || 10
                }
            });
        } else {
            res.json({
                success: true,
                data: {
                    enabled: false,
                    fix: false,
                    satellites: 0,
                    lastFix: null,
                    powerSave: false,
                    updateRate: 10,
                    error: response?.message || 'GPS not responding'
                }
            });
        }
    } catch (error) {
        if (!isTimeoutError(error)) logger.warn(`Location status error: ${error.message}`);
        res.json({
            success: true,
            data: {
                enabled: false,
                fix: false,
                satellites: 0,
                lastFix: null,
                powerSave: false,
                updateRate: 10,
                error: 'Failed to fetch GPS status'
            }
        });
    }
});

/**
 * Delete location history
 * DELETE /api/location/history/:id
 */
router.delete('/history/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^[0-9]+$/.test(id)) {
            return res.status(400).json({ success: false, message: 'Invalid location id' });
        }
        const db = req.app.locals.db;
        
        if (!db) {
            throw new Error('Database not available');
        }

        await db.run('DELETE FROM gps_locations WHERE id = ?', [id]);

        res.json({
            success: true,
            message: 'Location deleted'
        });
    } catch (error) {
        logger.error('Location delete error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete location'
        });
    }
});

/**
 * Clear all history for a device
 * DELETE /api/location/history/device/:deviceId
 */
router.delete('/history/device/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const db = req.app.locals.db;
        
        if (!db) {
            throw new Error('Database not available');
        }

        await db.run('DELETE FROM gps_locations WHERE device_id = ?', [deviceId]);

        res.json({
            success: true,
            message: 'All locations cleared for device'
        });
    } catch (error) {
        logger.error('Location clear error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to clear locations'
        });
    }
});

// ==================== HELPER FUNCTIONS ====================

/**
 * Convert NMEA DDMM.MMMM to decimal degrees.
 * Values >= 100 (lat) or >= 1000 (lon) indicate unconverted NMEA format.
 * Formula: deg + (val - deg*100) / 60
 */
function nmeaToDecimal(val) {
    if (val === 0) return 0;
    const absVal = Math.abs(val);
    const deg = Math.floor(absVal / 100);
    const minutes = absVal - deg * 100;
    return Math.sign(val) * (deg + minutes / 60);
}

function parseLocationData(data) {
    let lat = parseFloat(data.lat ?? data.latitude ?? data.latitude_deg ?? 0);
    let lng = parseFloat(data.lng ?? data.lon ?? data.longitude ?? data.longitude_deg ?? 0);

    // Detect unconverted NMEA DDMM.MMMM format and convert to decimal degrees
    if (Math.abs(lat) >= 100) lat = nmeaToDecimal(lat);
    if (Math.abs(lng) >= 1000) lng = nmeaToDecimal(lng);

    // Clamp to valid WGS84 ranges
    const latitude = (lat >= -90 && lat <= 90) ? lat : 0;
    const longitude = (lng >= -180 && lng <= 180) ? lng : 0;

    return {
        latitude,
        longitude,
        altitude: parseFloat(data.alt || data.altitude || 0),
        speed: parseFloat(data.speed || 0),
        heading: parseFloat(data.heading || data.course || 0),
        satellites: parseInt(data.satellites || data.sats || 0),
        accuracy: parseFloat(data.accuracy || data.hdop || 0),
        fix_quality: parseInt(data.fix || data.quality || 0),
        timestamp: data.timestamp || new Date().toISOString()
    };
}

function cacheLocation(deviceId, locationData) {
    // Store in memory cache
    lastLocations.set(deviceId, {
        ...locationData,
        cached: new Date().toISOString()
    });

    // Store in history cache (limit to 100 per device)
    if (!locationCache.has(deviceId)) {
        locationCache.set(deviceId, []);
    }
    
    const deviceLocations = locationCache.get(deviceId);
    deviceLocations.unshift(locationData);
    
    // Keep only last 100 locations in memory
    if (deviceLocations.length > 100) {
        deviceLocations.pop();
    }
}

function getLastKnownLocation(deviceId) {
    return lastLocations.get(deviceId) || null;
}

// ==================== GEOFENCING ====================

/** Haversine distance in metres between two WGS84 coordinates */
function haversineMetres(lat1, lon1, lat2, lon2) {
    const R = 6371000; // earth radius in metres
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Check all active geofences for a device against the latest GPS fix.
 * Detects entry/exit transitions and emits geofence:alert via Socket.IO.
 */
async function checkGeofences(deviceId, lat, lon) {
    const db = global.app?.locals?.db;
    if (!db) return;

    try {
        const fences = await db.all(
            `SELECT * FROM geofences WHERE device_id = ? AND active = 1`,
            [deviceId]
        );
        if (!fences.length) return;

        for (const fence of fences) {
            const dist = haversineMetres(lat, lon, fence.latitude, fence.longitude);
            const inside = dist <= fence.radius_m;

            // Read previous state
            const prev = await db.get(
                `SELECT inside FROM geofence_state WHERE geofence_id = ? AND device_id = ?`,
                [fence.id, deviceId]
            );
            const wasInside = prev ? (prev.inside === 1 || prev.inside === true) : null;

            // Upsert current state
            await db.run(
                `INSERT INTO geofence_state (geofence_id, device_id, inside, updated_at)
                 VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(geofence_id, device_id) DO UPDATE SET inside = excluded.inside, updated_at = excluded.updated_at`,
                [fence.id, deviceId, inside ? 1 : 0]
            );

            // On first observation (wasInside === null) just record, no alert
            if (wasInside === null) continue;

            const entered = inside && !wasInside;
            const exited  = !inside && wasInside;

            if ((entered && (fence.alert_on === 'enter' || fence.alert_on === 'both')) ||
                (exited  && (fence.alert_on === 'exit'  || fence.alert_on === 'both'))) {
                const event = entered ? 'entered' : 'exited';
                logger.info(`📍 Geofence "${fence.name}" ${event} by ${deviceId} (${dist.toFixed(0)}m from center)`);

                if (global.io) {
                    global.io.to('device:' + deviceId).emit('geofence:alert', {
                        deviceId,
                        fenceId: fence.id,
                        fenceName: fence.name,
                        event,
                        latitude: lat,
                        longitude: lon,
                        distanceMetres: Math.round(dist),
                        timestamp: new Date().toISOString()
                    });
                }
                global.automationEngine?.onEvent?.('gps.geofence', {
                    deviceId,
                    fenceId: fence.id,
                    fenceName: fence.name,
                    type: entered ? 'enter' : 'exit',
                    latitude: lat,
                    longitude: lon,
                    distanceMetres: Math.round(dist),
                    timestamp: new Date().toISOString()
                }, deviceId);
            }
        }
    } catch (err) {
        logger.error('Geofence check error:', err);
    }
}

/**
 * GET /api/location/geofences?deviceId=1
 */
router.get('/geofences', async (req, res) => {
    try {
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const db = req.app.locals.db;
        const fences = await db.all(
            `SELECT * FROM geofences WHERE device_id = ? ORDER BY created_at DESC`,
            [deviceId]
        );
        res.json({ success: true, data: fences });
    } catch (err) {
        logger.error('Get geofences error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch geofences' });
    }
});

/**
 * POST /api/location/geofences
 */
router.post('/geofences', [
    body('name').trim().notEmpty().withMessage('Name required').isLength({ max: 100 }),
    body('latitude').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
    body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
    body('radius_m').isFloat({ min: 1, max: 50000 }).withMessage('Radius must be 1–50000 m'),
    body('alert_on').optional().isIn(['enter', 'exit', 'both']),
    body('active').optional().isBoolean()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0]?.msg || "Validation failed", errors: errors.array() });
        }
        const { name, latitude, longitude, radius_m, alert_on = 'both', active = true } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const db = req.app.locals.db;
        const result = await db.run(
            `INSERT INTO geofences (device_id, name, latitude, longitude, radius_m, alert_on, active)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [deviceId, name, latitude, longitude, radius_m, alert_on, active ? 1 : 0]
        );
        logger.info(`Geofence created: ${name} (id=${result.lastID}) for ${deviceId}`);
        res.json({ success: true, message: 'Geofence created', id: result.lastID });
    } catch (err) {
        logger.error('Create geofence error:', err);
        res.status(500).json({ success: false, message: 'Failed to create geofence' });
    }
});

/**
 * PUT /api/location/geofences/:id
 */
router.put('/geofences/:id', [
    body('name').optional().trim().notEmpty(),
    body('latitude').optional().isFloat({ min: -90, max: 90 }),
    body('longitude').optional().isFloat({ min: -180, max: 180 }),
    body('radius_m').optional().isFloat({ min: 1, max: 50000 }),
    body('alert_on').optional().isIn(['enter', 'exit', 'both']),
    body('active').optional().isBoolean()
], async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^[0-9]+$/.test(id)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0]?.msg || "Validation failed", errors: errors.array() });
        }
        const db = req.app.locals.db;
        const fence = await db.get(`SELECT * FROM geofences WHERE id = ?`, [id]);
        if (!fence) return res.status(404).json({ success: false, message: 'Geofence not found' });

        const { name, latitude, longitude, radius_m, alert_on, active } = req.body;
        await db.run(
            `UPDATE geofences SET
                name      = COALESCE(?, name),
                latitude  = COALESCE(?, latitude),
                longitude = COALESCE(?, longitude),
                radius_m  = COALESCE(?, radius_m),
                alert_on  = COALESCE(?, alert_on),
                active    = COALESCE(?, active),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [name ?? null, latitude ?? null, longitude ?? null, radius_m ?? null,
             alert_on ?? null, active !== undefined ? (active ? 1 : 0) : null, id]
        );
        res.json({ success: true, message: 'Geofence updated' });
    } catch (err) {
        logger.error('Update geofence error:', err);
        res.status(500).json({ success: false, message: 'Failed to update geofence' });
    }
});

/**
 * DELETE /api/location/geofences/:id
 */
router.delete('/geofences/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^[0-9]+$/.test(id)) {
            return res.status(400).json({ success: false, message: 'Invalid id' });
        }
        const db = req.app.locals.db;
        await db.run('DELETE FROM geofences WHERE id = ?', [id]);
        res.json({ success: true, message: 'Geofence deleted' });
    } catch (err) {
        logger.error('Delete geofence error:', err);
        res.status(500).json({ success: false, message: 'Failed to delete geofence' });
    }
});

// ==================== MQTT HANDLER INTEGRATION ====================

// This should be called from mqttHandlers.js when GPS data arrives
async function handleGpsLocation(deviceId, data) {
    try {
        // Validate: payload must have a recognisable lat/lon field
        const rawLat = data.lat ?? data.latitude ?? data.latitude_deg ?? null;
        const rawLon = data.lng ?? data.lon ?? data.longitude ?? data.longitude_deg ?? null;
        if (rawLat === null || rawLon === null) {
            logger.warn(`GPS payload from ${deviceId} missing lat/lon fields — dropped`, { keys: Object.keys(data) });
            return null;
        }

        const locationData = parseLocationData(data);

        // Reject (0, 0) — sentinel for "no fix" or wrong field names
        if (locationData.latitude === 0 && locationData.longitude === 0) {
            logger.warn(`GPS payload from ${deviceId} resolved to (0,0) — likely no fix or wrong field names`);
            return null;
        }

        // Cache in memory
        cacheLocation(deviceId, locationData);

        // Save to database
        const db = global.app?.locals?.db;
        if (db) {
            const insertResult = await db.run(`
                INSERT INTO gps_locations
                (device_id, latitude, longitude, altitude, speed, heading,
                 satellites, accuracy, fix_quality, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                deviceId,
                locationData.latitude,
                locationData.longitude,
                locationData.altitude,
                locationData.speed,
                locationData.heading,
                locationData.satellites,
                locationData.accuracy,
                locationData.fix_quality,
                locationData.timestamp
            ]);

            // Reverse geocode asynchronously — don't block the MQTT handler
            const rowId = insertResult.lastID;
            reverseGeocode(locationData.latitude, locationData.longitude).then(address => {
                if (address && rowId) {
                    db.run('UPDATE gps_locations SET address = ? WHERE id = ?', [address, rowId])
                        .catch(err => logger.debug('Geocode update failed:', err));
                }
            }).catch(() => {});

            // Geofence check — fire-and-forget
            checkGeofences(deviceId, locationData.latitude, locationData.longitude).catch(() => {});
        }

        // Emit via Socket.IO
        if (global.io) {
            global.io.to('device:' + deviceId).emit('location:update', {
                deviceId,
                ...locationData
            });
        }

        logger.info(`📍 GPS location from ${deviceId}: ${locationData.latitude}, ${locationData.longitude} (${locationData.satellites} sats)`);

        return locationData;
    } catch (error) {
        logger.error('Error handling GPS location:', error);
        return null;
    }
}

// Export for use in mqttHandlers.js
module.exports = router;
module.exports.handleGpsLocation = handleGpsLocation;
