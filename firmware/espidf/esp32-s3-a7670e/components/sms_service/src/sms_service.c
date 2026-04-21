#include "sms_service.h"

#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_timer.h"

#include "health_monitor.h"
#include "modem_a7670.h"
#include "mqtt_mgr.h"
#include "storage_mgr.h"
#include "task_registry.h"
#include "unified_runtime.h"

#define SMS_SERVICE_FALLBACK_POLL_DIVISOR  12U
#define SMS_SERVICE_FALLBACK_POLL_INTERVAL_MS \
    ((uint32_t)CONFIG_UNIFIED_TELEPHONY_POLL_INTERVAL_MS * SMS_SERVICE_FALLBACK_POLL_DIVISOR)

static sms_service_status_t s_status;
static SemaphoreHandle_t s_lock;
static bool s_ready;
static TaskHandle_t s_task_handle;

static bool sms_payload_equals(const unified_sms_payload_t *left, const unified_sms_payload_t *right) {
    return left && right &&
           left->outgoing == right->outgoing &&
           strcmp(left->from, right->from) == 0 &&
           strcmp(left->text, right->text) == 0;
}

static bool sms_service_telephony_unavailable(const modem_a7670_status_t *modem_status) {
    return modem_status && modem_status->runtime.running && !modem_a7670_telephony_supported();
}

static void sms_service_set_health_locked(bool ready, const char *detail) {
    s_status.ready = ready;
    s_status.runtime.state = ready ? UNIFIED_MODULE_STATE_RUNNING : UNIFIED_MODULE_STATE_DEGRADED;
    s_status.runtime.running = ready;
    health_monitor_set_module_state(
        "sms_service",
        ready ? HEALTH_MODULE_STATE_OK : HEALTH_MODULE_STATE_DEGRADED,
        detail ? detail : (ready ? "running" : "modem_not_ready")
    );
}

static void sms_service_update_cycle_status_locked(
    esp_err_t last_error,
    const char *last_error_text,
    const char *detail,
    uint32_t failure_count_delta,
    bool ready,
    const char *health_detail
) {
    s_status.poll_count++;
    s_status.runtime.initialized = true;
    s_status.failure_count += failure_count_delta;
    s_status.runtime.last_error = last_error;
    if (last_error == ESP_OK) {
        s_status.runtime.last_error_text[0] = '\0';
    } else {
        unified_copy_cstr(
            s_status.runtime.last_error_text,
            sizeof(s_status.runtime.last_error_text),
            last_error_text
        );
    }
    if (detail) {
        unified_copy_cstr(s_status.last_detail, sizeof(s_status.last_detail), detail);
    } else if (ready &&
               (s_status.last_detail[0] == '\0' ||
                strcmp(s_status.last_detail, "modem_not_ready") == 0 ||
                strcmp(s_status.last_detail, "telephony_unavailable") == 0)) {
        unified_copy_cstr(s_status.last_detail, sizeof(s_status.last_detail), "running");
    }
    sms_service_set_health_locked(ready, health_detail);
}

static unified_action_response_t sms_service_build_response(
    unified_action_result_t result,
    int32_t result_code,
    const char *detail
) {
    unified_action_response_t response = {
        .action = {
            .command = UNIFIED_ACTION_CMD_SEND_SMS,
        },
        .result = result,
        .result_code = result_code,
    };

    unified_copy_cstr(response.detail, sizeof(response.detail), detail);
    return response;
}

static bool sms_service_parse_list_index(const char *response, int *out_index) {
    const char *header = NULL;
    int index = -1;

    if (!response || !out_index) {
        return false;
    }

    *out_index = -1;
    header = strstr(response, "+CMGL:");
    if (!header) {
        return false;
    }

    if (sscanf(header, "+CMGL: %d", &index) != 1 || index < 0) {
        return false;
    }

    *out_index = index;
    return true;
}

static void sms_service_record_incoming_locked(const unified_sms_payload_t *payload, const char *detail) {
    if (!payload) {
        return;
    }

    if (!sms_payload_equals(payload, &s_status.last_incoming)) {
        s_status.received_count++;
        s_status.last_incoming = *payload;
    }
}

static void sms_service_emit_incoming(const unified_sms_payload_t *payload, const char *detail) {
    if (!payload) {
        return;
    }

    storage_mgr_append_sms(payload);
    mqtt_mgr_publish_sms_incoming(payload);

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        sms_service_record_incoming_locked(payload, detail);
        xSemaphoreGive(s_lock);
    }
}

static void sms_service_notify_task(void) {
    if (s_task_handle) {
        xTaskNotifyGive(s_task_handle);
    }
}

static void sms_service_handle_modem_sms_event(void) {
    sms_service_notify_task();
}

static void sms_service_task(void *arg) {
    modem_a7670_status_t modem_status = {0};
    unified_sms_payload_t payload = {0};
    char response[256] = {0};
    int sms_index = -1;
    int fallback_sms_index = -1;
    bool handled_event = false;
    TickType_t wait_ticks = pdMS_TO_TICKS(CONFIG_UNIFIED_TELEPHONY_POLL_INTERVAL_MS);
    uint32_t now_ms = 0U;
    uint32_t last_fallback_poll_ms = 0U;
    uint32_t failure_count_delta = 0U;
    const char *cycle_detail = NULL;
    esp_err_t cycle_error = ESP_OK;
    const char *cycle_error_text = NULL;
    bool cycle_ready = true;
    const char *cycle_health_detail = "running";

    (void)arg;

    s_task_handle = xTaskGetCurrentTaskHandle();
    ESP_ERROR_CHECK(task_registry_register_expected("sms_task"));
    ESP_ERROR_CHECK(task_registry_mark_running("sms_task", true));
    ESP_ERROR_CHECK(health_monitor_register_module("sms_service"));

    while (true) {
        modem_a7670_get_status(&modem_status);
        handled_event = false;
        now_ms = unified_tick_now_ms();
        wait_ticks = pdMS_TO_TICKS(CONFIG_UNIFIED_TELEPHONY_POLL_INTERVAL_MS);
        failure_count_delta = 0U;
        cycle_detail = NULL;
        cycle_error = ESP_OK;
        cycle_error_text = NULL;
        cycle_ready = true;
        cycle_health_detail = "running";

        if (sms_service_telephony_unavailable(&modem_status)) {
            cycle_error = ESP_ERR_NOT_SUPPORTED;
            cycle_error_text = "telephony_unavailable";
            cycle_detail = "telephony_unavailable";
            cycle_ready = false;
            cycle_health_detail = "telephony_unavailable";
        } else if (!modem_status.runtime.running || !modem_status.sim_ready) {
            cycle_error = ESP_ERR_INVALID_STATE;
            cycle_error_text = "modem_not_ready";
            cycle_detail = "modem_not_ready";
            cycle_ready = false;
            cycle_health_detail = "modem_not_ready";
        } else {
            while (modem_a7670_pop_sms_index(&sms_index)) {
                if (modem_a7670_read_sms(sms_index, &payload, CONFIG_UNIFIED_TELEPHONY_ACTION_TIMEOUT_MS) == ESP_OK) {
                    handled_event = true;
                    sms_service_emit_incoming(&payload, "incoming_sms_urc");
                    cycle_detail = "incoming_sms";
                } else {
                    failure_count_delta++;
                    cycle_detail = "sms_read_failed";
                }
            }

            if (!handled_event &&
                (last_fallback_poll_ms == 0U ||
                 (now_ms - last_fallback_poll_ms) >= SMS_SERVICE_FALLBACK_POLL_INTERVAL_MS)) {
                last_fallback_poll_ms = now_ms;
                if (modem_a7670_command("AT+CMGF=1", response, sizeof(response), CONFIG_UNIFIED_TELEPHONY_ACTION_TIMEOUT_MS) == ESP_OK &&
                    modem_a7670_command("AT+CMGL=\"REC UNREAD\"", response, sizeof(response), CONFIG_UNIFIED_TELEPHONY_ACTION_TIMEOUT_MS) == ESP_OK &&
                    sms_service_parse_list_index(response, &fallback_sms_index)) {
                    if (modem_a7670_read_sms(fallback_sms_index, &payload, CONFIG_UNIFIED_TELEPHONY_ACTION_TIMEOUT_MS) == ESP_OK) {
                        sms_service_emit_incoming(&payload, "incoming_sms_fallback");
                        cycle_detail = "incoming_sms_fallback";
                    } else {
                        failure_count_delta++;
                        cycle_detail = "sms_fallback_read_failed";
                    }
                }
            }

            if (modem_status.runtime.running && modem_status.sim_ready) {
                wait_ticks = pdMS_TO_TICKS(SMS_SERVICE_FALLBACK_POLL_INTERVAL_MS);
            }
        }

        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            sms_service_update_cycle_status_locked(
                cycle_error,
                cycle_error_text,
                cycle_detail,
                failure_count_delta,
                cycle_ready,
                cycle_health_detail
            );
            xSemaphoreGive(s_lock);
        }

        ESP_ERROR_CHECK(task_registry_heartbeat("sms_task"));
        (void)ulTaskNotifyTake(pdTRUE, wait_ticks);
    }
}

esp_err_t sms_service_init(void) {
    BaseType_t task_ok = pdFAIL;

    if (s_ready) {
        return ESP_OK;
    }

    memset(&s_status, 0, sizeof(s_status));
    s_status.runtime.initialized = true;
    s_status.runtime.state = UNIFIED_MODULE_STATE_INITIALIZED;

    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) {
        return ESP_ERR_NO_MEM;
    }

    modem_a7670_set_sms_event_listener(sms_service_handle_modem_sms_event);

    task_ok = xTaskCreatePinnedToCore(
        sms_service_task,
        "sms_task",
        CONFIG_UNIFIED_TASK_STACK_MEDIUM,
        NULL,
        4,
        NULL,
        1
    );
    if (task_ok != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    s_ready = true;
    return ESP_OK;
}

unified_action_response_t sms_service_send(const char *number, const char *text, uint32_t timeout_ms) {
    modem_a7670_status_t modem_status = {0};
    unified_sms_payload_t outgoing = {0};
    char modem_response[256] = {0};
    esp_err_t err = ESP_FAIL;

    if (!number || !text || number[0] == '\0' || text[0] == '\0') {
        return sms_service_build_response(UNIFIED_ACTION_RESULT_REJECTED, ESP_ERR_INVALID_ARG, "invalid_sms_request");
    }

    modem_a7670_get_status(&modem_status);
    if (sms_service_telephony_unavailable(&modem_status)) {
        return sms_service_build_response(UNIFIED_ACTION_RESULT_REJECTED, ESP_ERR_NOT_SUPPORTED, "telephony_unavailable");
    }
    if (!modem_status.runtime.running || !modem_status.network_registered || !modem_status.sim_ready) {
        return sms_service_build_response(UNIFIED_ACTION_RESULT_REJECTED, ESP_ERR_INVALID_STATE, "modem_not_ready");
    }

    err = modem_a7670_send_sms(number, text, modem_response, sizeof(modem_response), timeout_ms);
    snprintf(outgoing.from, sizeof(outgoing.from), "%s", number);
    snprintf(outgoing.text, sizeof(outgoing.text), "%s", text);
    snprintf(
        outgoing.detail,
        sizeof(outgoing.detail),
        "%s",
        err == ESP_OK ? "sms_sent" : (err == ESP_ERR_TIMEOUT ? "sms_send_timeout" : "sms_send_failed")
    );
    outgoing.timestamp_ms = unified_time_now_ms();
    outgoing.outgoing = true;
    (void)storage_mgr_append_sms(&outgoing);

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        snprintf(s_status.last_destination, sizeof(s_status.last_destination), "%s", number);
        s_status.last_outgoing = outgoing;
        snprintf(s_status.last_detail, sizeof(s_status.last_detail), "%s", outgoing.detail);
        if (err == ESP_OK) {
            s_status.sent_count++;
        } else {
            s_status.failure_count++;
        }
        xSemaphoreGive(s_lock);
    }

    if (err == ESP_OK) {
        return sms_service_build_response(UNIFIED_ACTION_RESULT_COMPLETED, ESP_OK, "sms_sent");
    }

    if (err == ESP_ERR_TIMEOUT) {
        return sms_service_build_response(UNIFIED_ACTION_RESULT_TIMEOUT, err, "sms_send_timeout");
    }

    return sms_service_build_response(UNIFIED_ACTION_RESULT_FAILED, err, "sms_send_failed");
}

void sms_service_get_status(sms_service_status_t *out_status) {
    if (!out_status) {
        return;
    }

    memset(out_status, 0, sizeof(*out_status));
    if (!s_lock) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(1000)) != pdTRUE) {
        return;
    }

    *out_status = s_status;
    xSemaphoreGive(s_lock);
}
