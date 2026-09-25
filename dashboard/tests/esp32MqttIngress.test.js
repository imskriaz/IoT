'use strict';

// Source-contract gates, not a substitute for the primary agent's firmware
// build, broker-loss, command flood, fragmented publish and hardware tests.
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname,
    '../../firmware/espidf/esp32-s3-a7670e-idf6.1/components/mqtt_mgr/src/mqtt_mgr.c'), 'utf8');
const automationSource = fs.readFileSync(path.join(__dirname,
    '../../firmware/espidf/esp32-s3-a7670e-idf6.1/components/automation_bridge/src/automation_bridge.c'), 'utf8');
const modemSource = fs.readFileSync(path.join(__dirname,
    '../../firmware/espidf/esp32-s3-a7670e-idf6.1/components/modem_a7670/src/modem_a7670.c'), 'utf8');
const smsSource = fs.readFileSync(path.join(__dirname,
    '../../firmware/espidf/esp32-s3-a7670e-idf6.1/components/sms_service/src/sms_service.c'), 'utf8');

function body(name) {
    const signature = new RegExp(`(?:static\\s+)?(?:void|esp_err_t)\\s+${name}\\([^;]*?\\)\\s*\\{`, 's');
    const match = signature.exec(source);
    if (!match) throw new Error(`Missing function ${name}`);
    const start = match.index + match[0].length;
    let depth = 1;
    for (let i = start; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}' && --depth === 0) return source.slice(start, i);
    }
    throw new Error(`Unclosed function ${name}`);
}

describe('ESP32 MQTT ingress concurrency source contracts', () => {
    const callback = body('mqtt_event_handler');
    const worker = body('mqtt_mgr_process_esp_events');
    const dispatch = body('mqtt_mgr_process_esp_event_locked');

    test('IDF callback never waits for the manager lock or invokes a MQTT API', () => {
        expect(callback).not.toMatch(/xSemaphoreTake\s*\(/);
        expect(callback).not.toMatch(/esp_mqtt_client_\w+\s*\(/);
        expect(callback).not.toMatch(/automation_bridge_submit_mqtt_command\s*\(/);
        expect(callback).not.toMatch(/(?:calloc|malloc|heap_caps_\w+)\s*\(/);
        expect(callback).toContain('xQueueSend(s_ingress_queue, copy, 0)');
    });

    test('callback copies event-owned data and topic before waking the worker', () => {
        expect(callback).toContain('memcpy(copy->data, event->data, copy->length)');
        expect(callback).toContain('memcpy(copy->topic, event->topic, copy->topic_length)');
        expect(callback.indexOf('xQueueSend')).toBeLessThan(callback.indexOf('xTaskNotifyGive'));
        for (const event of ['CONNECTED', 'DISCONNECTED', 'ERROR', 'SUBSCRIBED', 'PUBLISHED', 'DATA']) {
            expect(callback).toContain(`MQTT_EVENT_${event}`);
        }
    });

    test('queue and assembly buffers are bounded and allocated off the MQTT callback stack', () => {
        expect(source).toMatch(/MQTT_MGR_INGRESS_DEPTH\s+16U/);
        expect(source).toMatch(/MQTT_MGR_INGRESS_PAYLOAD_LEN\s+\(CONFIG_UNIFIED_AUTOMATION_MESSAGE_LEN - 1U\)/);
        expect(body('mqtt_mgr_init')).toContain('xQueueCreateStatic');
        expect(body('mqtt_mgr_init')).toContain('MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT');
        expect(callback).toContain('&s_ingress->producer');
    });

    test('invalid sizes and negative offsets are rejected before any data copy', () => {
        for (const guard of ['event->data_len <= 0', 'event->total_data_len <= 0',
            'event->total_data_len > (int)MQTT_MGR_INGRESS_PAYLOAD_LEN',
            'event->current_data_offset < 0',
            'event->data_len > event->total_data_len - event->current_data_offset',
            'event->topic_len >= (int)sizeof(copy->topic)']) {
            expect(callback).toContain(guard);
        }
        expect(callback.indexOf('if (!copy->invalid)')).toBeLessThan(callback.indexOf('memcpy(copy->data'));
    });

    test('worker retains a dequeued pending event if manager lock is unavailable', () => {
        expect(worker).toContain('if (!s_ingress->have_pending)');
        const lockFailure = worker.slice(worker.indexOf('if (xSemaphoreTake'), worker.indexOf('unsigned overflow'));
        expect(lockFailure).toContain('return;');
        expect(lockFailure).not.toContain('have_pending = false');
        expect(worker.indexOf('mqtt_mgr_process_esp_event_locked')).toBeLessThan(
            worker.lastIndexOf('s_ingress->have_pending = false'));
    });

    test('overload is counted, degrades readiness, and requests a fresh session', () => {
        expect(callback).toContain('atomic_fetch_add(&s_ingress_overflow, 1U)');
        expect(worker).toContain('atomic_exchange(&s_ingress_overflow, 0U)');
        expect(worker).toContain('s_status.command_rejects += overflow');
        expect(worker).toContain('mqtt_ingress_queue_full');
        expect(worker).toContain('s_status.subscribed = false');
        expect(worker).toContain('mqtt_recovery_request(&s_esp_recovery');
        expect(worker).not.toContain('esp_mqtt_client_reconnect(s_client)');
    });

    test('stale client generations and stopped clients cannot mutate status', () => {
        expect(callback).toContain('copy->generation = (uint32_t)(uintptr_t)handler_args');
        expect(dispatch).toContain('event->generation != s_client_generation || !s_client_started');
        expect(body('mqtt_mgr_refresh_config_locked')).toContain('++s_client_generation');
    });

    test('fragment ordering, message identity, and exact full length gate one dispatch', () => {
        expect(dispatch).toContain('(size_t)event->offset != s_ingress->received');
        expect(dispatch).toContain('(size_t)event->total != s_ingress->total');
        expect(dispatch).toContain('event->msg_id != s_ingress->msg_id');
        expect(dispatch).toContain('if (s_ingress->received != s_ingress->total)');
        expect(dispatch.match(/automation_bridge_submit_mqtt_command\s*\(/g)).toHaveLength(1);
        expect(dispatch.match(/mqtt_mgr_process_result_ack\s*\(/g)).toHaveLength(1);
        const unlock = dispatch.indexOf('xSemaphoreGive(s_lock);');
        const ackDispatch = dispatch.indexOf('submit_err = mqtt_mgr_process_result_ack');
        const commandDispatch = dispatch.indexOf('submit_err = automation_bridge_submit_mqtt_command');
        const relock = dispatch.indexOf('xSemaphoreTake(s_lock, portMAX_DELAY);');
        expect(unlock).toBeGreaterThanOrEqual(0);
        expect(ackDispatch).toBeGreaterThan(unlock);
        expect(commandDispatch).toBeGreaterThan(ackDispatch);
        expect(relock).toBeGreaterThan(commandDispatch);
    });

    test('primary subscription acknowledgement gates readiness on the native contract', () => {
        expect(body('mqtt_mgr_subscribe_commands_locked')).not.toContain('s_status.subscribed = true');
        expect(body('mqtt_mgr_subscribe_topic_locked')).not.toContain('s_status.subscribed_count++');
        expect(dispatch).toContain('s_subscribe_acked[MQTT_SUBSCRIBE_PRIMARY_COMMAND]');
        expect(body('mqtt_mgr_subscribe_commands_locked')).toContain('subscribe_topic_locked("command/#")');
        expect(body('mqtt_mgr_subscribe_commands_locked')).not.toContain('cmd/#');
        expect(body('mqtt_mgr_ota_tick_locked')).toContain('mqtt_mgr_primary_subscription_ready_locked()');
        expect(dispatch).toContain('event->msg_id != s_subscribe_ids[index]');
        expect(dispatch).toContain('if (!s_subscribe_acked[index])');
        expect(callback).toContain('(unsigned char)event->data[index] > 2U');
        expect(dispatch).toContain('mqtt_suback_rejected');
        expect(dispatch).toContain('mqtt_suback_rejected');
        expect(dispatch).not.toContain('legacy cmd/# subscription rejected');
        const published = dispatch.indexOf('case MQTT_EVENT_PUBLISHED:');
        const correlated = dispatch.indexOf('event->msg_id == s_action_result_inflight_msg_id');
        expect(correlated).toBeGreaterThan(published);
        expect(dispatch).not.toContain('state_mgr_request_ota_validation()');
        const ack = body('mqtt_mgr_process_result_ack');
        expect(ack.indexOf('mqtt_mgr_ota_ack')).toBeGreaterThan(ack.indexOf('storage_mgr_result_ack'));
        expect(body('mqtt_mgr_ota_ack')).toContain('ota_validation_ack');
        expect(body('mqtt_mgr_ota_tick_locked')).toContain('s_ota_validation.acknowledged');
        expect(body('mqtt_mgr_ota_tick_locked')).toContain('state_mgr_request_ota_validation()');
        const durablePublisher = body('mqtt_mgr_publish_durable_result');
        expect(durablePublisher).toContain('&message_id');
        expect(durablePublisher).toContain('ota_validation_published');
        expect(durablePublisher).toContain('UNIFIED_ACTION_CMD_GET_STATUS');
        expect(durablePublisher).toContain('state_mgr_boot_id()');
        expect(source).not.toContain('ota_validation_observe');
        expect(source).not.toContain('ota_validation_puback');
        expect(source).not.toContain('s_ota_confirmation_msg_id');
        expect(source).not.toContain('esp_ota_mark_app_valid_cancel_rollback()');
    });

    test('modem RX admits only canonical command topics', () => {
        expect(modemSource).toContain('strstr(topic, "/command/") != NULL');
        expect(modemSource).not.toContain('strstr(topic, "/cmd/")');
        expect(modemSource).not.toContain('modem_a7670_mqtt_publish_legacy_locked');
    });

    test('native command parser requires one schema, device identity, and topic/command match', () => {
        expect(automationSource).toContain('cJSON_GetObjectItemCaseSensitive(root, "schema")');
        expect(automationSource).toContain('static const char *allowed_keys[]');
        expect(automationSource).toContain('if (!allowed)');
        expect(automationSource).not.toContain('ttlMs');
        expect(automationSource).not.toContain('expiry_ms');
        expect(automationSource).toContain('cJSON_GetObjectItemCaseSensitive(root, "device_id")');
        expect(automationSource).toContain('strcmp(node->valuestring, unified_action_command_name(command)) != 0');
        expect(automationSource).toContain('strcmp(command_name, unified_action_command_name(command)) == 0');
        expect(automationSource).not.toContain('normalized[index]');
        expect(automationSource).not.toContain('s_command_aliases');
        expect(automationSource).not.toContain('"connectionPolicy"');
        expect(automationSource).not.toContain('"loadBalancing"');
        expect(automationSource).not.toContain('"rawLine"');
        expect(automationSource).not.toContain('"sms_storage_index"');
        expect(automationSource).not.toContain('"sms_storage_id"');
        expect(automationSource).not.toContain('"delflag"');
        expect(automationSource).not.toContain('"scope"');
        expect(automationSource).toContain('automation_bridge_record_admission_rejection');
        expect(automationSource).toContain('api_bridge_record_external_response(&response, NULL)');
        expect(automationSource).toContain('Invalid or missing IDs are intentionally not reflected');
        expect(automationSource).toContain('automation_bridge_validate_envelope(root, item->topic, &topic_action)');
        expect(automationSource).toContain('automation_bridge_parse_command_metadata(item->topic, item->payload, &metadata)');
    });

    test('SUBACK timeout is wrap-safe and unsubscribed state is degraded', () => {
        expect(worker).toContain('mqtt_subscription_expired(s_suback_deadline_ms');
        expect(worker).toContain('mqtt_suback_timeout');
        expect(worker).toContain('mqtt_recovery_request(&s_esp_recovery');
        expect(body('mqtt_mgr_set_health_locked')).toContain('mqtt_command_subscription_pending');
    });

    test('OTA flash operations are owned by main_task, never status or MQTT workers', () => {
        const firmwareRoot = path.join(__dirname, '../../firmware/espidf/esp32-s3-a7670e-idf6.1');
        const status = fs.readFileSync(path.join(firmwareRoot,
            'components/device_status/src/device_status.c'), 'utf8');
        const main = fs.readFileSync(path.join(firmwareRoot, 'main/app_main.c'), 'utf8');
        const state = fs.readFileSync(path.join(firmwareRoot,
            'components/state_mgr/src/state_mgr.c'), 'utf8');
        expect(status).not.toMatch(/esp_ota_\w+\s*\(/);
        expect(source).not.toMatch(/esp_ota_\w+\s*\(/);
        expect(main).toContain('state_mgr_wait_for_ota_validation(UINT32_MAX)');
        expect(main).toContain('running->address != selected->address');
        expect(main).toContain('image_state != ESP_OTA_IMG_PENDING_VERIFY');
        expect(main).toContain('esp_ota_mark_app_valid_cancel_rollback()');
        expect(state).toContain('xTaskGetCurrentTaskHandle() != s_ota_executor');
        expect(state).toContain('ulTaskNotifyTake(pdTRUE, wait_ticks)');
    });

    test('result listener cannot drop terminal wakeups because of manager lock contention', () => {
        const listener = body('mqtt_mgr_handle_action_record');
        expect(listener).not.toMatch(/xSemaphoreTake\s*\(/);
        expect(listener).toContain('atomic_compare_exchange_weak');
        expect(listener).toContain('xTaskNotifyGive(mqtt_task_handle)');
        expect(body('mqtt_mgr_publish_recent_action_results')).toContain('atomic_load(&s_result_sequence_watermark)');
    });

    test('worker drains before transport maintenance and does not sleep over pending work', () => {
        const task = body('mqtt_mgr_task');
        expect(task.indexOf('mqtt_mgr_process_esp_events()')).toBeLessThan(task.indexOf('mqtt_mgr_get_loop_config'));
        expect(task).toContain('s_ingress->have_pending || uxQueueMessagesWaiting(s_ingress_queue) != 0U');
        expect(worker).toContain('count < MQTT_MGR_INGRESS_DEPTH');
    });

    test('modem publish receives buffer capacity, not pointer size', () => {
        expect(body('mqtt_mgr_publish_text_tracked')).toContain(
            'modem_a7670_mqtt_publish(topic, payload, 1, response, MQTT_MGR_MODEM_RESPONSE_LEN, 15000U)');
    });

    test('newer snapshots cannot suppress an older correlated terminal result', () => {
        expect(body('mqtt_mgr_publish_recent_action_results')).toContain(
            "s_action_records[index].response.action.correlation.correlation_id[0] == '\\0'");
    });

    test('OTA flash operations run from an internal SRAM worker stack', () => {
        const taskCreation = body('mqtt_mgr_init').slice(body('mqtt_mgr_init').indexOf('task_ok = xTaskCreatePinnedToCoreWithCaps'));
        expect(taskCreation).toContain('MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT');
        expect(taskCreation).not.toContain('MALLOC_CAP_SPIRAM');
    });

    test('firmware diagnostics do not print malformed command or modem response bodies', () => {
        expect(automationSource).not.toContain('error_at=%s');
        expect(automationSource).toContain('error_offset=%u');
        expect(smsSource).not.toContain('response=%s');
        expect(smsSource).toContain('response_len=%u');
    });
});
