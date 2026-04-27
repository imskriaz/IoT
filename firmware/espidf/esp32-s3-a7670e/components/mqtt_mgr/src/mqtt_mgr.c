#include "mqtt_mgr.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "mqtt_client.h"

#include "api_bridge.h"
#include "automation_bridge.h"
#include "board_bsp.h"
#include "config_mgr.h"
#include "health_monitor.h"
#include "modem_a7670.h"
#include "storage_mgr.h"
#include "task_registry.h"
#include "unified_runtime.h"
#include "wifi_mgr.h"

static const char *TAG = "mqtt_mgr";

#define MQTT_MGR_RECOVERY_LOOP_MS           500U
#define MQTT_MGR_STABLE_ESP_LOOP_MS        1000U
#define MQTT_MGR_TASK_HEARTBEAT_MS         5000U
#define MQTT_MGR_MIN_RETRY_CHECK_MS         100U
#define MQTT_MGR_MODEM_RETRY_BACKOFF_MS   15000U
#define MQTT_MGR_MODEM_RESET_BACKOFF_MS   45000U
#define MQTT_MGR_MODEM_RESET_THRESHOLD        3U
#define MQTT_MGR_MODEM_RESPONSE_LEN          512U
#define MQTT_MGR_ESP_START_RETRY_MS       15000U
#define MQTT_MGR_ESP_START_INTERNAL_MARGIN_BYTES 1024U
#define MQTT_MGR_WIFI_PRIMARY_MIN_RSSI_DBM   (-85)
#define MQTT_MGR_ESP_CONNECT_GRACE_MS      20000U
#define MQTT_MGR_MODEM_RESUBSCRIBE_MS     300000U
#define MQTT_MGR_ACTION_RESULT_BATCH_LIMIT     6U
#define MQTT_MGR_TASK_STACK_LEN            8192U

typedef enum {
    MQTT_MGR_TRANSPORT_NONE = 0,
    MQTT_MGR_TRANSPORT_ESP = 1,
    MQTT_MGR_TRANSPORT_MODEM = 2,
} mqtt_mgr_transport_t;

typedef struct {
    config_mgr_data_t config;
    modem_a7670_status_t modem;
    wifi_mgr_status_t wifi;
    unified_ussd_payload_t ussd_payload;
} mqtt_mgr_loop_scratch_t;

typedef struct {
    config_mgr_data_t config;
    board_bsp_identity_t identity;
    esp_mqtt_client_config_t mqtt_config;
    char broker_uri[CONFIG_MGR_MQTT_URI_LEN];
    char username[CONFIG_MGR_MQTT_AUTH_LEN];
    char password[CONFIG_MGR_MQTT_AUTH_LEN];
    char client_id[UNIFIED_DEVICE_ID_LEN];
    char modem_client_id[UNIFIED_DEVICE_ID_LEN + 8U];
    char broker_host[CONFIG_MGR_MQTT_URI_LEN];
    char command_topic[160];
} mqtt_mgr_config_refresh_scratch_t;

typedef struct {
    char from[64];
    char text[1024];
    char detail[64];
    char json[1280];
} mqtt_mgr_sms_publish_scratch_t;

static SemaphoreHandle_t s_lock;
static mqtt_mgr_status_t s_status;
static esp_mqtt_client_handle_t s_client;
static uint32_t s_last_action_result_sequence;
static uint32_t s_pending_action_result_sequence;
static bool s_client_started;
static bool s_ready;
static mqtt_mgr_transport_t s_transport;
static api_bridge_action_record_t *s_action_records;
static char s_broker_uri[CONFIG_MGR_MQTT_URI_LEN];
static char s_username[CONFIG_MGR_MQTT_AUTH_LEN];
static char s_password[CONFIG_MGR_MQTT_AUTH_LEN];
static char s_client_id[UNIFIED_DEVICE_ID_LEN];
static char s_esp_client_id[UNIFIED_DEVICE_ID_LEN + 8U];
static char s_modem_client_id[UNIFIED_DEVICE_ID_LEN + 8U];
static char s_topic_prefix[CONFIG_MGR_TOPIC_PREFIX];
static char s_broker_host[CONFIG_MGR_MQTT_URI_LEN];
static uint16_t s_broker_port;
static char s_command_topic[160];
static uint32_t s_next_action_result_retry_ms;
static char s_modem_rx_topic[160];
static char *s_modem_rx_payload;
static bool s_disconnect_modem_after_esp_connected;
static bool s_modem_connection_seen;
static uint32_t s_last_modem_subscribe_ms;
static uint32_t s_next_modem_connect_retry_ms;
static uint32_t s_next_esp_start_retry_ms;
static uint8_t s_modem_connect_failure_count;
static bool s_modem_reset_pending;
static unified_ussd_payload_t s_pending_ussd_result;
static bool s_have_pending_ussd_result;
static mqtt_mgr_loop_scratch_t s_loop_scratch;
static mqtt_mgr_config_refresh_scratch_t s_refresh_scratch;
static TaskHandle_t s_mqtt_task_handle;
static mqtt_mgr_status_listener_t s_status_listener;
static bool s_last_notified_connected;
static uint32_t s_config_revision;
static config_mgr_data_t s_loop_config;
static uint32_t s_loop_config_revision;
static uint32_t s_esp_connect_started_ms;

static esp_err_t mqtt_mgr_refresh_config_locked(void);
static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data);
static esp_err_t mqtt_mgr_build_topic_locked(const char *suffix, char *topic, size_t topic_len);
static esp_err_t mqtt_mgr_build_topic_parts(
    const char *prefix,
    const char *device_id,
    const char *suffix,
    char *topic,
    size_t topic_len
);
static esp_err_t mqtt_mgr_subscribe_topic_locked(const char *suffix);
static esp_err_t mqtt_mgr_subscribe_modem_command_topics_locked(void);
static void mqtt_mgr_publish_recent_action_results(void);
static void mqtt_mgr_handle_action_record(const api_bridge_action_record_t *record);
static void mqtt_mgr_handle_modem_message_ready(void);
static void mqtt_mgr_publish_pending_ussd_results(mqtt_mgr_loop_scratch_t *scratch);
static esp_err_t mqtt_mgr_parse_broker_uri(const char *uri, char *host, size_t host_len, uint16_t *port);
static esp_err_t mqtt_mgr_start_esp_client_locked(void);
static esp_err_t mqtt_mgr_start_modem_client_locked(void);
static esp_err_t mqtt_mgr_stop_transport_locked(void);
static void mqtt_mgr_process_modem_messages(void);
static void mqtt_mgr_set_health_locked(void);
static TickType_t mqtt_mgr_compute_loop_delay(
    bool wait_for_wifi_primary,
    bool modem_mqtt_connected,
    bool connected,
    mqtt_mgr_transport_t transport,
    uint32_t now_ms,
    uint32_t next_action_retry_ms,
    uint32_t pending_action_sequence,
    uint32_t last_action_sequence
);
static bool mqtt_mgr_wifi_primary_absent(const wifi_mgr_status_t *wifi);
static bool mqtt_mgr_wifi_primary_usable(const wifi_mgr_status_t *wifi);
static bool mqtt_mgr_modem_fallback_ready(
    const config_mgr_data_t *config,
    const modem_a7670_status_t *modem
);
static bool mqtt_mgr_is_bearer_recovery_failure(const char *detail);
static void mqtt_mgr_get_loop_config(config_mgr_data_t *out_config);
static bool mqtt_mgr_is_background_action_command(unified_action_command_t command);
static bool mqtt_mgr_has_newer_background_record(
    const api_bridge_action_record_t *records,
    size_t count,
    size_t current_index,
    uint32_t last_published_sequence
);

static bool mqtt_mgr_is_bearer_recovery_failure(const char *detail) {
    if (!detail || detail[0] == '\0') {
        return false;
    }

    return strstr(detail, "+CMQTTCONNECT: 0,3") != NULL ||
           strstr(detail, "+IP ERROR") != NULL ||
           strstr(detail, "netopen_no_ip") != NULL;
}

static void mqtt_mgr_get_loop_config(config_mgr_data_t *out_config) {
    uint32_t config_revision = 0U;

    if (!out_config) {
        return;
    }

    memset(out_config, 0, sizeof(*out_config));
    config_revision = config_mgr_revision();
    if (config_revision != 0U && s_loop_config_revision == config_revision) {
        *out_config = s_loop_config;
        return;
    }

    config_mgr_snapshot(&s_loop_config);
    s_loop_config_revision = config_revision;
    *out_config = s_loop_config;
}

static bool mqtt_mgr_is_background_action_command(unified_action_command_t command) {
    return command == UNIFIED_ACTION_CMD_GET_STATUS || command == UNIFIED_ACTION_CMD_STATUS_WATCH;
}

static bool mqtt_mgr_has_newer_background_record(
    const api_bridge_action_record_t *records,
    size_t count,
    size_t current_index,
    uint32_t last_published_sequence
) {
    if (!records || current_index >= count) {
        return false;
    }

    for (size_t index = current_index + 1U; index < count; ++index) {
        if (records[index].sequence == 0U || records[index].sequence <= last_published_sequence) {
            continue;
        }
        if (mqtt_mgr_is_background_action_command(records[index].response.action.command)) {
            return true;
        }
    }

    return false;
}

static void mqtt_mgr_log_internal_heap(const char *phase) {
    ESP_LOGI(
        TAG,
        "heap %s internal_free=%" PRIu32 " internal_largest=%" PRIu32 " total_free=%" PRIu32 " total_largest=%" PRIu32,
        phase ? phase : "unknown",
        (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
        (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
        (uint32_t)heap_caps_get_free_size(MALLOC_CAP_8BIT),
        (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)
    );
}

static esp_err_t mqtt_mgr_copy_text(char *dest, size_t dest_len, const char *src) {
    size_t copy_len = 0U;

    if (!dest || dest_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    if (!src) {
        dest[0] = '\0';
        return ESP_OK;
    }

    copy_len = strnlen(src, dest_len);
    if (copy_len >= dest_len) {
        memcpy(dest, src, dest_len - 1U);
        dest[dest_len - 1U] = '\0';
        return ESP_ERR_INVALID_SIZE;
    }

    memcpy(dest, src, copy_len);
    dest[copy_len] = '\0';
    return ESP_OK;
}

static esp_err_t mqtt_mgr_copy_text_suffix(char *dest, size_t dest_len, const char *src, const char *suffix) {
    size_t src_len = 0U;
    size_t suffix_len = 0U;

    if (!dest || dest_len == 0U || !suffix) {
        return ESP_ERR_INVALID_ARG;
    }

    if (!src) {
        src = "";
    }

    src_len = strlen(src);
    suffix_len = strlen(suffix);
    if (src_len + suffix_len >= dest_len) {
        dest[0] = '\0';
        return ESP_ERR_INVALID_SIZE;
    }

    if (src_len > 0U) {
        memcpy(dest, src, src_len);
    }
    if (suffix_len > 0U) {
        memcpy(dest + src_len, suffix, suffix_len);
    }
    dest[src_len + suffix_len] = '\0';
    return ESP_OK;
}

static bool mqtt_mgr_should_wait_for_wifi_primary(
    const config_mgr_data_t *config,
    const wifi_mgr_status_t *wifi
) {
    if (!config || !wifi) {
        return false;
    }

    if (!config->modem_fallback_enabled || !wifi->configured || !wifi->started) {
        return false;
    }

    if (wifi->connected || wifi->ip_assigned) {
        return false;
    }

    if (mqtt_mgr_wifi_primary_absent(wifi)) {
        return false;
    }

    return wifi->connect_attempt_count < 3U;
}

static bool mqtt_mgr_wifi_primary_absent(const wifi_mgr_status_t *wifi) {
    if (!wifi) {
        return false;
    }

    if (wifi->last_disconnect_reason == WIFI_REASON_NO_AP_FOUND) {
        return true;
    }

    /* Once a scan has completed and the configured target is still absent,
     * prefer modem fallback instead of burning more Wi-Fi-only wait cycles. */
    if (wifi->last_scan_elapsed_ms > 0U && !wifi->last_scan_target_visible) {
        return true;
    }

    return false;
}

static bool mqtt_mgr_wifi_primary_usable(const wifi_mgr_status_t *wifi) {
    if (!wifi || !wifi->connected || !wifi->ip_assigned) {
        return false;
    }

    /* RSSI is zero until the Wi-Fi task has refreshed AP info after got-ip.
     * Treat unknown as usable briefly, then reject edge links that repeatedly
     * cause beacon timeouts and MQTT reconnect churn. */
    return wifi->rssi == 0 || wifi->rssi >= MQTT_MGR_WIFI_PRIMARY_MIN_RSSI_DBM;
}

static bool mqtt_mgr_modem_fallback_ready(
    const config_mgr_data_t *config,
    const modem_a7670_status_t *modem
) {
    if (!config || !modem) {
        return false;
    }

    return config->modem_fallback_enabled &&
           modem->network_registered &&
           modem->data_mode_enabled &&
           modem->telephony_enabled;
}

static esp_err_t mqtt_mgr_start_esp_client_locked(void) {
    uint32_t now_ms = unified_tick_now_ms();
    uint32_t internal_largest = 0U;

    if (!s_client) {
        return ESP_ERR_INVALID_STATE;
    }
    if (s_client_started) {
        if (!s_status.connected && s_esp_connect_started_ms == 0U) {
            s_esp_connect_started_ms = now_ms;
        }
        if (s_status.connected || s_transport != MQTT_MGR_TRANSPORT_MODEM) {
            s_transport = MQTT_MGR_TRANSPORT_ESP;
        }
        return ESP_OK;
    }
    if (s_next_esp_start_retry_ms != 0U && now_ms < s_next_esp_start_retry_ms) {
        s_status.runtime.last_error = ESP_ERR_TIMEOUT;
        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_esp_retry_wait");
        return ESP_ERR_TIMEOUT;
    }
    internal_largest = (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (internal_largest < (MQTT_MGR_TASK_STACK_LEN + MQTT_MGR_ESP_START_INTERNAL_MARGIN_BYTES)) {
        s_next_esp_start_retry_ms = now_ms + MQTT_MGR_ESP_START_RETRY_MS;
        s_status.runtime.last_error = ESP_ERR_NO_MEM;
        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_esp_internal_heap_low");
        ESP_LOGW(
            TAG,
            "skip esp mqtt start internal_largest=%" PRIu32 " required=%u",
            internal_largest,
            (unsigned)(MQTT_MGR_TASK_STACK_LEN + MQTT_MGR_ESP_START_INTERNAL_MARGIN_BYTES)
        );
        return ESP_ERR_NO_MEM;
    }
    mqtt_mgr_log_internal_heap("before_start");
    ESP_LOGI(TAG, "starting client broker=%s", s_status.broker[0] != '\0' ? s_status.broker : "<unset>");
    if (esp_mqtt_client_start(s_client) != ESP_OK) {
        mqtt_mgr_log_internal_heap("start_failed");
        s_next_esp_start_retry_ms = now_ms + MQTT_MGR_ESP_START_RETRY_MS;
        s_status.runtime.last_error = ESP_FAIL;
        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_start_failed");
        return ESP_FAIL;
    }

    s_next_esp_start_retry_ms = 0U;
    mqtt_mgr_log_internal_heap("start_ok");
    s_client_started = true;
    s_esp_connect_started_ms = now_ms;
    s_status.runtime.running = true;
    if (s_transport != MQTT_MGR_TRANSPORT_MODEM) {
        s_transport = MQTT_MGR_TRANSPORT_ESP;
    }
    return ESP_OK;
}

static esp_err_t mqtt_mgr_start_modem_client_locked(void) {
    char response[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    esp_err_t err = ESP_OK;
    esp_err_t subscribe_err = ESP_OK;

    if (!s_broker_host[0] || s_broker_port == 0U) {
        return ESP_ERR_INVALID_STATE;
    }
    if (modem_a7670_mqtt_is_connected()) {
        s_transport = MQTT_MGR_TRANSPORT_MODEM;
        s_status.connected = true;
        s_status.subscribed = false;
        s_status.runtime.running = true;
        subscribe_err = mqtt_mgr_subscribe_modem_command_topics_locked();
        (void)subscribe_err;
        s_last_modem_subscribe_ms = unified_tick_now_ms();
        return ESP_OK;
    }

    err = modem_a7670_mqtt_connect(
        s_broker_host,
        s_broker_port,
        s_modem_client_id,
        s_username[0] ? s_username : NULL,
        s_password[0] ? s_password : NULL,
        NULL,
        response,
        sizeof(response),
        15000U
    );
    if (err != ESP_OK) {
        ESP_LOGW(
            TAG,
            "modem mqtt connect failed err=%s detail=%s",
            esp_err_to_name(err),
            response[0] ? response : "mqtt_modem_connect_failed"
        );
        s_status.runtime.last_error = err;
        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", response[0] ? response : "mqtt_modem_connect_failed");
        return err;
    }

    s_transport = MQTT_MGR_TRANSPORT_MODEM;
    s_status.connected = true;
    s_status.subscribed = false;
    s_status.runtime.running = true;
    s_status.runtime.last_error = ESP_OK;
    s_status.runtime.last_error_text[0] = '\0';
    s_next_modem_connect_retry_ms = 0U;
    s_modem_connect_failure_count = 0U;
    s_modem_reset_pending = false;
    subscribe_err = mqtt_mgr_subscribe_modem_command_topics_locked();
    (void)subscribe_err;
    s_last_modem_subscribe_ms = unified_tick_now_ms();
    return ESP_OK;
}

static esp_err_t mqtt_mgr_stop_transport_locked(void) {
    char response[UNIFIED_TEXT_MEDIUM_LEN] = {0};

    if (s_transport == MQTT_MGR_TRANSPORT_MODEM) {
        (void)modem_a7670_mqtt_disconnect(response, sizeof(response), 5000U);
    } else if (s_client_started && s_client) {
        ESP_LOGI(TAG, "stopping client");
        if (esp_mqtt_client_stop(s_client) != ESP_OK) {
            s_status.runtime.last_error = ESP_FAIL;
            snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_stop_failed");
            return ESP_FAIL;
        }
    }

    s_client_started = false;
    s_transport = MQTT_MGR_TRANSPORT_NONE;
    s_disconnect_modem_after_esp_connected = false;
    s_modem_connection_seen = false;
    s_esp_connect_started_ms = 0U;
    s_last_modem_subscribe_ms = 0U;
    s_next_modem_connect_retry_ms = 0U;
    s_next_esp_start_retry_ms = 0U;
    s_modem_connect_failure_count = 0U;
    s_modem_reset_pending = false;
    s_status.connected = false;
    s_status.subscribed = false;
    s_status.runtime.running = false;
    return ESP_OK;
}

static esp_err_t mqtt_mgr_subscribe_topic_locked(const char *suffix) {
    char topic[160] = {0};
    int msg_id = 0;

    if (!s_client || !suffix || suffix[0] == '\0') {
        return ESP_ERR_INVALID_STATE;
    }
    if (mqtt_mgr_build_topic_locked(suffix, topic, sizeof(topic)) != ESP_OK) {
        return ESP_ERR_INVALID_SIZE;
    }

    msg_id = esp_mqtt_client_subscribe(s_client, topic, 1);
    if (msg_id < 0) {
        return ESP_FAIL;
    }

    s_status.subscribed_count++;
    return ESP_OK;
}

static esp_err_t mqtt_mgr_subscribe_commands_locked(void) {
    if (mqtt_mgr_subscribe_topic_locked("cmd/#") != ESP_OK) {
        return ESP_FAIL;
    }
    if (mqtt_mgr_subscribe_topic_locked("command/#") != ESP_OK) {
        return ESP_FAIL;
    }

    s_status.subscribed = true;
    return ESP_OK;
}

static esp_err_t mqtt_mgr_subscribe_modem_command_topics_locked(void) {
    typedef struct {
        const char *suffix;
        bool primary;
    } modem_command_topic_t;
    static const modem_command_topic_t command_topics[] = {
        { "command/+", true },
        { "command/get-status", true },
        { "command/send-sms", true },
        { "command/send-sms-multipart", true }
    };
    char topic[160] = {0};
    char response[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    esp_err_t last_err = ESP_FAIL;
    size_t success_count = 0U;
    bool primary_command_topic_subscribed = false;

    for (size_t index = 0U; index < sizeof(command_topics) / sizeof(command_topics[0]); ++index) {
        topic[0] = '\0';
        response[0] = '\0';
        if (mqtt_mgr_build_topic_locked(command_topics[index].suffix, topic, sizeof(topic)) != ESP_OK) {
            last_err = ESP_ERR_INVALID_SIZE;
            continue;
        }
        last_err = modem_a7670_mqtt_subscribe(topic, response, sizeof(response), 5000U);
        if (last_err == ESP_OK) {
            success_count++;
            if (command_topics[index].primary) {
                primary_command_topic_subscribed = true;
                if (index == 0U) {
                    break;
                }
            }
        }
    }

    if (primary_command_topic_subscribed) {
        s_status.subscribed = true;
        s_status.subscribed_count += success_count;
        return ESP_OK;
    }

    s_status.subscribed = false;
    s_status.runtime.last_error = last_err;
    snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_modem_subscribe_failed");
    return last_err;
}

static void mqtt_mgr_copy_json_string(char *dest, size_t dest_len, const char *src) {
    size_t write_index = 0;

    if (!dest || dest_len == 0) {
        return;
    }

    dest[0] = '\0';
    if (!src) {
        return;
    }

    while (*src && write_index + 1U < dest_len) {
        if ((*src == '\\' || *src == '"') && write_index + 2U < dest_len) {
            dest[write_index++] = '\\';
            dest[write_index++] = *src++;
        } else if (*src == '\n' && write_index + 2U < dest_len) {
            dest[write_index++] = '\\';
            dest[write_index++] = 'n';
            ++src;
        } else if (*src == '\r' && write_index + 2U < dest_len) {
            dest[write_index++] = '\\';
            dest[write_index++] = 'r';
            ++src;
        } else {
            dest[write_index++] = *src++;
        }
    }

    dest[write_index] = '\0';
}

static esp_err_t mqtt_mgr_build_topic_locked(const char *suffix, char *topic, size_t topic_len) {
    if (!suffix || !topic || topic_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    if ((s_topic_prefix[0] == '\0' || s_client_id[0] == '\0') &&
        mqtt_mgr_refresh_config_locked() != ESP_OK) {
        return ESP_ERR_INVALID_STATE;
    }

    return mqtt_mgr_build_topic_parts(
        s_topic_prefix[0] ? s_topic_prefix : "device",
        s_client_id,
        suffix,
        topic,
        topic_len
    );
}

static esp_err_t mqtt_mgr_build_topic_parts(
    const char *prefix,
    const char *device_id,
    const char *suffix,
    char *topic,
    size_t topic_len
) {
    size_t prefix_len = 0U;
    size_t device_id_len = 0U;
    size_t suffix_len = 0U;
    size_t total_len = 0U;

    if (!prefix || !device_id || !suffix || !topic || topic_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    prefix_len = strlen(prefix);
    device_id_len = strlen(device_id);
    suffix_len = strlen(suffix);
    total_len = prefix_len + 1U + device_id_len + 1U + suffix_len;
    if (total_len >= topic_len) {
        topic[0] = '\0';
        return ESP_ERR_INVALID_SIZE;
    }

    memcpy(topic, prefix, prefix_len);
    topic[prefix_len] = '/';
    memcpy(topic + prefix_len + 1U, device_id, device_id_len);
    topic[prefix_len + 1U + device_id_len] = '/';
    memcpy(topic + prefix_len + 1U + device_id_len + 1U, suffix, suffix_len);
    topic[total_len] = '\0';
    return ESP_OK;
}

static esp_err_t mqtt_mgr_parse_broker_uri(const char *uri, char *host, size_t host_len, uint16_t *port) {
    const char *start = uri;
    const char *host_end = NULL;
    const char *port_start = NULL;
    char port_text[8] = {0};
    int written = 0;

    if (!uri || !host || host_len == 0U || !port) {
        return ESP_ERR_INVALID_ARG;
    }

    host[0] = '\0';
    *port = 1883U;

    if (strncmp(start, "mqtt://", 7) == 0) {
        start += 7;
    } else if (strncmp(start, "tcp://", 6) == 0) {
        start += 6;
    }

    host_end = strpbrk(start, ":/");
    if (!host_end) {
        host_end = start + strlen(start);
    }
    written = snprintf(host, host_len, "%.*s", (int)(host_end - start), start);
    if (written <= 0 || (size_t)written >= host_len) {
        return ESP_ERR_INVALID_SIZE;
    }

    if (*host_end == ':') {
        const char *port_end = strchr(host_end + 1, '/');
        size_t port_len = port_end ? (size_t)(port_end - (host_end + 1)) : strlen(host_end + 1);

        if (port_len == 0U || port_len >= sizeof(port_text)) {
            return ESP_ERR_INVALID_ARG;
        }

        port_start = host_end + 1;
        snprintf(port_text, sizeof(port_text), "%.*s", (int)port_len, port_start);
        *port = (uint16_t)strtoul(port_text, NULL, 10);
        if (*port == 0U) {
            return ESP_ERR_INVALID_ARG;
        }
    }

    return ESP_OK;
}

static esp_err_t mqtt_mgr_publish_text(const char *suffix, const char *payload) {
    char topic[160] = {0};
    int publish_id = -1;
    char response[MQTT_MGR_MODEM_RESPONSE_LEN] = {0};
    esp_err_t err = ESP_OK;

    if (!suffix || !payload || !s_lock) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_client) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    if (mqtt_mgr_build_topic_locked(suffix, topic, sizeof(topic)) != ESP_OK) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_SIZE;
    }
    if (!s_status.connected) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_STATE;
    }

    if (s_transport == MQTT_MGR_TRANSPORT_MODEM) {
        err = modem_a7670_mqtt_publish(topic, payload, 1, response, sizeof(response), 15000U);
        if (err != ESP_OK) {
            s_status.publish_failures++;
            s_status.connected = false;
            s_status.subscribed = false;
            s_status.runtime.last_error = err;
            snprintf(
                s_status.runtime.last_error_text,
                sizeof(s_status.runtime.last_error_text),
                "%.*s",
                (int)sizeof(s_status.runtime.last_error_text) - 1,
                response[0] ? response : "mqtt_modem_publish_failed"
            );
            xSemaphoreGive(s_lock);
            return err;
        }
    } else {
        publish_id = esp_mqtt_client_publish(s_client, topic, payload, 0, 1, 0);
        if (publish_id < 0) {
            s_status.publish_failures++;
            snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_publish_failed");
            xSemaphoreGive(s_lock);
            return ESP_FAIL;
        }
    }

    s_status.published_count++;
    xSemaphoreGive(s_lock);
    return ESP_OK;
}

static void mqtt_mgr_process_modem_messages(void) {
    if (!s_modem_rx_payload) {
        return;
    }

    memset(s_modem_rx_topic, 0, sizeof(s_modem_rx_topic));
    memset(s_modem_rx_payload, 0, CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN);

    while (modem_a7670_pop_mqtt_message(
        s_modem_rx_topic,
        sizeof(s_modem_rx_topic),
        s_modem_rx_payload,
        CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN
    )) {
        ESP_LOGI(
            TAG,
            "processing modem mqtt topic=%s payload_len=%u",
            s_modem_rx_topic,
            (unsigned)strlen(s_modem_rx_payload)
        );
        esp_err_t submit_err = automation_bridge_submit_mqtt_command(
            s_modem_rx_topic,
            strlen(s_modem_rx_topic),
            s_modem_rx_payload,
            strlen(s_modem_rx_payload)
        );

        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
            return;
        }

        s_status.command_messages++;
        if (submit_err != ESP_OK) {
            s_status.command_rejects++;
            s_status.runtime.last_error = submit_err;
            snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_command_submit_failed");
            ESP_LOGW(TAG, "modem mqtt submit failed topic=%s err=%s", s_modem_rx_topic, esp_err_to_name(submit_err));
        } else {
            s_status.runtime.last_error = ESP_OK;
            s_status.runtime.last_error_text[0] = '\0';
            ESP_LOGI(TAG, "modem mqtt submitted topic=%s", s_modem_rx_topic);
        }
        mqtt_mgr_set_health_locked();
        xSemaphoreGive(s_lock);
    }
}

static void mqtt_mgr_handle_modem_message_ready(void) {
    TaskHandle_t mqtt_task_handle = s_mqtt_task_handle;

    if (mqtt_task_handle) {
        xTaskNotifyGive(mqtt_task_handle);
    }
}

static void mqtt_mgr_publish_pending_ussd_results(mqtt_mgr_loop_scratch_t *scratch) {
    if (!scratch) {
        return;
    }

    while (true) {
        const unified_ussd_payload_t *payload = NULL;

        if (s_have_pending_ussd_result) {
            payload = &s_pending_ussd_result;
        } else if (modem_a7670_pop_ussd_result(&scratch->ussd_payload)) {
            s_pending_ussd_result = scratch->ussd_payload;
            s_have_pending_ussd_result = true;
            memset(&scratch->ussd_payload, 0, sizeof(scratch->ussd_payload));
            payload = &s_pending_ussd_result;
        } else {
            break;
        }

        if (mqtt_mgr_publish_ussd_result(payload) != ESP_OK) {
            break;
        }

        memset(&s_pending_ussd_result, 0, sizeof(s_pending_ussd_result));
        s_have_pending_ussd_result = false;
        /* USSD can leave the modem CMQTT receive lane stale. Reset only the
         * RX assembly state here so follow-up menu replies can arrive without
         * tearing down the whole MQTT session after every menu publish. */
        modem_a7670_reset_mqtt_rx_state();
    }
}

static void mqtt_mgr_set_health_locked(void) {
    health_module_state_t module_state = HEALTH_MODULE_STATE_OK;
    const char *detail = "running";

    if (!s_status.configured) {
        module_state = HEALTH_MODULE_STATE_DEGRADED;
        detail = "mqtt_uri_not_configured";
        s_status.runtime.state = UNIFIED_MODULE_STATE_DEGRADED;
    } else if (!s_status.connected) {
        module_state = HEALTH_MODULE_STATE_DEGRADED;
        detail = "mqtt_disconnected";
        s_status.runtime.state = UNIFIED_MODULE_STATE_DEGRADED;
    } else {
        s_status.runtime.state = UNIFIED_MODULE_STATE_RUNNING;
    }

    health_monitor_set_module_state("mqtt_mgr", module_state, detail);
}

static TickType_t mqtt_mgr_compute_loop_delay(
    bool wait_for_wifi_primary,
    bool modem_mqtt_connected,
    bool connected,
    mqtt_mgr_transport_t transport,
    uint32_t now_ms,
    uint32_t next_action_retry_ms,
    uint32_t pending_action_sequence,
    uint32_t last_action_sequence
) {
    uint32_t delay_ms = MQTT_MGR_RECOVERY_LOOP_MS;
    bool action_pending = pending_action_sequence != 0U && pending_action_sequence > last_action_sequence;

    if (transport == MQTT_MGR_TRANSPORT_ESP &&
        connected &&
        !wait_for_wifi_primary &&
        !modem_mqtt_connected) {
        delay_ms = MQTT_MGR_STABLE_ESP_LOOP_MS;
    }

    if (action_pending && next_action_retry_ms == 0U) {
        delay_ms = MQTT_MGR_MIN_RETRY_CHECK_MS;
    } else if (action_pending && next_action_retry_ms != 0U) {
        if (now_ms >= next_action_retry_ms) {
            delay_ms = MQTT_MGR_MIN_RETRY_CHECK_MS;
        } else {
            uint32_t retry_due_in_ms = next_action_retry_ms - now_ms;
            if (retry_due_in_ms < MQTT_MGR_MIN_RETRY_CHECK_MS) {
                retry_due_in_ms = MQTT_MGR_MIN_RETRY_CHECK_MS;
            }
            if (retry_due_in_ms < delay_ms) {
                delay_ms = retry_due_in_ms;
            }
        }
    }

    return pdMS_TO_TICKS(delay_ms);
}

static esp_err_t mqtt_mgr_refresh_config_locked(void) {
    mqtt_mgr_config_refresh_scratch_t *scratch = &s_refresh_scratch;
    uint32_t config_revision = config_mgr_revision();
    uint16_t broker_port = 1883U;
    const char *device_id = NULL;
    const char *topic_prefix = NULL;
    bool configured = false;
    bool changed = false;
    esp_err_t copy_err = ESP_OK;

    if (config_revision != 0U && s_config_revision == config_revision) {
        return ESP_OK;
    }

    memset(scratch, 0, sizeof(*scratch));
    config_mgr_snapshot(&scratch->config);
    board_bsp_get_identity(&scratch->identity);

    configured = scratch->config.mqtt_enabled && scratch->config.mqtt_uri[0] != '\0';
    device_id = scratch->config.device_id_override[0] ? scratch->config.device_id_override : scratch->identity.device_id;
    topic_prefix = scratch->config.mqtt_topic_prefix[0] ? scratch->config.mqtt_topic_prefix : "device";

    copy_err = mqtt_mgr_copy_text(scratch->broker_uri, sizeof(scratch->broker_uri), scratch->config.mqtt_uri);
    if (copy_err == ESP_OK) {
        copy_err = mqtt_mgr_copy_text(scratch->username, sizeof(scratch->username), scratch->config.mqtt_username);
    }
    if (copy_err == ESP_OK) {
        copy_err = mqtt_mgr_copy_text(scratch->password, sizeof(scratch->password), scratch->config.mqtt_password);
    }
    if (copy_err == ESP_OK) {
        copy_err = mqtt_mgr_copy_text(scratch->client_id, sizeof(scratch->client_id), device_id);
    }
    if (copy_err == ESP_OK) {
        copy_err = mqtt_mgr_copy_text_suffix(
            scratch->modem_client_id,
            sizeof(scratch->modem_client_id),
            scratch->client_id,
            "-modem"
        );
    }
    if (copy_err == ESP_OK) {
        copy_err = mqtt_mgr_build_topic_parts(
            topic_prefix,
            device_id,
            "command/#",
            scratch->command_topic,
            sizeof(scratch->command_topic)
        );
    }
    if (copy_err != ESP_OK) {
        s_config_revision = config_revision;
        s_status.configured = configured;
        scratch->broker_uri[sizeof(scratch->broker_uri) - 1U] = '\0';
        (void)mqtt_mgr_copy_text(s_status.broker, sizeof(s_status.broker), scratch->broker_uri);
        s_status.runtime.last_error = copy_err;
        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_config_invalid");
        s_status.runtime.state = UNIFIED_MODULE_STATE_DEGRADED;
        return copy_err;
    }
    if (configured) {
        esp_err_t parse_err = mqtt_mgr_parse_broker_uri(
            scratch->broker_uri,
            scratch->broker_host,
            sizeof(scratch->broker_host),
            &broker_port
        );
        if (parse_err != ESP_OK) {
            s_config_revision = config_revision;
            s_status.configured = true;
            (void)mqtt_mgr_copy_text(s_status.broker, sizeof(s_status.broker), scratch->broker_uri);
            s_status.runtime.last_error = parse_err;
            snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_uri_invalid");
            s_status.runtime.state = UNIFIED_MODULE_STATE_DEGRADED;
            return parse_err;
        }
    }

    changed =
        configured != s_status.configured ||
        strcmp(s_broker_uri, scratch->broker_uri) != 0 ||
        strcmp(s_username, scratch->username) != 0 ||
        strcmp(s_password, scratch->password) != 0 ||
        strcmp(s_client_id, scratch->client_id) != 0 ||
        strcmp(s_modem_client_id, scratch->modem_client_id) != 0 ||
        strcmp(s_command_topic, scratch->command_topic) != 0 ||
        (configured && (!s_client || strcmp(s_broker_host, scratch->broker_host) != 0 || s_broker_port != broker_port)) ||
        (!configured && s_client != NULL);

    if (!changed) {
        s_config_revision = config_revision;
        return ESP_OK;
    }

    if (s_transport != MQTT_MGR_TRANSPORT_NONE || s_client_started) {
        (void)mqtt_mgr_stop_transport_locked();
    }
    if (s_client) {
        esp_mqtt_client_destroy(s_client);
        s_client = NULL;
    }

    s_status.configured = configured;
    (void)mqtt_mgr_copy_text(s_status.broker, sizeof(s_status.broker), scratch->broker_uri);
    (void)mqtt_mgr_copy_text(s_broker_uri, sizeof(s_broker_uri), scratch->broker_uri);
    (void)mqtt_mgr_copy_text(s_username, sizeof(s_username), scratch->username);
    (void)mqtt_mgr_copy_text(s_password, sizeof(s_password), scratch->password);
    (void)mqtt_mgr_copy_text(s_client_id, sizeof(s_client_id), scratch->client_id);
    (void)mqtt_mgr_copy_text(s_topic_prefix, sizeof(s_topic_prefix), topic_prefix);
    if (mqtt_mgr_copy_text_suffix(s_esp_client_id, sizeof(s_esp_client_id), scratch->client_id, "-wifi") != ESP_OK) {
        s_config_revision = config_revision;
        s_status.runtime.last_error = ESP_ERR_INVALID_SIZE;
        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_config_invalid");
        s_status.runtime.state = UNIFIED_MODULE_STATE_DEGRADED;
        return ESP_ERR_INVALID_SIZE;
    }
    (void)mqtt_mgr_copy_text(s_modem_client_id, sizeof(s_modem_client_id), scratch->modem_client_id);
    (void)mqtt_mgr_copy_text(s_broker_host, sizeof(s_broker_host), scratch->broker_host);
    (void)mqtt_mgr_copy_text(s_command_topic, sizeof(s_command_topic), scratch->command_topic);
    s_broker_port = broker_port;
    s_transport = MQTT_MGR_TRANSPORT_NONE;
    s_client_started = false;
    s_disconnect_modem_after_esp_connected = false;
    s_next_esp_start_retry_ms = 0U;
    s_status.connected = false;
    s_status.subscribed = false;
    s_status.runtime.running = false;

    if (!configured) {
        s_config_revision = config_revision;
        s_status.runtime.last_error = ESP_ERR_INVALID_STATE;
        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_uri_not_configured");
        s_status.runtime.state = UNIFIED_MODULE_STATE_DEGRADED;
        return ESP_OK;
    }

    scratch->mqtt_config.broker.address.uri = s_broker_uri;
    scratch->mqtt_config.credentials.username = s_username[0] ? s_username : NULL;
    scratch->mqtt_config.credentials.authentication.password = s_password[0] ? s_password : NULL;
    scratch->mqtt_config.credentials.client_id = s_esp_client_id;
    scratch->mqtt_config.session.keepalive = 60;
    scratch->mqtt_config.task.stack_size = MQTT_MGR_TASK_STACK_LEN;
    scratch->mqtt_config.task.priority = 5;

    ESP_LOGI(
        TAG,
        "config broker=%s task_stack=%d internal_free=%" PRIu32 " internal_largest=%" PRIu32,
        s_broker_uri[0] ? s_broker_uri : "<unset>",
        scratch->mqtt_config.task.stack_size,
        (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
        (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)
    );

    s_client = esp_mqtt_client_init(&scratch->mqtt_config);
    if (!s_client) {
        ESP_LOGE(TAG, "esp_mqtt_client_init failed broker=%s", s_broker_uri[0] ? s_broker_uri : "<unset>");
        s_config_revision = config_revision;
        s_status.runtime.last_error = ESP_ERR_NO_MEM;
        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_client_init_failed");
        s_status.runtime.state = UNIFIED_MODULE_STATE_DEGRADED;
        return ESP_ERR_NO_MEM;
    }

    ESP_ERROR_CHECK(esp_mqtt_client_register_event(s_client, MQTT_EVENT_ANY, mqtt_event_handler, NULL));
    s_config_revision = config_revision;
    s_status.runtime.last_error = ESP_OK;
    s_status.runtime.last_error_text[0] = '\0';
    return ESP_OK;
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data) {
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;

    (void)handler_args;
    (void)base;

    if (!s_lock) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    if (s_transport != MQTT_MGR_TRANSPORT_ESP && event_id != MQTT_EVENT_CONNECTED) {
        xSemaphoreGive(s_lock);
        return;
    }

    switch ((esp_mqtt_event_id_t)event_id) {
        case MQTT_EVENT_CONNECTED:
            ESP_LOGI(TAG, "connected to broker=%s", s_status.broker[0] != '\0' ? s_status.broker : "<unset>");
            s_transport = MQTT_MGR_TRANSPORT_ESP;
            s_disconnect_modem_after_esp_connected = modem_a7670_mqtt_is_connected();
            s_esp_connect_started_ms = 0U;
            s_status.connected = true;
            s_status.subscribed = false;
            s_status.runtime.running = true;
            s_status.runtime.last_error = ESP_OK;
            s_status.runtime.last_error_text[0] = '\0';
            if (mqtt_mgr_subscribe_commands_locked() != ESP_OK) {
                s_status.command_rejects++;
                s_status.runtime.last_error = ESP_FAIL;
                snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_subscribe_failed");
            }
            mqtt_mgr_set_health_locked();
            xSemaphoreGive(s_lock);
            return;
        case MQTT_EVENT_DISCONNECTED:
            ESP_LOGW(TAG, "disconnected from broker");
            s_esp_connect_started_ms = unified_tick_now_ms();
            s_status.connected = false;
            s_status.subscribed = false;
            s_status.reconnect_count++;
            s_status.runtime.last_error = ESP_FAIL;
            snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_disconnected");
            mqtt_mgr_set_health_locked();
            xSemaphoreGive(s_lock);
            return;
        case MQTT_EVENT_ERROR:
            ESP_LOGW(TAG, "broker error");
            s_esp_connect_started_ms = unified_tick_now_ms();
            s_status.connected = false;
            s_status.subscribed = false;
            s_status.publish_failures++;
            s_status.runtime.last_error = ESP_FAIL;
            snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_error");
            if (event && event->error_handle) {
                s_status.runtime.last_error = event->error_handle->esp_tls_last_esp_err;
            }
            mqtt_mgr_set_health_locked();
            xSemaphoreGive(s_lock);
            return;
        case MQTT_EVENT_DATA:
            if (event && event->topic && event->data) {
                esp_err_t submit_err = ESP_OK;

                s_status.command_messages++;
                if (event->current_data_offset != 0 || event->data_len != event->total_data_len) {
                    s_status.command_rejects++;
                    s_status.runtime.last_error = ESP_ERR_NOT_SUPPORTED;
                    snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_fragmented_command");
                    mqtt_mgr_set_health_locked();
                    xSemaphoreGive(s_lock);
                    return;
                }

                xSemaphoreGive(s_lock);
                submit_err = automation_bridge_submit_mqtt_command(
                    event->topic,
                    (size_t)event->topic_len,
                    event->data,
                    (size_t)event->data_len
                );

                if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
                    return;
                }
                if (submit_err != ESP_OK) {
                    s_status.command_rejects++;
                    s_status.runtime.last_error = submit_err;
                    snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_command_submit_failed");
                } else {
                    s_status.runtime.last_error = ESP_OK;
                    s_status.runtime.last_error_text[0] = '\0';
                }
                mqtt_mgr_set_health_locked();
                xSemaphoreGive(s_lock);
                return;
            }
            break;
        default:
            break;
    }

    xSemaphoreGive(s_lock);
}

static void mqtt_mgr_task(void *arg) {
    mqtt_mgr_loop_scratch_t *scratch = &s_loop_scratch;
    bool modem_mqtt_connected = false;
    bool loop_connected = false;
    bool disconnect_modem_after_esp_connected = false;
    bool reset_modem_after_unlock = false;
    mqtt_mgr_transport_t loop_transport = MQTT_MGR_TRANSPORT_NONE;
    TickType_t publish_delay = pdMS_TO_TICKS(MQTT_MGR_RECOVERY_LOOP_MS);
    uint32_t next_action_retry_ms = 0U;
    uint32_t pending_action_sequence = 0U;
    uint32_t last_action_sequence = 0U;
    uint32_t last_task_heartbeat_ms = 0U;
    uint32_t loop_now_ms = 0U;
    bool wait_for_wifi_primary = false;
    mqtt_mgr_status_listener_t status_listener = NULL;
    bool notify_status_listener = false;

    (void)arg;
    s_mqtt_task_handle = xTaskGetCurrentTaskHandle();
    modem_a7670_set_mqtt_event_listener(mqtt_mgr_handle_modem_message_ready);

    ESP_ERROR_CHECK(task_registry_register_expected("mqtt_task"));
    ESP_ERROR_CHECK(task_registry_mark_running("mqtt_task", true));
    ESP_ERROR_CHECK(health_monitor_register_module("mqtt_mgr"));

    while (true) {
        mqtt_mgr_get_loop_config(&scratch->config);
        modem_a7670_get_status(&scratch->modem);
        wifi_mgr_get_status(&scratch->wifi);
        modem_mqtt_connected = modem_a7670_mqtt_is_connected();
        wait_for_wifi_primary = mqtt_mgr_should_wait_for_wifi_primary(&scratch->config, &scratch->wifi);

        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            (void)mqtt_mgr_refresh_config_locked();
            if (!modem_mqtt_connected) {
                s_modem_connection_seen = false;
                s_last_modem_subscribe_ms = 0U;
                if (s_transport == MQTT_MGR_TRANSPORT_MODEM) {
                    s_status.subscribed = false;
                }
            }
            if (s_status.configured && s_client) {
                if (mqtt_mgr_wifi_primary_usable(&scratch->wifi)) {
                    bool modem_fallback_ready =
                        mqtt_mgr_modem_fallback_ready(&scratch->config, &scratch->modem);
                    uint32_t now_ms = unified_tick_now_ms();
                    bool esp_connect_stalled = s_client_started &&
                        s_transport == MQTT_MGR_TRANSPORT_ESP &&
                        !s_status.connected &&
                        s_esp_connect_started_ms != 0U &&
                        (now_ms - s_esp_connect_started_ms) >= MQTT_MGR_ESP_CONNECT_GRACE_MS;

                    if (esp_connect_stalled && modem_fallback_ready) {
                        /* Wi-Fi is up, but the ESP MQTT client has not reached a
                         * connected state within the grace window. Prefer modem
                         * MQTT over staying disconnected indefinitely. */
                        ESP_LOGW(
                            TAG,
                            "esp mqtt stalled for %" PRIu32 "ms on wifi; switching to modem fallback",
                            now_ms - s_esp_connect_started_ms
                        );
                        (void)mqtt_mgr_stop_transport_locked();
                        if (mqtt_mgr_start_modem_client_locked() == ESP_OK) {
                            modem_mqtt_connected = modem_a7670_mqtt_is_connected();
                        }
                    } else if (mqtt_mgr_start_esp_client_locked() != ESP_OK) {
                        if (s_transport == MQTT_MGR_TRANSPORT_MODEM && modem_mqtt_connected) {
                            s_status.connected = true;
                            s_status.runtime.running = true;
                        } else if (modem_fallback_ready) {
                            ESP_LOGW(TAG, "esp mqtt start failed on wifi; trying modem fallback");
                            if (mqtt_mgr_start_modem_client_locked() == ESP_OK) {
                                modem_mqtt_connected = modem_a7670_mqtt_is_connected();
                            }
                        }
                    }
                } else if (!wait_for_wifi_primary &&
                           mqtt_mgr_modem_fallback_ready(&scratch->config, &scratch->modem)) {
                    uint32_t now_ms = unified_tick_now_ms();
                    if (s_transport == MQTT_MGR_TRANSPORT_ESP) {
                        (void)mqtt_mgr_stop_transport_locked();
                    }
                    if (s_transport == MQTT_MGR_TRANSPORT_MODEM && modem_mqtt_connected) {
                        s_status.connected = true;
                        s_status.runtime.running = true;
                    } else {
                        if (s_transport == MQTT_MGR_TRANSPORT_MODEM) {
                            s_status.connected = false;
                            s_status.subscribed = false;
                            s_status.runtime.running = false;
                        }
                        if (s_next_modem_connect_retry_ms != 0U && now_ms < s_next_modem_connect_retry_ms) {
                            s_status.runtime.last_error = ESP_ERR_TIMEOUT;
                            snprintf(
                                s_status.runtime.last_error_text,
                                sizeof(s_status.runtime.last_error_text),
                                "%s",
                                "mqtt_modem_retry_wait"
                            );
                        } else if (mqtt_mgr_start_modem_client_locked() != ESP_OK) {
                            if (mqtt_mgr_is_bearer_recovery_failure(s_status.runtime.last_error_text)) {
                                if (s_modem_connect_failure_count < UINT8_MAX) {
                                    s_modem_connect_failure_count++;
                                }
                                if (s_modem_connect_failure_count >= MQTT_MGR_MODEM_RESET_THRESHOLD &&
                                    !s_modem_reset_pending) {
                                    s_modem_reset_pending = true;
                                    reset_modem_after_unlock = true;
                                    s_status.runtime.last_error = ESP_ERR_INVALID_STATE;
                                    snprintf(
                                        s_status.runtime.last_error_text,
                                        sizeof(s_status.runtime.last_error_text),
                                        "%s",
                                        "mqtt_modem_reset_pending"
                                    );
                                    s_next_modem_connect_retry_ms = now_ms + MQTT_MGR_MODEM_RESET_BACKOFF_MS;
                                } else {
                                    s_next_modem_connect_retry_ms = now_ms + MQTT_MGR_MODEM_RETRY_BACKOFF_MS;
                                }
                            } else {
                                s_modem_connect_failure_count = 0U;
                                s_next_modem_connect_retry_ms = now_ms + MQTT_MGR_MODEM_RETRY_BACKOFF_MS;
                            }
                        } else {
                            modem_mqtt_connected = modem_a7670_mqtt_is_connected();
                        }
                    }
                } else {
                    (void)mqtt_mgr_stop_transport_locked();
                    s_status.runtime.last_error = ESP_ERR_INVALID_STATE;
                    snprintf(
                        s_status.runtime.last_error_text,
                        sizeof(s_status.runtime.last_error_text),
                        "%s",
                        wait_for_wifi_primary
                            ? "wifi_primary_connecting"
                            : !scratch->modem.data_mode_enabled
                            ? "mobile_data_disabled"
                            : (scratch->modem.data_session_open && scratch->modem.data_ip_address[0] != '\0')
                            ? "modem_mqtt_pending"
                            : (scratch->modem.data_session_open && !scratch->modem.ip_bearer_ready)
                                ? "modem_data_not_ready"
                                : "wifi_not_ready"
                    );
                }
                if (s_transport == MQTT_MGR_TRANSPORT_MODEM && modem_mqtt_connected) {
                    s_status.connected = true;
                    s_status.runtime.running = true;
                } else if (s_transport == MQTT_MGR_TRANSPORT_MODEM) {
                    s_status.connected = false;
                    s_status.subscribed = false;
                    s_status.runtime.running = false;
                }
            }
            if (s_disconnect_modem_after_esp_connected &&
                s_transport == MQTT_MGR_TRANSPORT_ESP &&
                s_status.connected) {
                s_disconnect_modem_after_esp_connected = false;
                disconnect_modem_after_esp_connected = true;
            }
            loop_transport = s_transport;
            loop_connected = s_status.connected;
            next_action_retry_ms = s_next_action_result_retry_ms;
            pending_action_sequence = s_pending_action_result_sequence;
            last_action_sequence = s_last_action_result_sequence;
            mqtt_mgr_set_health_locked();
            xSemaphoreGive(s_lock);
        }

        if (reset_modem_after_unlock) {
            char response[UNIFIED_TEXT_MEDIUM_LEN] = {0};
            esp_err_t reset_err = modem_a7670_reset_modem(response, sizeof(response), 15000U);

            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                s_modem_reset_pending = false;
                s_modem_connect_failure_count = 0U;
                s_status.runtime.last_error = reset_err;
                snprintf(
                    s_status.runtime.last_error_text,
                    sizeof(s_status.runtime.last_error_text),
                    "%s",
                    reset_err == ESP_OK
                        ? "mqtt_modem_reset_requested"
                        : (response[0] ? response : "mqtt_modem_reset_failed")
                );
                xSemaphoreGive(s_lock);
            }
            reset_modem_after_unlock = false;
            modem_mqtt_connected = false;
        }

        if (disconnect_modem_after_esp_connected) {
            char response[UNIFIED_TEXT_MEDIUM_LEN] = {0};
            esp_err_t disconnect_err = modem_a7670_mqtt_disconnect(response, sizeof(response), 5000U);
            disconnect_modem_after_esp_connected = false;
            modem_mqtt_connected = modem_a7670_mqtt_is_connected();
            if (disconnect_err != ESP_OK && modem_mqtt_connected) {
                if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                    s_disconnect_modem_after_esp_connected = true;
                    s_status.runtime.last_error = disconnect_err;
                    snprintf(
                        s_status.runtime.last_error_text,
                        sizeof(s_status.runtime.last_error_text),
                        "%s",
                        response[0] ? response : "mqtt_modem_disconnect_failed"
                    );
                    xSemaphoreGive(s_lock);
                }
                ESP_LOGW(
                    TAG,
                    "modem mqtt disconnect deferred err=%s detail=%s",
                    esp_err_to_name(disconnect_err),
                    response[0] ? response : "<none>"
                );
            }
        }

        if (modem_mqtt_connected) {
            bool process_modem_messages = true;
            bool resubscribe_modem = false;
            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                if (!s_modem_connection_seen) {
                    s_modem_connection_seen = true;
                }
                if (s_transport == MQTT_MGR_TRANSPORT_ESP && s_status.connected) {
                    process_modem_messages = false;
                } else {
                    resubscribe_modem = s_last_modem_subscribe_ms == 0U ||
                                        !s_status.subscribed;
                    s_transport = MQTT_MGR_TRANSPORT_MODEM;
                    s_status.connected = true;
                    s_status.runtime.running = true;
                }
                if (resubscribe_modem) {
                    (void)mqtt_mgr_subscribe_modem_command_topics_locked();
                    s_last_modem_subscribe_ms = unified_tick_now_ms();
                }
                xSemaphoreGive(s_lock);
            }
            if (process_modem_messages) {
                mqtt_mgr_process_modem_messages();
            }
        }

        if (s_status.connected) {
            mqtt_mgr_publish_pending_ussd_results(scratch);
        }

        mqtt_mgr_publish_recent_action_results();

        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            loop_transport = s_transport;
            loop_connected = s_status.connected;
            next_action_retry_ms = s_next_action_result_retry_ms;
            pending_action_sequence = s_pending_action_result_sequence;
            last_action_sequence = s_last_action_result_sequence;
            if (s_status.connected != s_last_notified_connected) {
                s_last_notified_connected = s_status.connected;
                status_listener = s_status_listener;
                notify_status_listener = true;
            } else {
                status_listener = NULL;
                notify_status_listener = false;
            }
            xSemaphoreGive(s_lock);
        }
        if (notify_status_listener && status_listener) {
            status_listener();
        }
        loop_now_ms = unified_tick_now_ms();
        publish_delay = mqtt_mgr_compute_loop_delay(
            wait_for_wifi_primary,
            modem_mqtt_connected,
            loop_connected,
            loop_transport,
            loop_now_ms,
            next_action_retry_ms,
            pending_action_sequence,
            last_action_sequence
        );

        if (last_task_heartbeat_ms == 0U ||
            (loop_now_ms - last_task_heartbeat_ms) >= MQTT_MGR_TASK_HEARTBEAT_MS) {
            ESP_ERROR_CHECK(task_registry_heartbeat("mqtt_task"));
            last_task_heartbeat_ms = loop_now_ms;
        }
        (void)ulTaskNotifyTake(pdTRUE, publish_delay);
    }
}

esp_err_t mqtt_mgr_init(void) {
    BaseType_t task_ok = pdFAIL;

    if (s_ready) {
        return ESP_OK;
    }

    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) {
        return ESP_ERR_NO_MEM;
    }

    if (!s_action_records) {
        s_action_records = heap_caps_calloc(
            CONFIG_UNIFIED_API_BRIDGE_HISTORY_DEPTH,
            sizeof(api_bridge_action_record_t),
            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
        );
        if (!s_action_records) {
            s_action_records = heap_caps_calloc(
                CONFIG_UNIFIED_API_BRIDGE_HISTORY_DEPTH,
                sizeof(api_bridge_action_record_t),
                MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT
            );
        }
        if (!s_action_records) {
            vSemaphoreDelete(s_lock);
            s_lock = NULL;
            return ESP_ERR_NO_MEM;
        }
    }

    if (!s_modem_rx_payload) {
        s_modem_rx_payload = heap_caps_calloc(
            CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN,
            sizeof(char),
            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
        );
        if (!s_modem_rx_payload) {
            s_modem_rx_payload = heap_caps_calloc(
                CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN,
                sizeof(char),
                MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT
            );
        }
        if (!s_modem_rx_payload) {
            vSemaphoreDelete(s_lock);
            s_lock = NULL;
            return ESP_ERR_NO_MEM;
        }
    }

    (void)api_bridge_set_result_listener(mqtt_mgr_handle_action_record);

    memset(&s_status, 0, sizeof(s_status));
    s_status.runtime.initialized = true;
    s_status.runtime.state = UNIFIED_MODULE_STATE_INITIALIZED;
    s_pending_action_result_sequence = 0U;
    s_transport = MQTT_MGR_TRANSPORT_NONE;
    s_broker_port = 1883U;
    s_broker_host[0] = '\0';
    s_modem_connection_seen = false;
    s_last_modem_subscribe_ms = 0U;
    s_next_modem_connect_retry_ms = 0U;
    s_modem_connect_failure_count = 0U;
    s_modem_reset_pending = false;
    if (mqtt_mgr_refresh_config_locked() != ESP_OK && !s_client) {
        ESP_LOGW(TAG, "initial mqtt config invalid or incomplete");
    }

    #if CONFIG_SPIRAM && CONFIG_SPIRAM_ALLOW_STACK_EXTERNAL_MEMORY
    task_ok = xTaskCreatePinnedToCoreWithCaps(
        mqtt_mgr_task,
        "mqtt_task",
        MQTT_MGR_TASK_STACK_LEN,
        NULL,
        4,
        NULL,
        1,
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
    );
    #endif
    if (task_ok != pdPASS) {
        task_ok = xTaskCreatePinnedToCore(
            mqtt_mgr_task,
            "mqtt_task",
            MQTT_MGR_TASK_STACK_LEN,
            NULL,
            4,
            NULL,
            1
        );
    }
    if (task_ok != pdPASS) {
        ESP_LOGE(TAG, "failed to create mqtt_task stack=%d", MQTT_MGR_TASK_STACK_LEN);
        return ESP_ERR_NO_MEM;
    }

    s_ready = true;
    ESP_LOGI(TAG, "ready configured=%d broker=%s", s_status.configured ? 1 : 0, s_status.configured ? s_status.broker : "<unset>");
    return ESP_OK;
}

void mqtt_mgr_get_status(mqtt_mgr_status_t *out_status) {
    if (!out_status) {
        return;
    }

    memset(out_status, 0, sizeof(*out_status));
    if (!s_ready) {
        return;
    }
    if (!s_lock || xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        *out_status = s_status;
        return;
    }

    (void)mqtt_mgr_refresh_config_locked();
    *out_status = s_status;
    xSemaphoreGive(s_lock);
}

void mqtt_mgr_set_status_listener(mqtt_mgr_status_listener_t listener) {
    if (!s_ready || !s_lock) {
        return;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }
    s_status_listener = listener;
    xSemaphoreGive(s_lock);
}

esp_err_t mqtt_mgr_publish_sms_incoming(const unified_sms_payload_t *payload) {
    mqtt_mgr_sms_publish_scratch_t *scratch = NULL;
    esp_err_t err = ESP_OK;

    if (!payload) {
        return ESP_ERR_INVALID_ARG;
    }

    scratch = heap_caps_calloc(1U, sizeof(*scratch), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!scratch) {
        scratch = heap_caps_calloc(1U, sizeof(*scratch), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }
    if (!scratch) {
        return ESP_ERR_NO_MEM;
    }

    mqtt_mgr_copy_json_string(scratch->from, sizeof(scratch->from), payload->from);
    mqtt_mgr_copy_json_string(scratch->text, sizeof(scratch->text), payload->text);
    mqtt_mgr_copy_json_string(scratch->detail, sizeof(scratch->detail), payload->detail);
    snprintf(
        scratch->json,
        sizeof(scratch->json),
        "{\"type\":\"sms_incoming\",\"from\":\"%s\",\"text\":\"%s\",\"detail\":\"%s\",\"sim_slot\":%u,\"timestamp\":%" PRIu32 "}",
        scratch->from,
        scratch->text,
        scratch->detail,
        (unsigned)payload->sim_slot,
        payload->timestamp_ms
    );
    err = mqtt_mgr_publish_text("sms/incoming", scratch->json);
    heap_caps_free(scratch);
    return err;
}

esp_err_t mqtt_mgr_publish_sms_delivery(const unified_sms_delivery_payload_t *payload) {
    char to[UNIFIED_TEXT_SHORT_LEN * 2U] = {0};
    char raw[UNIFIED_TEXT_LONG_LEN * 2U] = {0};
    char json[384] = {0};

    if (!payload) {
        return ESP_ERR_INVALID_ARG;
    }

    mqtt_mgr_copy_json_string(to, sizeof(to), payload->to);
    mqtt_mgr_copy_json_string(raw, sizeof(raw), payload->raw);
    snprintf(
        json,
        sizeof(json),
        "{\"type\":\"sms_delivery\",\"to\":\"%s\",\"message_reference\":%u,\"status_report_status\":%u,\"sim_slot\":%u,\"timestamp\":%" PRIu32 ",\"raw_report\":\"%s\"}",
        to,
        (unsigned)payload->message_reference,
        (unsigned)payload->status_report_status,
        (unsigned)payload->sim_slot,
        payload->timestamp_ms,
        raw
    );
    return mqtt_mgr_publish_text("sms/delivery", json);
}

esp_err_t mqtt_mgr_publish_call_event(const unified_call_payload_t *payload) {
    char number[64] = {0};
    char state[64] = {0};
    char json[256] = {0};

    if (!payload) {
        return ESP_ERR_INVALID_ARG;
    }

    mqtt_mgr_copy_json_string(number, sizeof(number), payload->number);
    mqtt_mgr_copy_json_string(state, sizeof(state), payload->state);
    snprintf(
        json,
        sizeof(json),
        "{\"type\":\"call_event\",\"number\":\"%s\",\"state\":\"%s\",\"sim_slot\":%u,\"timestamp\":%" PRIu32 "}",
        number,
        state,
        (unsigned)payload->sim_slot,
        payload->timestamp_ms
    );
    (void)storage_mgr_append_call(payload);
    return mqtt_mgr_publish_text("call/events", json);
}

esp_err_t mqtt_mgr_publish_ussd_result(const unified_ussd_payload_t *payload) {
    char code[64] = {0};
    char status[64] = {0};
    char response[256] = {0};
    char json[512] = {0};

    if (!payload) {
        return ESP_ERR_INVALID_ARG;
    }

    mqtt_mgr_copy_json_string(code, sizeof(code), payload->code);
    mqtt_mgr_copy_json_string(status, sizeof(status), payload->status);
    mqtt_mgr_copy_json_string(response, sizeof(response), payload->response);
    snprintf(
        json,
        sizeof(json),
        "{\"type\":\"ussd_result\",\"code\":\"%s\",\"status\":\"%s\",\"response\":\"%s\",\"session_active\":%s,\"sim_slot\":%u,\"timestamp\":%" PRIu32 "}",
        code,
        status,
        response,
        payload->session_active ? "true" : "false",
        (unsigned)payload->sim_slot,
        payload->timestamp_ms
    );
    return mqtt_mgr_publish_text("ussd/result", json);
}

esp_err_t mqtt_mgr_publish_action_result(const unified_action_response_t *response, const char *payload_json) {
    char correlation_id[UNIFIED_CORRELATION_ID_LEN * 2U] = {0};
    char device_id[UNIFIED_DEVICE_ID_LEN * 2U] = {0};
    char detail[UNIFIED_TEXT_MEDIUM_LEN * 2U] = {0};
    char *json = NULL;
    size_t json_len = 512U;
    int written = 0;
    esp_err_t publish_err = ESP_OK;

    if (!response) {
        return ESP_ERR_INVALID_ARG;
    }

    if (payload_json && payload_json[0] != '\0') {
        json_len += strlen(payload_json);
    }
    json = heap_caps_calloc(1U, json_len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!json) {
        json = heap_caps_calloc(1U, json_len, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }
    if (!json) {
        return ESP_ERR_NO_MEM;
    }

    mqtt_mgr_copy_json_string(correlation_id, sizeof(correlation_id), response->action.correlation.correlation_id);
    mqtt_mgr_copy_json_string(device_id, sizeof(device_id), response->action.correlation.device_id);
    mqtt_mgr_copy_json_string(detail, sizeof(detail), response->detail);

    if (payload_json && payload_json[0] != '\0') {
        written = snprintf(
            json,
            json_len,
            "{\"action_id\":\"%s\",\"device_id\":\"%s\",\"command\":\"%s\",\"result\":\"%s\",\"result_code\":%" PRId32 ",\"feature_reason\":%u,\"detail\":\"%s\",\"created_ms\":%" PRIu32 ",\"timeout_ms\":%" PRIu32 ",\"payload\":%s}",
            correlation_id,
            device_id,
            unified_action_command_name(response->action.command),
            unified_action_result_name(response->result),
            response->result_code,
            (unsigned)response->feature_reason,
            detail,
            response->action.correlation.created_ms,
            response->action.timeout_ms,
            payload_json
        );
    } else {
        written = snprintf(
            json,
            json_len,
            "{\"action_id\":\"%s\",\"device_id\":\"%s\",\"command\":\"%s\",\"result\":\"%s\",\"result_code\":%" PRId32 ",\"feature_reason\":%u,\"detail\":\"%s\",\"created_ms\":%" PRIu32 ",\"timeout_ms\":%" PRIu32 "}",
            correlation_id,
            device_id,
            unified_action_command_name(response->action.command),
            unified_action_result_name(response->result),
            response->result_code,
            (unsigned)response->feature_reason,
            detail,
            response->action.correlation.created_ms,
            response->action.timeout_ms
        );
    }

    if (written < 0 || (size_t)written >= json_len) {
        heap_caps_free(json);
        return ESP_ERR_INVALID_SIZE;
    }

    publish_err = mqtt_mgr_publish_text("action/result", json);
    ESP_LOGI(
        TAG,
        "action result publish command=%s result=%s err=%s",
        unified_action_command_name(response->action.command),
        unified_action_result_name(response->result),
        esp_err_to_name(publish_err)
    );
    heap_caps_free(json);
    return publish_err;
}

esp_err_t mqtt_mgr_publish_json(const char *suffix, const char *json) {
    if (!suffix || !json) {
        return ESP_ERR_INVALID_ARG;
    }

    return mqtt_mgr_publish_text(suffix, json);
}

static void mqtt_mgr_publish_recent_action_results(void) {
    size_t count = 0;
    size_t index = 0;
    uint32_t now_ms = 0U;
    uint32_t pending_sequence = 0U;
    uint32_t retry_ms = 0U;
    uint32_t last_published_sequence = 0U;
    uint32_t published_count_delta = 0U;
    uint32_t skipped_background_count = 0U;
    uint32_t processed_count = 0U;
    bool connected = false;

    if (!s_ready || !s_lock) {
        return;
    }

    now_ms = unified_tick_now_ms();
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    pending_sequence = s_pending_action_result_sequence;
    retry_ms = s_next_action_result_retry_ms;
    connected = s_status.connected;
    last_published_sequence = s_last_action_result_sequence;
    if (pending_sequence != 0U &&
        pending_sequence > s_last_action_result_sequence &&
        !connected &&
        (retry_ms == 0U || now_ms >= retry_ms)) {
        s_next_action_result_retry_ms = now_ms + MQTT_MGR_RECOVERY_LOOP_MS;
        retry_ms = s_next_action_result_retry_ms;
    }
    xSemaphoreGive(s_lock);

    if (!connected) {
        return;
    }
    if (retry_ms != 0U && now_ms < retry_ms) {
        return;
    }
    if (pending_sequence == 0U || pending_sequence <= s_last_action_result_sequence) {
        return;
    }

    count = api_bridge_snapshot_recent_records(s_action_records, CONFIG_UNIFIED_API_BRIDGE_HISTORY_DEPTH);
    for (index = 0; index < count; ++index) {
        esp_err_t err = ESP_OK;
        bool background_record = false;
        bool superseded_background = false;

        if (s_action_records[index].sequence == 0U || s_action_records[index].sequence <= last_published_sequence) {
            continue;
        }

        background_record = mqtt_mgr_is_background_action_command(s_action_records[index].response.action.command);
        superseded_background = background_record &&
            mqtt_mgr_has_newer_background_record(
                s_action_records,
                count,
                index,
                last_published_sequence
            );

        if (superseded_background) {
            last_published_sequence = s_action_records[index].sequence;
            skipped_background_count++;
            continue;
        }

        err = mqtt_mgr_publish_action_result(
            &s_action_records[index].response,
            s_action_records[index].payload[0] != '\0' ? s_action_records[index].payload : NULL
        );

        if (err == ESP_OK) {
            last_published_sequence = s_action_records[index].sequence;
            published_count_delta++;
            processed_count++;
            if (processed_count >= MQTT_MGR_ACTION_RESULT_BATCH_LIMIT) {
                break;
            }
        } else {
            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
                return;
            }
            s_last_action_result_sequence = last_published_sequence;
            s_status.action_results_published += published_count_delta;
            s_status.action_result_failures++;
            s_status.runtime.last_error = err;
            snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_action_result_publish_failed");
            s_next_action_result_retry_ms = now_ms + 5000U;
            mqtt_mgr_set_health_locked();
            xSemaphoreGive(s_lock);
            return;
        }
    }

    if (published_count_delta > 0U) {
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
            return;
        }
        s_last_action_result_sequence = last_published_sequence;
        s_status.action_results_published += published_count_delta;
        s_next_action_result_retry_ms = 0U;
        xSemaphoreGive(s_lock);
    }

    if (skipped_background_count > 0U && xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        if (last_published_sequence > s_last_action_result_sequence) {
            s_last_action_result_sequence = last_published_sequence;
        }
        xSemaphoreGive(s_lock);
    }
}

static void mqtt_mgr_handle_action_record(const api_bridge_action_record_t *record) {
    TaskHandle_t mqtt_task_handle = NULL;

    if (!record || record->sequence == 0U || !s_ready || !s_lock) {
        return;
    }
    if (record->response.action.command == UNIFIED_ACTION_CMD_STATUS_WATCH) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    /* Keep action execution light: the automation bridge can call this listener
     * from its command task, so modem publish work is deferred to mqtt_task. */
    if (record->sequence > s_pending_action_result_sequence) {
        s_pending_action_result_sequence = record->sequence;
    }
    if (record->sequence > s_last_action_result_sequence) {
        s_next_action_result_retry_ms = 0U;
    }
    mqtt_task_handle = s_mqtt_task_handle;
    xSemaphoreGive(s_lock);

    if (mqtt_task_handle) {
        xTaskNotifyGive(mqtt_task_handle);
    }
}
