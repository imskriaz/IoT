#include "api_bridge.h"

#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "driver/gpio.h"

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
    API_BRIDGE_ASYNC_TRANSITION_MAX = 2,
    API_BRIDGE_WIFI_TRANSITION_DEFAULT_TIMEOUT_MS = 20000,
    API_BRIDGE_WIFI_TRANSITION_MIN_TIMEOUT_MS = 5000,
    API_BRIDGE_WIFI_TRANSITION_MAX_TIMEOUT_MS = 60000,
    API_BRIDGE_OTA_MIN_TIMEOUT_MS = 180000,
    API_BRIDGE_OTA_DEFAULT_TIMEOUT_MS = 300000,
    API_BRIDGE_OTA_RESTART_DELAY_MS = 1500,
    API_BRIDGE_MODEM_RESTART_DEFAULT_TIMEOUT_MS = 45000,
    API_BRIDGE_GPIO_DIAGNOSTIC_PIN = 2,
    API_BRIDGE_GPIO_PULSE_MIN_MS = 50,
    API_BRIDGE_GPIO_PULSE_DEFAULT_MS = 500,
    API_BRIDGE_GPIO_PULSE_MAX_MS = 10000,
};

typedef struct {
    unified_service_runtime_t runtime;
    uint32_t executed_count;
    uint32_t rejected_count;
    uint32_t failed_count;
    uint32_t timeout_count;
    uint32_t mqtt_publish_failures;
    unified_action_response_t last_response;
} api_bridge_status_t;

typedef struct {
    wifi_mgr_scan_result_t results[API_BRIDGE_WIFI_SCAN_MAX_RESULTS];
    wifi_mgr_scan_request_t request;
    wifi_mgr_scan_report_t report;
    char escaped_ssid[(sizeof(((wifi_mgr_scan_result_t *)0)->ssid) * 2U)];
    char escaped_auth[32];
} api_bridge_wifi_scan_scratch_t;

/* FW-02: pending async Wi-Fi transitions. The command responds ACCEPTED
 * immediately; the terminal COMPLETED/FAILED/TIMEOUT result is published by
 * api_bridge_poll_async_transitions() once Wi-Fi settles or the deadline
 * passes. Admission permits one transition on the physical Wi-Fi lane. */
typedef enum {
    API_BRIDGE_WIFI_TRANSITION_CONNECT = 0,
    API_BRIDGE_WIFI_TRANSITION_DISCONNECT = 1,
} api_bridge_wifi_transition_kind_t;

typedef struct {
    bool active;
    bool dispatch_complete;
    bool operation_started;
    api_bridge_wifi_transition_kind_t kind;
    unified_action_envelope_t action;
    uint32_t deadline_ms;
    char ssid[CONFIG_MGR_WIFI_SSID_LEN];
} api_bridge_async_transition_t;

typedef struct {
    api_bridge_async_transition_t entries[API_BRIDGE_ASYNC_TRANSITION_MAX];
    size_t count;
} api_bridge_async_transition_table_t;

static SemaphoreHandle_t s_lock;
static SemaphoreHandle_t s_wifi_scan_lock;
static SemaphoreHandle_t s_async_transition_lock;
static api_bridge_async_transition_table_t s_async_transitions;
static api_bridge_status_t s_status;
static api_bridge_action_record_t *s_recent_records;
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

static size_t api_bridge_history_bytes(void) {
    return sizeof(*s_recent_records) * CONFIG_UNIFIED_API_BRIDGE_HISTORY_DEPTH;
}

static void *api_bridge_alloc_zeroed(size_t size) {
    void *buffer = heap_caps_calloc(1U, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);

    if (!buffer) {
        buffer = heap_caps_calloc(1U, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }

    return buffer;
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

static unified_action_result_t api_bridge_result_from_err(esp_err_t err) {
    if (err == ESP_OK) {
        return UNIFIED_ACTION_RESULT_COMPLETED;
    }
    return err == ESP_ERR_TIMEOUT ? UNIFIED_ACTION_RESULT_TIMEOUT : UNIFIED_ACTION_RESULT_FAILED;
}

static const char *api_bridge_detail_from_err(
    esp_err_t err,
    const char *completed_detail,
    const char *timeout_detail,
    const char *failed_detail
) {
    if (err == ESP_OK) {
        return completed_detail;
    }
    return err == ESP_ERR_TIMEOUT ? timeout_detail : failed_detail;
}

static void api_bridge_escape_json(const char *input, char *output, size_t output_len) {
    const char *cursor = input ? input : "";
    size_t write_index = 0;

    if (!output || output_len == 0) {
        return;
    }

    while (*cursor != '\0' && write_index + 1U < output_len) {
        char current = *cursor++;
        const char *escape = NULL;

        switch (current) {
            case '\\': escape = "\\\\"; break;
            case '"':  escape = "\\\""; break;
            case '\n': escape = "\\n"; break;
            case '\r': escape = "\\r"; break;
            case '\t': escape = "\\t"; break;
            case '\b': escape = "\\b"; break;
            case '\f': escape = "\\f"; break;
            default: break;
        }

        if (escape) {
            const size_t escape_len = strlen(escape);
            if (write_index + escape_len >= output_len) {
                break;
            }
            memcpy(output + write_index, escape, escape_len);
            write_index += escape_len;
        } else if ((unsigned char)current >= 0x20U) {
            output[write_index++] = current;
        } else {
            /* Remaining control bytes must not disappear silently either. */
            if (write_index + 6U >= output_len) {
                break;
            }
            int written = snprintf(output + write_index, output_len - write_index, "\\u%04x", (unsigned char)current);
            if (written != 6) {
                break;
            }
            write_index += 6U;
        }
    }
    output[write_index] = '\0';
}

static bool api_bridge_payload_missing(char *payload, size_t payload_len) {
    return !payload || payload_len == 0U;
}

static esp_err_t api_bridge_format_payload(char *payload, size_t payload_len, const char *format, ...)
    __attribute__((format(printf, 3, 4)));

static esp_err_t api_bridge_format_payload(char *payload, size_t payload_len, const char *format, ...) {
    va_list args;
    int written = 0;

    if (api_bridge_payload_missing(payload, payload_len) || !format) {
        return ESP_ERR_INVALID_ARG;
    }

    va_start(args, format);
    written = vsnprintf(payload, payload_len, format, args);
    va_end(args);

    if (written < 0 || (size_t)written >= payload_len) {
        payload[0] = '\0';
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

static esp_err_t api_bridge_write_response_payload(
    char *payload,
    size_t payload_len,
    const char *response
) {
    char escaped_response[512] = {0};
    int written = 0;

    if (api_bridge_payload_missing(payload, payload_len)) {
        return ESP_ERR_INVALID_ARG;
    }

    api_bridge_escape_json(response, escaped_response, sizeof(escaped_response));
    written = snprintf(payload, payload_len, "{\"response\":\"%s\"}", escaped_response);
    if (written < 0 || (size_t)written >= payload_len) {
        payload[0] = '\0';
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

static esp_err_t api_bridge_annotate_sms_history_payload(
    char *payload,
    size_t payload_len,
    uint32_t synced_count,
    const unified_action_response_t *pull_response
) {
    modem_a7670_status_t modem = {0};
    char escaped_detail[sizeof(pull_response->detail) * 2U] = {0};
    char prefix[256] = {0};
    size_t existing_len = 0U;
    size_t prefix_len = 0U;
    uint16_t storage_used = 0U;
    uint16_t storage_total = 0U;
    uint16_t storage_free = 0U;
    int written = 0;

    if (api_bridge_payload_missing(payload, payload_len) || !pull_response || payload[0] != '{') {
        return ESP_ERR_INVALID_ARG;
    }

    modem_a7670_get_status(&modem);
    storage_used = modem.sms_storage_used;
    storage_total = modem.sms_storage_total;
    storage_free = storage_total > storage_used ? (uint16_t)(storage_total - storage_used) : 0U;
    api_bridge_escape_json(pull_response->detail, escaped_detail, sizeof(escaped_detail));

    written = snprintf(
        prefix,
        sizeof(prefix),
        "\"synced\":%" PRIu32 ",\"pull_detail\":\"%s\",\"pull_result_code\":%" PRId32
        ",\"sms_storage_used\":%u,\"sms_storage_total\":%u,\"sms_storage_free\":%u,",
        synced_count,
        escaped_detail,
        pull_response->result_code,
        (unsigned)storage_used,
        (unsigned)storage_total,
        (unsigned)storage_free
    );
    if (written < 0 || (size_t)written >= sizeof(prefix)) {
        return ESP_ERR_INVALID_SIZE;
    }

    existing_len = strlen(payload);
    prefix_len = (size_t)written;
    if (existing_len + prefix_len >= payload_len) {
        return ESP_ERR_INVALID_SIZE;
    }

    memmove(payload + 1U + prefix_len, payload + 1U, existing_len);
    memcpy(payload + 1U, prefix, prefix_len);
    return ESP_OK;
}

static esp_err_t api_bridge_write_sms_pull_diagnostic_payload(
    char *payload,
    size_t payload_len,
    uint32_t synced_count,
    const unified_action_response_t *pull_response
) {
    modem_a7670_status_t modem = {0};
    char escaped_detail[sizeof(pull_response->detail) * 2U] = {0};
    uint16_t storage_used = 0U;
    uint16_t storage_total = 0U;
    uint16_t storage_free = 0U;
    int written = 0;

    if (api_bridge_payload_missing(payload, payload_len) || !pull_response) {
        return ESP_ERR_INVALID_ARG;
    }

    modem_a7670_get_status(&modem);
    storage_used = modem.sms_storage_used;
    storage_total = modem.sms_storage_total;
    storage_free = storage_total > storage_used ? (uint16_t)(storage_total - storage_used) : 0U;
    api_bridge_escape_json(pull_response->detail, escaped_detail, sizeof(escaped_detail));

    written = snprintf(
        payload,
        payload_len,
        "{\"synced\":%" PRIu32 ",\"count\":0,\"entries\":[],\"pull_detail\":\"%s\","
        "\"pull_result_code\":%" PRId32 ",\"sms_storage_used\":%u,"
        "\"sms_storage_total\":%u,\"sms_storage_free\":%u}",
        synced_count,
        escaped_detail,
        pull_response->result_code,
        (unsigned)storage_used,
        (unsigned)storage_total,
        (unsigned)storage_free
    );
    if (written < 0 || (size_t)written >= payload_len) {
        payload[0] = '\0';
        return ESP_ERR_INVALID_SIZE;
    }

    return ESP_OK;
}

static unified_action_response_t api_bridge_finish_modem_response(
    const unified_action_envelope_t *action,
    esp_err_t err,
    char *payload,
    size_t payload_len,
    const char *response,
    const char *completed_detail,
    const char *timeout_detail,
    const char *failed_detail,
    const char *payload_failed_detail
) {
    esp_err_t payload_err = ESP_OK;

    if (payload && payload_len > 0U) {
        payload_err = api_bridge_write_response_payload(payload, payload_len, response);
        if (payload_err != ESP_OK) {
            return api_bridge_build_response(
                action,
                UNIFIED_ACTION_RESULT_FAILED,
                payload_err,
                UNIFIED_FEATURE_REASON_NONE,
                payload_failed_detail
            );
        }
    }

    return api_bridge_build_response(
        action,
        api_bridge_result_from_err(err),
        err,
        UNIFIED_FEATURE_REASON_NONE,
        api_bridge_detail_from_err(err, completed_detail, timeout_detail, failed_detail)
    );
}

static bool api_bridge_ota_url_supported(const char *url) {
    /* FW-06: HTTP OTA is disabled (TLS with cert bundle only). Plaintext
     * downgrade must be rejected explicitly so the dashboard sees why. */
    if (!url) {
        return false;
    }
    if (strncmp(url, "https://", 8) == 0) {
        return true;
    }
    if (strncmp(url, "http://", 7) == 0) {
        ESP_LOGW(TAG, "OTA rejected plaintext http url (https only)");
    }
    return false;
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

static unified_action_response_t api_bridge_execute_modem_at(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    (void)request;
    (void)payload;
    (void)payload_len;

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_REJECTED,
        ESP_ERR_NOT_SUPPORTED,
        UNIFIED_FEATURE_REASON_NONE,
        "modem_at_requires_serial"
    );
}

static unified_action_response_t api_bridge_execute_storage_info(
    const unified_action_envelope_t *action,
    char *payload,
    size_t payload_len
) {
    storage_mgr_status_t storage = {0};
    char escaped_sd_error[64] = {0};

    if (!payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "storage_info_payload_missing"
        );
    }

    storage_mgr_get_status(&storage);
    api_bridge_escape_json(storage.sd.error, escaped_sd_error, sizeof(escaped_sd_error));
    if (api_bridge_format_payload(
            payload,
            payload_len,
            "{\"enabled\":%s,\"media_available\":%s,\"buffered_only\":%s,\"total_bytes\":%" PRIu64 ",\"used_bytes\":%" PRIu64 ",\"free_bytes\":%" PRIu64 ",\"sd_detected\":%s,\"sd_capacity_bytes\":%" PRIu64 ",\"sd_error\":\"%s\",\"system\":{\"total_bytes\":%" PRIu64 ",\"used_bytes\":%" PRIu64 ",\"free_bytes\":%" PRIu64 ",\"record_count\":%" PRIu32 ",\"dropped_count\":%" PRIu32 ",\"persist_failures\":%" PRIu32 ",\"mount_failures\":%" PRIu32 ",\"sd_write_failures\":%" PRIu32 ",\"sd_flush_count\":%" PRIu32 ",\"runtime\":{\"initialized\":%s,\"running\":%s,\"last_error\":%d,\"state\":%d}}}",
            storage.enabled ? "true" : "false",
            storage.sd.mounted ? "true" : "false",
            storage.sd.mounted ? "false" : "true",
            storage.sd.total_bytes,
            storage.sd.used_bytes,
            storage.sd.free_bytes,
            storage.sd.detected ? "true" : "false",
            storage.sd.capacity_bytes,
            escaped_sd_error,
            storage.total_bytes,
            storage.used_bytes,
            storage.free_bytes,
            storage.record_count,
            storage.dropped_count,
            storage.persist_failures,
            storage.mount_failures,
            storage.sd_write_failures,
            storage.sd_flush_count,
            storage.runtime.initialized ? "true" : "false",
            storage.runtime.running ? "true" : "false",
            (int)storage.runtime.last_error,
            (int)storage.runtime.state
        ) != ESP_OK) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_SIZE,
            UNIFIED_FEATURE_REASON_NONE,
            "storage_info_payload_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "storage_info_completed"
    );
}

static bool api_bridge_gpio_pin_is_allowed(uint8_t pin) {
    return pin == API_BRIDGE_GPIO_DIAGNOSTIC_PIN;
}

static esp_err_t api_bridge_write_gpio_payload(
    char *payload,
    size_t payload_len,
    uint8_t pin,
    int level,
    bool include_value,
    bool value
) {
    int written = 0;

    if (api_bridge_payload_missing(payload, payload_len)) {
        return ESP_ERR_INVALID_ARG;
    }

    written = include_value
        ? snprintf(
            payload,
            payload_len,
            "{\"pin\":%u,\"value\":%s,\"level\":%d,\"allowed_pins\":[%u]}",
            (unsigned)pin,
            value ? "true" : "false",
            level,
            (unsigned)API_BRIDGE_GPIO_DIAGNOSTIC_PIN
        )
        : snprintf(
            payload,
            payload_len,
            "{\"pin\":%u,\"level\":%d,\"allowed_pins\":[%u]}",
            (unsigned)pin,
            level,
            (unsigned)API_BRIDGE_GPIO_DIAGNOSTIC_PIN
        );

    if (written < 0 || (size_t)written >= payload_len) {
        payload[0] = '\0';
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

static unified_action_response_t api_bridge_execute_gpio_status(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    const uint8_t pin = (request && request->gpio_pin_present)
        ? request->gpio_pin
        : API_BRIDGE_GPIO_DIAGNOSTIC_PIN;
    const gpio_num_t gpio = (gpio_num_t)pin;
    esp_err_t err = ESP_OK;
    int level = 0;

    if (!api_bridge_gpio_pin_is_allowed(pin) || !GPIO_IS_VALID_GPIO(gpio)) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_NOT_SUPPORTED,
            UNIFIED_FEATURE_REASON_NONE,
            "unsupported_gpio_pin"
        );
    }
    if (!payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "gpio_status_payload_missing"
        );
    }

    level = gpio_get_level(gpio);
    err = api_bridge_write_gpio_payload(payload, payload_len, pin, level, false, false);
    if (err != ESP_OK) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            "gpio_status_payload_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "gpio_status_completed"
    );
}

static unified_action_response_t api_bridge_execute_gpio_write(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    const uint8_t pin = (request && request->gpio_pin_present)
        ? request->gpio_pin
        : API_BRIDGE_GPIO_DIAGNOSTIC_PIN;
    const gpio_num_t gpio = (gpio_num_t)pin;
    const bool value = request && request->gpio_value_present && request->gpio_value;
    esp_err_t err = ESP_OK;
    int level = 0;

    if (!request || !request->gpio_value_present) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "missing_gpio_value"
        );
    }
    if (!api_bridge_gpio_pin_is_allowed(pin) || !GPIO_IS_VALID_OUTPUT_GPIO(gpio)) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_NOT_SUPPORTED,
            UNIFIED_FEATURE_REASON_NONE,
            "unsupported_gpio_pin"
        );
    }
    if (!payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "gpio_write_payload_missing"
        );
    }

    err = gpio_set_direction(gpio, GPIO_MODE_INPUT_OUTPUT);
    if (err == ESP_OK) {
        err = gpio_set_level(gpio, value ? 1 : 0);
    }
    if (err != ESP_OK) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            "gpio_write_failed"
        );
    }

    level = gpio_get_level(gpio);
    err = api_bridge_write_gpio_payload(payload, payload_len, pin, level, true, value);
    if (err != ESP_OK) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            "gpio_write_payload_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "gpio_write_completed"
    );
}

static unified_action_response_t api_bridge_execute_gpio_pulse(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    const uint8_t pin = (request && request->gpio_pin_present)
        ? request->gpio_pin
        : API_BRIDGE_GPIO_DIAGNOSTIC_PIN;
    const gpio_num_t gpio = (gpio_num_t)pin;
    const bool value = request && request->gpio_value_present ? request->gpio_value : true;
    uint32_t pulse_ms = (request && request->ttl_ms > 0U)
        ? request->ttl_ms
        : ((request && request->interval_ms > 0U) ? request->interval_ms : API_BRIDGE_GPIO_PULSE_DEFAULT_MS);
    esp_err_t err = ESP_OK;
    int final_level = 0;
    int written = 0;

    if (!api_bridge_gpio_pin_is_allowed(pin) || !GPIO_IS_VALID_OUTPUT_GPIO(gpio)) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_NOT_SUPPORTED,
            UNIFIED_FEATURE_REASON_NONE,
            "unsupported_gpio_pin"
        );
    }
    if (!payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "gpio_pulse_payload_missing"
        );
    }

    if (pulse_ms < API_BRIDGE_GPIO_PULSE_MIN_MS) {
        pulse_ms = API_BRIDGE_GPIO_PULSE_MIN_MS;
    } else if (pulse_ms > API_BRIDGE_GPIO_PULSE_MAX_MS) {
        pulse_ms = API_BRIDGE_GPIO_PULSE_MAX_MS;
    }

    err = gpio_set_direction(gpio, GPIO_MODE_INPUT_OUTPUT);
    if (err == ESP_OK) err = gpio_set_level(gpio, value ? 1 : 0);
    if (err == ESP_OK) vTaskDelay(pdMS_TO_TICKS(pulse_ms));
    if (err == ESP_OK) err = gpio_set_level(gpio, value ? 0 : 1);
    if (err != ESP_OK) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            "gpio_pulse_failed"
        );
    }

    final_level = gpio_get_level(gpio);
    written = snprintf(
            payload,
            payload_len,
            "{\"pin\":%u,\"pulse_ms\":%" PRIu32 ",\"active_value\":%s,\"final_level\":%d,\"allowed_pins\":[%u]}",
            (unsigned)pin,
            pulse_ms,
            value ? "true" : "false",
            final_level,
            (unsigned)API_BRIDGE_GPIO_DIAGNOSTIC_PIN
        );
    if (written < 0 || (size_t)written >= payload_len) {
        payload[0] = '\0';
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_SIZE,
            UNIFIED_FEATURE_REASON_NONE,
            "gpio_pulse_payload_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "gpio_pulse_completed"
    );
}

static unified_action_response_t api_bridge_execute_file_list(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    const uint16_t max_entries = (request && request->max_entries > 0U)
        ? ((request->max_entries > CONFIG_UNIFIED_API_BRIDGE_MAX_LIST_ENTRIES)
            ? CONFIG_UNIFIED_API_BRIDGE_MAX_LIST_ENTRIES
            : request->max_entries)
        : CONFIG_UNIFIED_API_BRIDGE_MAX_LIST_ENTRIES;
    esp_err_t err = storage_mgr_list_files_json(
        request ? request->path : NULL,
        max_entries,
        payload,
        payload_len
    );

    return api_bridge_build_response(
        action,
        api_bridge_result_from_err(err),
        err,
        UNIFIED_FEATURE_REASON_NONE,
        api_bridge_detail_from_err(err, "file_list_completed", "file_list_timeout", "file_list_failed")
    );
}

static unified_action_response_t api_bridge_execute_file_read_meta(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    esp_err_t err = storage_mgr_build_file_meta_json(request ? request->path : NULL, payload, payload_len);

    return api_bridge_build_response(
        action,
        api_bridge_result_from_err(err),
        err,
        UNIFIED_FEATURE_REASON_NONE,
        api_bridge_detail_from_err(err, "file_read_meta_completed", "file_read_meta_timeout", "file_read_meta_failed")
    );
}

static unified_action_response_t api_bridge_execute_file_delete(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    char escaped_path[CONFIG_UNIFIED_API_BRIDGE_PATH_LEN * 2U] = {0};
    esp_err_t err = storage_mgr_delete_file(request ? request->path : NULL);

    if (err == ESP_OK && payload && payload_len > 0U) {
        int written = 0;

        api_bridge_escape_json(request ? request->path : "", escaped_path, sizeof(escaped_path));
        written = snprintf(payload, payload_len, "{\"path\":\"%s\",\"deleted\":true}", escaped_path);
        if (written < 0 || (size_t)written >= payload_len) {
            payload[0] = '\0';
            err = ESP_ERR_INVALID_SIZE;
        }
    }

    return api_bridge_build_response(
        action,
        api_bridge_result_from_err(err),
        err,
        UNIFIED_FEATURE_REASON_NONE,
        api_bridge_detail_from_err(err, "file_delete_completed", "file_delete_timeout", "file_delete_failed")
    );
}

static unified_action_response_t api_bridge_execute_unavailable_action(
    const unified_action_envelope_t *action,
    char *payload,
    size_t payload_len
) {
    if (payload && payload_len > 0U) {
        payload[0] = '\0';
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_REJECTED,
        ESP_ERR_NOT_SUPPORTED,
        UNIFIED_FEATURE_REASON_FEATURE_NOT_INSTALLED,
        "feature_not_installed"
    );
}

static unified_action_response_t api_bridge_execute_restart_modem(
    const unified_action_envelope_t *action,
    char *payload,
    size_t payload_len
) {
    char modem_response[256] = {0};
    const uint32_t timeout_ms = action && action->timeout_ms > 0
        ? action->timeout_ms
        : API_BRIDGE_MODEM_RESTART_DEFAULT_TIMEOUT_MS;
    esp_err_t err = modem_a7670_reset_modem(modem_response, sizeof(modem_response), timeout_ms);

    return api_bridge_finish_modem_response(
        action,
        err,
        payload,
        payload_len,
        modem_response,
        "restart_modem_completed",
        "restart_modem_timeout",
        "restart_modem_failed",
        "restart_modem_payload_failed"
    );
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

    err = config_mgr_apply_key_value_safe(request->key, request->value, &restart_required, &sensitive);
    if (err == ESP_ERR_NOT_SUPPORTED) {
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_REJECTED, err, UNIFIED_FEATURE_REASON_NONE, "unsupported_config_key");
    }
    if (err != ESP_OK) {
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_REJECTED, err, UNIFIED_FEATURE_REASON_NONE, "invalid_config_value");
    }

    api_bridge_escape_json(request->key, escaped_key, sizeof(escaped_key));
    api_bridge_escape_json(sensitive ? "<redacted>" : request->value, escaped_value, sizeof(escaped_value));
    if (api_bridge_format_payload(
            payload,
            payload_len,
            "{\"key\":\"%s\",\"value\":\"%s\",\"restart_required\":%s}",
            escaped_key,
            escaped_value,
            restart_required ? "true" : "false"
        ) != ESP_OK) {
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

_Static_assert(CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN >= DEVICE_STATUS_JSON_MAX_LEN,
               "API responses must hold a complete device status snapshot");

static unified_action_response_t api_bridge_execute_get_status(
    const unified_action_envelope_t *action,
    char *payload,
    size_t payload_len
) {
    device_status_snapshot_t *snapshot = NULL;
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

    /* The snapshot is large and JSON formatting also needs libc stack. Keep
     * the reusable automation task's peak stack bounded by placing this
     * command-local object in PSRAM, with internal-RAM fallback. */
    snapshot = api_bridge_alloc_zeroed(sizeof(*snapshot));
    if (!snapshot) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_NO_MEM,
            UNIFIED_FEATURE_REASON_NONE,
            "status_snapshot_allocation_failed"
        );
    }

    err = device_status_snapshot(snapshot);
    if (err == ESP_OK) {
        err = device_status_build_json_from_snapshot(snapshot, payload, payload_len);
    }
    heap_caps_free(snapshot);
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
    const uint32_t before_storage_id = request && request->sms_cursor_present
        ? request->sms_cursor
        : 0U;
    uint32_t synced_count = 0U;
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

    unified_action_response_t pull_response = before_storage_id == 0U
        ? sms_service_pull_pending(action ? action->timeout_ms : 0U, &synced_count)
        : api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_COMPLETED,
            ESP_OK,
            UNIFIED_FEATURE_REASON_NONE,
            "sms_page_continued"
        );
    if (pull_response.result == UNIFIED_ACTION_RESULT_REJECTED ||
        pull_response.result == UNIFIED_ACTION_RESULT_TIMEOUT ||
        pull_response.result == UNIFIED_ACTION_RESULT_FAILED) {
        if (api_bridge_write_sms_pull_diagnostic_payload(
                payload,
                payload_len,
                synced_count,
                &pull_response
            ) != ESP_OK) {
            payload[0] = '\0';
        }
        return api_bridge_build_response(
            action,
            pull_response.result,
            pull_response.result_code,
            pull_response.feature_reason,
            pull_response.detail
        );
    }

    err = storage_mgr_build_sms_history_json(
        payload,
        payload_len,
        max_entries,
        before_storage_id
    );
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
    err = api_bridge_annotate_sms_history_payload(payload, payload_len, synced_count, &pull_response);
    if (err != ESP_OK) {
        payload[0] = '\0';
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            "sms_history_diagnostic_payload_failed"
        );
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        synced_count > 0U ? "sms_pull_completed" : "sms_pull_empty"
    );
}

/* ------------------- FW-02 async transition tracking ------------------- */

static uint32_t api_bridge_wifi_transition_timeout_ms(const unified_action_envelope_t *action) {
    uint32_t requested_ms = action && action->timeout_ms > 0U
        ? action->timeout_ms
        : API_BRIDGE_WIFI_TRANSITION_DEFAULT_TIMEOUT_MS;

    if (requested_ms < API_BRIDGE_WIFI_TRANSITION_MIN_TIMEOUT_MS) {
        requested_ms = API_BRIDGE_WIFI_TRANSITION_MIN_TIMEOUT_MS;
    }
    if (requested_ms > API_BRIDGE_WIFI_TRANSITION_MAX_TIMEOUT_MS) {
        requested_ms = API_BRIDGE_WIFI_TRANSITION_MAX_TIMEOUT_MS;
    }
    return requested_ms;
}

static esp_err_t api_bridge_begin_wifi_transition(
    const unified_action_envelope_t *action,
    api_bridge_wifi_transition_kind_t kind,
    const char *ssid
) {
    api_bridge_async_transition_t *entry = NULL;
    uint32_t now_ms = unified_tick_now_ms();

    if (!s_async_transition_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_async_transition_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    /* One physical Wi-Fi lane: keep the original action until it settles.
     * Admission must occur before a caller changes driver state. */
    entry = NULL;
    for (size_t index = 0U; index < API_BRIDGE_ASYNC_TRANSITION_MAX; ++index) {
        api_bridge_async_transition_t *candidate = &s_async_transitions.entries[index];
        if (!candidate->active) {
            if (!entry) {
                entry = candidate;
            }
            continue;
        }
        xSemaphoreGive(s_async_transition_lock);
        return ESP_ERR_INVALID_STATE;
    }
    if (!entry) {
        xSemaphoreGive(s_async_transition_lock);
        return ESP_ERR_NO_MEM;
    }

    memset(entry, 0, sizeof(*entry));
    if (action) {
        entry->action = *action;
    }
    entry->kind = kind;
    entry->active = true;
    entry->deadline_ms = now_ms + api_bridge_wifi_transition_timeout_ms(action);
    unified_copy_cstr(entry->ssid, sizeof(entry->ssid), ssid ? ssid : "");
    if (s_async_transitions.count < API_BRIDGE_ASYNC_TRANSITION_MAX) {
        s_async_transitions.count++;
    }

    xSemaphoreGive(s_async_transition_lock);
    return ESP_OK;
}

/* Called after dispatch has returned. The poller cannot settle a transition
 * before its ACCEPTED record, or start a disconnect whose dispatch failed.
 * Recording ACCEPTED is not a broker PUBACK guarantee; terminal results use
 * the durable journal across transport changes. */
static void api_bridge_finish_wifi_dispatch(const unified_action_response_t *response) {
    if (!s_async_transition_lock ||
        xSemaphoreTake(s_async_transition_lock, portMAX_DELAY) != pdTRUE) {
        return;
    }
    for (size_t index = 0; index < API_BRIDGE_ASYNC_TRANSITION_MAX; ++index) {
        api_bridge_async_transition_t *entry = &s_async_transitions.entries[index];
        if (!entry->active || entry->dispatch_complete ||
            entry->action.command != response->action.command ||
            strcmp(entry->action.correlation.correlation_id,
                   response->action.correlation.correlation_id) != 0) {
            continue;
        }
        if (response->result == UNIFIED_ACTION_RESULT_ACCEPTED) {
            entry->dispatch_complete = true;
        } else {
            entry->active = false;
            if (s_async_transitions.count > 0U) s_async_transitions.count--;
        }
    }
    xSemaphoreGive(s_async_transition_lock);
}

void api_bridge_poll_async_transitions(void) {
    wifi_mgr_status_t wifi = {0};
    uint32_t now_ms = unified_tick_now_ms();

    if (!s_async_transition_lock) {
        return;
    }
    if (xSemaphoreTake(s_async_transition_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    for (size_t index = 0U; index < API_BRIDGE_ASYNC_TRANSITION_MAX; ++index) {
        api_bridge_async_transition_t *entry = &s_async_transitions.entries[index];
        unified_action_response_t response = {0};
        char payload[192] = {0};
        bool settled = false;
        bool expired = false;
        bool connected = false;

        if (!entry->active || !entry->dispatch_complete) {
            continue;
        }

        wifi_mgr_get_status(&wifi);
        connected = wifi.connected && wifi.ip_assigned;
        expired = (int32_t)(now_ms - entry->deadline_ms) >= 0;

        if (entry->kind == API_BRIDGE_WIFI_TRANSITION_CONNECT) {
            if (connected) {
                char escaped_ssid[CONFIG_MGR_WIFI_SSID_LEN * 2U] = {0};

                api_bridge_escape_json(wifi.ssid, escaped_ssid, sizeof(escaped_ssid));
                response = api_bridge_build_response(
                    &entry->action,
                    UNIFIED_ACTION_RESULT_COMPLETED,
                    ESP_OK,
                    UNIFIED_FEATURE_REASON_NONE,
                    "wifi_transition_connected"
                );
                snprintf(
                    payload,
                    sizeof(payload),
                    "{\"ssid\":\"%s\",\"connected\":true,\"rssi\":%d,\"ip\":\"%s\"}",
                    escaped_ssid,
                    (int)wifi.rssi,
                    wifi.ip_address
                );
                settled = true;
            } else if (expired) {
                response = api_bridge_build_response(
                    &entry->action,
                    UNIFIED_ACTION_RESULT_TIMEOUT,
                    ESP_ERR_TIMEOUT,
                    UNIFIED_FEATURE_REASON_NONE,
                    "wifi_transition_timeout"
                );
                snprintf(
                    payload,
                    sizeof(payload),
                    "{\"ssid\":\"%s\",\"connected\":false,\"last_reason\":\"%s\"}",
                    entry->ssid,
                    wifi.last_disconnect_reason_text[0] != '\0' ? wifi.last_disconnect_reason_text : "unknown"
                );
                settled = true;
            }
        } else {
            /* Dispatch completion arms this operation after recording ACCEPTED.
             * Its terminal result survives the resulting transport change. */
            if (!entry->operation_started) {
                esp_err_t disconnect_err = wifi_mgr_disconnect(true);
                entry->operation_started = true;
                if (disconnect_err != ESP_OK) {
                    response = api_bridge_build_response(
                        &entry->action,
                        UNIFIED_ACTION_RESULT_FAILED,
                        disconnect_err,
                        UNIFIED_FEATURE_REASON_NONE,
                        "wifi_disconnect_failed"
                    );
                    snprintf(
                        payload,
                        sizeof(payload),
                        "{\"ssid\":\"%s\",\"connected\":%s}",
                        entry->ssid,
                        connected ? "true" : "false"
                    );
                    settled = true;
                }
            }

            if (!settled && !wifi.connected && !wifi.ip_assigned) {
                response = api_bridge_build_response(
                    &entry->action,
                    UNIFIED_ACTION_RESULT_COMPLETED,
                    ESP_OK,
                    UNIFIED_FEATURE_REASON_NONE,
                    "wifi_transition_disconnected"
                );
                snprintf(
                    payload,
                    sizeof(payload),
                    "{\"ssid\":\"%s\",\"connected\":false,\"reconnect_suppressed\":%s}",
                    entry->ssid,
                    wifi.reconnect_suppressed ? "true" : "false"
                );
                settled = true;
            } else if (!settled && expired) {
                response = api_bridge_build_response(
                    &entry->action,
                    UNIFIED_ACTION_RESULT_FAILED,
                    ESP_ERR_TIMEOUT,
                    UNIFIED_FEATURE_REASON_NONE,
                    "wifi_disconnect_timeout"
                );
                snprintf(
                    payload,
                    sizeof(payload),
                    "{\"ssid\":\"%s\",\"connected\":true}",
                    entry->ssid
                );
                settled = true;
            }
        }

        if (settled) {
            ESP_LOGI(
                TAG,
                "async wifi transition settled kind=%d action_id=%s result=%s",
                (int)entry->kind,
                entry->action.correlation.correlation_id,
                unified_action_result_name(response.result)
            );
            entry->active = false;
            if (s_async_transitions.count > 0U) {
                s_async_transitions.count--;
            }
            xSemaphoreGive(s_async_transition_lock);
            (void)api_bridge_record_external_response(&response, payload);
            if (xSemaphoreTake(s_async_transition_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
                return;
            }
        }
    }

    xSemaphoreGive(s_async_transition_lock);
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

    api_bridge_escape_json(wifi.ssid, escaped_ssid, sizeof(escaped_ssid));
    if (api_bridge_format_payload(
            payload,
            payload_len,
            "{\"ssid\":\"%s\",\"configured\":%s,\"started\":%s,\"connected\":%s,\"transition\":\"async\"}",
            escaped_ssid,
            wifi.configured ? "true" : "false",
            wifi.started ? "true" : "false",
            wifi.connected ? "true" : "false"
        ) != ESP_OK) {
        payload[0] = '\0';
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_SIZE,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_reconnect_payload_failed"
        );
    }

    err = api_bridge_begin_wifi_transition(action, API_BRIDGE_WIFI_TRANSITION_CONNECT, wifi.ssid);
    if (err != ESP_OK) {
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_REJECTED, err,
            UNIFIED_FEATURE_REASON_NONE, "wifi_transition_busy");
    }
    err = wifi_mgr_request_connect();
    if (err != ESP_OK) {
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_FAILED, err,
            UNIFIED_FEATURE_REASON_NONE, "wifi_reconnect_failed");
    }

    /* FW-02: the transition is asynchronous; ACCEPTED is recorded before the
     * poller starts the physical operation. */

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_ACCEPTED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "wifi_reconnect_requested"
    );
}

static unified_action_response_t api_bridge_execute_wifi_profiles_apply(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    if (!request || !request->wifi_profiles_present) {
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_REJECTED, ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE, "invalid_wifi_profiles_request");
    }
    esp_err_t err = wifi_mgr_profiles_apply(&request->wifi_profiles);
    if (err == ESP_OK && payload && payload_len > 0U) {
        (void)api_bridge_format_payload(payload, payload_len,
            "{\"revision\":%" PRIu32 ",\"count\":%u,\"applied\":true}",
            request->wifi_profiles.revision, (unsigned)request->wifi_profiles.count);
    }
    return api_bridge_build_response(action, err == ESP_OK ? UNIFIED_ACTION_RESULT_COMPLETED : UNIFIED_ACTION_RESULT_FAILED,
        err, UNIFIED_FEATURE_REASON_NONE, err == ESP_OK ? "wifi_profiles_applied" : "wifi_profiles_apply_failed");
}

static unified_action_response_t api_bridge_execute_wifi_connect(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    wifi_mgr_status_t wifi = {0};
    char escaped_ssid[CONFIG_MGR_WIFI_SSID_LEN * 2U] = {0};
    esp_err_t err = ESP_OK;
    const bool password_set = request && request->password[0] != '\0';

    if (!request || request->ssid[0] == '\0' || !payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "invalid_wifi_connect_request"
        );
    }

    wifi_mgr_get_status(&wifi);
    api_bridge_escape_json(wifi.ssid[0] != '\0' ? wifi.ssid : request->ssid, escaped_ssid, sizeof(escaped_ssid));
    if (api_bridge_format_payload(
            payload,
            payload_len,
            "{\"ssid\":\"%s\",\"password_set\":%s,\"configured\":%s,\"started\":%s,\"connected\":%s,\"transition\":\"async\"}",
            escaped_ssid,
            password_set ? "true" : "false",
            wifi.configured ? "true" : "false",
            wifi.started ? "true" : "false",
            wifi.connected ? "true" : "false"
        ) != ESP_OK) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_INVALID_SIZE,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_connect_payload_failed"
        );
    }

    err = api_bridge_begin_wifi_transition(action, API_BRIDGE_WIFI_TRANSITION_CONNECT, request->ssid);
    if (err != ESP_OK) {
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_REJECTED, err,
            UNIFIED_FEATURE_REASON_NONE, "wifi_transition_busy");
    }
    err = wifi_mgr_request_runtime_connect(request->ssid, request->password);
    if (err != ESP_OK) {
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_FAILED, err,
            UNIFIED_FEATURE_REASON_NONE, "wifi_connect_failed");
    }

    /* FW-02: association and DHCP settle asynchronously after ACCEPTED. */

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_ACCEPTED,
        ESP_OK,
        UNIFIED_FEATURE_REASON_NONE,
        "wifi_connect_requested"
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

    /* A synchronous toggle uses the same reservation as async connection
     * changes, and releases it when its terminal dispatch result is recorded. */
    err = api_bridge_begin_wifi_transition(action, API_BRIDGE_WIFI_TRANSITION_CONNECT, wifi.ssid);
    if (err != ESP_OK) {
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_REJECTED, err,
            UNIFIED_FEATURE_REASON_NONE, "wifi_transition_busy");
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
    if (api_bridge_format_payload(
            payload,
            payload_len,
            "{\"ssid\":\"%s\",\"configured\":%s,\"started\":%s,\"connected\":%s,\"reconnect_suppressed\":%s}",
            escaped_ssid,
            wifi.configured ? "true" : "false",
            wifi.started ? "true" : "false",
            wifi.connected ? "true" : "false",
            wifi.reconnect_suppressed ? "true" : "false"
        ) != ESP_OK) {
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

    /* FW-02: reserve the asynchronous transition first. The physical driver
     * disconnect is started by api_bridge_poll_async_transitions() after the
     * ACCEPTED response has been recorded and offered to MQTT. */
    esp_err_t err = api_bridge_begin_wifi_transition(action, API_BRIDGE_WIFI_TRANSITION_DISCONNECT, wifi.ssid);
    if (err != ESP_OK) {
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_REJECTED, err,
            UNIFIED_FEATURE_REASON_NONE, "wifi_transition_busy");
    }

    api_bridge_escape_json(wifi.ssid, escaped_ssid, sizeof(escaped_ssid));
    if (api_bridge_format_payload(
            payload,
            payload_len,
            "{\"ssid\":\"%s\",\"configured\":%s,\"started\":%s,\"connected\":%s,\"reconnect_suppressed\":true,\"transition\":\"async\"}",
            escaped_ssid,
            wifi.configured ? "true" : "false",
            wifi.started ? "true" : "false",
            wifi.connected ? "true" : "false"
        ) != ESP_OK) {
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
        UNIFIED_ACTION_RESULT_ACCEPTED,
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
    if (api_bridge_format_payload(
            payload,
            payload_len,
            "{\"enabled\":%s,\"connected\":%s,\"ip_address\":\"%s\",\"network_registered\":%s}",
            modem.data_mode_enabled ? "true" : "false",
            (modem.data_session_open || modem.ip_bearer_ready || modem.data_ip_address[0] != '\0') ? "true" : "false",
            modem.data_ip_address,
            modem.network_registered ? "true" : "false"
        ) != ESP_OK) {
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
        WIFI_SCAN_BUSY_RETRY_COUNT = 8,
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

    int header_written = snprintf(
        payload,
        payload_len,
        "{\"networks\":["
    );
    if (header_written < 0 || (size_t)header_written >= payload_len) {
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
    used = (size_t)header_written;

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

    if (api_bridge_format_payload(
            payload + used,
            payload_len - used,
            "],\"report\":{\"total_visible\":%u,\"elapsed_ms\":%" PRIu32 ",\"mode\":\"%s\",\"channel\":%u}}",
            (unsigned int)scratch->report.total_visible,
            scratch->report.elapsed_ms,
            wifi_mgr_scan_mode_name(scratch->report.mode),
            (unsigned int)scratch->report.channel
        ) != ESP_OK) {
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

    err = config_mgr_apply_key_value_safe("modem_apn", request->apn, &restart_required, &sensitive);
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
    if (api_bridge_format_payload(
            payload,
            payload_len,
            "{\"apn\":\"%s\",\"username\":\"\",\"password_set\":false,\"auth\":\"%s\",\"reopen_session\":%s,\"restart_required\":%s}",
            escaped_apn,
            escaped_auth,
            reopen_session ? "true" : "false",
            restart_required ? "true" : "false"
        ) != ESP_OK) {
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
        if (api_bridge_format_payload(
            payload,
            payload_len,
            "{\"code\":\"%s\",\"response\":\"%s\"}",
            escaped_code,
            escaped_response
        ) != ESP_OK) {
            return api_bridge_build_response(
                action,
                UNIFIED_ACTION_RESULT_FAILED,
                ESP_ERR_INVALID_SIZE,
                UNIFIED_FEATURE_REASON_NONE,
                "ussd_payload_failed"
            );
        }
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
    const uint32_t timeout_ms = action && action->timeout_ms ? action->timeout_ms : 15000U;
    esp_err_t err = modem_a7670_cancel_ussd(response, sizeof(response), timeout_ms);

    return api_bridge_finish_modem_response(
        action,
        err,
        payload,
        payload_len,
        response,
        "ussd_cancelled",
        "ussd_cancel_timeout",
        "ussd_cancel_failed",
        "ussd_cancel_payload_failed"
    );
}

static unified_action_response_t api_bridge_execute_dial_number(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    char response[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    char escaped_number[UNIFIED_TEXT_SHORT_LEN * 2U] = {0};
    char escaped_response[UNIFIED_TEXT_MEDIUM_LEN * 2U] = {0};
    const uint32_t timeout_ms = action && action->timeout_ms ? action->timeout_ms : 45000U;
    esp_err_t err = ESP_OK;

    if (!request || request->number[0] == '\0') {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "dial_number_required"
        );
    }

    err = modem_a7670_dial(request->number, response, sizeof(response), timeout_ms);
    if (payload && payload_len > 0U) {
        api_bridge_escape_json(request->number, escaped_number, sizeof(escaped_number));
        api_bridge_escape_json(response, escaped_response, sizeof(escaped_response));
        if (api_bridge_format_payload(
                payload,
                payload_len,
                "{\"number\":\"%s\",\"response\":\"%s\"}",
                escaped_number,
                escaped_response
            ) != ESP_OK) {
            return api_bridge_build_response(
                action,
                UNIFIED_ACTION_RESULT_FAILED,
                ESP_ERR_INVALID_SIZE,
                UNIFIED_FEATURE_REASON_NONE,
                "dial_payload_failed"
            );
        }
    }

    return api_bridge_build_response(
        action,
        api_bridge_result_from_err(err),
        err,
        UNIFIED_FEATURE_REASON_NONE,
        api_bridge_detail_from_err(err, "dial_requested", "dial_timeout", "dial_failed")
    );
}

static unified_action_response_t api_bridge_execute_hangup_call(
    const unified_action_envelope_t *action,
    char *payload,
    size_t payload_len
) {
    char response[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    const uint32_t timeout_ms = action && action->timeout_ms ? action->timeout_ms : 15000U;
    esp_err_t err = modem_a7670_hangup(response, sizeof(response), timeout_ms);

    return api_bridge_finish_modem_response(
        action,
        err,
        payload,
        payload_len,
        response,
        "hangup_completed",
        "hangup_timeout",
        "hangup_failed",
        "hangup_payload_failed"
    );
}

static unified_action_response_t api_bridge_execute_routing_configure(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    config_connection_policy_t policy = config_mgr_connection_policy();
    wifi_mgr_status_t wifi = {0};
    modem_a7670_status_t modem = {0};
    char modem_response[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    bool restart_required = false;
    bool sensitive = false;
    bool failover = false;
    bool activation_pending = false;
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

    if (request->connection_policy[0] != '\0') {
        config_connection_policy_t requested_policy = CONFIG_CONNECTION_DUAL_ACTIVE_DEVELOPMENT;
        if (!config_mgr_parse_connection_policy(request->connection_policy, &requested_policy)) {
            return api_bridge_build_response(
                action,
                UNIFIED_ACTION_RESULT_REJECTED,
                ESP_ERR_INVALID_ARG,
                UNIFIED_FEATURE_REASON_NONE,
                "invalid_connection_policy"
            );
        }
        /* The A7670 modem MQTT path has not passed authenticated TLS and
         * certificate/time validation. Do not allow a policy that would move
         * the only command lane onto an unverified or plaintext path. */
        if (requested_policy == CONFIG_CONNECTION_CELLULAR_ONLY ||
            requested_policy == CONFIG_CONNECTION_CELLULAR_WIFI_FALLBACK) {
            return api_bridge_build_response(
                action,
                UNIFIED_ACTION_RESULT_REJECTED,
                ESP_ERR_NOT_SUPPORTED,
                UNIFIED_FEATURE_REASON_NONE,
                "secure_cellular_mqtt_not_available"
            );
        }
        if (requested_policy != policy) {
            err = config_mgr_apply_key_value_safe(
                "connection_policy",
                request->connection_policy,
                &restart_required,
                &sensitive
            );
            if (err != ESP_OK) {
                return api_bridge_build_response(
                    action,
                    UNIFIED_ACTION_RESULT_FAILED,
                    err,
                    UNIFIED_FEATURE_REASON_NONE,
                    "connection_policy_persist_failed"
                );
            }
            policy = requested_policy;
        }

        if (policy == CONFIG_CONNECTION_WIFI_ONLY ||
            policy == CONFIG_CONNECTION_WIFI_CELLULAR_FALLBACK ||
            policy == CONFIG_CONNECTION_DUAL_ACTIVE_DEVELOPMENT) {
            if (wifi_mgr_set_enabled(true) != ESP_OK) {
                activation_pending = true;
            }
        }
        if (policy == CONFIG_CONNECTION_DUAL_ACTIVE_DEVELOPMENT) {
            modem_a7670_get_status(&modem);
            if (!modem.data_session_open || !modem.ip_bearer_ready || modem.data_ip_address[0] == '\0') {
                err = modem_a7670_open_data_session(
                    modem_response,
                    sizeof(modem_response),
                    action && action->timeout_ms ? action->timeout_ms : 15000U
                );
                if (err != ESP_OK) {
                    activation_pending = true;
                }
            }
        }
    }

    if (request->failover_present && request->failover != failover) {
        err = config_mgr_apply_key_value_safe(
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

    policy = config_mgr_connection_policy();
    failover = config_mgr_modem_fallback_enabled();
    wifi_mgr_get_status(&wifi);
    modem_a7670_get_status(&modem);

    if (api_bridge_format_payload(
            payload,
            payload_len,
            "{\"connection_policy\":\"%s\",\"failover\":%s,\"load_balancing\":false,\"nat\":false,\"firewall\":false,\"restart_required\":%s,\"development_mode\":%s,\"activation_pending\":%s,\"wifi_connected\":%s,\"modem_bearer_ready\":%s}",
            config_mgr_connection_policy_name(policy),
            failover ? "true" : "false",
            restart_required ? "true" : "false",
            policy == CONFIG_CONNECTION_DUAL_ACTIVE_DEVELOPMENT ? "true" : "false",
            activation_pending ? "true" : "false",
            wifi.connected && wifi.ip_assigned ? "true" : "false",
            modem.data_session_open && modem.ip_bearer_ready && modem.data_ip_address[0] != '\0' ? "true" : "false"
        ) != ESP_OK) {
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
    wifi_mgr_status_t wifi = {0};

    if (!request || !api_bridge_ota_url_supported(request->url)) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "invalid_ota_url"
        );
    }

    /* AT-managed cellular MQTT does not provide an ESP lwIP HTTPS route.
     * Fail before erase/download instead of conflating a registered bearer
     * with a supported OTA byte stream. A modem downloader is separate work. */
    wifi_mgr_get_status(&wifi);
    if (!wifi.connected || !wifi.ip_assigned) {
        return api_bridge_build_response(action, UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_STATE, UNIFIED_FEATURE_REASON_NONE,
            "ota_requires_wifi_download");
    }

    if (action) {
        effective_action = *action;
        effective_action.timeout_ms = timeout_ms;
    }

    /* Signed download URLs are bearer credentials; never echo them into
     * routine logs or result payloads persisted by the dashboard. */
    ESP_LOGI(TAG, "OTA HTTPS download starting timeout_ms=%" PRIu32, timeout_ms);

    http_config.url = request->url;
    http_config.timeout_ms = (int)timeout_ms;
    http_config.keep_alive_enable = true;
    http_config.crt_bundle_attach = esp_crt_bundle_attach;

    ota_config.http_config = &http_config;

    err = esp_https_ota(&ota_config);
    if (payload && payload_len > 0U) {
        if (api_bridge_format_payload(
                payload,
                payload_len,
                "{\"restart\":%s,\"result_code\":%d,\"error\":\"%s\"}",
                err == ESP_OK ? "true" : "false",
                (int)err,
                err == ESP_OK ? "" : esp_err_to_name(err)) != ESP_OK) {
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
        UNIFIED_ACTION_RESULT_ACCEPTED,
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

static unified_action_response_t api_bridge_execute_delete_sms(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    esp_err_t err = ESP_ERR_INVALID_ARG;
    esp_err_t modem_err = ESP_OK;
    esp_err_t flash_err = ESP_OK;
    uint8_t delete_flag = 0U;
    uint32_t flash_deleted = 0U;
    const char *mode = "index";
    bool modem_requested = false;
    bool flash_requested = false;

    if (!request) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "invalid_sms_delete_request"
        );
    }

    if (request->sms_delete_all) {
        delete_flag = 4U;
        mode = "all";
    } else if (request->sms_delete_read) {
        delete_flag = 1U;
        mode = "read";
    } else if (request->sms_delete_flag_present && request->sms_delete_flag > 0U) {
        delete_flag = request->sms_delete_flag;
        mode = "flag";
    }

    if (delete_flag > 0U) {
        modem_requested = true;
        modem_err = modem_a7670_delete_sms_by_flag(delete_flag, action ? action->timeout_ms : 0U);
    } else if (request->sms_storage_index_present) {
        modem_requested = true;
        modem_err = modem_a7670_delete_sms((int)request->sms_storage_index, action ? action->timeout_ms : 0U);
    }

    if (request->sms_storage_id_present) {
        flash_requested = true;
        flash_err = storage_mgr_delete_sms_by_id(request->sms_storage_id, &flash_deleted);
        if (flash_err == ESP_ERR_NOT_FOUND) {
            flash_err = ESP_OK;
        }
    } else if (request->sms_delete_all) {
        flash_requested = true;
        flash_err = storage_mgr_delete_sms_by_scope(true, true, &flash_deleted);
        if (flash_err == ESP_ERR_NOT_FOUND) {
            flash_err = ESP_OK;
        }
    } else if (request->sms_delete_read) {
        flash_requested = true;
        flash_err = storage_mgr_delete_sms_by_scope(true, false, &flash_deleted);
        if (flash_err == ESP_ERR_NOT_FOUND) {
            flash_err = ESP_OK;
        }
    }

    if (!modem_requested && !flash_requested) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "missing_sms_delete_target"
        );
    }
    err = modem_err != ESP_OK ? modem_err : flash_err;

    if (payload && payload_len > 0U) {
        if (api_bridge_format_payload(
                payload,
                payload_len,
                "{\"mode\":\"%s\",\"storage_index\":%u,\"storage_id\":%" PRIu32 ",\"delete_flag\":%u,\"modem_requested\":%s,\"flash_requested\":%s,\"flash_deleted\":%" PRIu32 ",\"deleted\":%s}",
                mode,
                request->sms_storage_index_present ? (unsigned int)request->sms_storage_index : 0U,
                request->sms_storage_id_present ? request->sms_storage_id : 0U,
                (unsigned int)delete_flag,
                modem_requested ? "true" : "false",
                flash_requested ? "true" : "false",
                flash_deleted,
                err == ESP_OK ? "true" : "false") != ESP_OK) {
            payload[0] = '\0';
        }
    }

    return api_bridge_build_response(
        action,
        api_bridge_result_from_err(err),
        err,
        UNIFIED_FEATURE_REASON_NONE,
        err == ESP_OK ? "sms_delete_completed" : "sms_delete_failed"
    );
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
        case UNIFIED_ACTION_CMD_WIFI_CONNECT:
            return api_bridge_execute_wifi_connect(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_WIFI_PROFILES_APPLY:
            return api_bridge_execute_wifi_profiles_apply(action, request, payload, payload_len);
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
        case UNIFIED_ACTION_CMD_STORAGE_INFO:
            return api_bridge_execute_storage_info(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_MODEM_AT:
            return api_bridge_execute_modem_at(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_GPIO_STATUS:
            return api_bridge_execute_gpio_status(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_GPIO_WRITE:
            return api_bridge_execute_gpio_write(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_GPIO_PULSE:
            return api_bridge_execute_gpio_pulse(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_FILE_LIST:
            return api_bridge_execute_file_list(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_FILE_READ_META:
            return api_bridge_execute_file_read_meta(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_FILE_DELETE:
            return api_bridge_execute_file_delete(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_FILE_EXPORT:
            return api_bridge_execute_unavailable_action(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_SENSOR_READ:
            return api_bridge_execute_unavailable_action(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_START_CAMERA:
            return api_bridge_execute_unavailable_action(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_STOP_CAMERA:
            return api_bridge_execute_unavailable_action(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_TAKE_SNAPSHOT:
            return api_bridge_execute_unavailable_action(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_START_STREAM:
            return api_bridge_execute_unavailable_action(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_STOP_STREAM:
            return api_bridge_execute_unavailable_action(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_CARD_SCAN_START:
            return api_bridge_execute_unavailable_action(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_CARD_SCAN_STOP:
            return api_bridge_execute_unavailable_action(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_CARD_READ:
            return api_bridge_execute_unavailable_action(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_CARD_WRITE:
            return api_bridge_execute_unavailable_action(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_RESTART_MODEM:
            return api_bridge_execute_restart_modem(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_SEND_SMS:
        case UNIFIED_ACTION_CMD_SEND_SMS_MULTIPART:
            return api_bridge_execute_send_sms(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_DELETE_SMS:
            return api_bridge_execute_delete_sms(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_SEND_USSD:
            return api_bridge_execute_send_ussd(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_CANCEL_USSD:
            return api_bridge_execute_cancel_ussd(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_DIAL_NUMBER:
            return api_bridge_execute_dial_number(action, request, payload, payload_len);
        case UNIFIED_ACTION_CMD_HANGUP_CALL:
            return api_bridge_execute_hangup_call(action, payload, payload_len);
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

    s_recent_sequence++;
    if (s_recent_sequence == 0U) {
        s_recent_sequence = 1U;
    }

    record = &s_recent_records[s_recent_head];
    record->sequence = s_recent_sequence;
    record->replay = false;
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

    s_async_transition_lock = xSemaphoreCreateMutex();
    if (!s_async_transition_lock) {
        return ESP_ERR_NO_MEM;
    }
    memset(&s_async_transitions, 0, sizeof(s_async_transitions));

    s_wifi_scan_scratch = api_bridge_alloc_zeroed(sizeof(*s_wifi_scan_scratch));
    if (!s_wifi_scan_scratch) {
        return ESP_ERR_NO_MEM;
    }

    s_recent_records = api_bridge_alloc_zeroed(api_bridge_history_bytes());
    if (!s_recent_records) {
        return ESP_ERR_NO_MEM;
    }

    memset(&s_status, 0, sizeof(s_status));
    memset(s_recent_records, 0, api_bridge_history_bytes());
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
    bool durable_action = false;

    if (!s_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!action || !out_response || !out_payload || out_payload_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    durable_action = action->correlation.correlation_id[0] != '\0';
    normalized_action = *action;
    api_bridge_fill_identity(&normalized_action);
    out_payload[0] = '\0';
    /* Reserve a private-flash slot before any hardware side effect. A full or
     * unavailable journal must reject the command before the modem/GPIO lane. */
    esp_err_t reserve_err = durable_action ? storage_mgr_result_reserve(&normalized_action) : ESP_OK;
    if (reserve_err != ESP_OK) {
        if (reserve_err == ESP_ERR_NOT_ALLOWED &&
            storage_mgr_result_get(&normalized_action, &response, out_payload, out_payload_len) == ESP_OK) {
            /* A redelivery after terminal completion returns the original
             * durable outcome. Never replace it with a newer rejection that
             * could cause the dashboard to acknowledge the wrong result. */
            *out_response = response;
            return api_bridge_replay_response(&response);
        }
        response = api_bridge_build_response(
            &normalized_action, UNIFIED_ACTION_RESULT_REJECTED, reserve_err,
            UNIFIED_FEATURE_REASON_NONE,
            reserve_err == ESP_ERR_NO_MEM ? "result_journal_full" :
                (reserve_err == ESP_ERR_NOT_FINISHED ? "duplicate_action_uncertain" :
                 "result_journal_unavailable")
        );
        goto record_response;
    }
    response = api_bridge_dispatch_action(&normalized_action, request, out_payload, out_payload_len);
    if (durable_action && response.result != UNIFIED_ACTION_RESULT_ACCEPTED) {
        esp_err_t commit_err = storage_mgr_result_commit(&response, out_payload);
        if (commit_err != ESP_OK) {
            /* The durable reservation remains pinned. Re-execution with this
             * action ID is refused until operator reconciliation. */
            ESP_LOGE(TAG, "result commit failed command=%s err=%s; reservation retained",
                     unified_action_command_name(response.action.command), esp_err_to_name(commit_err));
        }
    }
record_response:
    record_snapshot = api_bridge_alloc_record_snapshot();

    /* This mutex protects bounded record copies only. Do not strand an
     * admitted transition by dropping its ACCEPTED record on contention. */
    if (xSemaphoreTake(s_lock, portMAX_DELAY) != pdTRUE) {
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
    api_bridge_finish_wifi_dispatch(&response);
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
    if (normalized_response.action.correlation.correlation_id[0] &&
        normalized_response.result != UNIFIED_ACTION_RESULT_ACCEPTED) {
        /* Async terminal responses complete an earlier reservation. Parse and
         * queue rejections have no prior reservation, so reserve on demand. */
        esp_err_t commit_err = storage_mgr_result_commit(&normalized_response, payload);
        if (commit_err == ESP_ERR_NOT_FOUND) {
            if (storage_mgr_result_reserve(&normalized_response.action) == ESP_OK) {
                commit_err = storage_mgr_result_commit(&normalized_response, payload);
            }
        }
        if (commit_err != ESP_OK && commit_err != ESP_ERR_INVALID_STATE) {
            ESP_LOGW(TAG, "external result not durable command=%s err=%s",
                     unified_action_command_name(normalized_response.action.command), esp_err_to_name(commit_err));
        }
    }
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

esp_err_t api_bridge_replay_response(const unified_action_response_t *response) {
    if (!s_ready || !s_lock || !response) return ESP_ERR_INVALID_STATE;
    api_bridge_action_record_t *snapshot = api_bridge_alloc_record_snapshot();
    if (!snapshot) return ESP_ERR_NO_MEM;
    esp_err_t err = storage_mgr_result_get(&response->action, &snapshot->response,
                                          snapshot->payload, sizeof(snapshot->payload));
    if (err != ESP_OK) {
        /* Never invent a body-less successful result when bounded history has
         * expired. Do not reserve or execute the action again. */
        snapshot->response = *response;
        snapshot->response.result = UNIFIED_ACTION_RESULT_REJECTED;
        snapshot->response.result_code = err;
        unified_copy_cstr(snapshot->response.detail, sizeof(snapshot->response.detail), "duplicate_result_unavailable");
        snapshot->payload[0] = '\0';
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        api_bridge_free_record_snapshot(snapshot);
        return ESP_ERR_TIMEOUT;
    }
    /* Copy into the existing bounded result ring, independent of journal ACK
     * scheduling. No flash recommit and no second hardware execution. */
    const size_t slot = s_recent_head;
    api_bridge_record_response_locked(&snapshot->response, snapshot->payload, NULL);
    s_recent_records[slot].replay = true;
    *snapshot = s_recent_records[slot];
    api_bridge_result_listener_t listener = s_result_listener;
    xSemaphoreGive(s_lock);
    if (listener) listener(snapshot);
    api_bridge_free_record_snapshot(snapshot);
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
