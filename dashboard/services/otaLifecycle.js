'use strict';

// OTA command completion spans two boots. Keep its evidence in the durable
// queue payload so a dashboard restart never turns an apply into a success.
const fs = require('fs');
const crypto = require('crypto');
const HASH = /^[a-f0-9]{64}$/;
const OPEN = ['waiting_response', 'ambiguous'];

function parseImage(buffer) {
    // ESP-IDF: esp_image_header_t (24), first segment header (8),
    // esp_app_desc_t (256). app_elf_sha256 is descriptor offset 144.
    if (!Buffer.isBuffer(buffer) || buffer.length < 288 || buffer[0] !== 0xe9 ||
        buffer[1] < 1 || buffer[1] > 16 || buffer.readUInt16LE(12) !== 9 ||
        buffer.readUInt32LE(28) < 256 || buffer.readUInt32LE(28) > buffer.length - 32 ||
        buffer.readUInt32LE(32) !== 0xabcd5432) {
        throw new Error('Firmware must be an ESP32-S3 ESP-IDF application image');
    }

    // Validate every declared segment and the ESP image checksum. Requiring the
    // appended SHA-256 prevents a truncated or header-spoofed file from entering
    // the durable OTA queue and failing only after the device starts downloading.
    let offset = 24;
    let checksum = 0xef;
    for (let segment = 0; segment < buffer[1]; segment += 1) {
        if (offset > buffer.length - 8) {
            throw new Error('Firmware image has a truncated segment header');
        }
        const dataLength = buffer.readUInt32LE(offset + 4);
        offset += 8;
        if (dataLength === 0 || dataLength > buffer.length - offset) {
            throw new Error('Firmware image has an invalid segment length');
        }
        const end = offset + dataLength;
        for (let index = offset; index < end; index += 1) checksum ^= buffer[index];
        offset = end;
    }
    const checksumOffset = Math.ceil((offset + 1) / 16) * 16 - 1;
    if (checksumOffset >= buffer.length || buffer[checksumOffset] !== checksum) {
        throw new Error('Firmware image checksum is invalid');
    }
    for (let index = offset; index < checksumOffset; index += 1) {
        if (buffer[index] !== 0) throw new Error('Firmware image padding is invalid');
    }
    if (buffer[23] !== 1 || checksumOffset + 33 !== buffer.length) {
        throw new Error('Firmware image must contain one appended SHA-256 digest');
    }
    const storedDigest = buffer.subarray(checksumOffset + 1);
    const calculatedDigest = crypto.createHash('sha256')
        .update(buffer.subarray(0, checksumOffset + 1)).digest();
    if (!crypto.timingSafeEqual(storedDigest, calculatedDigest)) {
        throw new Error('Firmware image SHA-256 digest is invalid');
    }
    const elf = buffer.subarray(176, 208).toString('hex');
    if (/^(0{64}|f{64})$/.test(elf)) throw new Error('Firmware image has no ELF identity');
    return {
        firmware_elf_sha256: elf,
        version: buffer.subarray(48, 80).toString('utf8').split('\0')[0],
        file_sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        file_size: buffer.length
    };
}

function metadata(row) {
    try { return JSON.parse(row.payload || '{}')._ota || null; } catch (_) { return null; }
}

function validMetadata(meta) {
    return meta?.schema === 1 && HASH.test(meta.expected_elf_sha256 || '') &&
        HASH.test(meta.source_elf_sha256 || '') && /^[a-f0-9]{16}$/i.test(meta.source_boot_id || '') &&
        ['ota_0', 'ota_1'].includes(meta.source_slot) && ['ota_0', 'ota_1'].includes(meta.target_slot) &&
        meta.source_slot !== meta.target_slot;
}

function isApplyResult(data) {
    return String(data?.command || '').replace(/-/g, '_') === 'ota_update' &&
        data?.detail === 'ota_update_applied_rebooting';
}

function prepare(filePath, filename, snapshot, actor, rollback = false) {
    const status = snapshot?.lastStatus;
    if (!snapshot?.online || !status || Date.now() - Date.parse(snapshot.lastStatusAt || '') > 90000 ||
        !Number.isFinite(Date.parse(snapshot.lastStatusAt || '')) ||
        !HASH.test(status.firmware_elf_sha256 || '') || !/^[a-f0-9]{16}$/i.test(status.boot_id || '') ||
        !['ota_0', 'ota_1'].includes(status.ota_slot) || status.ota_state !== 'valid') {
        throw new Error('A fresh validated device boot with firmware identity is required before OTA');
    }
    const image = parseImage(fs.readFileSync(filePath));
    return {
        schema: 1, phase: 'queued', filename, version: image.version,
        expected_elf_sha256: image.firmware_elf_sha256, file_sha256: image.file_sha256,
        file_size: image.file_size, source_boot_id: status.boot_id,
        source_elf_sha256: status.firmware_elf_sha256, source_slot: status.ota_slot,
        target_slot: status.ota_slot === 'ota_0' ? 'ota_1' : 'ota_0',
        flashed_by: String(actor || 'admin') + (rollback ? ' (rollback)' : '')
    };
}

class OtaLifecycle {
    constructor(service) {
        this.service = service;
        this.work = new Map();
        this.probes = new Map();
    }

    serial(deviceId, task) {
        const previous = this.work.get(deviceId) || Promise.resolve();
        const next = previous.catch(() => {}).then(task);
        this.work.set(deviceId, next);
        next.finally(() => { if (this.work.get(deviceId) === next) this.work.delete(deviceId); }).catch(() => {});
        return next;
    }

    emit(deviceId, event, data) {
        global.io?.to(`device:${deviceId}`).emit(event, { deviceId, ...data });
    }

    enqueue(deviceId, payload, timeout, options) {
        return this.serial(deviceId, async () => {
            const db = this.service._db();
            const existing = await db.get(`SELECT id FROM device_command_queue WHERE device_id = ?
                AND command = 'ota-update' AND status IN ('pending', 'dispatching', 'waiting_response', 'ambiguous') LIMIT 1`, [deviceId]);
            if (existing) {
                const error = new Error('An OTA update is already pending or needs boot verification');
                error.code = 'OTA_ALREADY_PENDING';
                throw error;
            }
            return this.service.publishCommand(deviceId, 'ota-update', payload, false, timeout, options);
        });
    }

    async handleAction(row, data) {
        return this.serial(row.device_id, async () => {
            const svc = this.service;
            row = await svc._db().get('SELECT * FROM device_command_queue WHERE id = ?', [row.id]);
            if (!row || !OPEN.includes(row.status)) return false;
            const meta = metadata(row);
            if (data.detail === 'action_outcome_uncertain_after_reboot') {
                await svc._markPersistentQueueAmbiguous(row, new Error('OTA execution crossed a reboot; awaiting image verification'));
                return true;
            }
            if (isApplyResult(data)) {
                if (!validMetadata(meta)) {
                    await svc._markPersistentQueueAmbiguous(row, new Error('OTA applied; image/boot proof was not recorded'));
                    return true;
                }
                const payload = JSON.parse(row.payload);
                payload._ota = { ...meta, phase: 'awaiting_boot', applied_at: new Date().toISOString() };
                await svc._updatePersistentQueueRow(row.id, {
                    status: 'waiting_response', payload: JSON.stringify(payload),
                    response_payload: JSON.stringify(data), completed_at: null,
                    next_attempt_at: svc._sqlTimestamp(Date.now() + 120000),
                    last_error: null
                });
                this.emit(row.device_id, 'ota:progress', { queueId: row.id, stage: 'rebooting', percent: 95 });
                await svc._emitDeviceQueueState(row.device_id);
                return true;
            }
            // Legacy producers may say completed before boot validation. An
            // action result alone can never establish the running image.
            if (String(data.result || '').toLowerCase() === 'completed') {
                await svc._markPersistentQueueAmbiguous(row, new Error('OTA result received without validated boot proof'));
                return true;
            }
            if (['failed', 'rejected', 'timeout', 'error'].includes(String(data.result || '').toLowerCase())) {
                await svc._updatePersistentQueueRow(row.id, { status: 'failed', response_payload: JSON.stringify(data),
                    completed_at: svc._sqlTimestamp(), next_attempt_at: null,
                    last_error: data.detail || data.error || 'OTA command failed' });
                const failed = await svc._db().get('SELECT * FROM device_command_queue WHERE id = ?', [row.id]);
                await svc._resolvePersistentQueueWaiter(failed);
                await svc._emitDeviceQueueState(row.device_id);
                this.emit(row.device_id, 'ota:error', { queueId: row.id, message: failed.last_error, response: data });
                return true;
            }
            return false;
        });
    }

    async observeStatus(deviceId, status, options = {}) {
        if (options.retained || !status?.boot_id) return;
        return this.serial(deviceId, async () => {
            const svc = this.service;
            const db = svc._db();
            if (!svc._hasDbMethods(db, ['all'])) return;
            const rows = await db.all(`SELECT * FROM device_command_queue
                WHERE device_id = ? AND command = 'ota-update'
                AND status IN ('waiting_response', 'ambiguous') AND published_at IS NOT NULL`, [deviceId]);
            for (const row of rows) {
                const meta = metadata(row);
                if (!validMetadata(meta) || status.boot_id === meta.source_boot_id) continue;
                // Only a command issued after this OTA publish can prove the
                // live boot; retained or delayed telemetry is merely a hint.
                const published = Date.parse(String(row.published_at).replace(' ', 'T') + 'Z');
                const fresh = options.fresh === true && Number(options.queryStartedAt) >= published;
                if (!fresh) {
                    this.probe(deviceId);
                    continue;
                }
                const actual = String(status.firmware_elf_sha256 || '').toLowerCase();
                if (!HASH.test(actual) || !['ota_0', 'ota_1'].includes(status.ota_slot)) continue;
                const expected = actual === meta.expected_elf_sha256 && status.ota_slot === meta.target_slot;
                if (expected && status.ota_state === 'valid') {
                    await this.finish(row, meta, status, null);
                } else if (expected && status.ota_state === 'pending_verify') {
                    const payload = JSON.parse(row.payload);
                    payload._ota = { ...meta, phase: 'verifying', candidate_boot_id: status.boot_id };
                    await svc._updatePersistentQueueRow(row.id, { payload: JSON.stringify(payload) });
                    this.emit(deviceId, 'ota:progress', { queueId: row.id, stage: 'verifying', percent: 98 });
                } else if (['awaiting_boot', 'verifying'].includes(meta.phase)) {
                    const rolledBack = actual === meta.source_elf_sha256 && status.ota_slot === meta.source_slot;
                    await this.finish(row, meta, status, rolledBack ? 'ota_rolled_back' : 'ota_unexpected_image_or_state');
                }
            }
        });
    }

    probe(deviceId) {
        const current = this.probes.get(deviceId);
        if (current?.active || Date.now() - (current?.at || 0) < 5000) return;
        const probe = { active: true, at: Date.now() };
        this.probes.set(deviceId, probe);
        // Do not await under the per-device mutation lock: the response itself
        // passes through observeStatus before this promise settles.
        this.service.publishCommand(deviceId, 'get-status', {}, true, 15000,
            { background: true, source: 'ota-verification', skipPersistentQueue: true,
                bypassCompatibility: true })
            .catch(() => {})
            .finally(() => { probe.active = false; });
    }

    async finish(row, meta, status, error) {
        const svc = this.service;
        const raw = svc._rawDb(svc._db());
        if (!raw?.transaction) throw new Error('Atomic OTA evidence persistence is unavailable');
        const result = {
            success: !error, result: error ? 'failed' : 'completed', command: 'ota_update',
            action_id: row.message_id, detail: error || 'ota_boot_verified',
            payload: { boot_id: status.boot_id, ota_slot: status.ota_slot,
                ota_state: status.ota_state, firmware_elf_sha256: status.firmware_elf_sha256 }
        };
        const saved = raw.transaction(() => {
            const update = raw.prepare(`UPDATE device_command_queue SET status = ?, response_payload = ?,
                completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, next_attempt_at = NULL,
                last_error = ? WHERE id = ? AND status IN ('waiting_response', 'ambiguous')`)
                .run(error ? 'failed' : 'completed', JSON.stringify(result), error, row.id);
            if (!update.changes) return false;
            if (!error) {
                raw.prepare(`INSERT INTO device_ota_history
                    (device_id, filename, firmware_version, file_size, flashed_by, notes) VALUES (?, ?, ?, ?, ?, ?)`)
                    .run(row.device_id, meta.filename, meta.version, meta.file_size, meta.flashed_by,
                        JSON.stringify({ queue_id: row.id, firmware_elf_sha256: meta.expected_elf_sha256,
                            file_sha256: meta.file_sha256, boot_id: status.boot_id, ota_slot: status.ota_slot }));
                raw.prepare(`DELETE FROM device_ota_history WHERE device_id = ? AND id NOT IN
                    (SELECT id FROM device_ota_history WHERE device_id = ? ORDER BY flashed_at DESC, id DESC LIMIT 10)`)
                    .run(row.device_id, row.device_id);
            }
            return true;
        })();
        if (!saved) return;
        const completed = await svc._db().get('SELECT * FROM device_command_queue WHERE id = ?', [row.id]);
        await svc._resolvePersistentQueueWaiter(completed);
        await svc._emitDeviceQueueState(row.device_id);
        this.emit(row.device_id, error ? 'ota:error' : 'ota:complete', {
            queueId: row.id, filename: meta.filename, version: meta.version,
            message: error || 'New firmware boot verified', response: result
        });
    }
}

module.exports = { OtaLifecycle, parseImage, prepare, metadata, validMetadata, isApplyResult };
