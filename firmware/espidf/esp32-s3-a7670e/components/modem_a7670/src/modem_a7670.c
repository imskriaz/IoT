#include "modem_a7670.h"

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "driver/uart.h"
#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_timer.h"

#include "board_bsp.h"
#include "config_mgr.h"
#include "health_monitor.h"
#include "modem_a7670_internal.h"
#include "state_mgr.h"
#include "task_registry.h"
#include "unified_runtime.h"

#define MODEM_A7670_UART_EVENT_QUEUE_LEN          16
#define MODEM_A7670_SOCKET_ID                     0
#define MODEM_A7670_REGISTRATION_REFRESH_INTERVAL_MS  15000U
#define MODEM_A7670_SIGNAL_REFRESH_INTERVAL_MS    15000U
#define MODEM_A7670_METADATA_REFRESH_INTERVAL_MS  180000U
#define MODEM_A7670_ENV_REFRESH_INTERVAL_MS       60000U
#define MODEM_A7670_DATA_SESSION_REFRESH_INTERVAL_MS 30000U
#define MODEM_A7670_HEALTHY_REGISTRATION_REFRESH_INTERVAL_MS 60000U
#define MODEM_A7670_HEALTHY_SIGNAL_REFRESH_INTERVAL_MS 30000U
#define MODEM_A7670_HEALTHY_METADATA_REFRESH_INTERVAL_MS 600000U
#define MODEM_A7670_HEALTHY_ENV_REFRESH_INTERVAL_MS 120000U
#define MODEM_A7670_HEALTHY_DATA_SESSION_REFRESH_INTERVAL_MS 60000U

#ifndef CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH
#define CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH  8
#endif

#ifndef CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN
#define CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN  2048
#endif

#define MODEM_A7670_UART_PARSE_LINE_LEN  (CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN + 64U)
#define MODEM_A7670_MQTT_QUEUE_DEPTH      12
#define MODEM_A7670_MQTT_TOPIC_LEN        160

typedef struct {
    char topic[MODEM_A7670_MQTT_TOPIC_LEN];
    char payload[CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN];
} modem_a7670_mqtt_message_t;

typedef struct {
    char task_urc_buffer[MODEM_A7670_UART_PARSE_LINE_LEN];
    char probe_response[160];
    char probe_urc_buffer[MODEM_A7670_UART_PARSE_LINE_LEN];
    char data_session_response[sizeof(((modem_a7670_status_t *)0)->last_response)];
    char data_session_ip_address[UNIFIED_IPV4_ADDR_LEN];
    char parse_line[MODEM_A7670_UART_PARSE_LINE_LEN];
    char parse_fragment[MODEM_A7670_UART_PARSE_LINE_LEN];
    char ussd_response_buffer[CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN];
    bool ussd_response_pending;
    bool ussd_response_session_active;
    bool ussd_request_active;
    uint32_t ussd_request_deadline_ms;
    bool sms_delivery_pdu_pending;
    uint16_t sms_delivery_pdu_expected_length;
} modem_a7670_runtime_scratch_t;

const char *TAG = "modem_a7670";

SemaphoreHandle_t s_lock;
modem_a7670_status_t s_status;
static modem_a7670_status_t s_public_status;
QueueHandle_t s_uart_event_queue;
bool s_ready;
bool s_uart_control_ready;
static bool s_modem_task_started;
bool s_at_echo_disabled;
static bool s_telephony_baseline_configured;
static int s_sms_index_queue[CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH];
static size_t s_sms_head;
static size_t s_sms_count;
static unified_sms_delivery_payload_t s_sms_delivery_queue[CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH];
static size_t s_sms_delivery_head;
static size_t s_sms_delivery_count;
static modem_a7670_mqtt_message_t s_mqtt_queue[MODEM_A7670_MQTT_QUEUE_DEPTH];
static size_t s_mqtt_head;
static size_t s_mqtt_count;
static bool s_mqtt_service_started;
static bool s_mqtt_connected;
static void (*s_mqtt_event_listener)(void);
static void (*s_sms_event_listener)(void);
static bool s_mqtt_rx_expect_topic;
static bool s_mqtt_rx_expect_payload;
static size_t s_mqtt_rx_expected_topic_len;
static size_t s_mqtt_rx_expected_payload_len;
static size_t s_mqtt_rx_topic_fragment_remaining;
static size_t s_mqtt_rx_payload_fragment_remaining;
static size_t s_mqtt_rx_topic_bytes;
static size_t s_mqtt_rx_payload_bytes;
static char s_mqtt_rx_topic[MODEM_A7670_MQTT_TOPIC_LEN];
static char s_mqtt_rx_payload[CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN];
static unified_ussd_payload_t s_ussd_queue[CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH];
static size_t s_ussd_head;
static size_t s_ussd_count;
char s_last_ussd_code[UNIFIED_TEXT_SHORT_LEN];
static modem_a7670_runtime_scratch_t s_runtime_scratch;
static bool s_verbose_errors_configured;
static bool s_operator_format_configured;
static uint32_t s_last_registration_refresh_ms;
static uint32_t s_last_signal_refresh_ms;
static uint32_t s_last_metadata_refresh_ms;
static uint32_t s_last_environment_refresh_ms;
static uint32_t s_last_data_session_refresh_ms;
static bool s_imei_refresh_pending;
static bool s_subscriber_refresh_pending;
static bool s_metadata_refresh_pending;

esp_err_t modem_a7670_send_command_locked(
    const char *command,
    char *response,
    size_t response_len,
    uint32_t timeout_ms,
    bool wait_for_prompt
);
void modem_a7670_parse_response_locked(const char *response);
esp_err_t modem_a7670_read_until_quiet_locked(char *response, size_t response_len, uint32_t quiet_ms);
static esp_err_t modem_a7670_read_until_quiet_bounded_locked(
    char *response,
    size_t response_len,
    uint32_t quiet_ms,
    uint32_t max_total_ms
);
esp_err_t modem_a7670_read_response_locked(
    char *response,
    size_t response_len,
    uint32_t timeout_ms,
    bool wait_for_prompt
);
static esp_err_t modem_a7670_read_response_until_phrase_locked(
    char *response,
    size_t response_len,
    uint32_t timeout_ms,
    const char *phrase
);
static size_t modem_a7670_skip_crlf_bytes(const char *buffer, size_t buffer_len, size_t offset);
static void modem_a7670_reset_mqtt_rx_locked(void);
static void modem_a7670_reset_uart_parse_fragment_locked(void);
static void modem_a7670_reset_pending_ussd_response_locked(void);
void modem_a7670_clear_ussd_request_locked(void);
void modem_a7670_arm_ussd_request_locked(uint32_t timeout_ms);
static void modem_a7670_handle_ussd_request_timeout_locked(void);
static bool modem_a7670_mqtt_rx_capture_active_locked(void);
static size_t modem_a7670_parse_cmqttrx_length(const char *line);
static bool modem_a7670_parse_cmqttrx_start_lengths(const char *line, size_t *topic_len, size_t *payload_len);
static void modem_a7670_append_fragment(char *dest, size_t dest_len, const char *fragment);
static bool modem_a7670_mqtt_topic_is_command(const char *topic);
static bool modem_a7670_infer_mqtt_topic_from_payload_locked(char *topic, size_t topic_len, const char *payload);
static void modem_a7670_queue_mqtt_message_locked(const char *topic, const char *payload);
static void modem_a7670_queue_completed_mqtt_rx_locked(void);
static void modem_a7670_queue_sms_index_locked(int index);
static void modem_a7670_queue_sms_delivery_locked(const unified_sms_delivery_payload_t *payload);
static void modem_a7670_queue_ussd_result_locked(const unified_ussd_payload_t *payload);
static void modem_a7670_parse_sms_index_locked(const char *line);
static void modem_a7670_parse_sms_delivery_report_locked(const char *line);
static bool modem_a7670_parse_sms_delivery_report_pdu_locked(const char *pdu_hex, uint16_t expected_tpdu_length);
static void modem_a7670_parse_ussd_result_locked(const char *line);
static esp_err_t modem_a7670_refresh_data_session_locked(uint32_t timeout_ms);
static esp_err_t modem_a7670_open_network_stack_locked(char *response, size_t response_len, uint32_t timeout_ms);
static esp_err_t modem_a7670_start_task_locked(void);
static esp_err_t modem_a7670_init_uart_control_locked(const uart_config_t *uart_config);
static esp_err_t modem_a7670_probe_uart_sideband(bool refresh_data_session);
bool modem_a7670_uart_control_blocked_locked(void);
static void modem_a7670_task(void *arg);
static void modem_a7670_parse_cbc_locked(const char *line);
static void modem_a7670_parse_imei_response_locked(const char *response);
static esp_err_t modem_a7670_mqtt_subscribe_locked(
    const char *topic,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
);
static esp_err_t modem_a7670_mqtt_publish_legacy_locked(
    const char *topic,
    const char *payload,
    int qos,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
);

static bool modem_a7670_response_has_success(const char *response) {
    return response && (strstr(response, "\r\nOK\r\n") != NULL || strstr(response, "\nOK\r\n") != NULL);
}

static bool modem_a7670_response_has_error(const char *response) {
    return response && (
        strstr(response, "\r\nERROR\r\n") != NULL ||
        strstr(response, "\nERROR\r\n") != NULL ||
        strstr(response, "+CMS ERROR:") != NULL ||
        strstr(response, "+CME ERROR:") != NULL
    );
}

static bool modem_a7670_response_has_prompt(const char *response) {
    return response && (strstr(response, "\r\n>") != NULL || strstr(response, "\n>") != NULL);
}

static bool modem_a7670_response_has_phrase(const char *response, const char *phrase) {
    return response && phrase && strstr(response, phrase) != NULL;
}

static bool modem_a7670_response_has_mqtt_start_ready(const char *response) {
    return modem_a7670_response_has_phrase(response, "+CMQTTSTART: 0") ||
           modem_a7670_response_has_phrase(response, "+CMQTTSTART: 23") ||
           modem_a7670_response_has_phrase(response, "already");
}

static bool modem_a7670_response_has_mqtt_stop_done(const char *response) {
    return modem_a7670_response_has_phrase(response, "+CMQTTSTOP:");
}

static bool modem_a7670_refresh_due(uint32_t now_ms, uint32_t last_refresh_ms, uint32_t interval_ms) {
    if (last_refresh_ms == 0U) {
        return true;
    }

    return (now_ms - last_refresh_ms) >= interval_ms;
}

static bool modem_a7670_extract_quoted_field(const char *line, int field_index, char *out_value, size_t out_len) {
    const char *cursor = line;
    int current_index = 0;

    if (!line || !out_value || out_len == 0U || field_index < 0) {
        return false;
    }

    out_value[0] = '\0';
    while ((cursor = strchr(cursor, '"')) != NULL) {
        const char *scan = cursor + 1;
        size_t written = 0U;
        bool escape = false;

        while (*scan != '\0') {
            if (!escape && *scan == '\\') {
                escape = true;
                ++scan;
                continue;
            }
            if (!escape && *scan == '"') {
                if (current_index == field_index) {
                    out_value[written] = '\0';
                    return true;
                }
                current_index++;
                cursor = scan + 1;
                break;
            }
            if (current_index == field_index && written + 1U < out_len) {
                char value = *scan;

                if (escape) {
                    switch (*scan) {
                        case 'n':
                            value = '\n';
                            break;
                        case 'r':
                            value = '\r';
                            break;
                        case 't':
                            value = '\t';
                            break;
                        default:
                            break;
                    }
                }
                out_value[written++] = value;
            }
            escape = false;
            ++scan;
        }
        if (*scan == '\0') {
            return false;
        }
    }

    return false;
}

static bool modem_a7670_parse_cmqttrecv_line(
    const char *line,
    char *topic,
    size_t topic_len,
    char *payload,
    size_t payload_len
) {
    const char *topic_start = NULL;
    const char *topic_end = NULL;
    const char *cursor = NULL;
    const char *payload_start = NULL;
    char *length_end = NULL;
    long declared_payload_len = -1L;
    size_t available_payload_len = 0U;
    size_t copy_len = 0U;

    if (!line || !topic || topic_len == 0U || !payload || payload_len == 0U) {
        return false;
    }

    topic[0] = '\0';
    payload[0] = '\0';
    if (!modem_a7670_extract_quoted_field(line, 0, topic, topic_len) || topic[0] == '\0') {
        return false;
    }

    topic_start = strchr(line, '"');
    if (!topic_start) {
        return false;
    }
    topic_end = strchr(topic_start + 1, '"');
    if (!topic_end) {
        return false;
    }

    cursor = topic_end + 1;
    while (*cursor == ' ' || *cursor == ',') {
        ++cursor;
    }
    if (*cursor >= '0' && *cursor <= '9') {
        declared_payload_len = strtol(cursor, &length_end, 10);
        if (length_end == cursor || declared_payload_len < 0L) {
            return false;
        }
        cursor = length_end;
        while (*cursor == ' ' || *cursor == ',') {
            ++cursor;
        }
    }
    if (*cursor != '"') {
        return false;
    }

    payload_start = cursor + 1;
    available_payload_len = strlen(payload_start);
    if (available_payload_len > 0U && payload_start[available_payload_len - 1U] == '"') {
        available_payload_len--;
    }
    if (declared_payload_len >= 0L) {
        copy_len = (size_t)declared_payload_len;
        if (copy_len > available_payload_len) {
            return false;
        }
    } else {
        copy_len = available_payload_len;
    }
    if (copy_len >= payload_len) {
        copy_len = payload_len - 1U;
    }
    memcpy(payload, payload_start, copy_len);
    payload[copy_len] = '\0';
    return true;
}

static void modem_a7670_copy_digits_with_plus(const char *input, char *output, size_t output_len) {
    size_t write_index = 0U;
    bool seen_digit = false;

    if (!output || output_len == 0U) {
        return;
    }

    output[0] = '\0';
    if (!input) {
        return;
    }

    for (const char *cursor = input; *cursor != '\0' && write_index + 1U < output_len; ++cursor) {
        const char current = *cursor;

        if (current == '+' && !seen_digit && write_index == 0U) {
            output[write_index++] = current;
            continue;
        }

        if (current >= '0' && current <= '9') {
            output[write_index++] = current;
            seen_digit = true;
        }
    }

    if (!seen_digit) {
        output[0] = '\0';
        return;
    }

    output[write_index] = '\0';
}

static bool modem_a7670_extract_subscriber_number_candidate(const char *line, char *out_value, size_t out_len) {
    const char *cursor = line;
    const char *start = NULL;
    const char *end = NULL;

    if (!line || !out_value || out_len == 0U) {
        return false;
    }

    out_value[0] = '\0';

    while ((start = strchr(cursor, '"')) != NULL) {
        char candidate[sizeof(s_status.subscriber_number)] = {0};
        end = strchr(start + 1, '"');
        if (!end) {
            break;
        }

        snprintf(candidate, sizeof(candidate), "%.*s", (int)(end - (start + 1)), start + 1);
        modem_a7670_copy_digits_with_plus(candidate, out_value, out_len);
        if (out_value[0] != '\0') {
            return true;
        }
        cursor = end + 1;
    }

    modem_a7670_copy_digits_with_plus(line, out_value, out_len);
    return out_value[0] != '\0';
}

static bool modem_a7670_parse_phonebook_subscriber_response_locked(
    const char *response,
    char *out_value,
    size_t out_len
) {
    const char *cursor = response;

    if (!response || !out_value || out_len == 0U) {
        return false;
    }

    out_value[0] = '\0';

    while (cursor && *cursor != '\0') {
        const char *line_end = strpbrk(cursor, "\r\n");
        size_t line_len = line_end ? (size_t)(line_end - cursor) : strlen(cursor);
        char line[192] = {0};

        if (line_len >= sizeof(line)) {
            line_len = sizeof(line) - 1U;
        }

        if (line_len > 0U) {
            memcpy(line, cursor, line_len);
            line[line_len] = '\0';

            if (strncmp(line, "+CPBR:", 6) == 0 &&
                modem_a7670_extract_subscriber_number_candidate(line, out_value, out_len)) {
                return true;
            }
        }

        if (!line_end) {
            break;
        }

        cursor = line_end;
        while (*cursor == '\r' || *cursor == '\n') {
            ++cursor;
        }
    }

    return false;
}

void modem_a7670_publish_status_locked(void) {
    s_public_status = s_status;
}

static void modem_a7670_set_health_locked(void) {
    health_module_state_t module_state = HEALTH_MODULE_STATE_OK;
    const char *detail = "running";

    if (!s_status.network_registered) {
        module_state = HEALTH_MODULE_STATE_DEGRADED;
        detail = s_status.timeout_count > 0 ? "probe_timeout" : "network_unregistered";
        s_status.runtime.state = UNIFIED_MODULE_STATE_DEGRADED;
    } else {
        s_status.runtime.state = UNIFIED_MODULE_STATE_RUNNING;
    }

    health_monitor_set_module_state("modem_a7670", module_state, detail);
}

static void modem_a7670_reset_mqtt_rx_locked(void) {
    s_mqtt_rx_expect_topic = false;
    s_mqtt_rx_expect_payload = false;
    s_mqtt_rx_expected_topic_len = 0U;
    s_mqtt_rx_expected_payload_len = 0U;
    s_mqtt_rx_topic_fragment_remaining = 0U;
    s_mqtt_rx_payload_fragment_remaining = 0U;
    s_mqtt_rx_topic_bytes = 0U;
    s_mqtt_rx_payload_bytes = 0U;
    s_mqtt_rx_topic[0] = '\0';
    s_mqtt_rx_payload[0] = '\0';
}

static void modem_a7670_reset_uart_parse_fragment_locked(void) {
    s_runtime_scratch.parse_fragment[0] = '\0';
}

static void modem_a7670_reset_pending_ussd_response_locked(void) {
    s_runtime_scratch.ussd_response_buffer[0] = '\0';
    s_runtime_scratch.ussd_response_pending = false;
    s_runtime_scratch.ussd_response_session_active = false;
}

void modem_a7670_clear_ussd_request_locked(void) {
    s_runtime_scratch.ussd_request_active = false;
    s_runtime_scratch.ussd_request_deadline_ms = 0U;
}

void modem_a7670_arm_ussd_request_locked(uint32_t timeout_ms) {
    uint32_t effective_timeout_ms = timeout_ms;

    if (effective_timeout_ms < 1000U) {
        effective_timeout_ms = 1000U;
    }

    s_runtime_scratch.ussd_request_active = true;
    s_runtime_scratch.ussd_request_deadline_ms = unified_tick_now_ms() + effective_timeout_ms;
}

static bool modem_a7670_mqtt_rx_capture_active_locked(void) {
    return s_mqtt_rx_expect_topic ||
           s_mqtt_rx_expect_payload ||
           s_mqtt_rx_topic[0] != '\0' ||
           s_mqtt_rx_payload[0] != '\0';
}

static size_t modem_a7670_parse_cmqttrx_length(const char *line) {
    const char *marker = NULL;
    char *end = NULL;
    long value = 0;

    if (!line) {
        return 0U;
    }

    marker = strrchr(line, ',');
    if (!marker) {
        marker = strchr(line, ':');
    }
    if (!marker) {
        return 0U;
    }

    value = strtol(marker + 1, &end, 10);
    if (end == (marker + 1) || value < 0L) {
        return 0U;
    }

    return (size_t)value;
}

static bool modem_a7670_parse_cmqttrx_start_lengths(const char *line, size_t *topic_len, size_t *payload_len) {
    unsigned int parsed_topic_len = 0U;
    unsigned int parsed_payload_len = 0U;
    int client_index = 0;

    if (!line || !topic_len || !payload_len) {
        return false;
    }

    if (sscanf(line, "+CMQTTRXSTART: %d,%u,%u", &client_index, &parsed_topic_len, &parsed_payload_len) != 3) {
        return false;
    }

    *topic_len = (size_t)parsed_topic_len;
    *payload_len = (size_t)parsed_payload_len;
    return true;
}

static void modem_a7670_append_fragment(char *dest, size_t dest_len, const char *fragment) {
    size_t used = 0U;
    size_t fragment_len = 0U;
    size_t copy_len = 0U;

    if (!dest || dest_len == 0U || !fragment || fragment[0] == '\0') {
        return;
    }

    used = strnlen(dest, dest_len);
    if (used >= (dest_len - 1U)) {
        return;
    }
    fragment_len = strlen(fragment);
    copy_len = fragment_len < ((dest_len - 1U) - used) ? fragment_len : ((dest_len - 1U) - used);
    memcpy(dest + used, fragment, copy_len);
    dest[used + copy_len] = '\0';
}

static bool modem_a7670_mqtt_topic_is_command(const char *topic) {
    if (!topic || topic[0] == '\0') {
        return false;
    }

    return strstr(topic, "/command/") != NULL || strstr(topic, "/cmd/") != NULL;
}

static bool modem_a7670_infer_mqtt_topic_from_payload_locked(char *topic, size_t topic_len, const char *payload) {
    const char *marker = "\"command\":\"";
    const char *start = NULL;
    const char *end = NULL;
    char command[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    board_bsp_identity_t identity = {0};
    char device_id_override[CONFIG_MGR_DEVICE_ID_LEN] = {0};
    char mqtt_topic_prefix[CONFIG_MGR_TOPIC_PREFIX] = {0};

    if (!topic || topic_len == 0U || !payload || payload[0] == '\0') {
        return false;
    }

    start = strstr(payload, marker);
    if (!start) {
        return false;
    }
    start += strlen(marker);
    end = strchr(start, '"');
    if (!end || end <= start) {
        return false;
    }

    snprintf(command, sizeof(command), "%.*s", (int)(end - start), start);
    for (size_t index = 0U; command[index] != '\0'; ++index) {
        if (command[index] == '_') {
            command[index] = '-';
        }
    }

    board_bsp_get_identity(&identity);
    config_mgr_get_device_id_override(device_id_override, sizeof(device_id_override));
    config_mgr_get_mqtt_topic_prefix(mqtt_topic_prefix, sizeof(mqtt_topic_prefix));
    snprintf(
        topic,
        topic_len,
        "%s/%s/command/%s",
        mqtt_topic_prefix[0] ? mqtt_topic_prefix : "device",
        device_id_override[0] ? device_id_override : identity.device_id,
        command
    );
    return true;
}

static void modem_a7670_queue_mqtt_message_locked(const char *topic, const char *payload) {
    size_t write_index = 0;
    void (*listener)(void) = NULL;

    if (!topic || topic[0] == '\0') {
        return;
    }

    if (s_mqtt_count < MODEM_A7670_MQTT_QUEUE_DEPTH) {
        write_index = (s_mqtt_head + s_mqtt_count) % MODEM_A7670_MQTT_QUEUE_DEPTH;
        s_mqtt_count++;
    } else {
        write_index = s_mqtt_head;
        s_mqtt_head = (s_mqtt_head + 1U) % MODEM_A7670_MQTT_QUEUE_DEPTH;
        s_status.timeout_count++;
    }

    snprintf(s_mqtt_queue[write_index].topic, sizeof(s_mqtt_queue[write_index].topic), "%s", topic);
    unified_copy_cstr(s_mqtt_queue[write_index].payload, sizeof(s_mqtt_queue[write_index].payload), payload);
    ESP_LOGI(TAG, "mqtt queued topic=%s payload_len=%u depth=%u", topic, (unsigned)strlen(payload ? payload : ""), (unsigned)s_mqtt_count);
    listener = s_mqtt_event_listener;
    if (listener) {
        listener();
    }
}

static void modem_a7670_trim_mqtt_json_payload_locked(void) {
    char *json_end = NULL;

    if (s_mqtt_rx_payload[0] != '{') {
        return;
    }

    json_end = strrchr(s_mqtt_rx_payload, '}');
    if (json_end && json_end[1] != '\0') {
        json_end[1] = '\0';
        s_mqtt_rx_payload_bytes = strlen(s_mqtt_rx_payload);
    }
}

static void modem_a7670_queue_completed_mqtt_rx_locked(void) {
    if (!modem_a7670_mqtt_topic_is_command(s_mqtt_rx_topic)) {
        s_mqtt_rx_topic[0] = '\0';
        (void)modem_a7670_infer_mqtt_topic_from_payload_locked(
            s_mqtt_rx_topic,
            sizeof(s_mqtt_rx_topic),
            s_mqtt_rx_payload
        );
    }

    modem_a7670_trim_mqtt_json_payload_locked();
    if (s_mqtt_rx_topic[0] != '\0' && s_mqtt_rx_payload[0] != '\0') {
        modem_a7670_queue_mqtt_message_locked(s_mqtt_rx_topic, s_mqtt_rx_payload);
    }
    modem_a7670_reset_mqtt_rx_locked();
}

static void modem_a7670_queue_sms_index_locked(int index) {
    size_t write_index = 0;

    if (index < 0) {
        return;
    }

    for (size_t i = 0; i < s_sms_count; ++i) {
        if (s_sms_index_queue[(s_sms_head + i) % CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH] == index) {
            return;
        }
    }

    if (s_sms_count < CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH) {
        write_index = (s_sms_head + s_sms_count) % CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH;
        s_sms_count++;
    } else {
        write_index = s_sms_head;
        s_sms_head = (s_sms_head + 1U) % CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH;
        s_status.timeout_count++;
    }

    s_sms_index_queue[write_index] = index;
    if (s_sms_event_listener) {
        s_sms_event_listener();
    }
}

static void modem_a7670_queue_sms_delivery_locked(const unified_sms_delivery_payload_t *payload) {
    size_t write_index = 0U;

    if (!payload) {
        return;
    }

    if (s_sms_delivery_count < CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH) {
        write_index = (s_sms_delivery_head + s_sms_delivery_count) % CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH;
        s_sms_delivery_count++;
    } else {
        write_index = s_sms_delivery_head;
        s_sms_delivery_head = (s_sms_delivery_head + 1U) % CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH;
        s_status.timeout_count++;
    }

    s_sms_delivery_queue[write_index] = *payload;
    if (s_sms_event_listener) {
        s_sms_event_listener();
    }
}

static void modem_a7670_queue_ussd_result_locked(const unified_ussd_payload_t *payload) {
    size_t write_index = 0U;

    if (!payload) {
        return;
    }

    if (s_ussd_count < CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH) {
        write_index = (s_ussd_head + s_ussd_count) % CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH;
        s_ussd_count++;
    } else {
        write_index = s_ussd_head;
        s_ussd_head = (s_ussd_head + 1U) % CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH;
        s_status.timeout_count++;
    }

    s_ussd_queue[write_index] = *payload;
}

static void modem_a7670_queue_ussd_payload_locked(bool session_active, const char *status, const char *response) {
    unified_ussd_payload_t payload = {0};

    snprintf(payload.code, sizeof(payload.code), "%s", s_last_ussd_code);
    snprintf(
        payload.status,
        sizeof(payload.status),
        "%s",
        status && status[0] != '\0'
            ? status
            : (session_active ? "active" : (response && response[0] != '\0' ? "success" : "cancelled"))
    );
    payload.session_active = session_active;
    payload.sim_slot = 0U;
    payload.timestamp_ms = unified_time_now_ms();
    if (response) {
        snprintf(payload.response, sizeof(payload.response), "%s", response);
    }

    modem_a7670_queue_ussd_result_locked(&payload);
}

static void modem_a7670_parse_sms_index_locked(const char *line) {
    const char *comma = NULL;
    int index = -1;

    if (!line) {
        return;
    }

    comma = strrchr(line, ',');
    if (!comma || sscanf(comma + 1, "%d", &index) != 1) {
        return;
    }

    modem_a7670_queue_sms_index_locked(index);
}

static int modem_a7670_sms_delivery_hex_nibble(char value) {
    if (value >= '0' && value <= '9') {
        return value - '0';
    }
    if (value >= 'A' && value <= 'F') {
        return value - 'A' + 10;
    }
    if (value >= 'a' && value <= 'f') {
        return value - 'a' + 10;
    }
    return -1;
}

static bool modem_a7670_sms_delivery_hex_byte_at(const char *hex, size_t byte_index, uint8_t *out_value) {
    const size_t hex_index = byte_index * 2U;
    int high = 0;
    int low = 0;

    if (!hex || !out_value || hex[hex_index] == '\0' || hex[hex_index + 1U] == '\0') {
        return false;
    }

    high = modem_a7670_sms_delivery_hex_nibble(hex[hex_index]);
    low = modem_a7670_sms_delivery_hex_nibble(hex[hex_index + 1U]);
    if (high < 0 || low < 0) {
        return false;
    }

    *out_value = (uint8_t)((high << 4) | low);
    return true;
}

static bool modem_a7670_parse_sms_delivery_report_pdu_locked(const char *pdu_hex, uint16_t expected_tpdu_length) {
    unified_sms_delivery_payload_t payload = {0};
    const char *hex = pdu_hex;
    size_t hex_len = 0U;
    size_t total_bytes = 0U;
    size_t tpdu_offset = 0U;
    size_t address_digits = 0U;
    size_t address_octets = 0U;
    size_t address_value_offset = 0U;
    size_t status_offset = 0U;
    uint8_t smsc_len = 0U;
    uint8_t first_octet = 0U;
    uint8_t message_reference = 0U;
    uint8_t address_toa = 0U;
    uint8_t status = 0U;

    if (!hex) {
        return false;
    }
    while (*hex == ' ') {
        hex++;
    }

    hex_len = strlen(hex);
    while (hex_len > 0U && hex[hex_len - 1U] == ' ') {
        hex_len--;
    }
    if (hex_len < 2U || (hex_len % 2U) != 0U) {
        return false;
    }
    for (size_t index = 0U; index < hex_len; ++index) {
        if (modem_a7670_sms_delivery_hex_nibble(hex[index]) < 0) {
            return false;
        }
    }

    total_bytes = hex_len / 2U;
    if (total_bytes < 2U) {
        return false;
    }

    if (expected_tpdu_length > 0U && total_bytes >= expected_tpdu_length) {
        tpdu_offset = total_bytes - (size_t)expected_tpdu_length;
    } else if (modem_a7670_sms_delivery_hex_byte_at(hex, 0U, &smsc_len) &&
               total_bytes > ((size_t)smsc_len + 1U)) {
        tpdu_offset = (size_t)smsc_len + 1U;
    } else {
        tpdu_offset = 0U;
    }

    if (tpdu_offset + 4U >= total_bytes ||
        !modem_a7670_sms_delivery_hex_byte_at(hex, tpdu_offset, &first_octet) ||
        !modem_a7670_sms_delivery_hex_byte_at(hex, tpdu_offset + 1U, &message_reference) ||
        !modem_a7670_sms_delivery_hex_byte_at(hex, tpdu_offset + 2U, &smsc_len) ||
        !modem_a7670_sms_delivery_hex_byte_at(hex, tpdu_offset + 3U, &address_toa)) {
        return false;
    }

    if ((first_octet & 0x03U) != 0x02U) {
        return false;
    }

    address_digits = smsc_len;
    address_octets = (address_digits + 1U) / 2U;
    address_value_offset = tpdu_offset + 4U;
    status_offset = address_value_offset + address_octets + 14U;
    if (status_offset >= total_bytes ||
        !modem_a7670_sms_delivery_hex_byte_at(hex, status_offset, &status)) {
        return false;
    }

    if ((address_toa & 0x70U) == 0x10U) {
        unified_copy_cstr(payload.to, sizeof(payload.to), "+");
    }
    for (size_t digit = 0U; digit < address_digits; ++digit) {
        uint8_t semi_octet = 0U;
        uint8_t nibble = 0U;
        size_t current_len = strlen(payload.to);

        if (current_len + 1U >= sizeof(payload.to) ||
            !modem_a7670_sms_delivery_hex_byte_at(hex, address_value_offset + (digit / 2U), &semi_octet)) {
            break;
        }

        nibble = (digit % 2U) == 0U
            ? (uint8_t)(semi_octet & 0x0FU)
            : (uint8_t)((semi_octet >> 4) & 0x0FU);
        if (nibble <= 9U) {
            payload.to[current_len] = (char)('0' + nibble);
            payload.to[current_len + 1U] = '\0';
        }
    }

    payload.message_reference = message_reference;
    payload.status_report_status = status;
    payload.sim_slot = 0U;
    payload.timestamp_ms = unified_time_now_ms();
    unified_copy_cstr(payload.raw, sizeof(payload.raw), hex);

    modem_a7670_queue_sms_delivery_locked(&payload);
    return true;
}

static void modem_a7670_parse_sms_delivery_report_locked(const char *line) {
    unified_sms_delivery_payload_t payload = {0};
    const char *cursor = NULL;
    const char *comma = NULL;
    char *end = NULL;
    long fo = -1;
    long mr = -1;
    long st = -1;

    if (!line || strncmp(line, "+CDS:", 5) != 0) {
        return;
    }

    cursor = strchr(line, ':');
    if (!cursor) {
        return;
    }
    cursor++;
    while (*cursor == ' ') {
        cursor++;
    }

    fo = strtol(cursor, &end, 10);
    if (end == cursor) {
        return;
    }
    while (*end == ' ') {
        end++;
    }
    if (*end != ',') {
        if (*end == '\0' && fo > 0 && fo <= UINT16_MAX) {
            s_runtime_scratch.sms_delivery_pdu_pending = true;
            s_runtime_scratch.sms_delivery_pdu_expected_length = (uint16_t)fo;
        }
        return;
    }

    cursor = end + 1;
    while (*cursor == ' ') {
        cursor++;
    }
    mr = strtol(cursor, &end, 10);
    if (end == cursor || mr < 0 || mr > UINT16_MAX) {
        return;
    }

    comma = strrchr(line, ',');
    if (!comma) {
        return;
    }
    st = strtol(comma + 1, &end, 10);
    if (end == comma + 1 || st < 0 || st > UINT16_MAX) {
        return;
    }

    (void)fo;
    (void)modem_a7670_extract_quoted_field(line, 0, payload.to, sizeof(payload.to));
    payload.message_reference = (uint16_t)mr;
    payload.status_report_status = (uint16_t)st;
    payload.sim_slot = 0U;
    payload.timestamp_ms = unified_time_now_ms();
    unified_copy_cstr(payload.raw, sizeof(payload.raw), line);

    modem_a7670_queue_sms_delivery_locked(&payload);
}

static void modem_a7670_parse_ussd_result_locked(const char *line) {
    const char *cursor = NULL;
    const char *payload_field = NULL;
    const char *payload_start = NULL;
    const char *payload_end = NULL;
    int session_state = -1;

    if (!line || strncmp(line, "+CUSD:", 6) != 0) {
        return;
    }

    cursor = strchr(line, ':');
    if (cursor) {
        (void)sscanf(cursor + 1, " %d", &session_state);
    }

    modem_a7670_reset_pending_ussd_response_locked();
    modem_a7670_clear_ussd_request_locked();

    payload_field = cursor ? strchr(cursor, ',') : NULL;
    if (!payload_field) {
        modem_a7670_queue_ussd_payload_locked(session_state == 1, NULL, "");
        return;
    }

    payload_field++;
    while (*payload_field == ' ') {
        ++payload_field;
    }

    if (*payload_field != '"') {
        modem_a7670_queue_ussd_payload_locked(session_state == 1, NULL, "");
        return;
    }

    payload_start = payload_field + 1;
    payload_end = strrchr(payload_start, '"');
    if (payload_end && payload_end > payload_start) {
        char response[UNIFIED_TEXT_MEDIUM_LEN] = {0};
        snprintf(response, sizeof(response), "%.*s", (int)(payload_end - payload_start), payload_start);
        modem_a7670_queue_ussd_payload_locked(session_state == 1, NULL, response);
        return;
    }

    s_runtime_scratch.ussd_response_pending = true;
    s_runtime_scratch.ussd_response_session_active = (session_state == 1);
    if (*payload_start != '\0') {
        modem_a7670_append_fragment(
            s_runtime_scratch.ussd_response_buffer,
            sizeof(s_runtime_scratch.ussd_response_buffer),
            payload_start
        );
    }
}

static size_t modem_a7670_skip_crlf_bytes(const char *buffer, size_t buffer_len, size_t offset) {
    while (buffer && offset < buffer_len && (buffer[offset] == '\r' || buffer[offset] == '\n')) {
        offset++;
    }
    return offset;
}

static void modem_a7670_parse_operator_locked(const char *line) {
    char operator_name[sizeof(s_status.operator_name)] = {0};

    if (!line) {
        return;
    }

    if (modem_a7670_extract_quoted_field(line, 0, operator_name, sizeof(operator_name))) {
        snprintf(s_status.operator_name, sizeof(s_status.operator_name), "%s", operator_name);
    }
}

static void modem_a7670_parse_network_type_locked(const char *line) {
    const char *marker = NULL;
    const char *value = NULL;
    const char *end = NULL;
    size_t length = 0U;
    char network_type[sizeof(s_status.network_type)] = {0};

    if (!line) {
        return;
    }

    marker = strstr(line, "+CPSI:");
    if (!marker) {
        return;
    }

    value = marker + strlen("+CPSI:");
    while (*value == ' ') {
        ++value;
    }

    end = strchr(value, ',');
    if (!end) {
        end = value + strlen(value);
    }
    while (end > value && (end[-1] == ' ' || end[-1] == '\r' || end[-1] == '\n')) {
        --end;
    }

    length = (size_t)(end - value);
    if (length == 0U) {
        s_status.network_type[0] = '\0';
        return;
    }
    if (length >= sizeof(network_type)) {
        length = sizeof(network_type) - 1U;
    }

    memcpy(network_type, value, length);
    network_type[length] = '\0';
    snprintf(s_status.network_type, sizeof(s_status.network_type), "%s", network_type);
}

static void modem_a7670_parse_subscriber_number_locked(const char *line) {
    char number[sizeof(s_status.subscriber_number)] = {0};

    if (!line) {
        return;
    }

    if (modem_a7670_extract_subscriber_number_candidate(line, number, sizeof(number))) {
        snprintf(s_status.subscriber_number, sizeof(s_status.subscriber_number), "%s", number);
    }
}

static void modem_a7670_refresh_subscriber_number_locked(char *response, size_t response_len, uint32_t timeout_ms) {
    static const char *phonebook_storages[] = {"ON", "SM", "ME"};
    char phonebook_response[sizeof(s_status.last_response)] = {0};
    char command[24] = {0};
    char number[sizeof(s_status.subscriber_number)] = {0};
    size_t storage_index = 0U;

    if (!response || response_len == 0U) {
        return;
    }

    (void)modem_a7670_command("AT+CNUM", response, response_len, timeout_ms);
    if (s_status.subscriber_number[0] != '\0') {
        return;
    }

    for (storage_index = 0U; storage_index < (sizeof(phonebook_storages) / sizeof(phonebook_storages[0])); ++storage_index) {
        snprintf(command, sizeof(command), "AT+CPBS=\"%s\"", phonebook_storages[storage_index]);
        if (modem_a7670_command(command, phonebook_response, sizeof(phonebook_response), timeout_ms) != ESP_OK) {
            continue;
        }

        if (modem_a7670_command("AT+CPBR=1,20", phonebook_response, sizeof(phonebook_response), timeout_ms) != ESP_OK) {
            continue;
        }

        if (modem_a7670_parse_phonebook_subscriber_response_locked(phonebook_response, number, sizeof(number))) {
            snprintf(s_status.subscriber_number, sizeof(s_status.subscriber_number), "%s", number);
            return;
        }
    }
}

static void modem_a7670_parse_cbc_locked(const char *line) {
    const char *marker = NULL;
    int bcs = 0;
    int bcl = 0;
    int voltage_mv = 0;
    float voltage_v = 0.0f;

    if (!line) {
        return;
    }

    marker = strstr(line, "+CBC:");
    if (!marker) {
        return;
    }

    if (sscanf(marker, "+CBC: %d,%d,%d", &bcs, &bcl, &voltage_mv) == 3 &&
        voltage_mv > 0 &&
        voltage_mv < 10000) {
        s_status.battery_voltage_mv = (int32_t)voltage_mv;
        return;
    }

    /* The current A76XX manual documents +CBC as a voltage string (for example
     * +CBC: 3.749V). Only use that fallback when the response is not the
     * older comma-delimited form. */
    if (strchr(marker, ',') == NULL &&
        sscanf(marker, "+CBC: %fV", &voltage_v) == 1 &&
        voltage_v > 0.0f &&
        voltage_v < 10.0f) {
        s_status.battery_voltage_mv = (int32_t)(voltage_v * 1000.0f + 0.5f);
    }
}

static void modem_a7670_parse_temperature_locked(const char *line) {
    const char *marker = NULL;
    int temperature_c = 0;

    if (!line) {
        return;
    }

    marker = strstr(line, "+CPMUTEMP:");
    if (!marker) {
        return;
    }

    if (sscanf(marker, "+CPMUTEMP: %d", &temperature_c) == 1 &&
        temperature_c > -100 &&
        temperature_c < 200) {
        s_status.temperature_c = (int32_t)temperature_c;
    }
}

static void modem_a7670_parse_imei_response_locked(const char *response) {
    const char *cursor = response;

    if (!response) {
        return;
    }

    while (*cursor != '\0') {
        char line[32] = {0};
        size_t line_len = 0U;
        bool all_digits = true;

        while (*cursor == '\r' || *cursor == '\n') {
            ++cursor;
        }
        while (cursor[line_len] != '\0' &&
               cursor[line_len] != '\r' &&
               cursor[line_len] != '\n' &&
               line_len + 1U < sizeof(line)) {
            line[line_len] = cursor[line_len];
            ++line_len;
        }
        line[line_len] = '\0';

        if (line_len >= 14U) {
            size_t index = 0U;

            for (index = 0U; index < line_len; ++index) {
                if (line[index] < '0' || line[index] > '9') {
                    all_digits = false;
                    break;
                }
            }
            if (all_digits) {
                size_t copy_len = line_len < (sizeof(s_status.imei) - 1U)
                    ? line_len
                    : (sizeof(s_status.imei) - 1U);

                memcpy(s_status.imei, line, copy_len);
                s_status.imei[copy_len] = '\0';
                return;
            }
        }

        cursor += line_len;
        while (*cursor == '\r' || *cursor == '\n') {
            ++cursor;
        }
    }
}

static void modem_a7670_parse_line_locked(const char *line) {
    int registration_n = -1;
    int registration_stat = -1;

    if (!line || line[0] == '\0') {
        return;
    }

    s_status.urc_count++;

    if (s_runtime_scratch.sms_delivery_pdu_pending) {
        const uint16_t expected_length = s_runtime_scratch.sms_delivery_pdu_expected_length;
        s_runtime_scratch.sms_delivery_pdu_pending = false;
        s_runtime_scratch.sms_delivery_pdu_expected_length = 0U;
        if (modem_a7670_parse_sms_delivery_report_pdu_locked(line, expected_length)) {
            return;
        }
    }

    if (s_runtime_scratch.ussd_response_pending) {
        const char *closing_quote = strchr(line, '"');

        if (closing_quote) {
            char final_fragment[UNIFIED_TEXT_MEDIUM_LEN] = {0};

            if (closing_quote > line) {
                snprintf(final_fragment, sizeof(final_fragment), "%.*s", (int)(closing_quote - line), line);
                if (s_runtime_scratch.ussd_response_buffer[0] != '\0') {
                    modem_a7670_append_fragment(
                        s_runtime_scratch.ussd_response_buffer,
                        sizeof(s_runtime_scratch.ussd_response_buffer),
                        "\n"
                    );
                }
                modem_a7670_append_fragment(
                    s_runtime_scratch.ussd_response_buffer,
                    sizeof(s_runtime_scratch.ussd_response_buffer),
                    final_fragment
                );
            }

            modem_a7670_queue_ussd_payload_locked(
                s_runtime_scratch.ussd_response_session_active,
                NULL,
                s_runtime_scratch.ussd_response_buffer
            );
            modem_a7670_reset_pending_ussd_response_locked();
            modem_a7670_clear_ussd_request_locked();
            return;
        }

        if (s_runtime_scratch.ussd_response_buffer[0] != '\0') {
            modem_a7670_append_fragment(
                s_runtime_scratch.ussd_response_buffer,
                sizeof(s_runtime_scratch.ussd_response_buffer),
                "\n"
            );
        }
        modem_a7670_append_fragment(
            s_runtime_scratch.ussd_response_buffer,
            sizeof(s_runtime_scratch.ussd_response_buffer),
            line
        );
        return;
    }

    if (strncmp(line, "+CMQTTCONNLOST", 14) == 0 || strncmp(line, "+CMQTTNONET", 11) == 0) {
        s_mqtt_connected = false;
        modem_a7670_reset_mqtt_rx_locked();
        return;
    }

    if (strncmp(line, "+CMQTTRXSTART:", 13) == 0) {
        size_t topic_len = 0U;
        size_t payload_len = 0U;

        s_mqtt_service_started = true;
        s_mqtt_connected = true;
        modem_a7670_reset_mqtt_rx_locked();
        if (modem_a7670_parse_cmqttrx_start_lengths(line, &topic_len, &payload_len)) {
            s_mqtt_rx_expected_topic_len = topic_len;
            s_mqtt_rx_expected_payload_len = payload_len;
            ESP_LOGI(TAG, "CMQTTRXSTART topic_len=%u payload_len=%u", (unsigned)topic_len, (unsigned)payload_len);
        } else {
            ESP_LOGW(TAG, "CMQTTRXSTART parse failed");
        }
        return;
    }

    if (strncmp(line, "+CMQTTRXTOPIC:", 13) == 0) {
        const size_t fragment_len = modem_a7670_parse_cmqttrx_length(line);
        ESP_LOGI(TAG, "CMQTTRXTOPIC fragment_len=%u", (unsigned)fragment_len);
        if (s_mqtt_rx_expected_topic_len == 0U) {
            s_mqtt_rx_expected_topic_len = fragment_len;
        }
        s_mqtt_rx_topic_fragment_remaining = fragment_len;
        s_mqtt_rx_expect_topic = fragment_len > 0U;
        s_mqtt_rx_expect_payload = false;
        return;
    }

    if (strncmp(line, "+CMQTTRXPAYLOAD:", 15) == 0) {
        const size_t fragment_len = modem_a7670_parse_cmqttrx_length(line);
        ESP_LOGI(TAG, "CMQTTRXPAYLOAD fragment_len=%u", (unsigned)fragment_len);
        if (s_mqtt_rx_expected_payload_len == 0U) {
            s_mqtt_rx_expected_payload_len = fragment_len;
        }
        s_mqtt_rx_payload_fragment_remaining = fragment_len;
        s_mqtt_rx_expect_topic = false;
        s_mqtt_rx_expect_payload = fragment_len > 0U;
        return;
    }

    if (strncmp(line, "+CMQTTRXEND:", 11) == 0) {
        ESP_LOGI(TAG, "CMQTTRXEND topic=%s payload_len=%u", s_mqtt_rx_topic, (unsigned)s_mqtt_rx_payload_bytes);
        const bool topic_complete = s_mqtt_rx_expected_topic_len == 0U ||
            s_mqtt_rx_topic_bytes >= s_mqtt_rx_expected_topic_len;
        const bool payload_complete = s_mqtt_rx_expected_payload_len == 0U ||
            s_mqtt_rx_payload_bytes >= s_mqtt_rx_expected_payload_len;

        if (s_mqtt_rx_payload_bytes > 0U && topic_complete && payload_complete) {
            modem_a7670_queue_completed_mqtt_rx_locked();
        } else {
            if (s_mqtt_rx_topic[0] != '\0' ||
                s_mqtt_rx_payload[0] != '\0' ||
                s_mqtt_rx_expected_topic_len > 0U ||
                s_mqtt_rx_expected_payload_len > 0U) {
                ESP_LOGW(
                    TAG,
                    "dropping incomplete CMQTTRX frame topic=%u/%u payload=%u/%u",
                    (unsigned)s_mqtt_rx_topic_bytes,
                    (unsigned)s_mqtt_rx_expected_topic_len,
                    (unsigned)s_mqtt_rx_payload_bytes,
                    (unsigned)s_mqtt_rx_expected_payload_len
                );
            }
            modem_a7670_reset_mqtt_rx_locked();
        }
        return;
    }

    if (strncmp(line, "+CMQTTRECV:", 11) == 0) {
        char recv_topic[MODEM_A7670_MQTT_TOPIC_LEN] = {0};
        char recv_payload[CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN] = {0};

        ESP_LOGI(TAG, "CMQTTRECV raw=%s", line);
        s_mqtt_service_started = true;
        s_mqtt_connected = true;
        if (modem_a7670_parse_cmqttrecv_line(line, recv_topic, sizeof(recv_topic), recv_payload, sizeof(recv_payload))) {
            modem_a7670_queue_mqtt_message_locked(recv_topic, recv_payload);
        } else {
            ESP_LOGW(TAG, "CMQTTRECV parse failed raw=%s", line);
        }
        return;
    }

    if (s_mqtt_rx_expect_topic) {
        modem_a7670_append_fragment(s_mqtt_rx_topic, sizeof(s_mqtt_rx_topic), line);
        return;
    }

    if (s_mqtt_rx_expect_payload) {
        modem_a7670_append_fragment(s_mqtt_rx_payload, sizeof(s_mqtt_rx_payload), line);
        return;
    }

    if (strcmp(line, "READY") == 0) {
        bool was_sim_ready = s_status.sim_ready;
        s_status.sim_ready = true;
        if (!was_sim_ready && s_status.subscriber_number[0] == '\0') {
            s_subscriber_refresh_pending = true;
        }
        return;
    }

    if (sscanf(line, "+CREG: %d,%d", &registration_n, &registration_stat) == 2 ||
        sscanf(line, "+CGREG: %d,%d", &registration_n, &registration_stat) == 2 ||
        sscanf(line, "+CEREG: %d,%d", &registration_n, &registration_stat) == 2) {
        bool was_registered = s_status.network_registered;
        s_status.network_registered = (registration_stat == 1 || registration_stat == 5);
        if (s_status.network_registered && !was_registered) {
            s_metadata_refresh_pending = true;
        }
    } else if (strstr(line, "+CPIN:")) {
        bool was_sim_ready = s_status.sim_ready;
        s_status.sim_ready = strstr(line, "READY") != NULL;
        s_status.telephony_enabled = s_status.sim_ready;
        if (!s_status.sim_ready) {
            /* Keep the last known number across normal probes, but clear it when
             * the SIM is genuinely unavailable so we do not keep stale identity
             * after SIM removal/reset. */
            s_status.subscriber_number[0] = '\0';
            s_subscriber_refresh_pending = false;
        } else if (!was_sim_ready && s_status.subscriber_number[0] == '\0') {
            s_subscriber_refresh_pending = true;
        }
    } else if (strstr(line, "+CSQ:")) {
        int rssi = -1;
        if (sscanf(strstr(line, "+CSQ:"), "+CSQ: %d", &rssi) == 1) {
            s_status.signal_quality = (rssi >= 0 && rssi != 99) ? rssi : -1;
        }
    } else if (strncmp(line, "+COPS:", 6) == 0) {
        modem_a7670_parse_operator_locked(line);
    } else if (strncmp(line, "+CPSI:", 6) == 0) {
        modem_a7670_parse_network_type_locked(line);
    } else if (strncmp(line, "+CBC:", 5) == 0) {
        modem_a7670_parse_cbc_locked(line);
    } else if (strncmp(line, "+CPMUTEMP:", 10) == 0) {
        modem_a7670_parse_temperature_locked(line);
    } else if (strncmp(line, "+CNUM:", 6) == 0) {
        modem_a7670_parse_subscriber_number_locked(line);
    } else if (strncmp(line, "+CUSD:", 6) == 0) {
        modem_a7670_parse_ussd_result_locked(line);
    } else if (strncmp(line, "+CMTI:", 6) == 0) {
        modem_a7670_parse_sms_index_locked(line);
    } else if (strncmp(line, "+CDS:", 5) == 0) {
        modem_a7670_parse_sms_delivery_report_locked(line);
    }
}

static void modem_a7670_sync_state_modes_locked(void) {
    state_mgr_snapshot_t snapshot = {0};
    bool runtime_changed = false;

    state_mgr_get_snapshot(&snapshot);
    runtime_changed = snapshot.telephony_enabled != s_status.telephony_enabled ||
                      snapshot.data_mode_enabled != s_status.data_mode_enabled;
    s_status.data_mode_enabled = snapshot.data_mode_enabled;
    if (runtime_changed) {
        (void)state_mgr_set_modem_runtime(s_status.telephony_enabled, s_status.data_mode_enabled);
    }
}

static bool modem_a7670_parse_ipaddr_response(const char *response, char *out_ip, size_t out_len) {
    const char *marker = NULL;
    const char *value = NULL;
    const char *line_end = NULL;
    size_t length = 0U;

    if (!response || !out_ip || out_len == 0U) {
        return false;
    }

    out_ip[0] = '\0';
    marker = strstr(response, "+IPADDR:");
    if (!marker) {
        return false;
    }

    value = marker + strlen("+IPADDR:");
    while (*value == ' ') {
        ++value;
    }

    line_end = strpbrk(value, "\r\n");
    length = line_end ? (size_t)(line_end - value) : strlen(value);
    if (length == 0U || length >= out_len) {
        return false;
    }

    snprintf(out_ip, out_len, "%.*s", (int)length, value);
    return strcmp(out_ip, "0.0.0.0") != 0;
}

static esp_err_t modem_a7670_configure_startup_pins(void) {
    gpio_config_t io_config = {
        .pin_bit_mask = (1ULL << PIN_MODEM_ENABLE),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&io_config);

    if (err != ESP_OK) {
        return err;
    }

    // Waveshare's own examples keep GPIO21 high during modem startup.
    return gpio_set_level(PIN_MODEM_ENABLE, 1);
}

static esp_err_t modem_a7670_start_task_locked(void) {
    BaseType_t task_ok = pdFAIL;

    if (s_modem_task_started) {
        return ESP_OK;
    }

    task_ok = xTaskCreatePinnedToCore(
        modem_a7670_task,
        "modem_task",
        CONFIG_UNIFIED_TASK_STACK_MEDIUM,
        NULL,
        4,
        NULL,
        1
    );
    if (task_ok != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    s_modem_task_started = true;
    return ESP_OK;
}

static esp_err_t modem_a7670_init_uart_control_locked(const uart_config_t *uart_config) {
    esp_err_t err = ESP_OK;

    if (!uart_config) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_uart_control_ready) {
        return ESP_OK;
    }

    err = uart_driver_install(
        (uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT,
        CONFIG_UNIFIED_MODEM_UART_RX_BUFFER,
        0,
        MODEM_A7670_UART_EVENT_QUEUE_LEN,
        &s_uart_event_queue,
        0
    );
    if (err != ESP_OK) {
        return err;
    }

    err = uart_param_config((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, uart_config);
    if (err != ESP_OK) {
        return err;
    }

    err = uart_set_rx_timeout((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, 1);
    if (err != ESP_OK) {
        return err;
    }

    err = uart_set_pin(
        (uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT,
        PIN_MODEM_TX,
        PIN_MODEM_RX,
        UART_PIN_NO_CHANGE,
        UART_PIN_NO_CHANGE
    );
    if (err != ESP_OK) {
        return err;
    }

    err = modem_a7670_configure_startup_pins();
    if (err != ESP_OK) {
        return err;
    }

    s_uart_control_ready = true;
    return ESP_OK;
}

bool modem_a7670_uart_control_blocked_locked(void) {
    return false;
}

static esp_err_t modem_a7670_probe_uart_sideband(bool refresh_data_session) {
    modem_a7670_runtime_scratch_t *scratch = &s_runtime_scratch;
    char *response = scratch->probe_response;
    char *urc_buffer = scratch->probe_urc_buffer;
    esp_err_t err = ESP_OK;
    uint32_t now_ms = unified_tick_now_ms();
    bool transport_alive = false;
    bool refresh_registration = false;
    bool registration_ready = false;
    bool refresh_signal = false;
    bool signal_ready = false;
    bool refresh_metadata = false;
    bool refresh_environment = false;
    bool refresh_subscriber = false;
    bool refresh_imei = false;
    uint32_t registration_refresh_interval_ms = MODEM_A7670_REGISTRATION_REFRESH_INTERVAL_MS;
    uint32_t signal_refresh_interval_ms = MODEM_A7670_SIGNAL_REFRESH_INTERVAL_MS;
    uint32_t metadata_refresh_interval_ms = MODEM_A7670_METADATA_REFRESH_INTERVAL_MS;
    uint32_t environment_refresh_interval_ms = MODEM_A7670_ENV_REFRESH_INTERVAL_MS;

    memset(response, 0, sizeof(scratch->probe_response));
    memset(urc_buffer, 0, sizeof(scratch->probe_urc_buffer));

    if (!s_uart_control_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        if (modem_a7670_mqtt_rx_capture_active_locked()) {
            /* Do not inject new AT probes while a CMQTTRX frame is still
             * assembling, but keep draining the UART so the in-flight MQTT
             * frame can complete even if no fresh UART event is posted. */
            memset(urc_buffer, 0, sizeof(scratch->probe_urc_buffer));
            (void)modem_a7670_read_until_quiet_locked(urc_buffer, sizeof(scratch->probe_urc_buffer), 50);
            s_status.runtime.running = s_status.data_session_open || s_status.ip_bearer_ready;
            modem_a7670_sync_state_modes_locked();
            modem_a7670_set_health_locked();
            modem_a7670_publish_status_locked();
            xSemaphoreGive(s_lock);
            return ESP_OK;
        }

        if (!modem_a7670_uart_control_blocked_locked()) {
            /* Keep the last known SIM and registration state between healthy probes.
             * Registration URCs are already enabled, so stale-window polling can
             * confirm state without forcing false negatives every loop. */
            (void)modem_a7670_read_until_quiet_locked(urc_buffer, sizeof(scratch->probe_urc_buffer), 20);
        } else {
            s_status.runtime.running = s_status.data_session_open || s_status.ip_bearer_ready;
            s_status.runtime.last_error = ESP_ERR_INVALID_STATE;
            snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "uart_control_blocked");
            snprintf(s_status.last_response, sizeof(s_status.last_response), "%s", "uart_control_blocked");
            modem_a7670_sync_state_modes_locked();
            modem_a7670_set_health_locked();
            modem_a7670_publish_status_locked();
            xSemaphoreGive(s_lock);
            return ESP_ERR_INVALID_STATE;
        }
        xSemaphoreGive(s_lock);
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        transport_alive = s_mqtt_connected &&
                          s_status.network_registered &&
                          s_status.data_session_open &&
                          s_status.ip_bearer_ready &&
                          s_status.data_ip_address[0] != '\0';
        xSemaphoreGive(s_lock);
    }

    if (transport_alive) {
        /* Once modem MQTT is healthy, prefer a fully event-driven lane for
         * incoming command delivery. Periodic AT refreshes can interleave with
         * CMQTTRX frames and make inbound MQTT less reliable than it should be.
         * Keep the last known modem state until the transport drops and we need
         * active recovery again. */
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            s_status.runtime.running = true;
            s_status.runtime.last_error = ESP_OK;
            s_status.runtime.last_error_text[0] = '\0';
            modem_a7670_sync_state_modes_locked();
            modem_a7670_set_health_locked();
            modem_a7670_publish_status_locked();
            xSemaphoreGive(s_lock);
        }
        return ESP_OK;
    }

    if (!transport_alive) {
        err = modem_a7670_command("AT", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS);
        if (err != ESP_OK) {
            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                s_status.timeout_count++;
                /* If AT probe fails after previously succeeding, the modem may have restarted.
                 * Reset echo and telephony config flags so they are re-sent on next success. */
                s_at_echo_disabled = false;
                s_telephony_baseline_configured = false;
                s_verbose_errors_configured = false;
                s_operator_format_configured = false;
                s_last_registration_refresh_ms = 0U;
                s_last_signal_refresh_ms = 0U;
                s_last_metadata_refresh_ms = 0U;
                s_last_environment_refresh_ms = 0U;
                s_status.sim_ready = false;
                s_status.telephony_enabled = false;
                s_status.network_registered = false;
                s_status.signal_quality = -1;
                s_status.runtime.running = s_status.data_session_open || s_status.ip_bearer_ready;
                s_status.runtime.last_error = err;
                snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "uart_probe_timeout");
                snprintf(s_status.last_response, sizeof(s_status.last_response), "%s", "uart_probe_timeout");
                s_status.battery_voltage_mv = -1;
                s_status.temperature_c = -1000;
                s_status.operator_name[0] = '\0';
                s_status.network_type[0] = '\0';
                modem_a7670_sync_state_modes_locked();
                modem_a7670_set_health_locked();
                modem_a7670_publish_status_locked();
                xSemaphoreGive(s_lock);
            }
            return err;
        }
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        s_status.runtime.running = true;
        s_status.runtime.last_error = ESP_OK;
        s_status.runtime.last_error_text[0] = '\0';
        xSemaphoreGive(s_lock);
    }

    if (!s_at_echo_disabled &&
        modem_a7670_command("ATE0", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK) {
        s_at_echo_disabled = true;
    }

    if (!s_verbose_errors_configured &&
        modem_a7670_command("AT+CMEE=2", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK) {
        /* CMEE survives until the modem restarts, so avoid reapplying it every probe. */
        s_verbose_errors_configured = true;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        refresh_registration =
            !s_telephony_baseline_configured ||
            !s_status.sim_ready ||
            !s_status.network_registered ||
            modem_a7670_refresh_due(
                now_ms,
                s_last_registration_refresh_ms,
                registration_refresh_interval_ms
            );
        xSemaphoreGive(s_lock);
    }

    if (refresh_registration) {
        if (modem_a7670_command("AT+CPIN?", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK &&
            modem_a7670_command("AT+CREG?", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK &&
            modem_a7670_command("AT+CGREG?", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK &&
            modem_a7670_command("AT+CEREG?", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK) {
            s_last_registration_refresh_ms = now_ms;
            registration_ready = true;
        } else {
            s_last_registration_refresh_ms = 0U;
        }
    } else {
        registration_ready = true;
    }

    if (registration_ready && xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        refresh_signal =
            s_status.signal_quality < 0 ||
            modem_a7670_refresh_due(
                now_ms,
                s_last_signal_refresh_ms,
                signal_refresh_interval_ms
            );
        xSemaphoreGive(s_lock);
    }

    if (registration_ready) {
        if (!refresh_signal) {
            signal_ready = true;
        } else if (modem_a7670_command("AT+CSQ", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK) {
            /* Signal strength drives observability, not bearer ownership. */
            s_last_signal_refresh_ms = now_ms;
            signal_ready = true;
        } else {
            s_last_signal_refresh_ms = 0U;
        }
    }

    if (registration_ready && signal_ready) {
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            if (!s_status.network_registered) {
                s_status.operator_name[0] = '\0';
                s_status.network_type[0] = '\0';
                s_last_metadata_refresh_ms = 0U;
                s_metadata_refresh_pending = false;
            } else {
                refresh_metadata =
                    s_metadata_refresh_pending ||
                    s_status.operator_name[0] == '\0' ||
                    s_status.network_type[0] == '\0' ||
                    modem_a7670_refresh_due(
                        now_ms,
                        s_last_metadata_refresh_ms,
                        metadata_refresh_interval_ms
                    );
            }

            if (!s_status.sim_ready) {
                s_subscriber_refresh_pending = false;
            }

            refresh_subscriber =
                s_status.sim_ready &&
                s_subscriber_refresh_pending &&
                s_status.subscriber_number[0] == '\0';

            refresh_imei =
                s_imei_refresh_pending &&
                s_status.imei[0] == '\0';

            refresh_environment = modem_a7670_refresh_due(
                now_ms,
                s_last_environment_refresh_ms,
                environment_refresh_interval_ms
            );
            xSemaphoreGive(s_lock);
        }

        if (refresh_metadata) {
            bool metadata_ok = true;

            /* AT+COPS=3,0 selects long alphanumeric operator format. Like CMEE,
             * it is a session-format setting, not live network state, so do not
             * reapply it on every metadata probe once it sticks. */
            if (!s_operator_format_configured) {
                metadata_ok = modem_a7670_command(
                    "AT+COPS=3,0",
                    response,
                    sizeof(scratch->probe_response),
                    CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS
                ) == ESP_OK;
                if (metadata_ok) {
                    s_operator_format_configured = true;
                }
            }
            if (metadata_ok) {
                metadata_ok = modem_a7670_command(
                    "AT+COPS?",
                    response,
                    sizeof(scratch->probe_response),
                    CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS
                ) == ESP_OK;
            }
            if (metadata_ok) {
                metadata_ok = modem_a7670_command(
                    "AT+CPSI?",
                    response,
                    sizeof(scratch->probe_response),
                    CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS
                ) == ESP_OK;
            }
            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                s_last_metadata_refresh_ms = metadata_ok ? now_ms : 0U;
                if (metadata_ok) {
                    s_metadata_refresh_pending = false;
                }
                xSemaphoreGive(s_lock);
            }
        }

        if (refresh_subscriber || refresh_imei) {
            if (refresh_subscriber) {
                modem_a7670_refresh_subscriber_number_locked(
                    response,
                    sizeof(scratch->probe_response),
                    CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS
                );
            }
            if (refresh_imei &&
                modem_a7670_command("AT+CGSN", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK &&
                xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                modem_a7670_parse_imei_response_locked(response);
                xSemaphoreGive(s_lock);
            }
            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                if (refresh_subscriber) {
                    s_subscriber_refresh_pending = false;
                }
                if (refresh_imei) {
                    s_imei_refresh_pending = false;
                }
                xSemaphoreGive(s_lock);
            }
        }

        if (refresh_environment) {
            s_last_environment_refresh_ms = now_ms;
            /* Battery/temperature are observability fields, not lane control signals. */
            (void)modem_a7670_command("AT+CBC", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS);
            (void)modem_a7670_command("AT+CPMUTEMP", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS);
        }
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            modem_a7670_sync_state_modes_locked();
            if (refresh_data_session) {
                (void)modem_a7670_refresh_data_session_locked(CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS);
            }
            modem_a7670_set_health_locked();
            modem_a7670_publish_status_locked();
            xSemaphoreGive(s_lock);
        }
    }

    if (!s_telephony_baseline_configured) {
        if (
            /* Enable registration URCs with location info (n=2 per 3GPP TS 27.007; enables async +CREG/+CGREG/+CEREG updates). */
            modem_a7670_command("AT+CREG=2", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK &&
            modem_a7670_command("AT+CGREG=2", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK &&
            modem_a7670_command("AT+CEREG=2", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK &&
            /* A76XX AT manual: CSMS=1 selects GSM phase 2+ SMS service and
             * CGSMS=3 keeps MO SMS circuit-switched preferred with GPRS fallback. */
            modem_a7670_command("AT+CSMS=1", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK &&
            modem_a7670_command("AT+CGSMS=3", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK &&
            /* Set SMS storage to modem flash (ME) instead of SIM for larger capacity (typically 200+ messages vs 20-30). */
            modem_a7670_command("AT+CPMS=\"ME\",\"ME\",\"ME\"", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK &&
            /* SIMCom documents IRA as the default-safe TE character set.
             * GSM can interfere with software flow control on some revisions. */
            modem_a7670_command("AT+CSCS=\"IRA\"", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK &&
            modem_a7670_command("AT+CMGF=1", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK &&
            /* Store incoming SMS via +CMTI and route status reports via +CDS for fast delivery updates. */
            modem_a7670_command("AT+CNMI=2,1,0,1,0", response, sizeof(scratch->probe_response), CONFIG_UNIFIED_MODEM_AT_TIMEOUT_MS) == ESP_OK) {
            s_telephony_baseline_configured = true;
        }
    }

    return ESP_OK;
}

static esp_err_t modem_a7670_refresh_data_session_locked(uint32_t timeout_ms) {
    modem_a7670_runtime_scratch_t *scratch = &s_runtime_scratch;
    state_mgr_snapshot_t snapshot = {0};
    char *response = scratch->data_session_response;
    char *ip_address = scratch->data_session_ip_address;
    uint32_t now_ms = unified_tick_now_ms();
    uint32_t refresh_interval_ms = MODEM_A7670_DATA_SESSION_REFRESH_INTERVAL_MS;
    bool refresh_due = true;

    memset(response, 0, sizeof(scratch->data_session_response));
    memset(ip_address, 0, sizeof(scratch->data_session_ip_address));

    state_mgr_get_snapshot(&snapshot);
    s_status.data_mode_enabled = snapshot.data_mode_enabled;

    if (!s_status.network_registered || !s_status.data_mode_enabled) {
        s_status.data_session_open = false;
        s_status.ip_bearer_ready = false;
        s_status.data_ip_address[0] = '\0';
        s_mqtt_connected = false;
        s_mqtt_service_started = false;
        s_last_data_session_refresh_ms = 0U;
        return ESP_OK;
    }

    if (s_mqtt_connected && s_status.data_session_open && s_status.ip_bearer_ready) {
        refresh_interval_ms = MODEM_A7670_HEALTHY_DATA_SESSION_REFRESH_INTERVAL_MS;
    }

    /* A live modem MQTT session already proves the bearer is usable, so do
     * not force AT+IPADDR on every probe loop while MQTT stays connected.
     * Keep the stale-window refresh and the missing-bearer checks instead. */
    refresh_due = !s_status.data_session_open ||
                  !s_status.ip_bearer_ready ||
                  s_status.data_ip_address[0] == '\0' ||
                  modem_a7670_refresh_due(
                      now_ms,
                      s_last_data_session_refresh_ms,
                      refresh_interval_ms
                  );
    if (!refresh_due) {
        return ESP_OK;
    }

    s_status.data_session_open = false;
    s_status.ip_bearer_ready = false;
    s_status.data_ip_address[0] = '\0';

    if (modem_a7670_send_command_locked("AT+IPADDR", response, sizeof(scratch->data_session_response), timeout_ms, false) == ESP_OK &&
        modem_a7670_parse_ipaddr_response(response, ip_address, sizeof(scratch->data_session_ip_address))) {
        s_status.data_session_open = true;
        s_status.ip_bearer_ready = true;
        unified_copy_cstr(s_status.data_ip_address, sizeof(s_status.data_ip_address), ip_address);
        s_last_data_session_refresh_ms = now_ms;
        return ESP_OK;
    }

    s_mqtt_connected = false;
    s_mqtt_service_started = false;
    s_last_data_session_refresh_ms = 0U;
    return ESP_ERR_INVALID_STATE;
}

void modem_a7670_parse_response_locked(const char *response) {
    modem_a7670_runtime_scratch_t *scratch = &s_runtime_scratch;
    char *fragment = scratch->parse_fragment;
    size_t fragment_len = sizeof(scratch->parse_fragment);
    size_t response_len = 0U;
    size_t fragment_used = 0U;
    size_t copy_len = 0U;
    size_t cursor = 0U;

    if (!response || response[0] == '\0') {
        return;
    }

    response_len = strlen(response);
    fragment_used = strnlen(fragment, fragment_len);
    if (fragment_used >= (fragment_len - 1U)) {
        modem_a7670_reset_uart_parse_fragment_locked();
        fragment_used = 0U;
    }

    copy_len = response_len < ((fragment_len - 1U) - fragment_used)
        ? response_len
        : ((fragment_len - 1U) - fragment_used);
    if (copy_len == 0U) {
        ESP_LOGW(TAG, "dropping modem UART fragment; parser buffer is full");
        modem_a7670_reset_uart_parse_fragment_locked();
        return;
    }

    memcpy(fragment + fragment_used, response, copy_len);
    fragment[fragment_used + copy_len] = '\0';

    while (cursor < (fragment_used + copy_len)) {
        bool capture_topic = false;
        bool capture_payload = false;
        size_t data_start = 0U;
        size_t available = 0U;
        size_t remaining_expected = 0U;
        size_t consumed = 0U;
        char *dest = NULL;
        size_t dest_len = 0U;
        size_t *captured_bytes = NULL;
        size_t line_start = modem_a7670_skip_crlf_bytes(fragment, fragment_used + copy_len, cursor);
        size_t line_end = line_start;
        char *line = scratch->parse_line;
        size_t line_len = 0U;
        bool has_line_ending = false;

        if (line_start >= (fragment_used + copy_len)) {
            cursor = line_start;
            break;
        }

        capture_topic = s_mqtt_rx_expect_topic &&
                        s_mqtt_rx_topic_fragment_remaining > 0U;
        capture_payload = s_mqtt_rx_expect_payload &&
                          s_mqtt_rx_payload_fragment_remaining > 0U;
        if (capture_topic || capture_payload) {
            data_start = line_start;
            available = (fragment_used + copy_len) - data_start;
            if (capture_topic) {
                remaining_expected = s_mqtt_rx_topic_fragment_remaining;
                dest = s_mqtt_rx_topic;
                dest_len = sizeof(s_mqtt_rx_topic);
                captured_bytes = &s_mqtt_rx_topic_bytes;
            } else {
                remaining_expected = s_mqtt_rx_payload_fragment_remaining;
                dest = s_mqtt_rx_payload;
                dest_len = sizeof(s_mqtt_rx_payload);
                captured_bytes = &s_mqtt_rx_payload_bytes;
            }

            consumed = available < remaining_expected ? available : remaining_expected;
            if (consumed > 0U) {
                size_t stored = strnlen(dest, dest_len);
                size_t store_capacity = stored < (dest_len - 1U) ? ((dest_len - 1U) - stored) : 0U;
                size_t store_len = consumed < store_capacity ? consumed : store_capacity;

                if (store_len > 0U) {
                    memcpy(dest + stored, fragment + data_start, store_len);
                    dest[stored + store_len] = '\0';
                }
                *captured_bytes += consumed;
                if (capture_topic) {
                    s_mqtt_rx_topic_fragment_remaining -= consumed;
                } else {
                    s_mqtt_rx_payload_fragment_remaining -= consumed;
                }
                cursor = data_start + consumed;
            } else {
                cursor = data_start;
            }

            if ((capture_topic && s_mqtt_rx_topic_fragment_remaining > 0U) ||
                (capture_payload && s_mqtt_rx_payload_fragment_remaining > 0U)) {
                break;
            }

            if (capture_topic) {
                s_mqtt_rx_expect_topic = false;
            } else {
                s_mqtt_rx_expect_payload = false;
                if (s_mqtt_rx_expected_payload_len > 0U &&
                    s_mqtt_rx_payload_bytes >= s_mqtt_rx_expected_payload_len) {
                    modem_a7670_queue_completed_mqtt_rx_locked();
                }
            }
            cursor = modem_a7670_skip_crlf_bytes(fragment, fragment_used + copy_len, cursor);
            continue;
        }

        while (line_end < (fragment_used + copy_len) &&
               fragment[line_end] != '\r' &&
               fragment[line_end] != '\n') {
            line_end++;
        }
        has_line_ending = (line_end < (fragment_used + copy_len));
        if (!has_line_ending) {
            if (line_start == 0U && line_end >= (fragment_len - 1U)) {
                line_len = line_end;
                if (line_len >= sizeof(scratch->parse_line)) {
                    line_len = sizeof(scratch->parse_line) - 1U;
                }
                memcpy(line, fragment, line_len);
                line[line_len] = '\0';
                modem_a7670_parse_line_locked(line);
                modem_a7670_reset_uart_parse_fragment_locked();
                cursor = fragment_len - 1U;
            }
            break;
        }

        memset(line, 0, sizeof(scratch->parse_line));
        line_len = line_end - line_start;
        if (line_len > 0U) {
            if (line_len >= sizeof(scratch->parse_line)) {
                line_len = sizeof(scratch->parse_line) - 1U;
                ESP_LOGW(TAG, "truncating modem UART line to %u bytes", (unsigned)line_len);
            }
            memcpy(line, fragment + line_start, line_len);
            line[line_len] = '\0';
            modem_a7670_parse_line_locked(line);
        }

        cursor = modem_a7670_skip_crlf_bytes(fragment, fragment_used + copy_len, line_end);
    }

    if (cursor > 0U) {
        size_t remaining = (fragment_used + copy_len) - cursor;
        if (remaining > 0U) {
            memmove(fragment, fragment + cursor, remaining);
        }
        fragment[remaining] = '\0';
    }

    snprintf(s_status.last_response, sizeof(s_status.last_response), "%s", response);
}

esp_err_t modem_a7670_read_until_quiet_locked(char *response, size_t response_len, uint32_t quiet_ms) {
    uint32_t max_total_ms = quiet_ms > 0U ? (quiet_ms + 250U) : 250U;
    return modem_a7670_read_until_quiet_bounded_locked(response, response_len, quiet_ms, max_total_ms);
}

static esp_err_t modem_a7670_read_until_quiet_bounded_locked(
    char *response,
    size_t response_len,
    uint32_t quiet_ms,
    uint32_t max_total_ms
) {
    int bytes = 0;
    size_t used = 0;
    int64_t deadline_us = esp_timer_get_time() + ((int64_t)quiet_ms * 1000LL);
    int64_t max_deadline_us = max_total_ms > 0U
        ? esp_timer_get_time() + ((int64_t)max_total_ms * 1000LL)
        : 0LL;
    char read_buffer[96] = {0};

    if (!response || response_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    response[0] = '\0';
    while (esp_timer_get_time() < deadline_us && used < (response_len - 1U)) {
        int64_t now_us = esp_timer_get_time();
        size_t remaining = response_len - used;
        int appended = 0;

        if (max_deadline_us > 0LL && now_us >= max_deadline_us) {
            break;
        }

        bytes = uart_read_bytes(
            (uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT,
            read_buffer,
            sizeof(read_buffer) - 1U,
            pdMS_TO_TICKS(50)
        );
        if (bytes <= 0) {
            continue;
        }

        read_buffer[bytes] = '\0';
        appended = snprintf(response + used, remaining, "%s", read_buffer);
        if (appended < 0) {
            return ESP_FAIL;
        }

        used += (size_t)appended < remaining ? (size_t)appended : (remaining - 1U);
        deadline_us = esp_timer_get_time() + ((int64_t)quiet_ms * 1000LL);
        if (max_deadline_us > 0LL && deadline_us > max_deadline_us) {
            deadline_us = max_deadline_us;
        }
    }

    if (used == 0) {
        return ESP_ERR_NOT_FOUND;
    }

    modem_a7670_parse_response_locked(response);
    return ESP_OK;
}

esp_err_t modem_a7670_read_response_locked(
    char *response,
    size_t response_len,
    uint32_t timeout_ms,
    bool wait_for_prompt
) {
    int bytes = 0;
    size_t used = 0;
    int64_t deadline_us = 0;
    char read_buffer[96] = {0};

    if (!response || response_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    response[0] = '\0';
    deadline_us = esp_timer_get_time() + ((int64_t)timeout_ms * 1000LL);

    while (esp_timer_get_time() < deadline_us && used < (response_len - 1U)) {
        size_t remaining = response_len - used;
        int appended = 0;

        bytes = uart_read_bytes(
            (uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT,
            read_buffer,
            sizeof(read_buffer) - 1U,
            pdMS_TO_TICKS(100)
        );
        if (bytes <= 0) {
            continue;
        }

        read_buffer[bytes] = '\0';
        appended = snprintf(response + used, remaining, "%s", read_buffer);
        if (appended < 0) {
            return ESP_FAIL;
        }
        used += (size_t)appended < remaining ? (size_t)appended : (remaining - 1U);

        if (modem_a7670_response_has_success(response) ||
            modem_a7670_response_has_error(response) ||
            (wait_for_prompt && modem_a7670_response_has_prompt(response))) {
            break;
        }
    }

    modem_a7670_parse_response_locked(response);

    if (wait_for_prompt) {
        return modem_a7670_response_has_prompt(response) ? ESP_OK : ESP_ERR_TIMEOUT;
    }

    if (modem_a7670_response_has_success(response)) {
        return ESP_OK;
    }

    return modem_a7670_response_has_error(response) ? ESP_FAIL : ESP_ERR_TIMEOUT;
}

static esp_err_t modem_a7670_read_response_until_phrase_locked(
    char *response,
    size_t response_len,
    uint32_t timeout_ms,
    const char *phrase
) {
    int bytes = 0;
    size_t used = 0;
    int64_t deadline_us = 0;
    char read_buffer[96] = {0};

    if (!response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    response[0] = '\0';
    deadline_us = esp_timer_get_time() + ((int64_t)timeout_ms * 1000LL);

    while (esp_timer_get_time() < deadline_us && used < (response_len - 1U)) {
        size_t remaining = response_len - used;
        int appended = 0;

        bytes = uart_read_bytes(
            (uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT,
            read_buffer,
            sizeof(read_buffer) - 1U,
            pdMS_TO_TICKS(100)
        );
        if (bytes <= 0) {
            continue;
        }

        read_buffer[bytes] = '\0';
        appended = snprintf(response + used, remaining, "%s", read_buffer);
        if (appended < 0) {
            return ESP_FAIL;
        }
        used += (size_t)appended < remaining ? (size_t)appended : (remaining - 1U);

        if (phrase && strstr(response, phrase) != NULL) {
            modem_a7670_parse_response_locked(response);
            return ESP_OK;
        }
        if (modem_a7670_response_has_error(response)) {
            modem_a7670_parse_response_locked(response);
            return ESP_FAIL;
        }
    }

    modem_a7670_parse_response_locked(response);
    if (phrase && strstr(response, phrase) != NULL) {
        return ESP_OK;
    }
    if (modem_a7670_response_has_success(response)) {
        return ESP_OK;
    }
    return modem_a7670_response_has_error(response) ? ESP_FAIL : ESP_ERR_TIMEOUT;
}

esp_err_t modem_a7670_send_command_locked(
    const char *command,
    char *response,
    size_t response_len,
    uint32_t timeout_ms,
    bool wait_for_prompt
) {
    char stale_data[160] = {0};

    if (!command || !response || response_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    modem_a7670_read_until_quiet_bounded_locked(stale_data, sizeof(stale_data), 20, 250);
    if (uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, command, strlen(command)) < 0 ||
        uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, "\r\n", 2) < 0) {
        return ESP_FAIL;
    }

    return modem_a7670_read_response_locked(response, response_len, timeout_ms, wait_for_prompt);
}

static esp_err_t modem_a7670_open_network_stack_locked(char *response, size_t response_len, uint32_t timeout_ms) {
    char ip_response[sizeof(((modem_a7670_status_t *)0)->last_response)] = {0};
    char ip_address[UNIFIED_IPV4_ADDR_LEN] = {0};
    esp_err_t err = ESP_OK;

    if (!response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    err = modem_a7670_send_command_locked("AT+NETOPEN", response, response_len, timeout_ms, false);
    if (err != ESP_OK &&
        !modem_a7670_response_has_phrase(response, "+NETOPEN: 0") &&
        !modem_a7670_response_has_phrase(response, "+NETOPEN: 1") &&
        !modem_a7670_response_has_phrase(response, "+NETOPEN: 3") &&
        !modem_a7670_response_has_phrase(response, "already")) {
        (void)modem_a7670_send_command_locked("AT+NETOPEN?", ip_response, sizeof(ip_response), timeout_ms, false);
    }

    err = modem_a7670_send_command_locked("AT+IPADDR", ip_response, sizeof(ip_response), timeout_ms, false);
    if (err != ESP_OK || !modem_a7670_parse_ipaddr_response(ip_response, ip_address, sizeof(ip_address))) {
        snprintf(response, response_len, "%s", ip_response[0] != '\0' ? ip_response : "netopen_no_ip");
        s_status.data_session_open = false;
        s_status.data_ip_address[0] = '\0';
        return ESP_ERR_INVALID_STATE;
    }

    s_status.data_session_open = true;
    unified_copy_cstr(s_status.data_ip_address, sizeof(s_status.data_ip_address), ip_address);
    unified_copy_cstr(response, response_len, s_status.data_ip_address);
    return ESP_OK;
}

esp_err_t modem_a7670_prepare_command(char *buffer, size_t buffer_len, const char *prefix, const char *value, const char *suffix) {
    int written = 0;

    if (!buffer || buffer_len == 0 || !prefix) {
        return ESP_ERR_INVALID_ARG;
    }

    written = snprintf(buffer, buffer_len, "%s%s%s", prefix, value ? value : "", suffix ? suffix : "");
    if (written < 0) {
        return ESP_FAIL;
    }
    if ((size_t)written >= buffer_len) {
        return ESP_ERR_INVALID_SIZE;
    }

    return ESP_OK;
}

static void modem_a7670_task(void *arg) {
    modem_a7670_runtime_scratch_t *scratch = &s_runtime_scratch;
    char *urc_buffer = scratch->task_urc_buffer;
    uart_event_t uart_event = {0};
    bool probe_due = false;

    (void)arg;

    ESP_ERROR_CHECK(task_registry_register_expected("modem_task"));
    ESP_ERROR_CHECK(task_registry_mark_running("modem_task", true));
    ESP_ERROR_CHECK(health_monitor_register_module("modem_a7670"));

    while (true) {
        probe_due = s_uart_event_queue == NULL ||
            xQueueReceive(
                s_uart_event_queue,
                &uart_event,
                pdMS_TO_TICKS(CONFIG_UNIFIED_MODEM_PROBE_INTERVAL_MS)
            ) != pdTRUE;

        if (probe_due) {
            if (modem_a7670_probe_uart_sideband(true) != ESP_OK) {
                if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                    s_status.runtime.running = false;
                    modem_a7670_sync_state_modes_locked();
                    modem_a7670_set_health_locked();
                    modem_a7670_publish_status_locked();
                    xSemaphoreGive(s_lock);
                }
            }

            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                /* The sideband probe already drains stale URCs before issuing AT
                 * commands. Keep only this post-probe drain to collect trailing
                 * registration and CMQTT URCs without doubling idle UART reads. */
                memset(urc_buffer, 0, sizeof(scratch->task_urc_buffer));
                modem_a7670_read_until_quiet_locked(urc_buffer, sizeof(scratch->task_urc_buffer), 50);
                modem_a7670_handle_ussd_request_timeout_locked();
                xSemaphoreGive(s_lock);
            }
        } else if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            switch (uart_event.type) {
                case UART_DATA:
                case UART_PATTERN_DET:
                    memset(urc_buffer, 0, sizeof(scratch->task_urc_buffer));
                    /* Drain modem URCs as soon as bytes arrive instead of waiting
                     * for the next probe tick. This makes SMS and MQTT notifications
                     * effectively event-driven on the UART side. */
                    modem_a7670_read_until_quiet_locked(urc_buffer, sizeof(scratch->task_urc_buffer), 50);
                    break;
                case UART_FIFO_OVF:
                case UART_BUFFER_FULL:
                    uart_flush_input((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT);
                    if (s_uart_event_queue) {
                        xQueueReset(s_uart_event_queue);
                    }
                    modem_a7670_reset_uart_parse_fragment_locked();
                    s_status.timeout_count++;
                    snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "uart_overflow");
                    break;
                case UART_BREAK:
                case UART_PARITY_ERR:
                case UART_FRAME_ERR:
                    s_status.timeout_count++;
                    snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "uart_signal_error");
                    break;
                default:
                    break;
            }

            modem_a7670_handle_ussd_request_timeout_locked();
            xSemaphoreGive(s_lock);
        }

        ESP_ERROR_CHECK(task_registry_heartbeat("modem_task"));
    }
}

esp_err_t modem_a7670_init(void) {
    uart_config_t uart_config = {
        .baud_rate = CONFIG_UNIFIED_MODEM_UART_BAUD_RATE,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };

    if (s_ready) {
        return ESP_OK;
    }

    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) {
        return ESP_ERR_NO_MEM;
    }

    memset(&s_status, 0, sizeof(s_status));
    memset(&s_public_status, 0, sizeof(s_public_status));
    memset(s_sms_index_queue, 0, sizeof(s_sms_index_queue));
    memset(s_mqtt_queue, 0, sizeof(s_mqtt_queue));
    memset(s_ussd_queue, 0, sizeof(s_ussd_queue));
    memset(s_last_ussd_code, 0, sizeof(s_last_ussd_code));
    s_at_echo_disabled = false;
    s_verbose_errors_configured = false;
    s_operator_format_configured = false;
    s_sms_head = 0U;
    s_sms_count = 0U;
    s_mqtt_head = 0U;
    s_mqtt_count = 0U;
    s_ussd_head = 0U;
    s_ussd_count = 0U;
    s_last_metadata_refresh_ms = 0U;
    s_last_environment_refresh_ms = 0U;
    s_last_data_session_refresh_ms = 0U;
    s_last_registration_refresh_ms = 0U;
    s_last_signal_refresh_ms = 0U;
    s_imei_refresh_pending = true;
    s_subscriber_refresh_pending = false;
    s_metadata_refresh_pending = true;
    s_mqtt_service_started = false;
    s_mqtt_connected = false;
    modem_a7670_sms_invalidate_runtime_state_locked();
    modem_a7670_reset_mqtt_rx_locked();
    modem_a7670_reset_uart_parse_fragment_locked();
    modem_a7670_reset_pending_ussd_response_locked();
    modem_a7670_clear_ussd_request_locked();

    s_status.runtime.initialized = true;
    s_status.runtime.state = UNIFIED_MODULE_STATE_INITIALIZED;
    s_status.backend = MODEM_A7670_BACKEND_UART;
    s_status.signal_quality = -1;
    s_status.battery_voltage_mv = -1;
    s_status.temperature_c = -1000;
    s_public_status = s_status;

    /* The main lane keeps modem runtime on the UART control path. USB remains
     * available for debug and provisioning outside this data path. */
    ESP_ERROR_CHECK(modem_a7670_init_uart_control_locked(&uart_config));
    ESP_ERROR_CHECK(modem_a7670_start_task_locked());

    s_ready = true;
    ESP_LOGI(
        TAG,
        "ready backend=%d uart_ctrl=%s uart=%d baud=%d",
        (int)s_status.backend,
        s_uart_control_ready ? "yes" : "no",
        CONFIG_UNIFIED_MODEM_UART_PORT,
        CONFIG_UNIFIED_MODEM_UART_BAUD_RATE
    );
    return ESP_OK;
}

void modem_a7670_get_status(modem_a7670_status_t *out_status) {
    if (!out_status) {
        return;
    }

    if (!s_ready || !s_lock) {
        memset(out_status, 0, sizeof(*out_status));
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(1000)) != pdTRUE) {
        *out_status = s_public_status;
        return;
    }

    *out_status = s_public_status;
    xSemaphoreGive(s_lock);
}

bool modem_a7670_telephony_supported(void) {
    return true;
}

esp_err_t modem_a7670_command(const char *command, char *response, size_t response_len, uint32_t timeout_ms) {
    esp_err_t err = ESP_FAIL;

    if (!s_ready || !s_uart_control_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, false);
    xSemaphoreGive(s_lock);
    return err;
}

/**
 * Perform a full modem reset via AT+CFUN=1,1 (per vendor A76XX AT command manual).
 * This reinitializes the modem without power cycling. Use as last-resort recovery.
 */
esp_err_t modem_a7670_reset_modem(char *response, size_t response_len, uint32_t timeout_ms) {
    esp_err_t err = ESP_OK;

    if (!response || response_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }

    ESP_LOGW(TAG, "modem reset requested via AT+CFUN=1,1");
    err = modem_a7670_command("AT+CFUN=1,1", response, response_len, timeout_ms);
    if (err == ESP_OK) {
        /* Reset internal state tracking after modem reboot. */
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            s_at_echo_disabled = false;
            s_telephony_baseline_configured = false;
            s_verbose_errors_configured = false;
            s_operator_format_configured = false;
            s_last_registration_refresh_ms = 0U;
            s_last_signal_refresh_ms = 0U;
            s_last_metadata_refresh_ms = 0U;
            s_last_environment_refresh_ms = 0U;
            s_last_data_session_refresh_ms = 0U;
            s_imei_refresh_pending = (s_status.imei[0] == '\0');
            s_subscriber_refresh_pending = false;
            s_metadata_refresh_pending = true;
            modem_a7670_sms_invalidate_runtime_state_locked();
            s_status.sim_ready = false;
            s_status.network_registered = false;
            s_status.telephony_enabled = false;
            s_status.data_mode_enabled = false;
            s_status.data_session_open = false;
            s_status.ip_bearer_ready = false;
            xSemaphoreGive(s_lock);
        }
    }
    return err;
}

static esp_err_t modem_a7670_mqtt_shutdown_locked(char *response, size_t response_len, uint32_t timeout_ms) {
    char local_response[128] = {0};
    const uint32_t stop_wait_ms = timeout_ms < 5000U ? timeout_ms : 5000U;

    /* The modem's CMQTT service state can survive bearer changes, failed
     * attempts, or MCU-side resets, so do not rely on local RAM flags here. */
    (void)modem_a7670_send_command_locked("AT+CMQTTDISC=0,10", local_response, sizeof(local_response), timeout_ms, false);
    vTaskDelay(pdMS_TO_TICKS(100));
    (void)modem_a7670_send_command_locked("AT+CMQTTREL=0", local_response, sizeof(local_response), timeout_ms, false);
    vTaskDelay(pdMS_TO_TICKS(100));
    (void)modem_a7670_send_command_locked("AT+CMQTTSTOP", local_response, sizeof(local_response), timeout_ms, false);
    if (!modem_a7670_response_has_mqtt_stop_done(local_response)) {
        char stop_response[128] = {0};
        if (modem_a7670_read_response_until_phrase_locked(
                stop_response,
                sizeof(stop_response),
                stop_wait_ms,
                "+CMQTTSTOP:") == ESP_OK ||
            modem_a7670_response_has_mqtt_stop_done(stop_response)) {
            snprintf(local_response, sizeof(local_response), "%s", stop_response);
        }
    }
    (void)modem_a7670_read_until_quiet_locked(local_response, sizeof(local_response), 150);

    s_mqtt_service_started = false;
    s_mqtt_connected = false;
    modem_a7670_reset_mqtt_rx_locked();
    if (response && response_len > 0U) {
        snprintf(response, response_len, "%s", local_response[0] != '\0' ? local_response : "mqtt_disconnected");
    }
    return ESP_OK;
}

static esp_err_t modem_a7670_mqtt_subscribe_locked(
    const char *topic,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    char command[96] = {0};
    esp_err_t err = ESP_OK;

    if (!topic || topic[0] == '\0' || !response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_mqtt_connected) {
        snprintf(response, response_len, "%s", "mqtt_not_connected");
        return ESP_ERR_INVALID_STATE;
    }

    /* Prefer the vendor-documented two-step subscription flow. On this board,
     * direct CMQTTSUB acks can look healthy while inbound publishes never
     * surface as CMQTTRX frames afterwards. */
    snprintf(command, sizeof(command), "AT+CMQTTSUBTOPIC=0,%u,1", (unsigned)strlen(topic));
    err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, true);
    if (err == ESP_OK) {
        response[0] = '\0';
        if (uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, topic, strlen(topic)) < 0) {
            err = ESP_FAIL;
        } else {
            err = modem_a7670_read_response_locked(response, response_len, timeout_ms, false);
        }
    }
    if (err == ESP_OK) {
        snprintf(command, sizeof(command), "%s", "AT+CMQTTSUB=0");
        err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, false);
    }
    if (err == ESP_OK && !modem_a7670_response_has_phrase(response, "+CMQTTSUB:")) {
        err = modem_a7670_read_response_until_phrase_locked(response, response_len, timeout_ms, "+CMQTTSUB:");
    }
    if (err == ESP_OK && !modem_a7670_response_has_phrase(response, "+CMQTTSUB: 0,0")) {
        err = ESP_FAIL;
    }

    if (err != ESP_OK) {
        ESP_LOGW(
            TAG,
            "CMQTTSUBTOPIC flow topic=%s failed err=%s response=%s; retrying with direct CMQTTSUB",
            topic,
            esp_err_to_name(err),
            response[0] ? response : "<empty>"
        );
        response[0] = '\0';
        snprintf(command, sizeof(command), "AT+CMQTTSUB=0,%u,1", (unsigned)strlen(topic));
        err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, true);
        if (err == ESP_OK) {
            response[0] = '\0';
            if (uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, topic, strlen(topic)) < 0) {
                err = ESP_FAIL;
            } else {
                err = modem_a7670_read_response_locked(response, response_len, timeout_ms, false);
            }
        }

        if (err == ESP_OK && !modem_a7670_response_has_phrase(response, "+CMQTTSUB:")) {
            err = modem_a7670_read_response_until_phrase_locked(response, response_len, timeout_ms, "+CMQTTSUB:");
        }
        if (err == ESP_OK && !modem_a7670_response_has_phrase(response, "+CMQTTSUB: 0,0")) {
            err = ESP_FAIL;
        }
    }

    if (err != ESP_OK) {
        ESP_LOGW(
            TAG,
            "CMQTTSUB topic=%s failed err=%s response=%s",
            topic,
            esp_err_to_name(err),
            response[0] ? response : "<empty>"
        );
    } else {
        ESP_LOGI(TAG, "CMQTTSUB topic=%s ok", topic);
    }
    return err;
}

esp_err_t modem_a7670_mqtt_connect(
    const char *host,
    uint16_t port,
    const char *client_id,
    const char *username,
    const char *password,
    const char *subscribe_topic,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    modem_a7670_status_t status = {0};
    char command[256] = {0};
    char shutdown_response[128] = {0};
    const uint32_t shutdown_timeout_ms = timeout_ms < 5000U ? timeout_ms : 5000U;
    esp_err_t err = ESP_OK;

    if (!host || host[0] == '\0' || port == 0U || !client_id || client_id[0] == '\0' || !response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || s_status.backend != MODEM_A7670_BACKEND_UART || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }

    modem_a7670_get_status(&status);
    if (!status.data_session_open || status.data_ip_address[0] == '\0') {
        err = modem_a7670_open_data_session(response, response_len, timeout_ms);
        if (err != ESP_OK) {
            return err;
        }
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    if (s_mqtt_connected) {
        snprintf(response, response_len, "%s", "mqtt_already_connected");
        xSemaphoreGive(s_lock);
        return ESP_OK;
    }

    for (int attempt = 0; attempt < 2; ++attempt) {
        if (attempt > 0) {
            /* Only tear down after a real START failure. If a command publish
             * arrives during reconnect, +CMQTTRECV proves the existing session
             * is still useful and must not be destroyed mid-frame. */
            (void)modem_a7670_mqtt_shutdown_locked(shutdown_response, sizeof(shutdown_response), shutdown_timeout_ms);
            vTaskDelay(pdMS_TO_TICKS(800));
        }
        (void)modem_a7670_read_until_quiet_locked(shutdown_response, sizeof(shutdown_response), 250);

        ESP_LOGI(TAG, "mqtt connect using CMQTT host=%s port=%u attempt=%d", host, (unsigned)port, attempt + 1);
        err = modem_a7670_send_command_locked("AT+CMQTTSTART", response, response_len, timeout_ms, false);
        if (modem_a7670_response_has_mqtt_stop_done(response) &&
            !modem_a7670_response_has_phrase(response, "+CMQTTSTART:")) {
            response[0] = '\0';
            err = modem_a7670_read_response_until_phrase_locked(response, response_len, timeout_ms, "+CMQTTSTART:");
        }
        if (!modem_a7670_response_has_phrase(response, "+CMQTTSTART:") &&
            !modem_a7670_response_has_phrase(response, "already")) {
            esp_err_t start_wait_err =
                modem_a7670_read_response_until_phrase_locked(response, response_len, timeout_ms, "+CMQTTSTART:");
            if (start_wait_err != ESP_OK && err == ESP_OK) {
                err = start_wait_err;
            }
        }
        if (err == ESP_OK && modem_a7670_response_has_mqtt_start_ready(response)) {
            break;
        }
        if (s_mqtt_connected) {
            snprintf(response, response_len, "%s", "mqtt_already_connected");
            xSemaphoreGive(s_lock);
            return ESP_OK;
        }
        if (attempt == 0) {
            ESP_LOGW(
                TAG,
                "CMQTTSTART attempt=%d failed err=%s response=%s; retrying after forced shutdown",
                attempt + 1,
                esp_err_to_name(err == ESP_OK ? ESP_FAIL : err),
                response[0] ? response : "<empty>"
            );
        }
    }
    if (s_mqtt_connected) {
        snprintf(response, response_len, "%s", "mqtt_already_connected");
        xSemaphoreGive(s_lock);
        return ESP_OK;
    }
    if (err != ESP_OK || !modem_a7670_response_has_mqtt_start_ready(response)) {
        ESP_LOGW(
            TAG,
            "CMQTTSTART failed err=%s response=%s",
            esp_err_to_name(err == ESP_OK ? ESP_FAIL : err),
            response[0] ? response : "<empty>"
        );
        xSemaphoreGive(s_lock);
        return err == ESP_OK ? ESP_FAIL : err;
    }
    s_mqtt_service_started = true;

    snprintf(command, sizeof(command), "AT+CMQTTACCQ=0,\"%s\",0", client_id);
    err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, false);
    if (err != ESP_OK &&
        !modem_a7670_response_has_phrase(response, "+CMQTTACCQ:") &&
        !modem_a7670_response_has_phrase(response, "11")) {
        ESP_LOGW(
            TAG,
            "CMQTTACCQ failed err=%s response=%s",
            esp_err_to_name(err),
            response[0] ? response : "<empty>"
        );
        (void)modem_a7670_mqtt_shutdown_locked(response, response_len, timeout_ms);
        xSemaphoreGive(s_lock);
        return err;
    }

    (void)modem_a7670_send_command_locked("AT+CMQTTCFG=\"version\",0,4", response, response_len, timeout_ms, false);
    /* Dashboard command payloads are standard UTF-8 JSON. Leaving the modem in
     * "not check UTF8" mode is intended for hex/non-UTF8 payload flows and can
     * corrupt or drop Bangla/Unicode command bodies before they reach the
     * automation bridge. */
    (void)modem_a7670_send_command_locked("AT+CMQTTCFG=\"checkUTF8\",0,1", response, response_len, timeout_ms, false);
    /* Use the vendor-documented CMQTTRXSTART/TOPIC/PAYLOAD/END receive frame.
     * The single-line MQTT_EX +CMQTTRECV extension has dropped bytes from long
     * dashboard SMS commands on this modem, which makes JSON parsing fail. */
    if (modem_a7670_send_command_locked("AT+CMQTTCFG=\"argtopic\",0,0,0", response, response_len, timeout_ms, false) != ESP_OK) {
        (void)modem_a7670_send_command_locked("AT+CMQTTCFG=\"argtopic\",0,0", response, response_len, timeout_ms, false);
    }

    if (username && username[0] != '\0' && password && password[0] != '\0') {
        snprintf(
            command,
            sizeof(command),
            "AT+CMQTTCONNECT=0,\"tcp://%s:%u\",60,1,\"%s\",\"%s\"",
            host,
            (unsigned)port,
            username,
            password
        );
    } else {
        snprintf(command, sizeof(command), "AT+CMQTTCONNECT=0,\"tcp://%s:%u\",60,1", host, (unsigned)port);
    }

    err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, false);
    if (!modem_a7670_response_has_phrase(response, "+CMQTTCONNECT:")) {
        err = modem_a7670_read_response_until_phrase_locked(response, response_len, timeout_ms, "+CMQTTCONNECT:");
    }
    if (err != ESP_OK || !modem_a7670_response_has_phrase(response, "+CMQTTCONNECT: 0,0")) {
        bool reopen_data_session = modem_a7670_response_has_phrase(response, "+CMQTTCONNECT: 0,3");

        ESP_LOGW(
            TAG,
            "CMQTTCONNECT failed err=%s response=%s",
            esp_err_to_name(err == ESP_OK ? ESP_FAIL : err),
            response[0] ? response : "<empty>"
        );
        (void)modem_a7670_mqtt_shutdown_locked(response, response_len, timeout_ms);
        if (reopen_data_session) {
            char netclose_response[128] = {0};

            ESP_LOGW(TAG, "CMQTTCONNECT network failure; reopening modem data session on next retry");
            (void)modem_a7670_send_command_locked("AT+NETCLOSE", netclose_response, sizeof(netclose_response), timeout_ms, false);
            s_status.data_session_open = false;
            s_status.ip_bearer_ready = false;
            s_status.data_ip_address[0] = '\0';
            s_last_data_session_refresh_ms = 0U;
            modem_a7670_publish_status_locked();
        }
        xSemaphoreGive(s_lock);
        return err == ESP_OK ? ESP_FAIL : err;
    }

    s_mqtt_connected = true;
    if (subscribe_topic && subscribe_topic[0] != '\0') {
        err = modem_a7670_mqtt_subscribe_locked(subscribe_topic, response, response_len, timeout_ms);
        if (err != ESP_OK) {
            (void)modem_a7670_mqtt_shutdown_locked(response, response_len, timeout_ms);
            xSemaphoreGive(s_lock);
            return err;
        }
    }

    snprintf(response, response_len, "%s", "mqtt_connected");
    xSemaphoreGive(s_lock);
    return ESP_OK;
}

esp_err_t modem_a7670_mqtt_subscribe(
    const char *topic,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    esp_err_t err = ESP_OK;

    if (!topic || topic[0] == '\0' || !response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || s_status.backend != MODEM_A7670_BACKEND_UART || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    err = modem_a7670_mqtt_subscribe_locked(topic, response, response_len, timeout_ms);
    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t modem_a7670_mqtt_disconnect(char *response, size_t response_len, uint32_t timeout_ms) {
    esp_err_t err = ESP_OK;

    if (!response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || s_status.backend != MODEM_A7670_BACKEND_UART || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    err = modem_a7670_mqtt_shutdown_locked(response, response_len, timeout_ms);
    xSemaphoreGive(s_lock);
    return err;
}

static esp_err_t modem_a7670_mqtt_publish_legacy_locked(
    const char *topic,
    const char *payload,
    int qos,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    char command[96] = {0};
    esp_err_t err = ESP_OK;

    if (!topic || topic[0] == '\0' || !payload || !response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    snprintf(command, sizeof(command), "AT+CMQTTTOPIC=0,%u", (unsigned)strlen(topic));
    err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, true);
    if (err == ESP_OK) {
        response[0] = '\0';
        if (uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, topic, strlen(topic)) < 0) {
            err = ESP_FAIL;
        } else {
            err = modem_a7670_read_response_locked(response, response_len, timeout_ms, false);
        }
    }
    if (err != ESP_OK) {
        return err;
    }

    snprintf(command, sizeof(command), "AT+CMQTTPAYLOAD=0,%u", (unsigned)strlen(payload));
    err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, true);
    if (err == ESP_OK) {
        response[0] = '\0';
        if (uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, payload, strlen(payload)) < 0) {
            err = ESP_FAIL;
        } else {
            err = modem_a7670_read_response_locked(response, response_len, timeout_ms, false);
        }
    }
    if (err != ESP_OK) {
        return err;
    }

    snprintf(command, sizeof(command), "AT+CMQTTPUB=0,%d,60", qos < 0 ? 0 : qos);
    err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, false);
    if (err == ESP_OK && !modem_a7670_response_has_phrase(response, "+CMQTTPUB:")) {
        err = modem_a7670_read_response_until_phrase_locked(response, response_len, timeout_ms, "+CMQTTPUB:");
    }
    if (err == ESP_OK && !modem_a7670_response_has_phrase(response, "+CMQTTPUB: 0,0")) {
        err = ESP_FAIL;
    }

    return err;
}

esp_err_t modem_a7670_mqtt_publish(
    const char *topic,
    const char *payload,
    int qos,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    esp_err_t err = ESP_OK;

    if (!topic || topic[0] == '\0' || !payload || !response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || s_status.backend != MODEM_A7670_BACKEND_UART || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    if (!s_mqtt_connected) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_STATE;
    }

    err = modem_a7670_mqtt_publish_legacy_locked(topic, payload, qos, response, response_len, timeout_ms);

    if (err != ESP_OK) {
        s_mqtt_connected = false;
    }
    xSemaphoreGive(s_lock);
    return err;
}

bool modem_a7670_mqtt_is_connected(void) {
    bool connected = false;

    if (!s_ready || !s_lock) {
        return false;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return s_mqtt_connected;
    }
    connected = s_mqtt_connected;
    xSemaphoreGive(s_lock);
    return connected;
}

void modem_a7670_mark_mqtt_desynced(void) {
    if (!s_lock) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    /* USSD can leave the A7670 CMQTT lane stale without emitting an explicit
     * disconnect URC. Force the MQTT manager to reconnect on its next loop. */
    s_mqtt_connected = false;
    modem_a7670_reset_mqtt_rx_locked();
    xSemaphoreGive(s_lock);
}

void modem_a7670_reset_mqtt_rx_state(void) {
    if (!s_lock) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    modem_a7670_reset_mqtt_rx_locked();
    xSemaphoreGive(s_lock);
}

bool modem_a7670_pop_mqtt_message(char *topic, size_t topic_len, char *payload, size_t payload_len) {
    char urc_response[512] = {0};
    bool has_value = false;

    if (!topic || topic_len == 0U || !payload || payload_len == 0U || !s_lock) {
        return false;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return false;
    }

    (void)modem_a7670_read_until_quiet_locked(urc_response, sizeof(urc_response), 50);

    if (s_mqtt_count > 0U) {
        snprintf(topic, topic_len, "%s", s_mqtt_queue[s_mqtt_head].topic);
        snprintf(payload, payload_len, "%s", s_mqtt_queue[s_mqtt_head].payload);
        s_mqtt_head = (s_mqtt_head + 1U) % MODEM_A7670_MQTT_QUEUE_DEPTH;
        s_mqtt_count--;
        has_value = true;
    }

    xSemaphoreGive(s_lock);
    return has_value;
}

void modem_a7670_set_mqtt_event_listener(void (*listener)(void)) {
    s_mqtt_event_listener = listener;
}

void modem_a7670_set_sms_event_listener(void (*listener)(void)) {
    s_sms_event_listener = listener;
}

bool modem_a7670_pop_sms_index(int *out_index) {
    bool has_value = false;

    if (!out_index || !s_lock) {
        return false;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return false;
    }

    if (s_sms_count > 0U) {
        *out_index = s_sms_index_queue[s_sms_head];
        s_sms_head = (s_sms_head + 1U) % CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH;
        s_sms_count--;
        has_value = true;
    }

    xSemaphoreGive(s_lock);
    return has_value;
}

bool modem_a7670_pop_sms_delivery(unified_sms_delivery_payload_t *out_payload) {
    bool has_value = false;

    if (!out_payload || !s_lock) {
        return false;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return false;
    }

    if (s_sms_delivery_count > 0U) {
        *out_payload = s_sms_delivery_queue[s_sms_delivery_head];
        memset(&s_sms_delivery_queue[s_sms_delivery_head], 0, sizeof(s_sms_delivery_queue[s_sms_delivery_head]));
        s_sms_delivery_head = (s_sms_delivery_head + 1U) % CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH;
        s_sms_delivery_count--;
        has_value = true;
    }

    xSemaphoreGive(s_lock);
    return has_value;
}

void modem_a7670_drop_sms_indexes_locked(const int *indexes, size_t count) {
    size_t read_count = 0U;
    size_t write_count = 0U;

    if (!indexes || count == 0U) {
        return;
    }

    for (read_count = 0U; read_count < s_sms_count; ++read_count) {
        const int current_index = s_sms_index_queue[(s_sms_head + read_count) % CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH];
        bool drop = false;

        for (size_t match_index = 0U; match_index < count; ++match_index) {
            if (indexes[match_index] == current_index) {
                drop = true;
                break;
            }
        }

        if (!drop) {
            s_sms_index_queue[write_count] = current_index;
            write_count++;
        }
    }

    s_sms_head = 0U;
    s_sms_count = write_count;
}

bool modem_a7670_pop_ussd_result(unified_ussd_payload_t *out_payload) {
    bool has_value = false;

    if (!out_payload || !s_lock) {
        return false;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return false;
    }

    if (s_ussd_count > 0U) {
        *out_payload = s_ussd_queue[s_ussd_head];
        memset(&s_ussd_queue[s_ussd_head], 0, sizeof(s_ussd_queue[s_ussd_head]));
        s_ussd_head = (s_ussd_head + 1U) % CONFIG_UNIFIED_MODEM_EVENT_QUEUE_DEPTH;
        s_ussd_count--;
        has_value = true;
    }

    xSemaphoreGive(s_lock);
    return has_value;
}

static void modem_a7670_handle_ussd_request_timeout_locked(void) {
    uint32_t now_ms = 0U;

    if (!s_runtime_scratch.ussd_request_active) {
        return;
    }

    now_ms = unified_tick_now_ms();
    if ((int32_t)(now_ms - s_runtime_scratch.ussd_request_deadline_ms) < 0) {
        return;
    }

    ESP_LOGW(TAG, "ussd response timed out code=%s", s_last_ussd_code[0] != '\0' ? s_last_ussd_code : "<unknown>");
    s_status.timeout_count++;
    snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "ussd_response_timeout");
    snprintf(s_status.last_response, sizeof(s_status.last_response), "%s", "ussd_response_timeout");
    modem_a7670_queue_ussd_payload_locked(false, "failed", "ussd_response_timeout");
    modem_a7670_reset_pending_ussd_response_locked();
    modem_a7670_clear_ussd_request_locked();
}

esp_err_t modem_a7670_open_data_session(char *response, size_t response_len, uint32_t timeout_ms) {
    state_mgr_snapshot_t snapshot = {0};
    esp_err_t err = ESP_FAIL;

    if (!response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }

    state_mgr_get_snapshot(&snapshot);

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    err = modem_a7670_send_command_locked("ATE0", response, response_len, timeout_ms, false);
    if (err == ESP_OK) {
        s_at_echo_disabled = true;
        err = modem_a7670_send_command_locked("AT+CGATT=1", response, response_len, timeout_ms, false);
    }
    if (err == ESP_OK) {
        /* Configure APN before activating PDP context (per vendor TCP/IP application note). */
        char modem_apn[CONFIG_MGR_APN_LEN] = {0};
        char cgdcont_cmd[96] = {0};
        config_mgr_get_modem_apn(modem_apn, sizeof(modem_apn));
        if (modem_apn[0] != '\0') {
            snprintf(cgdcont_cmd, sizeof(cgdcont_cmd), "AT+CGDCONT=1,\"IP\",\"%s\"", modem_apn);
        } else {
            snprintf(cgdcont_cmd, sizeof(cgdcont_cmd), "AT+CGDCONT=1,\"IP\"");
        }
        err = modem_a7670_send_command_locked(cgdcont_cmd, response, response_len, timeout_ms, false);
    }
    if (err == ESP_OK) {
        err = modem_a7670_send_command_locked("AT+CGACT=1,1", response, response_len, timeout_ms, false);
    }
    if (err == ESP_OK) {
        err = modem_a7670_open_network_stack_locked(response, response_len, timeout_ms);
    }
    if (err == ESP_OK) {
        s_status.data_mode_enabled = true;
        s_status.ip_bearer_ready = s_status.data_session_open && s_status.data_ip_address[0] != '\0';
        s_last_data_session_refresh_ms = s_status.ip_bearer_ready ? unified_tick_now_ms() : 0U;
        s_status.runtime.last_error = ESP_OK;
        s_status.runtime.last_error_text[0] = '\0';
        (void)state_mgr_set_modem_runtime(snapshot.telephony_enabled, true);
    } else {
        s_status.data_mode_enabled = snapshot.data_mode_enabled;
        s_status.data_session_open = false;
        s_status.ip_bearer_ready = false;
        s_status.data_ip_address[0] = '\0';
        s_last_data_session_refresh_ms = 0U;
        (void)state_mgr_set_modem_runtime(snapshot.telephony_enabled, snapshot.data_mode_enabled);
    }
    modem_a7670_sync_state_modes_locked();
    modem_a7670_publish_status_locked();
    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t modem_a7670_close_data_session(char *response, size_t response_len, uint32_t timeout_ms) {
    state_mgr_snapshot_t snapshot = {0};
    esp_err_t err = ESP_FAIL;

    if (!response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }

    state_mgr_get_snapshot(&snapshot);
    (void)state_mgr_set_modem_runtime(snapshot.telephony_enabled, false);

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    err = ESP_OK;
    s_status.data_mode_enabled = false;
    if (modem_a7670_send_command_locked("AT+NETCLOSE", response, response_len, timeout_ms, false) != ESP_OK) {
        (void)modem_a7670_send_command_locked("AT+NETCLOSE?", response, response_len, timeout_ms, false);
    }
    s_status.data_session_open = false;
    s_status.ip_bearer_ready = false;
    s_status.data_ip_address[0] = '\0';
    s_last_data_session_refresh_ms = 0U;
    s_mqtt_connected = false;
    s_mqtt_service_started = false;
    modem_a7670_publish_status_locked();
    xSemaphoreGive(s_lock);
    if (err == ESP_OK && response && response_len > 0U) {
        snprintf(response, response_len, "%s", "data_session_closed");
    }
    return err;
}

