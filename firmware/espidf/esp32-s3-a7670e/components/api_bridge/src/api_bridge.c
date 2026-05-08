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
    API_BRIDGE_OTA_MIN_TIMEOUT_MS = 180000,
    API_BRIDGE_OTA_DEFAULT_TIMEOUT_MS = 300000,
    API_BRIDGE_OTA_RESTART_DELAY_MS = 1500,
    API_BRIDGE_MODEM_RESTART_DEFAULT_TIMEOUT_MS = 45000,
    API_BRIDGE_GPIO_DIAGNOSTIC_PIN = 2,
    API_BRIDGE_GPIO_PULSE_MIN_MS = 50,
    API_BRIDGE_GPIO_PULSE_DEFAULT_MS = 500,
    API_BRIDGE_GPIO_PULSE_MAX_MS = 10000,
    API_BRIDGE_MODEM_AT_RESPONSE_LEN = 768,
    API_BRIDGE_MODEM_AT_TRUNCATED_PREVIEW_LEN = 160,
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

typedef struct {
    char modem_response[API_BRIDGE_MODEM_AT_RESPONSE_LEN];
    char escaped_line[UNIFIED_TEXT_LONG_LEN * 2U];
    char escaped_response[API_BRIDGE_MODEM_AT_RESPONSE_LEN * 2U];
    char truncated_response[API_BRIDGE_MODEM_AT_TRUNCATED_PREVIEW_LEN + 16U];
    char escaped_truncated_response[(API_BRIDGE_MODEM_AT_TRUNCATED_PREVIEW_LEN + 16U) * 2U];
} api_bridge_modem_at_scratch_t;

static SemaphoreHandle_t s_lock;
static SemaphoreHandle_t s_wifi_scan_lock;
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

static bool api_bridge_payload_missing(char *payload, size_t payload_len) {
    return !payload || payload_len == 0U;
}

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

static bool api_bridge_raw_modem_line_is_valid(const char *line) {
    if (!line || line[0] == '\0') {
        return false;
    }
    if (line[0] != 'A' && line[0] != 'a') {
        return false;
    }
    for (size_t index = 0U; line[index] != '\0'; ++index) {
        const unsigned char current = (unsigned char)line[index];
        if (current < 0x20U || current > 0x7EU) {
            return false;
        }
    }
    return true;
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

static unified_action_response_t api_bridge_execute_modem_at(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    char *payload,
    size_t payload_len
) {
    api_bridge_modem_at_scratch_t *scratch = NULL;
    unified_action_response_t response = {0};
    esp_err_t err = ESP_OK;
    int written = 0;
    const uint32_t timeout_ms = action && action->timeout_ms > 0U ? action->timeout_ms : 10000U;

    if (!request || !api_bridge_raw_modem_line_is_valid(request->raw_line) || !payload || payload_len == 0U) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            UNIFIED_FEATURE_REASON_NONE,
            "invalid_modem_at_line"
        );
    }

    scratch = api_bridge_alloc_zeroed(sizeof(*scratch));
    if (!scratch) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_NO_MEM,
            UNIFIED_FEATURE_REASON_NONE,
            "modem_at_no_memory"
        );
    }

    err = modem_a7670_command(request->raw_line, scratch->modem_response, sizeof(scratch->modem_response), timeout_ms);
    api_bridge_escape_json(request->raw_line, scratch->escaped_line, sizeof(scratch->escaped_line));
    api_bridge_escape_json(scratch->modem_response, scratch->escaped_response, sizeof(scratch->escaped_response));
    written = snprintf(
            payload,
            payload_len,
            "{\"line\":\"%s\",\"response\":\"%s\"}",
            scratch->escaped_line,
            scratch->escaped_response
        );
    if (written < 0 || (size_t)written >= payload_len) {
        size_t preview_len = 0U;

        while (preview_len < API_BRIDGE_MODEM_AT_TRUNCATED_PREVIEW_LEN &&
               scratch->modem_response[preview_len] != '\0') {
            scratch->truncated_response[preview_len] = scratch->modem_response[preview_len];
            ++preview_len;
        }
        scratch->truncated_response[preview_len] = '\0';
        if (scratch->modem_response[preview_len] != '\0') {
            const char *suffix = "...[truncated]";
            strncat(
                scratch->truncated_response,
                suffix,
                sizeof(scratch->truncated_response) - strlen(scratch->truncated_response) - 1U
            );
        }
        api_bridge_escape_json(
            scratch->truncated_response,
            scratch->escaped_truncated_response,
            sizeof(scratch->escaped_truncated_response)
        );
        written = snprintf(
                payload,
                payload_len,
                "{\"line\":\"%s\",\"response\":\"%s\"}",
                scratch->escaped_line,
                scratch->escaped_truncated_response
            );
        if (written < 0 || (size_t)written >= payload_len) {
            payload[0] = '\0';
            response = api_bridge_build_response(
                action,
                UNIFIED_ACTION_RESULT_FAILED,
                ESP_ERR_INVALID_SIZE,
                UNIFIED_FEATURE_REASON_NONE,
                "modem_at_payload_failed"
            );
            heap_caps_free(scratch);
            return response;
        }
    }

    response = api_bridge_build_response(
        action,
        err == ESP_OK ? UNIFIED_ACTION_RESULT_COMPLETED : (err == ESP_ERR_TIMEOUT ? UNIFIED_ACTION_RESULT_TIMEOUT : UNIFIED_ACTION_RESULT_FAILED),
        err,
        UNIFIED_FEATURE_REASON_NONE,
        err == ESP_OK ? "modem_at_completed" : (err == ESP_ERR_TIMEOUT ? "modem_at_timeout" : "modem_at_failed")
    );
    heap_caps_free(scratch);
    return response;
}

static unified_action_response_t api_bridge_execute_storage_info(
    const unified_action_envelope_t *action,
    char *payload,
    size_t payload_len
) {
    storage_mgr_status_t storage = {0};

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
    if (api_bridge_format_payload(
            payload,
            payload_len,
            "{\"enabled\":%s,\"media_available\":%s,\"buffered_only\":%s,\"total_bytes\":%" PRIu64 ",\"used_bytes\":%" PRIu64 ",\"free_bytes\":%" PRIu64 ",\"record_count\":%" PRIu32 ",\"dropped_count\":%" PRIu32 ",\"persist_failures\":%" PRIu32 ",\"mount_failures\":%" PRIu32 ",\"sd_write_failures\":%" PRIu32 ",\"sd_flush_count\":%" PRIu32 ",\"runtime\":{\"initialized\":%s,\"running\":%s,\"last_error\":%d,\"state\":%d}}",
            storage.enabled ? "true" : "false",
            storage.media_available ? "true" : "false",
            storage.buffered_only ? "true" : "false",
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

static unified_action_response_t api_bridge_execute_placeholder_lane(
    const unified_action_envelope_t *action,
    char *payload,
    size_t payload_len,
    const char *lane,
    const char *detail
) {
    char escaped_lane[64] = {0};
    char escaped_detail[96] = {0};

    if (payload && payload_len > 0U) {
        api_bridge_escape_json(lane, escaped_lane, sizeof(escaped_lane));
        api_bridge_escape_json(detail, escaped_detail, sizeof(escaped_detail));
        if (api_bridge_format_payload(
                payload,
                payload_len,
                "{\"lane\":\"%s\",\"implemented\":false,\"message\":\"%s\"}",
                escaped_lane,
                escaped_detail
            ) != ESP_OK) {
            payload[0] = '\0';
        }
    }

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_REJECTED,
        ESP_ERR_NOT_SUPPORTED,
        UNIFIED_FEATURE_REASON_FEATURE_NOT_INSTALLED,
        detail
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

    unified_action_response_t pull_response = sms_service_pull_pending(
        action ? action->timeout_ms : 0U,
        &synced_count
    );
    if (pull_response.result == UNIFIED_ACTION_RESULT_REJECTED ||
        pull_response.result == UNIFIED_ACTION_RESULT_TIMEOUT ||
        pull_response.result == UNIFIED_ACTION_RESULT_FAILED) {
        payload[0] = '\0';
        return pull_response;
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
        synced_count > 0U ? "sms_pull_completed" : "sms_pull_empty"
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
    if (api_bridge_format_payload(
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

    err = wifi_mgr_request_runtime_connect(request->ssid, request->password);
    if (err != ESP_OK) {
        return api_bridge_build_response(
            action,
            UNIFIED_ACTION_RESULT_FAILED,
            err,
            UNIFIED_FEATURE_REASON_NONE,
            "wifi_connect_failed"
        );
    }

    wifi_mgr_get_status(&wifi);
    api_bridge_escape_json(wifi.ssid[0] != '\0' ? wifi.ssid : request->ssid, escaped_ssid, sizeof(escaped_ssid));
    if (api_bridge_format_payload(
            payload,
            payload_len,
            "{\"ssid\":\"%s\",\"password_set\":%s,\"configured\":%s,\"started\":%s,\"connected\":%s}",
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

    return api_bridge_build_response(
        action,
        UNIFIED_ACTION_RESULT_COMPLETED,
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
    if (api_bridge_format_payload(
            payload,
            payload_len,
            "{\"ssid\":\"%s\",\"configured\":%s,\"started\":%s,\"connected\":%s,\"reconnect_suppressed\":true}",
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

    if (api_bridge_format_payload(
            payload,
            payload_len,
            "{\"failover\":%s,\"load_balancing\":false,\"nat\":false,\"firewall\":false,\"restart_required\":%s}",
            failover ? "true" : "false",
            restart_required ? "true" : "false"
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
        if (api_bridge_format_payload(
                payload,
                payload_len,
                "{\"url\":\"%s\",\"restart\":%s}",
                escaped_url,
                err == ESP_OK ? "true" : "false") != ESP_OK) {
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
        case UNIFIED_ACTION_CMD_WIFI_CONNECT:
            return api_bridge_execute_wifi_connect(action, request, payload, payload_len);
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
            return api_bridge_execute_placeholder_lane(action, payload, payload_len, "file_export", "file_export_not_implemented");
        case UNIFIED_ACTION_CMD_SENSOR_READ:
            return api_bridge_execute_placeholder_lane(action, payload, payload_len, "sensor", "sensor_lane_not_implemented");
        case UNIFIED_ACTION_CMD_START_CAMERA:
            return api_bridge_execute_placeholder_lane(action, payload, payload_len, "camera", "camera_lane_not_installed");
        case UNIFIED_ACTION_CMD_STOP_CAMERA:
            return api_bridge_execute_placeholder_lane(action, payload, payload_len, "camera", "camera_lane_not_installed");
        case UNIFIED_ACTION_CMD_TAKE_SNAPSHOT:
            return api_bridge_execute_placeholder_lane(action, payload, payload_len, "camera", "camera_lane_not_installed");
        case UNIFIED_ACTION_CMD_START_STREAM:
            return api_bridge_execute_placeholder_lane(action, payload, payload_len, "camera", "camera_lane_not_installed");
        case UNIFIED_ACTION_CMD_STOP_STREAM:
            return api_bridge_execute_placeholder_lane(action, payload, payload_len, "camera", "camera_lane_not_installed");
        case UNIFIED_ACTION_CMD_CARD_SCAN_START:
            return api_bridge_execute_placeholder_lane(action, payload, payload_len, "card", "card_lane_not_installed");
        case UNIFIED_ACTION_CMD_CARD_SCAN_STOP:
            return api_bridge_execute_placeholder_lane(action, payload, payload_len, "card", "card_lane_not_installed");
        case UNIFIED_ACTION_CMD_CARD_READ:
            return api_bridge_execute_placeholder_lane(action, payload, payload_len, "card", "card_lane_not_installed");
        case UNIFIED_ACTION_CMD_CARD_WRITE:
            return api_bridge_execute_placeholder_lane(action, payload, payload_len, "card", "card_lane_not_installed");
        case UNIFIED_ACTION_CMD_RESTART_MODEM:
            return api_bridge_execute_restart_modem(action, payload, payload_len);
        case UNIFIED_ACTION_CMD_SEND_SMS:
        case UNIFIED_ACTION_CMD_SEND_SMS_MULTIPART:
            return api_bridge_execute_send_sms(action, request, payload, payload_len);
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
