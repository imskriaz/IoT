'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { OtaLifecycle, parseImage, prepare, validMetadata, isApplyResult } = require('../services/otaLifecycle');

function image(elfHex) {
    // One 256-byte app-description segment, checksum-aligned to 16 bytes,
    // followed by the ESP-IDF appended image digest.
    const buffer = Buffer.alloc(336, 0);
    buffer[0] = 0xe9;
    buffer[1] = 1;
    buffer[23] = 1;
    buffer.writeUInt16LE(9, 12);
    buffer.writeUInt32LE(256, 28);
    buffer.writeUInt32LE(0xabcd5432, 32);
    buffer.write('test-version', 48, 'ascii');
    Buffer.from(elfHex, 'hex').copy(buffer, 176);
    let checksum = 0xef;
    for (let index = 32; index < 288; index += 1) checksum ^= buffer[index];
    buffer[303] = checksum;
    crypto.createHash('sha256').update(buffer.subarray(0, 304)).digest().copy(buffer, 304);
    return buffer;
}

describe('OTA boot verification contract', () => {
    let file;
    const elf = crypto.createHash('sha256').update('candidate').digest('hex');

    beforeEach(() => {
        file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ota-contract-')), 'candidate.bin');
        fs.writeFileSync(file, image(elf));
    });

    afterEach(() => {
        try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch (_) {}
    });

    test('parses the ESP-IDF S3 image identity, version and file digest', () => {
        const parsed = parseImage(fs.readFileSync(file));
        expect(parsed.firmware_elf_sha256).toBe(elf);
        expect(parsed.version).toBe('test-version');
        expect(parsed.file_sha256).toHaveLength(64);
    });

    test('rejects segment corruption even when the ESP header and identity still look valid', () => {
        const corrupted = Buffer.from(fs.readFileSync(file));
        corrupted[96] ^= 0x01;
        expect(() => parseImage(corrupted)).toThrow(/checksum|digest/);
    });

    test('requires a fresh valid source boot and selects the opposite slot', () => {
        const boot = '0123456789abcdef';
        const snapshot = { online: true, lastStatusAt: new Date().toISOString(), lastStatus: {
            boot_id: boot, ota_slot: 'ota_0', ota_state: 'valid',
            firmware_elf_sha256: 'a'.repeat(64)
        } };
        const meta = prepare(file, 'candidate.bin', snapshot, 'admin');
        expect(meta.target_slot).toBe('ota_1');
        expect(meta.expected_elf_sha256).toBe(elf);
        expect(meta.source_boot_id).toBe(boot);
        expect(validMetadata(meta)).toBe(true);
    });

    test('fails closed for stale or identity-less status', () => {
        expect(() => prepare(file, 'candidate.bin', { online: false }, 'admin')).toThrow(/fresh validated/);
        expect(() => prepare(file, 'candidate.bin', {
            online: true, lastStatusAt: new Date().toISOString(), lastStatus: {
                boot_id: '0123456789abcdef', ota_slot: 'ota_0', ota_state: 'pending_verify'
            }
        }, 'admin')).toThrow(/fresh validated/);
    });

    test('only the rebooting apply response enters the asynchronous lifecycle', () => {
        expect(isApplyResult({ command: 'ota_update', detail: 'ota_update_applied_rebooting' })).toBe(true);
        expect(isApplyResult({ command: 'ota-update', detail: 'ota_update_applied_rebooting' })).toBe(true);
        expect(isApplyResult({ command: 'ota_update', result: 'completed' })).toBe(false);
        expect(isApplyResult({ command: 'ota_update', detail: 'ota_update_failed' })).toBe(false);
    });
});

describe('OTA durable two-boot lifecycle', () => {
    let raw;
    let service;
    let lifecycle;
    const expected = 'b'.repeat(64);
    const source = 'a'.repeat(64);
    const meta = {
        schema: 1, phase: 'queued', filename: 'candidate.bin', version: 'v2',
        expected_elf_sha256: expected, file_sha256: 'c'.repeat(64), file_size: 1234,
        source_boot_id: '1111111111111111', source_elf_sha256: source,
        source_slot: 'ota_0', target_slot: 'ota_1', flashed_by: 'admin'
    };

    beforeEach(() => {
        raw = new Database(':memory:');
        raw.exec(`CREATE TABLE device_command_queue (
            id INTEGER PRIMARY KEY, device_id TEXT, command TEXT, status TEXT,
            message_id TEXT, payload TEXT, published_at TEXT, response_payload TEXT,
            completed_at TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            next_attempt_at TEXT, last_error TEXT);
            CREATE TABLE device_ota_history (id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT, filename TEXT, firmware_version TEXT, file_size INTEGER,
            flashed_by TEXT, notes TEXT, flashed_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
        raw.prepare(`INSERT INTO device_command_queue
            (id,device_id,command,status,message_id,payload,published_at)
            VALUES (1,'device-a','ota-update','waiting_response','ota-1',?, '2026-09-19 00:00:00')`)
            .run(JSON.stringify({ url: 'https://example.test/fw', _ota: meta }));
        const asyncDb = {
            get: async (sql, params = []) => raw.prepare(sql).get(...params),
            all: async (sql, params = []) => raw.prepare(sql).all(...params),
            run: async (sql, params = []) => raw.prepare(sql).run(...params)
        };
        service = {
            _db: () => asyncDb,
            _rawDb: () => raw,
            _hasDbMethods: () => true,
            _sqlTimestamp: (at = Date.now()) => new Date(at).toISOString().slice(0, 19).replace('T', ' '),
            _updatePersistentQueueRow: async (id, fields) => {
                const entries = Object.entries(fields);
                raw.prepare(`UPDATE device_command_queue SET ${entries.map(([key]) => `${key}=?`).join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
                    .run(...entries.map(([, value]) => value), id);
            },
            _markPersistentQueueAmbiguous: async (row, error) => raw.prepare(
                `UPDATE device_command_queue SET status='ambiguous', last_error=?, next_attempt_at=NULL WHERE id=?`)
                .run(error.message, row.id),
            _resolvePersistentQueueWaiter: jest.fn(),
            _emitDeviceQueueState: jest.fn(),
            publishCommand: jest.fn().mockResolvedValue({ result: 'completed' })
        };
        lifecycle = new OtaLifecycle(service);
    });

    afterEach(() => raw.close());

    test('apply acknowledgement remains pending until exact new valid boot', async () => {
        await lifecycle.handleAction({ id: 1, device_id: 'device-a' }, {
            command: 'ota_update', result: 'accepted', detail: 'ota_update_applied_rebooting'
        });
        let row = raw.prepare('SELECT * FROM device_command_queue WHERE id=1').get();
        expect(row.status).toBe('waiting_response');
        expect(JSON.parse(row.payload)._ota.phase).toBe('awaiting_boot');
        expect(raw.prepare('SELECT COUNT(*) count FROM device_ota_history').get().count).toBe(0);

        await lifecycle.observeStatus('device-a', {
            boot_id: '2222222222222222', ota_slot: 'ota_1', ota_state: 'pending_verify',
            firmware_elf_sha256: expected
        }, { fresh: true, queryStartedAt: Date.parse('2026-09-19T00:01:00Z') });
        row = raw.prepare('SELECT * FROM device_command_queue WHERE id=1').get();
        expect(row.status).toBe('waiting_response');
        expect(JSON.parse(row.payload)._ota.phase).toBe('verifying');

        await lifecycle.observeStatus('device-a', {
            boot_id: '2222222222222222', ota_slot: 'ota_1', ota_state: 'valid',
            firmware_elf_sha256: expected
        }, { fresh: true, queryStartedAt: Date.parse('2026-09-19T00:01:01Z') });
        row = raw.prepare('SELECT * FROM device_command_queue WHERE id=1').get();
        expect(row.status).toBe('completed');
        expect(JSON.parse(row.response_payload).detail).toBe('ota_boot_verified');
        expect(raw.prepare('SELECT COUNT(*) count FROM device_ota_history').get().count).toBe(1);
    });

    test('retained/same-boot status cannot complete and rollback is explicit', async () => {
        await lifecycle.handleAction({ id: 1, device_id: 'device-a' }, {
            command: 'ota_update', result: 'accepted', detail: 'ota_update_applied_rebooting'
        });
        const evidence = { boot_id: '2222222222222222', ota_slot: 'ota_1', ota_state: 'valid', firmware_elf_sha256: expected };
        await lifecycle.observeStatus('device-a', evidence, { retained: true, fresh: true, queryStartedAt: Date.now() });
        expect(raw.prepare('SELECT status FROM device_command_queue WHERE id=1').get().status).toBe('waiting_response');
        await lifecycle.observeStatus('device-a', { ...evidence, boot_id: meta.source_boot_id },
            { fresh: true, queryStartedAt: Date.parse('2026-09-19T00:01:00Z') });
        expect(raw.prepare('SELECT status FROM device_command_queue WHERE id=1').get().status).toBe('waiting_response');
        await lifecycle.observeStatus('device-a', {
            boot_id: '3333333333333333', ota_slot: meta.source_slot, ota_state: 'valid', firmware_elf_sha256: source
        }, { fresh: true, queryStartedAt: Date.parse('2026-09-19T00:01:00Z') });
        const row = raw.prepare('SELECT status,last_error FROM device_command_queue WHERE id=1').get();
        expect(row).toEqual({ status: 'failed', last_error: 'ota_rolled_back' });
        expect(raw.prepare('SELECT COUNT(*) count FROM device_ota_history').get().count).toBe(0);
    });

    test('post-reboot uncertainty remains reconcilable', async () => {
        await lifecycle.handleAction({ id: 1, device_id: 'device-a' }, {
            command: 'ota_update', result: 'failed', detail: 'action_outcome_uncertain_after_reboot'
        });
        expect(raw.prepare('SELECT status FROM device_command_queue WHERE id=1').get().status).toBe('ambiguous');
        await lifecycle.observeStatus('device-a', {
            boot_id: '2222222222222222', ota_slot: 'ota_1', ota_state: 'valid', firmware_elf_sha256: expected
        }, { fresh: true, queryStartedAt: Date.parse('2026-09-19T00:01:00Z') });
        expect(raw.prepare('SELECT status FROM device_command_queue WHERE id=1').get().status).toBe('completed');
    });

    test('status hint requests a real device probe rather than cached compatibility status', async () => {
        lifecycle.probe('device-a');
        await new Promise(resolve => setImmediate(resolve));
        expect(service.publishCommand).toHaveBeenCalledWith('device-a', 'get-status', {}, true, 15000,
            expect.objectContaining({ source: 'ota-verification', bypassCompatibility: true }));
    });

    test('rejects a second open OTA with a stable conflict code', async () => {
        await expect(lifecycle.enqueue('device-a', { _ota: meta }, 300000, {}))
            .rejects.toMatchObject({ code: 'OTA_ALREADY_PENDING' });
        expect(service.publishCommand).not.toHaveBeenCalled();
    });
});
