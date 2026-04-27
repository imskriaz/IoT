#include "sms_service.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"

#include "health_monitor.h"
#include "modem_a7670.h"
#include "mqtt_mgr.h"
#include "storage_mgr.h"
#include "task_registry.h"
#include "unified_runtime.h"

#define SMS_SERVICE_FALLBACK_POLL_DIVISOR  2U
#define SMS_SERVICE_FALLBACK_POLL_INTERVAL_MS \
    ((uint32_t)CONFIG_UNIFIED_TELEPHONY_POLL_INTERVAL_MS * SMS_SERVICE_FALLBACK_POLL_DIVISOR)
#define SMS_SERVICE_URC_FALLBACK_GRACE_MS  (SMS_SERVICE_FALLBACK_POLL_INTERVAL_MS * 2U)
#define SMS_SERVICE_EVENT_RETRY_DELAY_MS  750U
#define SMS_SERVICE_SINGLE_SMS_TEXT_LEN_BYTES  160U
#define SMS_SERVICE_UNICODE_SEND_TIMEOUT_MS  45000U
#define SMS_SERVICE_MULTIPART_SEND_TIMEOUT_MS  60000U
#define SMS_SERVICE_EVENT_MODEM_TIMEOUT_MS  1000U
#define SMS_SERVICE_BACKGROUND_MODEM_TIMEOUT_MS  2500U
#define SMS_SERVICE_MODEM_RESPONSE_LEN  1024U

static const char *TAG = "sms_service";

static sms_service_status_t s_status;
static SemaphoreHandle_t s_lock;
static bool s_ready;
static TaskHandle_t s_task_handle;

static void *sms_service_alloc_zeroed(size_t size) {
    void *buffer = heap_caps_calloc(1U, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);

    if (!buffer) {
        buffer = heap_caps_calloc(1U, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }

    return buffer;
}

static void sms_service_free(void *buffer) {
    if (buffer) {
        heap_caps_free(buffer);
    }
}

static uint32_t sms_service_requested_timeout_ms(uint32_t timeout_ms) {
    return timeout_ms > 0U ? timeout_ms : CONFIG_UNIFIED_TELEPHONY_ACTION_TIMEOUT_MS;
}

static bool sms_service_requires_unicode_timeout(const char *text) {
    if (!text) {
        return false;
    }

    for (size_t index = 0U; text[index] != '\0'; ++index) {
        if (((unsigned char)text[index]) > 0x7FU) {
            return true;
        }
    }

    return false;
}

static uint32_t sms_service_effective_send_timeout_ms(
    size_t text_len,
    bool requires_unicode_timeout,
    uint32_t timeout_ms,
    bool force_multipart
) {
    uint32_t effective_timeout_ms = sms_service_requested_timeout_ms(timeout_ms);

    if ((force_multipart || text_len > SMS_SERVICE_SINGLE_SMS_TEXT_LEN_BYTES) &&
        effective_timeout_ms < SMS_SERVICE_MULTIPART_SEND_TIMEOUT_MS) {
        return SMS_SERVICE_MULTIPART_SEND_TIMEOUT_MS;
    }
    if (requires_unicode_timeout &&
        effective_timeout_ms < SMS_SERVICE_UNICODE_SEND_TIMEOUT_MS) {
        return SMS_SERVICE_UNICODE_SEND_TIMEOUT_MS;
    }

    return effective_timeout_ms;
}

static uint32_t sms_service_background_timeout_ms(void) {
    const uint32_t configured_timeout_ms = CONFIG_UNIFIED_TELEPHONY_ACTION_TIMEOUT_MS;

    if (configured_timeout_ms == 0U) {
        return SMS_SERVICE_BACKGROUND_MODEM_TIMEOUT_MS;
    }

    return configured_timeout_ms < SMS_SERVICE_BACKGROUND_MODEM_TIMEOUT_MS
        ? configured_timeout_ms
        : SMS_SERVICE_BACKGROUND_MODEM_TIMEOUT_MS;
}

static uint32_t sms_service_event_timeout_ms(void) {
    const uint32_t configured_timeout_ms = CONFIG_UNIFIED_TELEPHONY_ACTION_TIMEOUT_MS;

    if (configured_timeout_ms == 0U) {
        return SMS_SERVICE_EVENT_MODEM_TIMEOUT_MS;
    }

    return configured_timeout_ms < SMS_SERVICE_EVENT_MODEM_TIMEOUT_MS
        ? configured_timeout_ms
        : SMS_SERVICE_EVENT_MODEM_TIMEOUT_MS;
}

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
    unified_action_command_t command,
    unified_action_result_t result,
    int32_t result_code,
    const char *detail,
    uint32_t timeout_ms
) {
    unified_action_response_t response = {
        .action = {
            .command = command,
            .timeout_ms = timeout_ms,
        },
        .result = result,
        .result_code = result_code,
    };

    unified_copy_cstr(response.detail, sizeof(response.detail), detail);
    return response;
}

static bool sms_service_extract_cmgs_reference(const char *response, uint16_t *out_reference) {
    const char *cursor = response;

    if (!response || !out_reference) {
        return false;
    }

    while ((cursor = strstr(cursor, "+CMGS:")) != NULL) {
        char *end = NULL;
        long reference = 0;

        cursor += 6;
        while (*cursor == ' ') {
            cursor++;
        }
        reference = strtol(cursor, &end, 10);
        if (end != cursor && reference >= 0 && reference <= UINT16_MAX) {
            *out_reference = (uint16_t)reference;
            return true;
        }
    }

    return false;
}

static unified_action_response_t sms_service_send_with_transport(
    const char *number,
    const char *text,
    uint32_t timeout_ms,
    bool force_multipart,
    const sms_service_send_options_t *options
) {
    modem_a7670_status_t modem_status = {0};
    modem_a7670_sms_send_options_t modem_options = {0};
    const modem_a7670_sms_send_options_t *modem_options_ptr = NULL;
    unified_sms_payload_t outgoing = {0};
    char *modem_response = NULL;
    esp_err_t err = ESP_FAIL;
    const uint32_t requested_timeout_ms = sms_service_requested_timeout_ms(timeout_ms);
    unified_action_command_t command = UNIFIED_ACTION_CMD_SEND_SMS;
    const char *success_detail = "sms_sent";
    const char *timeout_detail = "sms_send_timeout";
    const char *failed_detail = "sms_send_failed";
    uint32_t effective_timeout_ms = requested_timeout_ms;
    size_t text_len = 0U;
    bool requires_unicode_timeout = false;
    uint16_t expected_parts = 0U;
    uint16_t message_reference = 0U;
    bool has_dashboard_pdu = false;
    bool has_message_reference = false;
    char success_detail_with_reference[UNIFIED_TEXT_MEDIUM_LEN] = {0};

    if (options) {
        expected_parts = options->expected_parts;
        force_multipart = options->force_multipart || expected_parts > 1U;
        modem_options.use_ucs2_present = options->use_ucs2_present;
        modem_options.use_ucs2 = options->use_ucs2;
        modem_options.expected_parts = options->expected_parts;
        modem_options.pdu_hex = options->pdu_hex;
        modem_options.pdu_length = options->pdu_length;
        modem_options_ptr = &modem_options;
        has_dashboard_pdu = options->pdu_hex && options->pdu_hex[0] != '\0';
    }
    command = force_multipart ? UNIFIED_ACTION_CMD_SEND_SMS_MULTIPART : UNIFIED_ACTION_CMD_SEND_SMS;
    success_detail = force_multipart ? "sms_multipart_sent" : "sms_sent";
    timeout_detail = force_multipart ? "sms_multipart_timeout" : "sms_send_timeout";
    failed_detail = force_multipart ? "sms_multipart_failed" : "sms_send_failed";

    if (!has_dashboard_pdu && (!number || !text || number[0] == '\0' || text[0] == '\0')) {
        return sms_service_build_response(
            command,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_ARG,
            "invalid_sms_request",
            requested_timeout_ms
        );
    }

    text_len = text ? strlen(text) : 0U;
    requires_unicode_timeout = has_dashboard_pdu
        ? true
        : (options && options->use_ucs2_present
        ? options->use_ucs2
        : sms_service_requires_unicode_timeout(text));
    effective_timeout_ms = sms_service_effective_send_timeout_ms(
        text_len,
        requires_unicode_timeout,
        timeout_ms,
        force_multipart
    );

    ESP_LOGI(
        TAG,
        "send command=%d text_len=%u unicode=%u parts=%u timeout_ms=%" PRIu32,
        (int)command,
        (unsigned)text_len,
        requires_unicode_timeout ? 1U : 0U,
        (unsigned)expected_parts,
        effective_timeout_ms
    );

    modem_a7670_get_status(&modem_status);
    if (sms_service_telephony_unavailable(&modem_status)) {
        return sms_service_build_response(
            command,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_NOT_SUPPORTED,
            "telephony_unavailable",
            effective_timeout_ms
        );
    }
    if (!modem_status.runtime.running || !modem_status.network_registered || !modem_status.sim_ready) {
        return sms_service_build_response(
            command,
            UNIFIED_ACTION_RESULT_REJECTED,
            ESP_ERR_INVALID_STATE,
            "modem_not_ready",
            effective_timeout_ms
        );
    }

    modem_response = sms_service_alloc_zeroed(SMS_SERVICE_MODEM_RESPONSE_LEN);
    if (!modem_response) {
        return sms_service_build_response(
            command,
            UNIFIED_ACTION_RESULT_FAILED,
            ESP_ERR_NO_MEM,
            "sms_response_alloc_failed",
            effective_timeout_ms
        );
    }

    if (has_dashboard_pdu) {
        err = modem_a7670_send_sms_with_options(
            number,
            text,
            modem_response,
            SMS_SERVICE_MODEM_RESPONSE_LEN,
            effective_timeout_ms,
            modem_options_ptr
        );
    } else if (force_multipart) {
        err = modem_a7670_send_sms_multipart_with_options(
            number,
            text,
            modem_response,
            SMS_SERVICE_MODEM_RESPONSE_LEN,
            effective_timeout_ms,
            modem_options_ptr
        );
    } else {
        err = modem_a7670_send_sms_with_options(
            number,
            text,
            modem_response,
            SMS_SERVICE_MODEM_RESPONSE_LEN,
            effective_timeout_ms,
            modem_options_ptr
        );
    }
    if (err != ESP_OK) {
        printf(
            "sms_service_send_failed err=%s response=%s\n",
            esp_err_to_name(err),
            modem_response[0] ? modem_response : "<empty>"
        );
    }
    snprintf(outgoing.from, sizeof(outgoing.from), "%s", number ? number : "");
    snprintf(outgoing.text, sizeof(outgoing.text), "%s", text ? text : "");
    has_message_reference = err == ESP_OK &&
        sms_service_extract_cmgs_reference(modem_response, &message_reference);
    if (has_message_reference) {
        snprintf(
            success_detail_with_reference,
            sizeof(success_detail_with_reference),
            "%s_mr_%u",
            success_detail,
            (unsigned)message_reference
        );
    }

    snprintf(
        outgoing.detail,
        sizeof(outgoing.detail),
        "%s",
        err == ESP_OK
            ? success_detail
            : (err == ESP_ERR_TIMEOUT ? timeout_detail : failed_detail)
    );
    outgoing.sim_slot = 0U;
    outgoing.timestamp_ms = unified_time_now_ms();
    outgoing.outgoing = true;
    (void)storage_mgr_append_sms(&outgoing);

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        snprintf(s_status.last_destination, sizeof(s_status.last_destination), "%s", number ? number : "");
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
        sms_service_free(modem_response);
        return sms_service_build_response(
            command,
            UNIFIED_ACTION_RESULT_COMPLETED,
            ESP_OK,
            has_message_reference ? success_detail_with_reference : success_detail,
            effective_timeout_ms
        );
    }

    if (err == ESP_ERR_TIMEOUT) {
        sms_service_free(modem_response);
        return sms_service_build_response(
            command,
            UNIFIED_ACTION_RESULT_TIMEOUT,
            err,
            timeout_detail,
            effective_timeout_ms
        );
    }

    sms_service_free(modem_response);
    return sms_service_build_response(
        command,
        UNIFIED_ACTION_RESULT_FAILED,
        err,
        failed_detail,
        effective_timeout_ms
    );
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
    unified_sms_payload_t emitted = {0};

    if (!payload) {
        return;
    }

    emitted = *payload;
    if (detail && detail[0] != '\0') {
        unified_copy_cstr(emitted.detail, sizeof(emitted.detail), detail);
    }

    storage_mgr_append_sms(&emitted);
    mqtt_mgr_publish_sms_incoming(&emitted);

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        sms_service_record_incoming_locked(&emitted, detail);
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
    unified_sms_payload_t *payload = NULL;
    unified_sms_delivery_payload_t *delivery = NULL;
    int sms_index = -1;
    bool event_consumed = false;
    bool saw_event = false;
    TickType_t wait_ticks = pdMS_TO_TICKS(CONFIG_UNIFIED_TELEPHONY_POLL_INTERVAL_MS);
    uint32_t now_ms = 0U;
    uint32_t last_fallback_poll_ms = 0U;
    uint32_t last_urc_success_ms = 0U;
    uint32_t event_timeout_ms = sms_service_event_timeout_ms();
    uint32_t background_timeout_ms = sms_service_background_timeout_ms();
    uint32_t failure_count_delta = 0U;
    const char *cycle_detail = NULL;
    esp_err_t cycle_error = ESP_OK;
    const char *cycle_error_text = NULL;
    bool cycle_ready = true;
    const char *cycle_health_detail = "running";

    (void)arg;

    payload = sms_service_alloc_zeroed(sizeof(*payload));
    delivery = sms_service_alloc_zeroed(sizeof(*delivery));
    if (!payload || !delivery) {
        ESP_LOGE(TAG, "sms task scratch allocation failed");
        sms_service_free(payload);
        sms_service_free(delivery);
        vTaskDelete(NULL);
        return;
    }

    s_task_handle = xTaskGetCurrentTaskHandle();
    ESP_ERROR_CHECK(task_registry_register_expected("sms_task"));
    ESP_ERROR_CHECK(task_registry_mark_running("sms_task", true));
    ESP_ERROR_CHECK(health_monitor_register_module("sms_service"));

    while (true) {
        modem_a7670_get_status(&modem_status);
        event_consumed = false;
        saw_event = false;
        now_ms = unified_tick_now_ms();
        event_timeout_ms = sms_service_event_timeout_ms();
        background_timeout_ms = sms_service_background_timeout_ms();
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
                saw_event = true;
                memset(payload, 0, sizeof(*payload));
                if (modem_a7670_consume_sms_index(sms_index, payload, event_timeout_ms) == ESP_OK) {
                    event_consumed = true;
                    last_urc_success_ms = now_ms;
                    sms_service_emit_incoming(payload, "incoming_sms_urc");
                    cycle_detail = "incoming_sms";
                }
            }

            memset(delivery, 0, sizeof(*delivery));
            while (modem_a7670_pop_sms_delivery(delivery)) {
                saw_event = true;
                event_consumed = true;
                last_urc_success_ms = now_ms;
                (void)mqtt_mgr_publish_sms_delivery(delivery);
                (void)modem_a7670_acknowledge_new_message(event_timeout_ms);
                cycle_detail = "sms_delivery_report";
                memset(delivery, 0, sizeof(*delivery));
            }

            if (!event_consumed &&
                (last_urc_success_ms == 0U ||
                 (now_ms - last_urc_success_ms) >= SMS_SERVICE_URC_FALLBACK_GRACE_MS) &&
                (saw_event ||
                 last_fallback_poll_ms == 0U ||
                 (now_ms - last_fallback_poll_ms) >= SMS_SERVICE_FALLBACK_POLL_INTERVAL_MS)) {
                last_fallback_poll_ms = now_ms;
                memset(payload, 0, sizeof(*payload));
                if (modem_a7670_consume_pending_sms(payload, background_timeout_ms) == ESP_OK) {
                    do {
                        sms_service_emit_incoming(payload, "incoming_sms_fallback");
                        cycle_detail = "incoming_sms_fallback";
                        memset(payload, 0, sizeof(*payload));
                    } while (modem_a7670_consume_pending_sms(payload, background_timeout_ms) == ESP_OK);
                }
            }

            if (modem_status.runtime.running && modem_status.sim_ready) {
                uint32_t idle_wait_ms = SMS_SERVICE_FALLBACK_POLL_INTERVAL_MS;

                if (saw_event && !event_consumed) {
                    idle_wait_ms = SMS_SERVICE_EVENT_RETRY_DELAY_MS;
                } else if (last_urc_success_ms != 0U &&
                           (now_ms - last_urc_success_ms) < SMS_SERVICE_URC_FALLBACK_GRACE_MS) {
                    idle_wait_ms = SMS_SERVICE_URC_FALLBACK_GRACE_MS - (now_ms - last_urc_success_ms);
                }
                wait_ticks = pdMS_TO_TICKS(idle_wait_ms);
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
    return sms_service_send_with_transport(number, text, timeout_ms, false, NULL);
}

unified_action_response_t sms_service_send_multipart(const char *number, const char *text, uint32_t timeout_ms) {
    return sms_service_send_with_transport(number, text, timeout_ms, true, NULL);
}

unified_action_response_t sms_service_send_with_options(
    const char *number,
    const char *text,
    uint32_t timeout_ms,
    const sms_service_send_options_t *options
) {
    return sms_service_send_with_transport(
        number,
        text,
        timeout_ms,
        options ? options->force_multipart : false,
        options
    );
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
