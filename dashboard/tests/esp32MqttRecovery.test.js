'use strict';

const fs = require('fs');
const path = require('path');

const firmwareRoot = path.resolve(__dirname, '../../firmware/espidf/esp32-s3-a7670e-idf6.1/components/mqtt_mgr/src');
const source = fs.readFileSync(path.join(firmwareRoot, 'mqtt_mgr.c'), 'utf8');

test('connected overflow and SUBACK timeout request worker-owned recovery', () => {
    const processing = source.split('static void mqtt_mgr_process_esp_events(void) {')[1]
        .split('static void mqtt_mgr_task(void *arg) {')[0];
    expect(processing).toMatch(/overflow != 0U[\s\S]+mqtt_recovery_request\(&s_esp_recovery/);
    expect(processing).toMatch(/mqtt_subscription_expired[\s\S]+mqtt_recovery_request\(&s_esp_recovery/);
    expect(processing).not.toContain('esp_mqtt_client_reconnect');
});

test('recovery serializes stop before start and retains failures for retry', () => {
    const loop = source.split('static void mqtt_mgr_task(void *arg) {')[1];
    expect(loop).toContain('mqtt_recovery_next(&s_esp_recovery');
    expect(loop).toMatch(/recovery_action == MQTT_RECOVERY_STOP[\s\S]+mqtt_mgr_stop_esp_client_for_recovery_locked\(\)[\s\S]+mqtt_mgr_start_esp_client_locked\(\)/);
    expect(loop).toContain('mqtt_recovery_result(');
    expect(loop).toMatch(/recovery_err == ESP_OK && recovery_action == MQTT_RECOVERY_STOP[\s\S]+s_status\.reconnect_count\+\+/);
    expect(loop).toContain('mqtt_recovery_stop_failed');
    expect(loop).toContain('mqtt_recovery_start_failed');
});

test('ESP recovery owns the ESP client and preserves modem transport', () => {
    const recoveryStop = source.split('static esp_err_t mqtt_mgr_stop_esp_client_for_recovery_locked(void) {')[1]
        .split('static esp_err_t mqtt_mgr_build_topic_locked')[0];
    expect(recoveryStop).toContain('esp_mqtt_client_stop(s_client)');
    expect(recoveryStop).toContain('if (s_transport == MQTT_MGR_TRANSPORT_ESP)');
    expect(recoveryStop).not.toContain('modem_a7670_mqtt_disconnect');
});

test('full stop handles a running ESP candidate before clearing its lifecycle', () => {
    const fullStop = source.split('static esp_err_t mqtt_mgr_stop_transport_locked(void) {')[1]
        .split('static esp_err_t mqtt_mgr_subscribe_topic_locked')[0];
    expect(fullStop.indexOf('esp_mqtt_client_stop(s_client)'))
        .toBeLessThan(fullStop.indexOf('s_client_started = false'));
    expect(fullStop.indexOf('s_client_started = false'))
        .toBeLessThan(fullStop.indexOf('modem_a7670_mqtt_disconnect'));
    const refresh = source.split('static esp_err_t mqtt_mgr_refresh_config_locked(void) {')[1]
        .split('static void mqtt_event_handler')[0];
    expect(refresh).toMatch(/stop_err = mqtt_mgr_stop_transport_locked\(\);[\s\S]+if \(stop_err != ESP_OK\) \{\s*return stop_err;/);
});

test('modem subscription retry is deadline/backoff gated', () => {
    expect(source).toContain('mqtt_failover_retry_due(');
    expect(source).toMatch(/s_modem_subscribe_failure_count\+\+[\s\S]+s_next_modem_subscribe_retry_ms/);
    expect(source).toContain('MQTT_MGR_MODEM_SUBSCRIBE_RETRY_MS');
});

test('late ESP SUBACK cannot resurrect a disconnected session', () => {
    expect(source).toContain('mqtt_suback_current_session(');
    expect(source).toMatch(/s_suback_deadline_ms = 0U;[\s\S]+memset\(s_subscribe_acked, 0, sizeof\(s_subscribe_acked\)\);[\s\S]+s_esp_recovery =/);
});

test('native command subscription arms a deadline', () => {
    expect(source).toContain('mqtt_subscription_due(');
    const subscribe = source.split('static esp_err_t mqtt_mgr_subscribe_commands_locked(void) {')[1]
        .split('static esp_err_t mqtt_mgr_subscribe_modem_command_topics_locked(void) {')[0];
    expect(subscribe).toMatch(/s_suback_deadline_ms = 0U;[\s\S]+subscribe_topic_locked\("command\/#"\)[\s\S]+s_suback_deadline_ms = mqtt_subscription_deadline\([\s\S]+MQTT_MGR_SUBACK_TIMEOUT_MS\)/);
    expect(subscribe).toMatch(/if \(mqtt_mgr_subscribe_topic_locked\("command\/#"\) != ESP_OK\) \{\s*return ESP_FAIL;/);
    expect(subscribe).not.toContain('cmd/#');
});
