#include "api_bridge.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_system.h"
#include "esp_wifi.h"

#include "board_bsp.h"
#include "config_mgr.h"
#include "device_status.h"
#include "health_monitor.h"
#include "modem_a7670.h"
#include "sms_service.h"
#include "status_watch.h"
#include "storage_mgr.h"
#include "unified_runtime.h"
#include "wifi_mgr.h"

static const char *TAG = "api_bridge";

enum {
    API_BRIDGE_WIFI_SCAN_MAX_RESULTS = 12,
    API_BRIDGE_OTA_MIN_TIMEOUT_MS = 180000,
    API_BRIDGE_OTA_DEFAULT_TIMEOUT_MS = 300000,
    API_BRIDGE_OTA_RESTART_DELAY_MS = 1500,
};

typedef struct {
    unified_service_runtime_t runtime;
    uint32_t executed_count;
    uint32_t rejected_count;
    uint32_t failed_count;
    uint32_t timeout_count;
    uint32_t mqtt_publish_failures;
    unified_action_response_t last_response;
    char last_payload[CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN];
} api_bridge_status_t;

typedef struct {
    wifi_mgr_scan_result_t results[API_BRIDGE_WIFI_SCAN_MAX_RESULTS];
    wifi_mgr_scan_request_t request;
    wifi_mgr_scan_report_t report;
    char escaped_ssid[(sizeof(((wifi_mgr_scan_result_t *)0)->ssid) * 2U)];
    char escaped_auth[32];
} api_bridge_wifi_scan_scratch_t;

static SemaphoreHandle_t s_lock;
static SemaphoreHandle_t s_wifi_scan_lock;
static api_bridge_status_t s_status;
static api_bridge_action_record_t s_recent_records[CONFIG_UNIFIED_API_BRIDGE_HISTORY_DEPTH];
static size_t s_recent_head;
static size_t s_recent_count;
static uint32_t s_recent_sequence;
static api_bridge_result_listener_t s_result_listener;
static api_bridge_wifi_scan_scratch_t *s_wifi_scan_scratch;
static bool s_ready;

static api_bridge_action_record_t *api_bridge_alloc_record_snapshot(void) {
    api_bridge_action_record_t *record = heap_caps_malloc(
        sizeof(api_bridge_action_record_t),
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
    );

    if (!record) {
        record = heap_caps_malloc(
            sizeof(api_bridge_action_record_t),
            MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT
        );
    }

    return record;
}

static void api_bridge_free_record_snapshot(api_bridge_action_record_t *record) {
    if (record) {
        heap_caps_free(record);
    }
}

static void api_bridge_set_health_locked(const char *detail) {
    s_status.runtime.running = true;
    s_status.runtime.state = UNIFIED_MODULE_STATE_RUNNING;
    (void)health_monitor_set_module_state("api_bridge", HEALTH_MODULE_STATE_OK, detail ? detail : "running");
}

static void api_bridge_mark_activity_locked(const char *detail) {
    api_bridge_set_health_locked(detail ? detail : "running");
}

static void api_bridge_fill_identity(unified_action_envelope_t *action) {
    board_bsp_identity_t identity = {0};
    char device_id_override[CONFIG_MGR_DEVICE_ID_LEN] = {0};
    uint32_t now_ms = 0U;

    if (!action) {
        return;
    }

    board_bsp_get_identity(&identity);
    config_mgr_get_device_id_override(device_id_override, sizeof(device_id_override));

    if (action->correlation.device_id[0] == '\0') {
        snprintf(
            action->correlation.device_id,
            sizeof(action->correlation.device_id),
            "%s",
            device_id_override[0] ? device_id_override : identity.device_id
        );
    }
    if (action->correlation.correlation_id[0] == '\0' || action->correlation.created_ms == 0U) {
        now_ms = unified_tick_now_ms();
    }
    if (action->correlation.correlation_id[0] == '\0') {
        snprintf(
            action->correlation.correlation_id,
            sizeof(action->correlation.correlation_id),
            "%s-%" PRIu32,
            unified_action_command_name(action->command),
            now_ms
        );
    }
    if (action->correlation.created_ms == 0U) {
        action->correlation.created_ms = now_ms;
    }
}

static unified_action_response_t api_bridge_build_response(
    const unified_action_envelope_t *action,
    unified_action_result_t result,
    int32_t result_code,
    unified_feature_reason_t feature_reason,
    const char *detail
) {
    unified_action_response_t response = {0};

    if (action) {
        response.action = *action;
    }
    response.result = result;
    response.result_code = result_code;
    response.feature_reason = feature_reason;
    unified_copy_cstr(response.detail, sizeof(response.detail), detail);
    return response;
}

static void api_bridge_escape_json(const char *input, char *output, size_t output_len) {
    const char *cursor = input ? input : "";
    size_t write_index = 0;

    if (!output || output_len == 0) {
        return;
    }

    while (*cursor != '\0' && write_index + 1U < output_len) {
        char current = *cursor++;

        if ((current == '\\' || current == '"') && write_index + 2U < output_len) {
            output[write_index++] = '\\';
            output[write_index++] = current;
        } else if (current == '\n' && write_index + 2U < output_len) {
            output[write_index++] = '\\';
            output[write_index++] = 'n';
        } else if (current == '\r' && write_index + 2U < output_len) {
            output[write_index++] = '\\';
            output[write_index++] = 'r';
        } else if ((unsigned char)current >= 0x20U) {
            output[write_index++] = current;
        }
    }
    output[write_index] = '\0';
}

static bool api_bridge_ota_url_supported(const char *url) {
    return url &&
           (strncmp(url, "http://", 7) == 0 || strncmp(url, "https://", 8) == 0);
}

static uint32_t api_bridge_ota_timeout_ms(const unified_action_envelope_t *action) {
    const uint32_t requested_timeout_ms = action && action->timeout_ms > 0U
        ? action->timeout_ms
        : API_BRIDGE_OTA_DEFAULT_TIMEOUT_MS;

    return requested_timeout_ms < API_BRIDGE_OTA_MIN_TIMEOUT_MS
        ? API_BRIDGE_OTA_MIN_TIMEOUT_MS
        : requested_timeout_ms;
}

static void api_bridge_delayed_restart_task(void *arg) {
    const uint32_t delay_ms = (uint32_t)(uintptr_t)arg;

    vTaskDelay(pdMS_TO_TICKS(delay_ms));
    esp_restart();
}

static void api_bridge_schedule_restart(uint32_t delay_ms) {
    BaseType_t task_ok = xTaskCreate(
        api_bridge_delayed_restart_task,
        "ota_restart",
        CONFIG_UNIFIED_TASK_STACK_SMALL,
        (void *)(uintptr_t)delay_ms,
        3,
        NULL
    );

    if (task_ok != pdPASS) {
        ESP_LOGW(TAG, "failed to schedule OTA restart; restarting inline");
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
        esp_restart();
    }
}

static unified_action_response_t api_bridge_execute_config_set(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    bool restart_required = false;
    bool sensitive = false;
    esp_err_t err = ESP_OK;
    char escaped_key[CONFIG_UNIFIED_API_BRIDGE_CONFIG_KEY_LEN * 2U] = {0};
    char escaped_value[CONFIG_UNIFIED_API_BRIDGE_CONFIG_VALUE_LEN * 2U] = {0};

    if (!request || request->key[0] == '\0' || !payload || payload_len == 0U) {
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_REJECTED, ESP_ERR_INVALID_ARG, UNIFIED_FEATURE_REASON_NONE, "invalid_config_request");
    }

    err = config_mgr_apply_key_value(request->key, request->value, &restart_required, &sensitive);
    if (err == ESP_ERR_NOT_SUPPORTED) {
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_REJECTED, err, UNIFIED_FEATURE_REASON_NONE, "unsupported_config_key");
    }
    if (err != ESP_OK) {
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_REJECTED, err, UNIFIED_FEATURE_REASON_NONE, "invalid_config_value");
    }

    api_bridge_escape_json(request->key, escaped_key, sizeof(escaped_key));
    api_bridge_escape_json(sensitive ? "<redacted>" : request->value, escaped_value, sizeof(escaped_value));
    if (snprintf(
            payload,
            payload_len,
            "{\"key\":\"%s\",\"value\":\"%s\",\"restart_required\":%s}",
            escaped_key,
            escaped_value,
            restart_required ? "true" : "false"
        ) >= (int)payload_len) {
        payload[0] = '\0';
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_FAILED, ESP_ERR_INVALID_SIZE, UNIFIED_FEATURE_REASON_NONE, "config_payload_failed");
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        restart_required ? "config_set_restart_required" : "config_set_completed"
    );
}

static unified_action_response_t api_bridge_execute_get_status(
    const unified_action_envelope_t *action,
    char *payload,
    size_t payload_len
) {
    device_status_snapshot_t snapshot;
    esp_err_t err = ESP_OK;

    if (!payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "invalid_status_request"
        );
    }

    err = device_status_snapshot(&snapshot);
    if (err == ESP_OK) {
        err = device_status_build_json_from_snapshot(&snapshot, payload, payload_len);
    }
    if (err != ESP_OK) {
        payload[0] = '\0';
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            "status_payload_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "status_snapshot"
    );
}

static unified_action_response_t api_bridge_execute_get_sms_history(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    uint16_t max_entries = request ? request->max_entries : 0U;
    esp_err_t err = ESP_OK;

    if (!payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "invalid_sms_history_request"
        );
    }

    err = storage_mgr_build_sms_history_json(payload, payload_len, max_entries);
    if (err != ESP_OK) {
        payload[0] = '\0';
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            "sms_history_payload_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "sms_history_snapshot"
    );
}

static unified_action_response_t api_bridge_execute_wifi_reconnect(
    const unified_action_envelope_t *action,
    char *payload,
    size_t payload_len
) {
    wifi_mgr_status_t wifi = {0};
    char escaped_ssid[sizeof(wifi.ssid) * 2U] = {0};
    esp_err_t err = ESP_OK;

    if (!payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "invalid_wifi_reconnect_request"
        );
    }

    wifi_mgr_get_status(&wifi);
    if (!wifi.configured) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_STATE,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_not_configured"
        );
    }

    err = wifi_mgr_request_connect();
    if (err != ESP_OK) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_reconnect_failed"
        );
    }

    api_bridge_escape_json(wifi.ssid, escaped_ssid, sizeof(escaped_ssid));
    if (snprintf(
            payload,
            payload_len,
            "{\"ssid\":\"%s\",\"configured\":%s,\"started\":%s,\"connected\":%s}",
            escaped_ssid,
            wifi.configured ? "true" : "false",
            wifi.started ? "true" : "false",
            wifi.connected ? "true" : "false"
        ) >= (int)payload_len) {
        payload[0] = '\0';
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_SIZE,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_reconnect_payload_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "wifi_reconnect_requested"
    );
}

static unified_action_response_t api_bridge_execute_wifi_toggle(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    wifi_mgr_status_t wifi = {0};
    modem_a7670_status_t modem = {0};
    char escaped_ssid[sizeof(wifi.ssid) * 2U] = {0};
    esp_err_t err = ESP_OK;

    if (!request || !request->enabled_present || !payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "invalid_wifi_toggle_request"
        );
    }

    wifi_mgr_get_status(&wifi);
    if (!wifi.configured) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_STATE,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_not_configured"
        );
    }

    modem_a7670_get_status(&modem);
    if (!request->enabled &&
        !(modem.data_mode_enabled && (modem.data_session_open || modem.ip_bearer_ready || modem.data_ip_address[0] != '\0'))) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_STATE,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_disable_requires_mobile_data"
        );
    }

    err = wifi_mgr_set_enabled(request->enabled);
    if (err != ESP_OK) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            request->enabled ? "wifi_enable_failed" : "wifi_disable_failed"
        );
    }

    wifi_mgr_get_status(&wifi);
    api_bridge_escape_json(wifi.ssid, escaped_ssid, sizeof(escaped_ssid));
    if (snprintf(
            payload,
            payload_len,
            "{\"ssid\":\"%s\",\"configured\":%s,\"started\":%s,\"connected\":%s,\"reconnect_suppressed\":%s}",
            escaped_ssid,
            wifi.configured ? "true" : "false",
            wifi.started ? "true" : "false",
            wifi.connected ? "true" : "false",
            wifi.reconnect_suppressed ? "true" : "false"
        ) >= (int)payload_len) {
        payload[0] = '\0';
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_SIZE,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_toggle_payload_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        request->enabled ? "wifi_enabled" : "wifi_disabled"
    );
}

static unified_action_response_t api_bridge_execute_wifi_disconnect(
    const unified_action_envelope_t *action,
    char *payload,
    size_t payload_len
) {
    wifi_mgr_status_t wifi = {0};
    char escaped_ssid[sizeof(wifi.ssid) * 2U] = {0};
    esp_err_t err = ESP_OK;

    if (!payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "invalid_wifi_disconnect_request"
        );
    }

    wifi_mgr_get_status(&wifi);
    if (!wifi.configured) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_STATE,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_not_configured"
        );
    }

    err = wifi_mgr_disconnect(true);
    if (err != ESP_OK) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_disconnect_failed"
        );
    }

    api_bridge_escape_json(wifi.ssid, escaped_ssid, sizeof(escaped_ssid));
    if (snprintf(
            payload,
            payload_len,
            "{\"ssid\":\"%s\",\"configured\":%s,\"started\":%s,\"connected\":%s,\"reconnect_suppressed\":true}",
            escaped_ssid,
            wifi.configured ? "true" : "false",
            wifi.started ? "true" : "false",
            wifi.connected ? "true" : "false"
        ) >= (int)payload_len) {
        payload[0] = '\0';
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_SIZE,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_disconnect_payload_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "wifi_disconnect_requested"
    );
}

static unified_action_response_t api_bridge_execute_mobile_toggle(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    modem_a7670_status_t modem = {0};
    char response[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    esp_err_t err = ESP_OK;

    if (!request || !request->enabled_present || !payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "invalid_mobile_toggle_request"
        );
    }

    modem_a7670_get_status(&modem);
    if (!modem.runtime.running || !modem.sim_ready) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_STATE,
            UNIFIED_FEATURE_REASON_NONE,
            "modem_not_ready"
        );
    }

    if (!request->enabled) {
        wifi_mgr_status_t wifi = {0};
        wifi_mgr_get_status(&wifi);
        if (!(wifi.connected || wifi.ip_assigned)) {
            return api_bridge_build_response(
                action,
                UNIFIED_ACTION_RESULT_REJECTED,
                ESP_ERR_INVALID_STATE,
                UNIFIED_FEATURE_REASON_NONE,
                "mobile_disable_requires_wifi"
            );
        }
    }

    if (request->enabled) {
        err = modem_a7670_open_data_session(response, sizeof(response), action && action->timeout_ms ? action->timeout_ms : 15000U);
    } else {
        err = modem_a7670_close_data_session(response, sizeof(response), action && action->timeout_ms ? action->timeout_ms : 15000U);
    }

    if (err != ESP_OK) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            request->enabled ? "mobile_enable_failed" : "mobile_disable_failed"
        );
    }

    modem_a7670_get_status(&modem);
    if (snprintf(
            payload,
            payload_len,
            "{\"enabled\":%s,\"connected\":%s,\"ip_address\":\"%s\",\"network_registered\":%s}",
            modem.data_mode_enabled ? "true" : "false",
            (modem.data_session_open || modem.ip_bearer_ready || modem.data_ip_address[0] != '\0') ? "true" : "false",
            modem.data_ip_address,
            modem.network_registered ? "true" : "false"
        ) >= (int)payload_len) {
        payload[0] = '\0';
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_SIZE,
            UNIFIED_FEATURE_REASON_NONE,
            "mobile_toggle_payload_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        request->enabled ? "mobile_enabled" : "mobile_disabled"
    );
}

static bool api_bridge_wifi_scan_retryable(esp_err_t err) {
    return err == ESP_ERR_INVALID_STATE || err == ESP_ERR_TIMEOUT || err == ESP_ERR_WIFI_STATE;
}

static esp_err_t api_bridge_run_wifi_scan_with_retry(
    const wifi_mgr_scan_request_t *request,
    wifi_mgr_scan_result_t *results,
    size_t max_results,
    size_t *out_count,
    wifi_mgr_scan_report_t *out_report
) {
    enum {
        WIFI_SCAN_BUSY_RETRY_COUNT = 24,
        WIFI_SCAN_BUSY_RETRY_DELAY_MS = 250,
    };
    esp_err_t err = ESP_OK;

    for (uint8_t attempt = 0U; attempt < WIFI_SCAN_BUSY_RETRY_COUNT; ++attempt) {
        err = wifi_mgr_scan_networks(request, results, max_results, out_count, out_report);
        if (!api_bridge_wifi_scan_retryable(err)) {
            return err;
        }
        vTaskDelay(pdMS_TO_TICKS(WIFI_SCAN_BUSY_RETRY_DELAY_MS));
    }

    return err;
}

static unified_action_response_t api_bridge_execute_wifi_scan(
    const unified_action_envelope_t *action,
    char *payload,
    size_t payload_len
) {
    api_bridge_wifi_scan_scratch_t *scratch = s_wifi_scan_scratch;
    unified_action_response_t response = {0};
    size_t result_count = 0U;
    size_t used = 0U;
    esp_err_t err = ESP_OK;

    if (!payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "invalid_wifi_scan_request"
        );
    }

    if (!scratch || !s_wifi_scan_lock) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_NO_MEM,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_scan_scratch_unavailable"
        );
    }

    if (xSemaphoreTake(s_wifi_scan_lock, pdMS_TO_TICKS(250)) != pdTRUE) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_TIMEOUT,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_scan_busy"
        );
    }

    memset(scratch, 0, sizeof(*scratch));
    scratch->request.mode = WIFI_MGR_SCAN_MODE_ACTIVE;
    scratch->request.channel = 0U;
    scratch->request.dwell_time_ms = 160U;

    err = api_bridge_run_wifi_scan_with_retry(
        &scratch->request,
        scratch->results,
        API_BRIDGE_WIFI_SCAN_MAX_RESULTS,
        &result_count,
        &scratch->report
    );
    if (err == ESP_OK && result_count == 0U) {
        scratch->request.mode = WIFI_MGR_SCAN_MODE_PASSIVE;
        scratch->request.dwell_time_ms = 260U;
        err = api_bridge_run_wifi_scan_with_retry(
            &scratch->request,
            scratch->results,
            API_BRIDGE_WIFI_SCAN_MAX_RESULTS,
            &result_count,
            &scratch->report
        );
    }
    if (err != ESP_OK) {
        response = api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            api_bridge_wifi_scan_retryable(err) ? "wifi_scan_busy" : "wifi_scan_failed"
        );
        goto done;
    }

    used = (size_t)snprintf(
        payload,
        payload_len,
        "{\"networks\":["
    );
    if (used >= payload_len) {
        payload[0] = '\0';
        response = api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_SIZE,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_scan_payload_failed"
        );
        goto done;
    }

    for (size_t index = 0U; index < result_count; ++index) {
        int written = 0;

        scratch->escaped_ssid[0] = '\0';
        scratch->escaped_auth[0] = '\0';
        api_bridge_escape_json(
            scratch->results[index].ssid[0] != '\0' ? scratch->results[index].ssid : "Hidden Network",
            scratch->escaped_ssid,
            sizeof(scratch->escaped_ssid)
        );
        api_bridge_escape_json(
            wifi_mgr_auth_mode_name(scratch->results[index].authmode),
            scratch->escaped_auth,
            sizeof(scratch->escaped_auth)
        );
        written = snprintf(
            payload + used,
            payload_len - used,
            "%s{\"ssid\":\"%s\",\"rssi\":%d,\"channel\":%u,\"encryption\":\"%s\"}",
            index == 0U ? "" : ",",
            scratch->escaped_ssid,
            (int)scratch->results[index].rssi,
            (unsigned int)scratch->results[index].primary_channel,
            scratch->escaped_auth
        );
        if (written < 0 || (size_t)written >= (payload_len - used)) {
            payload[0] = '\0';
            response = api_bridge_build_response(
                action,
                UNIFIED_ACTION_RESULT_FAILED,
                ESP_ERR_INVALID_SIZE,
                UNIFIED_FEATURE_REASON_NONE,
                "wifi_scan_payload_failed"
            );
            goto done;
        }
        used += (size_t)written;
    }

    if (snprintf(
            payload + used,
            payload_len - used,
            "],\"report\":{\"total_visible\":%u,\"elapsed_ms\":%" PRIu32 ",\"mode\":\"%s\",\"channel\":%u}}",
            (unsigned int)scratch->report.total_visible,
            scratch->report.elapsed_ms,
            wifi_mgr_scan_mode_name(scratch->report.mode),
            (unsigned int)scratch->report.channel
        ) >= (int)(payload_len - used)) {
        payload[0] = '\0';
        response = api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_SIZE,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_scan_payload_failed"
        );
        goto done;
    }

    response = api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "wifi_scan_completed"
    );

done:
    xSemaphoreGive(s_wifi_scan_lock);
    return response;
}

static unified_action_response_t api_bridge_execute_mobile_apn(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    modem_a7670_status_t modem = {0};
    bool restart_required = false;
    bool sensitive = false;
    bool reopen_session = false;
    char modem_apn[CONFIG_MGR_APN_LEN] = {0};
    esp_err_t err = ESP_OK;
    char escaped_apn[128] = {0};
    char escaped_auth[32] = {0};

    if (!request || request->apn[0] == '\0' || !payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "invalid_mobile_apn_request"
        );
    }

    modem_a7670_get_status(&modem);
    reopen_session = modem.data_mode_enabled;

    err = config_mgr_apply_key_value("modem_apn", request->apn, &restart_required, &sensitive);
    if (err != ESP_OK) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            err == ESP_ERR_NOT_SUPPORTED ? "unsupported_apn_config" : "invalid_apn_value"
        );
    }

    if (reopen_session) {
        char response[UNIFIED_TEXT_MEDIUM_LEN] = {0};
        err = modem_a7670_close_data_session(response, sizeof(response), action && action->timeout_ms ? action->timeout_ms : 15000U);
        if (err == ESP_OK) {
            err = modem_a7670_open_data_session(response, sizeof(response), action && action->timeout_ms ? action->timeout_ms : 15000U);
        }
        if (err != ESP_OK) {
            return api_bridge_build_response(
                action,
                UNIFIED_ACTION_RESULT_FAILED,
                err,
                UNIFIED_FEATURE_REASON_NONE,
                "mobile_apn_reconnect_failed"
            );
        }
    }

    config_mgr_get_modem_apn(modem_apn, sizeof(modem_apn));
    api_bridge_escape_json(modem_apn, escaped_apn, sizeof(escaped_apn));
    api_bridge_escape_json(request->auth[0] != '\0' ? request->auth : "none", escaped_auth, sizeof(escaped_auth));
    if (snprintf(
            payload,
            payload_len,
            "{\"apn\":\"%s\",\"username\":\"\",\"password_set\":false,\"auth\":\"%s\",\"reopen_session\":%s,\"restart_required\":%s}",
            escaped_apn,
            escaped_auth,
            reopen_session ? "true" : "false",
            restart_required ? "true" : "false"
        ) >= (int)payload_len) {
        payload[0] = '\0';
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_SIZE,
            UNIFIED_FEATURE_REASON_NONE,
            "mobile_apn_payload_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        reopen_session ? "mobile_apn_updated_runtime" : "mobile_apn_updated"
    );
}

static unified_action_response_t api_bridge_execute_send_ussd(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    char response[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    char escaped_code[UNIFIED_TEXT_SHORT_LEN * 2U] = {0};
    char escaped_response[UNIFIED_TEXT_MEDIUM_LEN * 2U] = {0};
    const uint32_t timeout_ms = action && action->timeout_ms ? action->timeout_ms : 15000U;
    esp_err_t err = ESP_OK;

    if (!request || request->code[0] == '\0') {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "ussd_code_required"
        );
    }

    err = modem_a7670_send_ussd(request->code, response, sizeof(response), timeout_ms);
    api_bridge_escape_json(request->code, escaped_code, sizeof(escaped_code));
    api_bridge_escape_json(response, escaped_response, sizeof(escaped_response));
    if (payload && payload_len > 0U) {
        (void)snprintf(
            payload,
            payload_len,
            "{\"code\":\"%s\",\"response\":\"%s\"}",
            escaped_code,
            escaped_response
        );
    }

    if (err != ESP_OK) {
        return api_bridge_build_response(
            action,
            err == ESP_ERR_TIMEOUT ? UNIFIED_ACTION_RESULT_TIMEOUT : UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            "ussd_request_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "ussd_requested"
    );
}

static unified_action_response_t api_bridge_execute_cancel_ussd(
    const unified_action_envelope_t *action,
    char *payload,
    size_t payload_len
) {
    char response[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    char escaped_response[UNIFIED_TEXT_MEDIUM_LEN * 2U] = {0};
    const uint32_t timeout_ms = action && action->timeout_ms ? action->timeout_ms : 15000U;
    esp_err_t err = modem_a7670_cancel_ussd(response, sizeof(response), timeout_ms);

    api_bridge_escape_json(response, escaped_response, sizeof(escaped_response));
    if (payload && payload_len > 0U) {
        (void)snprintf(payload, payload_len, "{\"response\":\"%s\"}", escaped_response);
    }

    if (err != ESP_OK) {
        return api_bridge_build_response(
            action,
            err == ESP_ERR_TIMEOUT ? UNIFIED_ACTION_RESULT_TIMEOUT : UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            "ussd_cancel_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "ussd_cancelled"
    );
}

static unified_action_response_t api_bridge_execute_routing_configure(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    bool restart_required = false;
    bool sensitive = false;
    bool failover = false;
    esp_err_t err = ESP_OK;

    if (!request || !payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "invalid_routing_config_request"
        );
    }

    if ((request->load_balancing_present && request->load_balancing) ||
        (request->nat_present && request->nat) ||
        (request->firewall_present && request->firewall)) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_NOT_SUPPORTED,
            UNIFIED_FEATURE_REASON_NONE,
            "routing_option_not_supported"
        );
    }

    failover = config_mgr_modem_fallback_enabled();

    if (request->failover_present && request->failover != failover) {
        err = config_mgr_apply_key_value(
            "modem_fallback_enabled",
            request->failover ? "true" : "false",
            &restart_required,
            &sensitive
        );
        if (err != ESP_OK) {
            payload[0] = '\0';
            return api_bridge_build_response(
                action,
                UNIFIED_ACTION_RESULT_FAILED,
                err,
                UNIFIED_FEATURE_REASON_NONE,
                "routing_failover_config_failed"
            );
        }
        failover = request->failover;
    }

    if (snprintf(
            payload,
            payload_len,
            "{\"failover\":%s,\"load_balancing\":false,\"nat\":false,\"firewall\":false,\"restart_required\":%s}",
            failover ? "true" : "false",
            restart_required ? "true" : "false"
        ) >= (int)payload_len) {
        payload[0] = '\0';
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_SIZE,
            UNIFIED_FEATURE_REASON_NONE,
            "routing_config_payload_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "routing_configured"
    );
}

static unified_action_response_t api_bridge_execute_status_watch(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    status_watch_policy_t policy = {0};
    bool active = request ? request->enabled : true;
    esp_err_t err = status_watch_update(
        active,
        request ? request->ttl_ms : 0U,
        request ? request->interval_ms : 0U
    );

    status_watch_get_policy(&policy);
    if (payload && payload_len > 0U) {
        snprintf(
            payload,
            payload_len,
            "{\"active\":%s,\"ttl_ms\":%" PRIu32 ",\"interval_ms\":%" PRIu32 ",\"idle_interval_ms\":%" PRIu32 "}",
            policy.active ? "true" : "false",
            policy.ttl_ms,
            policy.active_interval_ms,
            policy.idle_interval_ms
        );
    }

    if (err != ESP_OK) {
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_FAILED, err, UNIFIED_FEATURE_REASON_NONE, "status_watch_failed");
    }

    return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_COMPLETED, ESP_OK, UNIFIED_FEATURE_REASON_NONE, "status_watch_updated");
}

static unified_action_response_t api_bridge_execute_ota_update(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    unified_action_envelope_t effective_action = {0};
    esp_http_client_config_t http_config = {0};
    esp_https_ota_config_t ota_config = {0};
    esp_err_t err = ESP_FAIL;
    const uint32_t timeout_ms = api_bridge_ota_timeout_ms(action);
    char escaped_url[CONFIG_UNIFIED_API_BRIDGE_URL_LEN * 2U] = {0};

    if (!request || !api_bridge_ota_url_supported(request->url)) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "invalid_ota_url"
        );
    }

    if (action) {
        effective_action = *action;
        effective_action.timeout_ms = timeout_ms;
    }

    ESP_LOGI(TAG, "OTA update starting url=%s timeout_ms=%" PRIu32, request->url, timeout_ms);

    http_config.url = request->url;
    http_config.timeout_ms = (int)timeout_ms;
    http_config.keep_alive_enable = true;
    http_config.crt_bundle_attach = esp_crt_bundle_attach;

    ota_config.http_config = &http_config;

    err = esp_https_ota(&ota_config);
    if (payload && payload_len > 0U) {
        api_bridge_escape_json(request->url, escaped_url, sizeof(escaped_url));
        if (snprintf(
                payload,
                payload_len,
                "{\"url\":\"%s\",\"restart\":%s}",
                escaped_url,
                err == ESP_OK ? "true" : "false") >= (int)payload_len) {
            payload[0] = '\0';
        }
    }

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "OTA update failed err=%s", esp_err_to_name(err));
        return api_bridge_build_response(
            action ? &effective_action : action,
            err == ESP_ERR_TIMEOUT ? UNIFIED_ACTION_RESULT_TIMEOUT : UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            "ota_update_failed"
        );
    }

    ESP_LOGI(TAG, "OTA update applied; reboot scheduled");
    api_bridge_schedule_restart(API_BRIDGE_OTA_RESTART_DELAY_MS);
    return api_bridge_build_response(
        action ? &effective_action : action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "ota_update_applied_rebooting"
    );
}

static unified_action_response_t api_bridge_execute_send_sms(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    unified_action_response_t response = {0};
    sms_service_send_options_t send_options = {0};
    bool force_multipart = false;
    const bool has_dashboard_pdu = request && request->sms_pdu[0] != '\0';

    if (request) {
        if (request->sms_parts > 1U) {
            force_multipart = true;
        } else if (request->sms_multipart_present) {
            force_multipart = request->sms_multipart;
        } else if (action && action->command == UNIFIED_ACTION_CMD_SEND_SMS_MULTIPART) {
            force_multipart = true;
        }
    } else if (action && action->command == UNIFIED_ACTION_CMD_SEND_SMS_MULTIPART) {
        force_multipart = true;
    }

    send_options.force_multipart = force_multipart;
    if (request) {
        send_options.expected_parts = request->sms_parts;
        if (has_dashboard_pdu) {
            send_options.pdu_hex = request->sms_pdu;
            send_options.pdu_length = request->sms_pdu_length;
        }
        if (request->sms_transport_encoding[0] != '\0') {
            send_options.use_ucs2_present = true;
            send_options.use_ucs2 = strcmp(request->sms_transport_encoding, "ucs2") == 0 ||
                strcmp(request->sms_transport_encoding, "UCS2") == 0;
        } else if (request->sms_encoding[0] != '\0') {
            send_options.use_ucs2_present = true;
            send_options.use_ucs2 = strcmp(request->sms_encoding, "unicode") == 0 ||
                strcmp(request->sms_encoding, "UNICODE") == 0;
        }
    }

    response = sms_service_send_with_options(
        request ? request->number : NULL,
        request ? request->text : NULL,
        action ? action->timeout_ms : 0U,
        &send_options
    );
    if (action) {
        response.action = *action;
    }

    if (payload && payload_len > 0U) {
        payload[0] = '\0';
    }

    return response;
}

static unified_action_response_t api_bridge_dispatch_action(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    unified_action_response_t response = {0};

    if (payload && payload_len > 0U) {
        payload[0] = '\0';
    }

    switch (action->command) {
        case UNIFIED_ACTION_CMD_GET_STATUS:
            return api_bridge_execute_get_status(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_GET_SMS_HISTORY:
            return api_bridge_execute_get_sms_history(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_CONFIG_SET:
            return api_bridge_execute_config_set(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_WIFI_RECONNECT:
            return api_bridge_execute_wifi_reconnect(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_WIFI_TOGGLE:
            return api_bridge_execute_wifi_toggle(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_WIFI_DISCONNECT:
            return api_bridge_execute_wifi_disconnect(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_WIFI_SCAN:
            return api_bridge_execute_wifi_scan(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_MOBILE_TOGGLE:
            return api_bridge_execute_mobile_toggle(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_MOBILE_APN:
            return api_bridge_execute_mobile_apn(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_ROUTING_CONFIGURE:
            return api_bridge_execute_routing_configure(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_STATUS_WATCH:
            return api_bridge_execute_status_watch(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_OTA_UPDATE:
            return api_bridge_execute_ota_update(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_SEND_SMS:
        case UNIFIED_ACTION_CMD_SEND_SMS_MULTIPART:
            return api_bridge_execute_send_sms(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_SEND_USSD:
            return api_bridge_execute_send_ussd(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_CANCEL_USSD:
            return api_bridge_execute_cancel_ussd(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_REBOOT_DEVICE:
            response = api_bridge_build_response(action, UNIFIED_ACTION_RESULT_ACCEPTED, ESP_OK, UNIFIED_FEATURE_REASON_NONE, "reboot_scheduled");
            vTaskDelay(pdMS_TO_TICKS(250));
            esp_restart();
            return response;
        case UNIFIED_ACTION_CMD_NONE:
            return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_REJECTED, ESP_ERR_INVALID_ARG, UNIFIED_FEATURE_REASON_NONE, "invalid_action_command");
        default:
            return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_REJECTED, ESP_ERR_NOT_SUPPORTED, UNIFIED_FEATURE_REASON_NONE, "unsupported_action_command");
    }
}

static void api_bridge_record_response_locked(
    const unified_action_response_t *response,
    const char *payload,
    api_bridge_action_record_t *out_record
) {
    api_bridge_action_record_t *record = NULL;

    if (!response) {
        return;
    }

    s_status.executed_count++;
    if (response->result == UNIFIED_ACTION_RESULT_REJECTED) {
        s_status.rejected_count++;
    } else if (response->result == UNIFIED_ACTION_RESULT_FAILED) {
        s_status.failed_count++;
    } else if (response->result == UNIFIED_ACTION_RESULT_TIMEOUT) {
        s_status.timeout_count++;
    }

    s_status.last_response = *response;
    unified_copy_cstr(s_status.last_payload, sizeof(s_status.last_payload), payload);

    s_recent_sequence++;
    if (s_recent_sequence == 0U) {
        s_recent_sequence = 1U;
    }

    record = &s_recent_records[s_recent_head];
    record->sequence = s_recent_sequence;
    record->response = *response;
    unified_copy_cstr(record->payload, sizeof(record->payload), payload);
    if (out_record) {
        *out_record = *record;
    }

    s_recent_head = (s_recent_head + 1U) % CONFIG_UNIFIED_API_BRIDGE_HISTORY_DEPTH;
    if (s_recent_count < CONFIG_UNIFIED_API_BRIDGE_HISTORY_DEPTH) {
        s_recent_count++;
    }

    if (response->result == UNIFIED_ACTION_RESULT_COMPLETED || response->result == UNIFIED_ACTION_RESULT_ACCEPTED) {
        s_status.runtime.last_error = ESP_OK;
        s_status.runtime.last_error_text[0] = '\0';
    } else {
        s_status.runtime.last_error = response->result_code;
        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", response->detail);
    }
}

esp_err_t api_bridge_init(void) {
    if (s_ready) {
        return ESP_OK;
    }

    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) {
        return ESP_ERR_NO_MEM;
    }
    s_wifi_scan_lock = xSemaphoreCreateMutex();
    if (!s_wifi_scan_lock) {
        return ESP_ERR_NO_MEM;
    }

    s_wifi_scan_scratch = heap_caps_calloc(
        1U,
        sizeof(*s_wifi_scan_scratch),
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
    );
    if (!s_wifi_scan_scratch) {
        s_wifi_scan_scratch = heap_caps_calloc(
            1U,
            sizeof(*s_wifi_scan_scratch),
            MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT
        );
    }
    if (!s_wifi_scan_scratch) {
        return ESP_ERR_NO_MEM;
    }

    memset(&s_status, 0, sizeof(s_status));
    memset(s_recent_records, 0, sizeof(s_recent_records));
    s_status.runtime.initialized = true;
    s_status.runtime.state = UNIFIED_MODULE_STATE_INITIALIZED;
    ESP_ERROR_CHECK(health_monitor_register_module("api_bridge"));
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        api_bridge_mark_activity_locked("ready");
        xSemaphoreGive(s_lock);
    }

    s_ready = true;
    ESP_LOGI(TAG, "ready history=%d payload=%d", CONFIG_UNIFIED_API_BRIDGE_HISTORY_DEPTH, CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN);
    return ESP_OK;
}

esp_err_t api_bridge_execute_action(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    unified_action_response_t *out_response,
    char *out_payload,
    size_t out_payload_len
) {
    unified_action_envelope_t normalized_action = {0};
    unified_action_response_t response = {0};
    api_bridge_action_record_t *record_snapshot = NULL;
    api_bridge_result_listener_t listener = NULL;

    if (!s_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!action || !out_response || !out_payload || out_payload_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    normalized_action = *action;
    api_bridge_fill_identity(&normalized_action);
    out_payload[0] = '\0';
    response = api_bridge_dispatch_action(&normalized_action, request, out_payload, out_payload_len);
    record_snapshot = api_bridge_alloc_record_snapshot();

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        api_bridge_free_record_snapshot(record_snapshot);
        return ESP_ERR_TIMEOUT;
    }
    api_bridge_record_response_locked(&response, out_payload, record_snapshot);
    listener = s_result_listener;
    api_bridge_mark_activity_locked(unified_action_command_name(response.action.command));
    xSemaphoreGive(s_lock);

    *out_response = response;
    if (listener && record_snapshot && record_snapshot->sequence != 0U) {
        listener(record_snapshot);
    }
    api_bridge_free_record_snapshot(record_snapshot);
    return ESP_OK;
}

esp_err_t api_bridge_record_external_response(
    const unified_action_response_t *response,
    const char *payload
) {
    unified_action_response_t normalized_response = {0};
    api_bridge_action_record_t *record_snapshot = NULL;
    api_bridge_result_listener_t listener = NULL;

    if (!s_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!response) {
        return ESP_ERR_INVALID_ARG;
    }

    normalized_response = *response;
    api_bridge_fill_identity(&normalized_response.action);
    record_snapshot = api_bridge_alloc_record_snapshot();

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        api_bridge_free_record_snapshot(record_snapshot);
        return ESP_ERR_TIMEOUT;
    }
    api_bridge_record_response_locked(&normalized_response, payload, record_snapshot);
    listener = s_result_listener;
    api_bridge_mark_activity_locked(unified_action_command_name(normalized_response.action.command));
    xSemaphoreGive(s_lock);

    if (listener && record_snapshot && record_snapshot->sequence != 0U) {
        listener(record_snapshot);
    }
    api_bridge_free_record_snapshot(record_snapshot);
    return ESP_OK;
}

esp_err_t api_bridge_set_result_listener(api_bridge_result_listener_t listener) {
    s_result_listener = listener;
    return ESP_OK;
}

size_t api_bridge_snapshot_recent_records(api_bridge_action_record_t *out_entries, size_t max_entries) {
    size_t copy_count = 0;
    size_t start = 0;

    if (!out_entries || max_entries == 0U || !s_lock) {
        return 0;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return 0;
    }

    copy_count = s_recent_count < max_entries ? s_recent_count : max_entries;
    start = (s_recent_head + CONFIG_UNIFIED_API_BRIDGE_HISTORY_DEPTH - copy_count) % CONFIG_UNIFIED_API_BRIDGE_HISTORY_DEPTH;
    for (size_t index = 0; index < copy_count; ++index) {
        out_entries[index] = s_recent_records[(start + index) % CONFIG_UNIFIED_API_BRIDGE_HISTORY_DEPTH];
    }
    xSemaphoreGive(s_lock);
    return copy_count;
}
