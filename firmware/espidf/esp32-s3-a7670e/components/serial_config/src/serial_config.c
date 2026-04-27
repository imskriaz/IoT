#include "serial_config.h"

#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "driver/uart.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"

#include "config_mgr.h"
#include "device_status.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "modem_a7670.h"

#define SERIAL_CONFIG_UART_NUM       ((uart_port_t)CONFIG_ESP_CONSOLE_UART_NUM)
#define SERIAL_CONFIG_RX_BUFFER_LEN  512
#define SERIAL_CONFIG_LINE_LEN       768
#define SERIAL_CONFIG_STATUS_JSON_LEN 3072
#define SERIAL_CONFIG_TASK_STACK_LEN CONFIG_UNIFIED_TASK_STACK_SMALL
#define SERIAL_CONFIG_READ_TIMEOUT_MS 1000U

#if defined(CONFIG_MGR_MQTT_URI_LEN) && CONFIG_MGR_MQTT_URI_LEN > CONFIG_MGR_WIFI_PASS_LEN
#define SERIAL_CONFIG_DECODED_VALUE_LEN CONFIG_MGR_MQTT_URI_LEN
#else
#define SERIAL_CONFIG_DECODED_VALUE_LEN CONFIG_MGR_WIFI_PASS_LEN
#endif

static const char *TAG = "serial_config";

typedef struct {
    char status_device_id_b64[64];
    char status_wifi_ssid_b64[96];
    char status_modem_apn_b64[96];
#if defined(CONFIG_MGR_MQTT_URI_LEN)
    char status_mqtt_uri_b64[192];
    char status_mqtt_username_b64[96];
#endif
    char modem_decoded[192];
    char modem_response[512];
    char modem_response_b64[768];
    char set_token[256];
    char set_decoded[SERIAL_CONFIG_DECODED_VALUE_LEN];
    char set_applied[192];
    char line[896];
} serial_config_scratch_t;

static TaskHandle_t s_serial_task;
static TaskHandle_t s_status_json_task;
static bool s_status_json_task_with_caps;
static bool s_ready;
static char s_serial_line[SERIAL_CONFIG_LINE_LEN];
static char *s_status_json_payload;
static serial_config_scratch_t *s_scratch;

static void serial_config_status_json_task(void *arg);

static bool serial_config_copy_string(char *dest, size_t dest_len, const char *src) {
    size_t length = 0U;

    if (!dest || !src || dest_len == 0U) {
        return false;
    }

    length = strlen(src);
    if (length >= dest_len) {
        return false;
    }

    memcpy(dest, src, length + 1U);
    return true;
}

static void serial_config_emit_line(const char *line) {
    if (!line || line[0] == '\0') {
        return;
    }

    printf("%s\r\n", line);
    fflush(stdout);
}

static void serial_config_emit_status_json(void) {
    BaseType_t task_ok = pdFAIL;

    if (s_status_json_task) {
        serial_config_emit_line("status_json ok=no code=busy");
        return;
    }
    if (!s_status_json_payload) {
        serial_config_emit_line("status_json ok=no code=status_buffer_unavailable");
        return;
    }

#if CONFIG_SPIRAM && CONFIG_SPIRAM_ALLOW_STACK_EXTERNAL_MEMORY
    task_ok = xTaskCreatePinnedToCoreWithCaps(
        serial_config_status_json_task,
        "serial_status",
        CONFIG_UNIFIED_TASK_STACK_XLARGE,
        NULL,
        tskIDLE_PRIORITY + 1,
        &s_status_json_task,
        1,
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
    );
    s_status_json_task_with_caps = task_ok == pdPASS;
#endif
    if (task_ok != pdPASS) {
        task_ok = xTaskCreatePinnedToCore(
            serial_config_status_json_task,
            "serial_status",
            CONFIG_UNIFIED_TASK_STACK_XLARGE,
            NULL,
            tskIDLE_PRIORITY + 1,
            &s_status_json_task,
            1
        );
        s_status_json_task_with_caps = false;
    }
    if (task_ok != pdPASS) {
        s_status_json_task = NULL;
        s_status_json_task_with_caps = false;
        serial_config_emit_line("status_json ok=no code=status_task_unavailable");
    }
}

static void serial_config_status_json_task(void *arg) {
    (void)arg;

    if (!s_status_json_payload) {
        serial_config_emit_line("status_json ok=no code=status_buffer_unavailable");
        s_status_json_task = NULL;
        if (s_status_json_task_with_caps) {
            vTaskDeleteWithCaps(NULL);
        } else {
            vTaskDelete(NULL);
        }
        return;
    }

    s_status_json_payload[0] = '\0';

    if (device_status_build_json(s_status_json_payload, SERIAL_CONFIG_STATUS_JSON_LEN) != ESP_OK) {
        serial_config_emit_line("status_json ok=no code=status_unavailable");
        s_status_json_task = NULL;
        if (s_status_json_task_with_caps) {
            vTaskDeleteWithCaps(NULL);
        } else {
            vTaskDelete(NULL);
        }
        return;
    }

    printf("STATUS_JSON %s\r\n", s_status_json_payload);
    fflush(stdout);
    s_status_json_task = NULL;
    if (s_status_json_task_with_caps) {
        vTaskDeleteWithCaps(NULL);
    } else {
        vTaskDelete(NULL);
    }
}

static bool serial_config_next_token(char **cursor, char *token, size_t token_len) {
    size_t length = 0U;
    char *start = NULL;

    if (!cursor || !*cursor || !token || token_len < 2U) {
        return false;
    }

    start = *cursor;
    while (*start == ' ') {
        ++start;
    }
    if (*start == '\0') {
        *cursor = start;
        return false;
    }

    while (start[length] != '\0' && start[length] != ' ') {
        ++length;
    }
    if (length >= token_len) {
        length = token_len - 1U;
    }

    memcpy(token, start, length);
    token[length] = '\0';
    *cursor = start + strnlen(start, length);
    while (**cursor != '\0' && **cursor != ' ') {
        ++(*cursor);
    }
    return true;
}

static bool serial_config_decode_b64(const char *input, char *output, size_t output_len) {
    size_t decoded_len = 0U;
    int ret = 0;

    if (!input || !output || output_len == 0U) {
        return false;
    }

    if (input[0] == '\0') {
        output[0] = '\0';
        return true;
    }

    ret = mbedtls_base64_decode(
        (unsigned char *)output,
        output_len - 1U,
        &decoded_len,
        (const unsigned char *)input,
        strlen(input)
    );
    if (ret != 0 || decoded_len >= output_len) {
        return false;
    }

    output[decoded_len] = '\0';
    return true;
}

static bool serial_config_encode_b64(const char *input, char *output, size_t output_len) {
    size_t encoded_len = 0U;
    int ret = 0;

    if (!input || !output || output_len == 0U) {
        return false;
    }

    ret = mbedtls_base64_encode(
        (unsigned char *)output,
        output_len,
        &encoded_len,
        (const unsigned char *)input,
        strlen(input)
    );
    if (ret != 0 || encoded_len >= output_len) {
        return false;
    }

    output[encoded_len] = '\0';
    return true;
}

static void serial_config_append_field(char *buffer, size_t buffer_len, const char *field) {
    size_t used = 0U;

    if (!buffer || !field || field[0] == '\0' || buffer_len == 0U) {
        return;
    }

    used = strnlen(buffer, buffer_len);
    if (used >= buffer_len - 1U) {
        return;
    }

    if (used > 0U) {
        (void)snprintf(buffer + used, buffer_len - used, ",%s", field);
    } else {
        (void)snprintf(buffer + used, buffer_len - used, "%s", field);
    }
}

#if defined(CONFIG_MGR_MQTT_URI_LEN)
static bool serial_config_parse_bool(const char *value, bool *out_value) {
    if (!value || !out_value) {
        return false;
    }

    if (strcmp(value, "1") == 0 || strcmp(value, "true") == 0 || strcmp(value, "yes") == 0 || strcmp(value, "on") == 0) {
        *out_value = true;
        return true;
    }
    if (strcmp(value, "0") == 0 || strcmp(value, "false") == 0 || strcmp(value, "no") == 0 || strcmp(value, "off") == 0) {
        *out_value = false;
        return true;
    }
    return false;
}
#endif

static void serial_config_emit_status(void) {
    config_mgr_data_t config = {0};
    serial_config_scratch_t *scratch = s_scratch;

    if (!scratch) {
        serial_config_emit_line("cfg_status ok=no code=scratch_unavailable");
        return;
    }
    memset(scratch, 0, sizeof(*scratch));

    config_mgr_snapshot(&config);
    (void)serial_config_encode_b64(config.device_id_override, scratch->status_device_id_b64, sizeof(scratch->status_device_id_b64));
    (void)serial_config_encode_b64(config.wifi_ssid, scratch->status_wifi_ssid_b64, sizeof(scratch->status_wifi_ssid_b64));
    (void)serial_config_encode_b64(config.modem_apn, scratch->status_modem_apn_b64, sizeof(scratch->status_modem_apn_b64));
#if defined(CONFIG_MGR_MQTT_URI_LEN)
    (void)serial_config_encode_b64(config.mqtt_uri, scratch->status_mqtt_uri_b64, sizeof(scratch->status_mqtt_uri_b64));
    (void)serial_config_encode_b64(config.mqtt_username, scratch->status_mqtt_username_b64, sizeof(scratch->status_mqtt_username_b64));
#endif

    (void)snprintf(
        scratch->line,
        sizeof(scratch->line),
#if defined(CONFIG_MGR_MQTT_URI_LEN)
        "cfg_status ok=yes schema=%" PRIu32 " device_id_override_b64=%s wifi_ssid_b64=%s wifi_password_set=%s modem_apn_b64=%s mqtt_enabled=%s modem_fallback_enabled=%s mqtt_uri_b64=%s mqtt_username_b64=%s mqtt_password_set=%s",
        config_mgr_schema_version(),
        scratch->status_device_id_b64,
        scratch->status_wifi_ssid_b64,
        config.wifi_password[0] != '\0' ? "yes" : "no",
        scratch->status_modem_apn_b64,
        config.mqtt_enabled ? "yes" : "no",
        config.modem_fallback_enabled ? "yes" : "no",
        scratch->status_mqtt_uri_b64,
        scratch->status_mqtt_username_b64,
        config.mqtt_password[0] != '\0' ? "yes" : "no"
#else
        "cfg_status ok=yes schema=%" PRIu32 " device_id_override_b64=%s wifi_ssid_b64=%s wifi_password_set=%s modem_apn_b64=%s",
        config_mgr_schema_version(),
        scratch->status_device_id_b64,
        scratch->status_wifi_ssid_b64,
        config.wifi_password[0] != '\0' ? "yes" : "no",
        scratch->status_modem_apn_b64
#endif
    );
    serial_config_emit_line(scratch->line);
}

static void serial_config_handle_modem_command(const char *encoded_command) {
    serial_config_scratch_t *scratch = s_scratch;
    esp_err_t err = ESP_OK;

    if (!scratch) {
        serial_config_emit_line("modem_cmd ok=no code=scratch_unavailable");
        return;
    }
    memset(scratch, 0, sizeof(*scratch));

    if (!encoded_command || encoded_command[0] == '\0') {
        serial_config_emit_line("modem_cmd ok=no code=invalid_arg detail=missing_command");
        return;
    }
    if (!serial_config_decode_b64(encoded_command, scratch->modem_decoded, sizeof(scratch->modem_decoded)) ||
        scratch->modem_decoded[0] == '\0') {
        serial_config_emit_line("modem_cmd ok=no code=invalid_arg detail=decode_failed");
        return;
    }
    if (strncmp(scratch->modem_decoded, "AT", 2) != 0) {
        serial_config_emit_line("modem_cmd ok=no code=invalid_arg detail=must_start_with_AT");
        return;
    }

    err = modem_a7670_command(scratch->modem_decoded, scratch->modem_response, sizeof(scratch->modem_response), 15000U);
    if (!serial_config_encode_b64(scratch->modem_response, scratch->modem_response_b64, sizeof(scratch->modem_response_b64))) {
        scratch->modem_response_b64[0] = '\0';
    }

    if (err == ESP_OK) {
        (void)snprintf(scratch->line, sizeof(scratch->line), "modem_cmd ok=yes response_b64=%s", scratch->modem_response_b64);
        serial_config_emit_line(scratch->line);
        return;
    }

    (void)snprintf(
        scratch->line,
        sizeof(scratch->line),
        "modem_cmd ok=no code=%s response_b64=%s",
        esp_err_to_name(err),
        scratch->modem_response_b64
    );
    serial_config_emit_line(scratch->line);
}

static void serial_config_schedule_reboot(void) {
    /* Keep restart in the serial task so config apply never depends on
     * allocating yet another FreeRTOS task under low internal RAM pressure. */
    vTaskDelay(pdMS_TO_TICKS(1200));
    esp_restart();
}

static void serial_config_handle_set(char *cursor) {
    config_mgr_data_t next = {0};
    serial_config_scratch_t *scratch = s_scratch;
    bool has_updates = false;
    esp_err_t err = ESP_OK;
#if defined(CONFIG_MGR_MQTT_URI_LEN)
    bool bool_value = false;
#endif

    if (!scratch) {
        serial_config_emit_line("cfg_apply ok=no code=scratch_unavailable");
        return;
    }
    memset(scratch, 0, sizeof(*scratch));

    config_mgr_snapshot(&next);
    while (serial_config_next_token(&cursor, scratch->set_token, sizeof(scratch->set_token))) {
        char *equals = strchr(scratch->set_token, '=');
        const char *key = scratch->set_token;
        const char *value = equals ? equals + 1 : "";

        if (!equals) {
            serial_config_emit_line("cfg_apply ok=no code=invalid_arg detail=missing_equals");
            return;
        }
        *equals = '\0';

        if (strcmp(key, "device_id_override_b64") == 0) {
            if (!serial_config_decode_b64(value, scratch->set_decoded, sizeof(scratch->set_decoded)) ||
                !serial_config_copy_string(next.device_id_override, sizeof(next.device_id_override), scratch->set_decoded)) {
                serial_config_emit_line("cfg_apply ok=no code=invalid_arg detail=device_id_override");
                return;
            }
            serial_config_append_field(scratch->set_applied, sizeof(scratch->set_applied), "device_id_override");
            has_updates = true;
        } else if (strcmp(key, "wifi_ssid_b64") == 0) {
            if (!serial_config_decode_b64(value, scratch->set_decoded, sizeof(scratch->set_decoded)) ||
                !serial_config_copy_string(next.wifi_ssid, sizeof(next.wifi_ssid), scratch->set_decoded)) {
                serial_config_emit_line("cfg_apply ok=no code=invalid_arg detail=wifi_ssid");
                return;
            }
            serial_config_append_field(scratch->set_applied, sizeof(scratch->set_applied), "wifi_ssid");
            has_updates = true;
        } else if (strcmp(key, "wifi_password_b64") == 0) {
            if (!serial_config_decode_b64(value, scratch->set_decoded, sizeof(scratch->set_decoded)) ||
                !serial_config_copy_string(next.wifi_password, sizeof(next.wifi_password), scratch->set_decoded)) {
                serial_config_emit_line("cfg_apply ok=no code=invalid_arg detail=wifi_password");
                return;
            }
            serial_config_append_field(scratch->set_applied, sizeof(scratch->set_applied), "wifi_password");
            has_updates = true;
        } else if (strcmp(key, "modem_apn_b64") == 0) {
            if (!serial_config_decode_b64(value, scratch->set_decoded, sizeof(scratch->set_decoded)) ||
                !serial_config_copy_string(next.modem_apn, sizeof(next.modem_apn), scratch->set_decoded)) {
                serial_config_emit_line("cfg_apply ok=no code=invalid_arg detail=modem_apn");
                return;
            }
            serial_config_append_field(scratch->set_applied, sizeof(scratch->set_applied), "modem_apn");
            has_updates = true;
#if defined(CONFIG_MGR_MQTT_URI_LEN)
        } else if (strcmp(key, "mqtt_uri_b64") == 0) {
            if (!serial_config_decode_b64(value, scratch->set_decoded, sizeof(scratch->set_decoded)) ||
                !serial_config_copy_string(next.mqtt_uri, sizeof(next.mqtt_uri), scratch->set_decoded)) {
                serial_config_emit_line("cfg_apply ok=no code=invalid_arg detail=mqtt_uri");
                return;
            }
            serial_config_append_field(scratch->set_applied, sizeof(scratch->set_applied), "mqtt_uri");
            has_updates = true;
        } else if (strcmp(key, "mqtt_username_b64") == 0) {
            if (!serial_config_decode_b64(value, scratch->set_decoded, sizeof(scratch->set_decoded)) ||
                !serial_config_copy_string(next.mqtt_username, sizeof(next.mqtt_username), scratch->set_decoded)) {
                serial_config_emit_line("cfg_apply ok=no code=invalid_arg detail=mqtt_username");
                return;
            }
            serial_config_append_field(scratch->set_applied, sizeof(scratch->set_applied), "mqtt_username");
            has_updates = true;
        } else if (strcmp(key, "mqtt_password_b64") == 0) {
            if (!serial_config_decode_b64(value, scratch->set_decoded, sizeof(scratch->set_decoded)) ||
                !serial_config_copy_string(next.mqtt_password, sizeof(next.mqtt_password), scratch->set_decoded)) {
                serial_config_emit_line("cfg_apply ok=no code=invalid_arg detail=mqtt_password");
                return;
            }
            serial_config_append_field(scratch->set_applied, sizeof(scratch->set_applied), "mqtt_password");
            has_updates = true;
        } else if (strcmp(key, "mqtt_enabled") == 0) {
            if (!serial_config_parse_bool(value, &bool_value)) {
                serial_config_emit_line("cfg_apply ok=no code=invalid_arg detail=mqtt_enabled");
                return;
            }
            next.mqtt_enabled = bool_value;
            serial_config_append_field(scratch->set_applied, sizeof(scratch->set_applied), "mqtt_enabled");
            has_updates = true;
        } else if (strcmp(key, "modem_fallback_enabled") == 0) {
            if (!serial_config_parse_bool(value, &bool_value)) {
                serial_config_emit_line("cfg_apply ok=no code=invalid_arg detail=modem_fallback_enabled");
                return;
            }
            next.modem_fallback_enabled = bool_value;
            serial_config_append_field(scratch->set_applied, sizeof(scratch->set_applied), "modem_fallback_enabled");
            has_updates = true;
#endif
        } else {
            serial_config_emit_line("cfg_apply ok=no code=not_supported detail=key");
            return;
        }
    }

    if (!has_updates) {
        serial_config_emit_line("cfg_apply ok=no code=invalid_arg detail=no_updates");
        return;
    }

    err = config_mgr_store(&next);
    if (err != ESP_OK) {
        serial_config_emit_line("cfg_apply ok=no code=store_failed detail=config_invalid");
        return;
    }

    if (scratch->set_applied[0] != '\0') {
        (void)snprintf(
            scratch->line,
            sizeof(scratch->line),
            "cfg_apply ok=yes restart_required=yes applied=%s",
            scratch->set_applied
        );
        serial_config_emit_line(scratch->line);
    } else {
        serial_config_emit_line("cfg_apply ok=yes restart_required=yes");
    }
    serial_config_schedule_reboot();
}

static void serial_config_handle_command(char *line) {
    char *cursor = line;

    while (*cursor == ' ') {
        ++cursor;
    }
    if (*cursor == '\0') {
        return;
    }

    if (strcmp(cursor, "cfg_get") == 0) {
        serial_config_emit_status();
        return;
    }
    if (strcmp(cursor, "status_json") == 0) {
        serial_config_emit_status_json();
        return;
    }
    if (strncmp(cursor, "modem_at_b64=", 13) == 0) {
        serial_config_handle_modem_command(cursor + 13);
        return;
    }
    if (strcmp(cursor, "cfg_reboot") == 0) {
        serial_config_emit_line("cfg_apply ok=yes restart_required=yes applied=reboot_only");
        serial_config_schedule_reboot();
        return;
    }
    if (strncmp(cursor, "cfg_set", 7) == 0 && (cursor[7] == '\0' || cursor[7] == ' ')) {
        serial_config_handle_set(cursor + 7);
        return;
    }

    serial_config_emit_line("cfg_apply ok=no code=not_supported detail=command");
}

static void serial_config_task(void *arg) {
    uint8_t byte = 0U;
    size_t index = 0U;

    (void)arg;
    ESP_LOGI(TAG, "ready uart=%d", (int)SERIAL_CONFIG_UART_NUM);
    memset(s_serial_line, 0, sizeof(s_serial_line));

    while (true) {
        int read = uart_read_bytes(
            SERIAL_CONFIG_UART_NUM,
            &byte,
            1U,
            pdMS_TO_TICKS(SERIAL_CONFIG_READ_TIMEOUT_MS)
        );

        if (read <= 0) {
            continue;
        }

        if (byte == '\r' || byte == '\n') {
            if (index > 0U) {
                s_serial_line[index] = '\0';
                serial_config_handle_command(s_serial_line);
                index = 0U;
                memset(s_serial_line, 0, sizeof(s_serial_line));
            }
            continue;
        }

        if (byte < 0x20U || byte > 0x7EU) {
            continue;
        }

        if (index + 1U >= sizeof(s_serial_line)) {
            index = 0U;
            memset(s_serial_line, 0, sizeof(s_serial_line));
            serial_config_emit_line("cfg_apply ok=no code=invalid_arg detail=line_too_long");
            continue;
        }

        s_serial_line[index++] = (char)byte;
    }
}

esp_err_t serial_config_init(void) {
    uart_config_t uart_config = {
        .baud_rate = CONFIG_ESP_CONSOLE_UART_BAUDRATE,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT
    };
    esp_err_t err = ESP_OK;
    BaseType_t task_ok = pdFAIL;

    if (s_ready) {
        return ESP_OK;
    }

    if (!uart_is_driver_installed(SERIAL_CONFIG_UART_NUM)) {
        err = uart_driver_install(SERIAL_CONFIG_UART_NUM, SERIAL_CONFIG_RX_BUFFER_LEN, 0, 0, NULL, 0);
        if (err != ESP_OK) {
            return err;
        }
        ESP_ERROR_CHECK(uart_param_config(SERIAL_CONFIG_UART_NUM, &uart_config));
    }

    if (!s_scratch) {
        s_scratch = heap_caps_calloc(
            1U,
            sizeof(*s_scratch),
            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
        );
        if (!s_scratch) {
            s_scratch = heap_caps_calloc(
                1U,
                sizeof(*s_scratch),
                MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT
            );
        }
        if (!s_scratch) {
            return ESP_ERR_NO_MEM;
        }
    }

    if (!s_status_json_payload) {
        s_status_json_payload = heap_caps_calloc(
            SERIAL_CONFIG_STATUS_JSON_LEN,
            sizeof(char),
            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
        );
        if (!s_status_json_payload) {
            s_status_json_payload = heap_caps_calloc(
                SERIAL_CONFIG_STATUS_JSON_LEN,
                sizeof(char),
                MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT
            );
        }
        if (!s_status_json_payload) {
            return ESP_ERR_NO_MEM;
        }
    }

    #if CONFIG_SPIRAM && CONFIG_SPIRAM_ALLOW_STACK_EXTERNAL_MEMORY
    task_ok = xTaskCreatePinnedToCoreWithCaps(
        serial_config_task,
        "serial_cfg",
        SERIAL_CONFIG_TASK_STACK_LEN,
        NULL,
        tskIDLE_PRIORITY + 1,
        &s_serial_task,
        1,
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
    );
    #endif
    if (task_ok != pdPASS) {
        task_ok = xTaskCreate(
            serial_config_task,
            "serial_cfg",
            SERIAL_CONFIG_TASK_STACK_LEN,
            NULL,
            tskIDLE_PRIORITY + 1,
            &s_serial_task
        );
    }
    if (task_ok != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    s_ready = true;
    return ESP_OK;
}
