#include "modem_a7670_internal.h"

#include <stdio.h>
#include <string.h>

#include "driver/uart.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "unified_runtime.h"

#define MODEM_A7670_USSD_CANCEL_URC_WAIT_MS      3000U
#define MODEM_A7670_USSD_CANCEL_POLL_QUIET_MS     250U
#define MODEM_A7670_USSD_CANCEL_IDLE_SLICE_MS     100U

static bool modem_a7670_parse_sms_payload_from_response(const char *response, unified_sms_payload_t *out_payload) {
    const char *header = NULL;
    const char *quote = NULL;
    const char *from_start = NULL;
    const char *from_end = NULL;
    const char *text_start = NULL;
    const char *text_end = NULL;
    int quote_index = 0;

    if (!response || !out_payload) {
        return false;
    }

    header = strstr(response, "+CMGR:");
    if (!header) {
        return false;
    }

    memset(out_payload, 0, sizeof(*out_payload));
    quote = header;
    while ((quote = strchr(quote, '"')) != NULL) {
        ++quote_index;
        if (quote_index == 2) {
            from_start = quote + 1;
            break;
        }
        ++quote;
    }
    if (!from_start) {
        return false;
    }

    from_end = strchr(from_start, '"');
    if (!from_end) {
        return false;
    }

    snprintf(out_payload->from, sizeof(out_payload->from), "%.*s", (int)(from_end - from_start), from_start);

    text_start = strstr(from_end, "\r\n");
    if (!text_start) {
        return false;
    }
    text_start += 2;
    text_end = strstr(text_start, "\r\n");
    if (!text_end) {
        text_end = text_start + strlen(text_start);
    }

    snprintf(out_payload->text, sizeof(out_payload->text), "%.*s", (int)(text_end - text_start), text_start);
    snprintf(out_payload->detail, sizeof(out_payload->detail), "%s", "incoming_sms");
    out_payload->timestamp_ms = unified_time_now_ms();
    out_payload->outgoing = false;
    return true;
}

esp_err_t modem_a7670_send_sms(
    const char *number,
    const char *text,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    char command[48] = {0};
    esp_err_t err = ESP_FAIL;
    const uint8_t ctrl_z = 0x1AU;

    if (!number || !text || !response || response_len == 0 || number[0] == '\0' || text[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_uart_control_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    err = modem_a7670_send_command_locked("AT+CMGF=1", response, response_len, timeout_ms, false);
    if (err == ESP_OK) {
        err = modem_a7670_prepare_command(command, sizeof(command), "AT+CMGS=\"", number, "\"");
    }
    if (err == ESP_OK) {
        err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, true);
    }
    if (err == ESP_OK) {
        response[0] = '\0';
        if (uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, text, strlen(text)) < 0 ||
            uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, (const char *)&ctrl_z, 1) < 0) {
            err = ESP_FAIL;
        } else {
            err = modem_a7670_read_response_locked(response, response_len, timeout_ms, false);
        }
    }

    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t modem_a7670_dial(
    const char *number,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    char command[48] = {0};
    esp_err_t err = ESP_OK;
    size_t i = 0;

    if (!number || number[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    for (i = 0; number[i] != '\0'; i++) {
        char c = number[i];
        if ((c < '0' || c > '9') && c != '+' && c != '-' && c != '.' &&
            c != '*' && c != '#' && c != ',' && c != 'W' && c != 'P') {
            ESP_LOGW(TAG, "dial rejected invalid char '%c' in number", c);
            return ESP_ERR_INVALID_ARG;
        }
    }
    if (i >= sizeof(command) - 6) {
        return ESP_ERR_INVALID_SIZE;
    }

    err = modem_a7670_prepare_command(command, sizeof(command), "ATD", number, ";");
    if (err != ESP_OK) {
        return err;
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }

    return modem_a7670_command(command, response, response_len, timeout_ms);
}

esp_err_t modem_a7670_hangup(char *response, size_t response_len, uint32_t timeout_ms) {
    return modem_a7670_command("ATH", response, response_len, timeout_ms);
}

esp_err_t modem_a7670_send_ussd(
    const char *code,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    char command[64] = {0};
    esp_err_t err = ESP_OK;
    int written = 0;
    size_t i = 0;

    if (!code || code[0] == '\0' || !response || response_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_uart_control_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    for (i = 0; code[i] != '\0'; i++) {
        char c = code[i];
        if ((c < '0' || c > '9') && c != '*' && c != '#') {
            ESP_LOGW(TAG, "ussd rejected invalid char '%c' in code", c);
            return ESP_ERR_INVALID_ARG;
        }
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }

    /* Robi chained replies require the same DCS as the root request.
     * Omitting ",15" on digit-only follow-ups leaves the session hanging. */
    written = snprintf(command, sizeof(command), "AT+CUSD=1,\"%s\",15", code);
    if (written < 0 || (size_t)written >= sizeof(command)) {
        return ESP_ERR_INVALID_SIZE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    snprintf(s_last_ussd_code, sizeof(s_last_ussd_code), "%s", code);
    err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, false);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "ussd accepted by modem code=%s", code);
    } else {
        ESP_LOGW(TAG, "ussd request failed code=%s err=%s response=%s", code, esp_err_to_name(err), response);
    }

    xSemaphoreGive(s_lock);
    if (err == ESP_OK) {
        /* AT+CUSD can leave the modem CMQTT lane logically connected but unable
         * to deliver follow-up publishes. Force a reconnect after the modem
         * accepts the request so action results and later +CUSD menus publish
         * on a fresh MQTT session. */
        modem_a7670_mark_mqtt_desynced();
    }
    return err;
}

esp_err_t modem_a7670_cancel_ussd(char *response, size_t response_len, uint32_t timeout_ms) {
    char urc_buffer[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    esp_err_t err = ESP_OK;

    if (!response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_uart_control_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    response[0] = '\0';
    err = modem_a7670_send_command_locked("AT+CUSD=2", response, response_len, timeout_ms, false);
    if (err == ESP_OK) {
        const uint32_t wait_ms = timeout_ms == 0U
            ? MODEM_A7670_USSD_CANCEL_URC_WAIT_MS
            : (timeout_ms < MODEM_A7670_USSD_CANCEL_URC_WAIT_MS ? timeout_ms : MODEM_A7670_USSD_CANCEL_URC_WAIT_MS);
        const int64_t deadline_us = esp_timer_get_time() + ((int64_t)wait_ms * 1000LL);

        s_last_ussd_code[0] = '\0';
        while (esp_timer_get_time() < deadline_us) {
            urc_buffer[0] = '\0';
            if (modem_a7670_read_until_quiet_locked(
                    urc_buffer,
                    sizeof(urc_buffer),
                    MODEM_A7670_USSD_CANCEL_POLL_QUIET_MS) == ESP_OK &&
                strstr(urc_buffer, "+CUSD:") != NULL) {
                ESP_LOGI(TAG, "ussd cancel completed");
                break;
            }

            vTaskDelay(pdMS_TO_TICKS(MODEM_A7670_USSD_CANCEL_IDLE_SLICE_MS));
        }
    }

    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t modem_a7670_read_sms(int storage_index, unified_sms_payload_t *out_payload, uint32_t timeout_ms) {
    char response[256] = {0};
    char command[32] = {0};
    esp_err_t err = ESP_FAIL;
    int written = 0;

    if (storage_index < 0 || !out_payload) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_uart_control_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    err = modem_a7670_send_command_locked("AT+CMGF=1", response, sizeof(response), timeout_ms, false);
    if (err == ESP_OK) {
        written = snprintf(command, sizeof(command), "AT+CMGR=%d", storage_index);
        if (written < 0 || (size_t)written >= sizeof(command)) {
            err = ESP_ERR_INVALID_SIZE;
        }
    }
    if (err == ESP_OK) {
        err = modem_a7670_send_command_locked(command, response, sizeof(response), timeout_ms, false);
    }
    if (err == ESP_OK && !modem_a7670_parse_sms_payload_from_response(response, out_payload)) {
        err = ESP_FAIL;
    }
    if (err == ESP_OK) {
        written = snprintf(command, sizeof(command), "AT+CMGD=%d,0", storage_index);
        if (written > 0 && (size_t)written < sizeof(command)) {
            modem_a7670_send_command_locked(command, response, sizeof(response), timeout_ms, false);
        }
    }

    xSemaphoreGive(s_lock);
    return err;
}
