'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../firmware/espidf/esp32-s3-a7670e-idf6.1/components');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const service = read('sms_service/src/sms_service.c');
const modem = read('modem_a7670/src/modem_a7670.c');
const sms = read('modem_a7670/src/modem_a7670_telephony.c');
const storageHeader = read('storage_mgr/include/storage_mgr.h');
const storage = read('storage_mgr/src/storage_mgr.c');
const deviceStatus = read('device_status/src/device_status.c');
test('both receive paths retain notifications until settlement', () => {
    expect(service).toContain('while (modem_a7670_peek_sms_index(&sms_index))');
    expect(sms).toContain('if (modem_a7670_peek_sms_index(&queued_sms_index))');
    expect(service + sms).not.toContain('modem_a7670_pop_sms_index(');
    expect(sms).toContain('if (err == ESP_OK && delete_flag == 0U) modem_a7670_drop_sms_indexes_locked');
});
test('retry is bounded and failed settlement cannot spin or count as synced', () => {
    expect(service).toContain('SMS_SERVICE_EVENT_MAX_ATTEMPTS    3U');
    expect(service).toContain('if (++retry_sms_attempts >= SMS_SERVICE_EVENT_MAX_ATTEMPTS)');
    expect(service).toContain('if (sms_retry_pending) break;');
    expect(service).toContain('if (!sms_retry_pending && !event_consumed');
    expect(service).toMatch(/pending_err = sms_service_settle_consumed[^;]+;\s+if \(pending_err != ESP_OK\) break;/);
    expect(service).toMatch(/err = sms_service_settle_consumed\(payload, "incoming_sms_pull"\);\s+sms_service_release_consume_lock\(\);\s+if \(err != ESP_OK\) break;\s+synced_count\+\+;/);
});
test('deferring only drops the notification and never deletes modem storage', () => {
    const body = modem.split('void modem_a7670_defer_sms_index(int index) {')[1].split('\n}')[0];
    expect(body).toContain('modem_a7670_drop_sms_indexes_locked(&index, 1U)');
    expect(body).not.toMatch(/CMGD|delete_sms/);
});
test('receive lane cannot modify durable message identity', () => {
    const body = service.split('static sms_emit_result_t sms_service_emit_incoming(')[1].split('static esp_err_t sms_service_settle_consumed')[0];
    expect(body).toContain('emitted.multipart_part_count > 1U ? "incoming_sms_part" : "incoming_sms"');
    expect(body).not.toContain('sizeof(emitted.detail), detail');
});
test('storage queue depth reports pending flush work, not retained history', () => {
    expect(storageHeader).toContain('uint32_t pending_flush_count;');
    expect(storage).toContain('s_status.pending_flush_count = (uint32_t)s_pending_count;');
    expect(deviceStatus).toContain('out_snapshot->storage_queue_depth = storage.pending_flush_count;');
    expect(deviceStatus).not.toContain('out_snapshot->storage_queue_depth = storage.record_count;');
});
