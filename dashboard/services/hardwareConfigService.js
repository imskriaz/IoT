'use strict';

const crypto = require('crypto');
const { validateHardwareConfiguration } = require('./hardwareCatalogService');

function parseJson(value) {
    try { return value == null ? null : JSON.parse(value); } catch (_) { return null; }
}

function failure(statusCode, message, details) {
    return Object.assign(new Error(message), { statusCode, details });
}

function rawDatabase(db) {
    if (!db?._raw?.transaction || !db._raw.prepare) {
        throw failure(503, 'Atomic hardware configuration storage is unavailable');
    }
    return db._raw;
}

function readContext(raw, deviceId) {
    if (!raw.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId)) {
        throw failure(404, 'Device not found');
    }
    const current = raw.prepare('SELECT * FROM device_hardware_configs WHERE device_id = ?').get(deviceId);
    const cached = raw.prepare('SELECT payload_json FROM device_status_cache WHERE device_id = ?').get(deviceId);
    const status = parseJson(cached?.payload_json);
    // Cached reports are diagnostic evidence only. They cannot establish an
    // authenticated enrollment or grant native transactional apply support.
    const manifest = status?.hardware?.driverManifest || status?.hardware?.driver_manifest || null;
    return { current, manifest, epoch: current?.enrollment_epoch || null };
}

function validateInContext(configuration, context) {
    const result = validateHardwareConfiguration(configuration, { manifest: context.manifest });
    return {
        ...result,
        applyEligible: false,
        warnings: [...result.warnings, {
            path: 'apply', code: 'native_apply_unavailable',
            message: 'Native transactional hardware apply and authenticated enrollment are not available; this is saved intent only'
        }]
    };
}

function validateConfiguration(db, deviceId, configuration) {
    const raw = rawDatabase(db);
    return raw.transaction(() => validateInContext(configuration, readContext(raw, deviceId)))();
}

function saveApplyIntent(db, { deviceId, configuration, expectedRevision, createdBy = null }) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw failure(400, 'expectedRevision must be a non-negative safe integer');
    }
    const raw = rawDatabase(db);
    // No await belongs in this transaction. BEGIN IMMEDIATE serializes both
    // another request in this process and writers using another connection.
    return raw.transaction(() => {
        const context = readContext(raw, deviceId);
        const currentRevision = context.current?.desired_revision ?? 0;
        if (expectedRevision !== currentRevision) {
            throw failure(409, 'Hardware configuration changed; reload before applying');
        }
        if (!Number.isSafeInteger(currentRevision) || currentRevision >= Number.MAX_SAFE_INTEGER) {
            throw failure(409, 'Hardware configuration revision is exhausted');
        }
        const result = validateInContext(configuration, context);
        if (!result.valid) throw failure(422, 'Hardware configuration is invalid', result.errors);
        const revision = currentRevision + 1;
        const actionId = `hw-${crypto.randomUUID()}`.slice(0, 31);
        const snapshot = JSON.stringify(result.configuration);
        raw.prepare(`INSERT INTO device_hardware_configs
            (device_id, desired_revision, desired_json, desired_hash, enrollment_epoch, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(device_id) DO UPDATE SET
              desired_revision=excluded.desired_revision, desired_json=excluded.desired_json,
              desired_hash=excluded.desired_hash, updated_at=CURRENT_TIMESTAMP`)
            .run(deviceId, revision, snapshot, result.configHash, context.epoch);
        raw.prepare(`INSERT INTO device_hardware_apply_jobs
            (action_id, device_id, enrollment_epoch, requested_revision, requested_hash,
             previous_hash, status, created_by, requested_config_json, catalog_version)
            VALUES (?, ?, ?, ?, ?, ?, 'blocked_driver', ?, ?, ?)`)
            .run(actionId, deviceId, context.epoch, revision, result.configHash,
                context.current?.desired_hash || null, createdBy, snapshot, result.catalogVersion);
        return {
            success: true, pending: false, actionId, revision, configHash: result.configHash,
            status: 'blocked_driver', readiness: 'configured_unverified', blocked: true,
            warnings: result.warnings
        };
    }).immediate();
}

module.exports = { parseJson, validateConfiguration, saveApplyIntent };
