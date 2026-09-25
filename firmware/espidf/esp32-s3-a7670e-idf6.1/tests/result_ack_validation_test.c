#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "cJSON.h"
#include "unified_json_text.h"
#include "envelope_limits.h"
#define UNIFIED_DEVICE_ID_LEN CONFIG_MGR_DEVICE_ID_LEN
#define ESP_OK 0
#define ESP_ERR_INVALID_ARG 258
#define ESP_ERR_NOT_FOUND 261
typedef int esp_err_t;
typedef enum { UNIFIED_ACTION_CMD_NONE, UNIFIED_ACTION_CMD_GET_STATUS,
    UNIFIED_ACTION_CMD_WIFI_PROFILES_APPLY } unified_action_command_t;
static const char s_client_id[] = "device-a";
static uint32_t s_next_durable_result_retry_ms;
static int ack_calls;
static int expected_command;
static int ota_ack_calls;
static void mqtt_mgr_ota_ack(const char *action_id, unified_action_command_t command) {
    (void)action_id;
    (void)command;
    ++ota_ack_calls;
}
static bool mqtt_mgr_is_result_ack_topic(const char *topic) {
    return strcmp(topic, "device/device-a/command/action-result-ack") == 0;
}
static const char *unified_action_command_name(unified_action_command_t command) {
    static const char *names[] = { "none", "get_status", "wifi_profiles_apply" };
    return names[command];
}
static esp_err_t storage_mgr_result_ack(const char *device, const char *action,
                                       unified_action_command_t command) {
    ++ack_calls;
    return strcmp(device, "device-a") == 0 && strcmp(action, "rejected-1") == 0 &&
        (int)command == expected_command ? ESP_OK : ESP_ERR_NOT_FOUND;
}
#include "result_ack_production.h"
static void check(const char *device, const char *action, const char *command,
                  esp_err_t expected, int calls) {
    char json[512];
    snprintf(json, sizeof(json), "{\"schema_version\":1,\"device_id\":\"%s\",\"action_id\":\"%s\",\"command\":\"%s\"}", device, action, command);
    ack_calls = 0;
    ota_ack_calls = 0;
    s_next_durable_result_retry_ms = 9000;
    assert(mqtt_mgr_process_result_ack("device/device-a/command/action-result-ack", json) == expected);
    assert(ack_calls == calls);
    assert(ota_ack_calls == (expected == ESP_OK ? 1 : 0));
    assert(s_next_durable_result_retry_ms == (expected == ESP_OK ? 0U : 9000U));
}
int main(void) {
    expected_command = UNIFIED_ACTION_CMD_NONE;
    check("device-a", "rejected-1", "none", ESP_OK, 1);
    check("device-a", "wrong-action", "none", ESP_ERR_NOT_FOUND, 1);
    check("device-b", "rejected-1", "none", ESP_ERR_INVALID_ARG, 0);
    check("device-a", "", "none", ESP_ERR_INVALID_ARG, 0);
    check("device-a", "rejected-1", "unknown", ESP_ERR_INVALID_ARG, 0);
    check("device-a", "rejected-1", "get_status", ESP_ERR_NOT_FOUND, 1);
    expected_command = UNIFIED_ACTION_CMD_GET_STATUS;
    check("device-a", "rejected-1", "get_status", ESP_OK, 1);
    check("device-a", "rejected-1", "get-status", ESP_ERR_INVALID_ARG, 0);
    check("device-a\\u0000other", "rejected-1", "get_status", ESP_ERR_INVALID_ARG, 0);
    check("device-a", "rejected-1\\u0000other", "get_status", ESP_ERR_INVALID_ARG, 0);
    check("device-a", "rejected-1", "get_status\\u0000other", ESP_ERR_INVALID_ARG, 0);
    expected_command = UNIFIED_ACTION_CMD_WIFI_PROFILES_APPLY;
    check("device-a", "rejected-1", "wifi_profiles_apply", ESP_OK, 1);
    assert(mqtt_mgr_process_result_ack("wrong-topic", "{}") == ESP_ERR_INVALID_ARG);
    assert(mqtt_mgr_process_result_ack("device/device-a/command/action-result-ack", "{} trailing") == ESP_ERR_INVALID_ARG);
    const char *invalid[] = {
        "{\"schema_version\":1,\"device_id\":\"device-a\",\"action_id\":\"rejected-1\",\"command\":\"none\",\"command\":\"get_status\"}",
        "{\"schema_version\":1,\"device_id\":\"device-a\",\"action_id\":\"rejected-1\",\"command\":\"none\",\"extra\":true}",
        "{\"schema_version\":1,\"device_id\":\"device-a\",\"action_id\":\"rejected-1\"}",
        "{\"schema_version\\u0000other\":1,\"device_id\":\"device-a\",\"action_id\":\"rejected-1\",\"command\":\"wifi_profiles_apply\"}"
    };
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
        ack_calls = ota_ack_calls = 0;
        assert(mqtt_mgr_process_result_ack("device/device-a/command/action-result-ack", invalid[i]) == ESP_ERR_INVALID_ARG);
        assert(ack_calls == 0 && ota_ack_calls == 0);
    }
    puts("production result ACK: rejected NONE, correlation, canonical names, NUL aliases, retry release PASS");
    return 0;
}
