#include "mqtt_mgr.h"
#include "mqtt_failover.h"
#include "mqtt_recovery.h"
#include "ota_validation_gate.h"

#include <inttypes.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "mqtt_client.h"
#include "cJSON.h"

#include "api_bridge.h"
#include "automation_bridge.h"
#include "board_bsp.h"
#include "config_mgr.h"
#include "health_monitor.h"
#include "modem_a7670.h"
#include "storage_mgr.h"
#include "state_mgr.h"
#include "task_registry.h"
#include "unified_runtime.h"
#include "wifi_mgr.h"

static const char *TAG = "mqtt_mgr";

#define MQTT_MGR_RECOVERY_LOOP_MS           500U
#define MQTT_MGR_STABLE_ESP_LOOP_MS        1000U
#define MQTT_MGR_TASK_HEARTBEAT_MS         5000U
#define MQTT_MGR_MIN_RETRY_CHECK_MS         100U
#define MQTT_MGR_MODEM_RETRY_BACKOFF_MS   15000U
#define MQTT_MGR_MODEM_RETRY_MAX_MS      300000U
#define MQTT_MGR_MODEM_RESET_BACKOFF_MS   45000U
#define MQTT_MGR_MODEM_RESET_THRESHOLD        3U
#define MQTT_MGR_MODEM_RESPONSE_LEN          512U
#define MQTT_MGR_ESP_START_RETRY_MS       15000U
#define MQTT_MGR_ESP_START_INTERNAL_MARGIN_BYTES 512U
#define MQTT_MGR_ESP_CLIENT_STACK_LEN     6144U
#define MQTT_MGR_ESP_CONNECT_GRACE_MS      20000U
#define MQTT_MGR_WIFI_PROMOTION_HOLD_MS    30000U
#define MQTT_MGR_MODEM_RESUBSCRIBE_MS     300000U
/* FW-03: drain at least a full automation-queue worth of results per cycle
 * so unpublished results cannot be overwritten by the 8-entry history ring
 * while more commands complete. History depth is raised to 20 (see Kconfig),
 * queue depth is 16, and each cycle now drains up to 16 results. */
#define MQTT_MGR_ACTION_RESULT_BATCH_LIMIT    16U
/* Resource fix: mqtt_task measured only 764B of headroom at 8192; the deep
 * publish chain (result -> publish_text -> esp/modem publish) plus JSON
 * formatting needs more margin to avoid stack-overflow hangs. */
#define MQTT_MGR_TASK_STACK_LEN           10240U
#define MQTT_MGR_INGRESS_DEPTH               16U
#define MQTT_MGR_INGRESS_PAYLOAD_LEN       (CONFIG_UNIFIED_AUTOMATION_MESSAGE_LEN - 1U)
#define MQTT_MGR_SUBACK_TIMEOUT_MS       15000U
#define MQTT_MGR_ACTION_RESULT_ACK_TIMEOUT_MS 15000U

typedef struct {
    int32_t event_id;
    uint32_t generation;
    int msg_id;
    esp_err_t error;
    int offset;
    int total;
    size_t length;
    size_t topic_length;
    bool invalid;
    bool retained;
    char topic[160];
    char data[MQTT_MGR_INGRESS_PAYLOAD_LEN + 1U];
} mqtt_mgr_ingress_event_t;

typedef struct {
    mqtt_mgr_ingress_event_t producer;
    mqtt_mgr_ingress_event_t pending;
    char topic[160];
    char payload[MQTT_MGR_INGRESS_PAYLOAD_LEN + 1U];
    size_t received;
    size_t total;
    int msg_id;
    bool have_pending;
    bool retained;
} mqtt_mgr_ingress_scratch_t;

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
    char multipart_ref[64];
    char json[1408];
} mqtt_mgr_sms_publish_scratch_t;

static SemaphoreHandle_t s_lock;
static mqtt_mgr_status_t s_status;
static esp_mqtt_client_handle_t s_client;
static uint32_t s_last_action_result_sequence;
static uint32_t s_pending_action_result_sequence;
/* Neither listener may wait on s_lock: ESP-MQTT invokes callbacks while
 * holding its API mutex, and API result listeners run on the command lane. */
static atomic_uint s_result_sequence_watermark;
static atomic_uint s_ingress_overflow;
static uint32_t s_client_generation;
static QueueHandle_t s_ingress_queue;
static StaticQueue_t s_ingress_queue_control;
static uint8_t *s_ingress_queue_storage;
static mqtt_mgr_ingress_scratch_t *s_ingress;
enum {
    MQTT_SUBSCRIBE_PRIMARY_COMMAND = 0,
    MQTT_SUBSCRIBE_LEGACY_CMD = 1,
    MQTT_SUBSCRIBE_TOPIC_COUNT = 2
};
static int s_subscribe_ids[MQTT_SUBSCRIBE_TOPIC_COUNT] = {-1, -1};
static bool s_subscribe_acked[MQTT_SUBSCRIBE_TOPIC_COUNT];
static uint32_t s_suback_deadline_ms;
static mqtt_recovery_t s_esp_recovery;
static char s_publish_response[MQTT_MGR_MODEM_RESPONSE_LEN];
static bool s_ota_confirmed;
static ota_validation_gate_t s_ota_validation;
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
static uint32_t s_next_durable_result_retry_ms;
/* An ESP-MQTT message ID proves enqueue, not broker receipt. Keep the action
 * result cursor behind the QoS 1 PUBACK so reconnect can replay safely. */
static int s_action_result_inflight_msg_id;
static uint32_t s_action_result_inflight_sequence;
static uint32_t s_action_result_ack_deadline_ms;
static char s_modem_rx_topic[160];
static char *s_modem_rx_payload;
static bool s_disconnect_modem_after_esp_connected;
static bool s_modem_connection_seen;
static uint32_t s_last_modem_subscribe_ms;
static uint32_t s_next_modem_connect_retry_ms;
static uint32_t s_next_esp_start_retry_ms;
static uint8_t s_modem_connect_failure_count;
static uint8_t s_modem_endpoint_failure_count;
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
static uint32_t s_esp_connected_since_ms;

static esp_err_t mqtt_mgr_refresh_config_locked(void);
static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data);
static void mqtt_mgr_process_esp_events(void);
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
static void mqtt_mgr_publish_durable_result(void);
static bool mqtt_mgr_is_result_ack_topic(const char *topic);
static esp_err_t mqtt_mgr_process_result_ack(const char *topic, const char *payload);
static void mqtt_mgr_handle_action_record(const api_bridge_action_record_t *record);
static void mqtt_mgr_handle_modem_message_ready(void);
static void mqtt_mgr_publish_pending_ussd_results(mqtt_mgr_loop_scratch_t *scratch);
static esp_err_t mqtt_mgr_parse_broker_uri(const char *uri, char *host, size_t host_len, uint16_t *port);
static esp_err_t mqtt_mgr_start_esp_client_locked(void);
static esp_err_t mqtt_mgr_start_modem_client_locked(void);
static esp_err_t mqtt_mgr_stop_transport_locked(void);
static void mqtt_mgr_process_modem_messages(void);
static void mqtt_mgr_set_health_locked(void);
static esp_err_t mqtt_mgr_publish_text_tracked(const char *suffix, const char *payload, int *out_message_id);
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
static bool mqtt_mgr_wifi_primary_usable(const wifi_mgr_status_t *wifi);
static bool mqtt_mgr_broker_is_lan_scoped(const char *host);
static bool mqtt_mgr_modem_fallback_ready(
    const config_mgr_data_t *config,
    const modem_a7670_status_t *modem
);
static void mqtt_mgr_get_loop_config(config_mgr_data_t *out_config);
static bool mqtt_mgr_is_background_action_command(unified_action_command_t command);
static bool mqtt_mgr_has_newer_background_record(
    const api_bridge_action_record_t *records,
    size_t count,
    size_t current_index,
    uint32_t last_published_sequence
);

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

    /* Wi-Fi remains the preferred path only after it is actually usable.
     * While it is disconnected, do not hold MQTT offline for startup scans,
     * absent-AP retries, or credential/auth retries. The Wi-Fi manager keeps
     * reconnecting in the background and this task promotes Wi-Fi after it has
     * IP plus a stability hold. */
    return false;
}

static bool mqtt_mgr_wifi_primary_usable(const wifi_mgr_status_t *wifi) {
    /* Association plus an assigned IP is the routing fact. RSSI remains
     * telemetry: a weak but working LAN link must still be allowed to recover
     * its MQTT session, and the existing connect-grace timer detects a broker
     * path that is actually unusable. */
    return wifi && wifi->connected && wifi->ip_assigned;
}

static bool mqtt_mgr_policy_allows_wifi(const config_mgr_data_t *config) {
    return config && config->connection_policy != CONFIG_CONNECTION_CELLULAR_ONLY;
}

static bool mqtt_mgr_policy_prefers_cellular(const config_mgr_data_t *config) {
    return config &&
        (config->connection_policy == CONFIG_CONNECTION_CELLULAR_ONLY ||
         config->connection_policy == CONFIG_CONNECTION_CELLULAR_WIFI_FALLBACK);
}

static bool mqtt_mgr_policy_allows_modem(const config_mgr_data_t *config) {
    return config && config->connection_policy != CONFIG_CONNECTION_WIFI_ONLY;
}

static bool mqtt_mgr_broker_is_lan_scoped(const char *host) {
    unsigned octet_a = 0U;
    unsigned octet_b = 0U;
    unsigned octet_c = 0U;
    unsigned octet_d = 0U;
    char trailing = '\0';
    int parsed = 0;

    if (!host || host[0] == '\0') {
        return false;
    }
    if (strcmp(host, "localhost") == 0) {
        return true;
    }

    parsed = sscanf(
        host,
        "%u.%u.%u.%u%c",
        &octet_a,
        &octet_b,
        &octet_c,
        &octet_d,
        &trailing
    );
    if (parsed != 4 || octet_a > 255U || octet_b > 255U ||
        octet_c > 255U || octet_d > 255U) {
        return false;
    }

    return octet_a == 0U ||
           octet_a == 10U ||
           octet_a == 127U ||
           (octet_a == 100U && octet_b >= 64U && octet_b <= 127U) ||
           (octet_a == 169U && octet_b == 254U) ||
           (octet_a == 172U && octet_b >= 16U && octet_b <= 31U) ||
           (octet_a == 192U && octet_b == 168U) ||
           octet_a >= 224U;
}

static bool mqtt_mgr_modem_fallback_ready(
    const config_mgr_data_t *config,
    const modem_a7670_status_t *modem
) {
    if (!config || !modem) {
        return false;
    }

    /* The modem client has no TLS parameter/certificate path. Never downgrade
     * an mqtts/ssl URI to plaintext modem MQTT. */
    if (strncmp(config->mqtt_uri, "mqtts://", 8) == 0 ||
        strncmp(config->mqtt_uri, "ssl://", 6) == 0) {
        return false;
    }

    /* A normal cellular bearer cannot route loopback, link-local, RFC1918, or
     * CGNAT broker literals. Keep retrying the ESP/LAN client instead of
     * blocking the modem lane with guaranteed CMQTT failures. */
    return !mqtt_mgr_broker_is_lan_scoped(s_broker_host) &&
           mqtt_mgr_policy_allows_modem(config) &&
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
        if (s_transport != MQTT_MGR_TRANSPORT_MODEM) {
            s_transport = MQTT_MGR_TRANSPORT_ESP;
        }
        return ESP_OK;
    }
    if (s_next_esp_start_retry_ms != 0U && (int32_t)(now_ms - s_next_esp_start_retry_ms) < 0) {
        /* Keep the actual last start failure visible while backing off. */
        return ESP_ERR_TIMEOUT;
    }
    internal_largest = (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (internal_largest < (MQTT_MGR_ESP_CLIENT_STACK_LEN + MQTT_MGR_ESP_START_INTERNAL_MARGIN_BYTES)) {
        s_next_esp_start_retry_ms = now_ms + MQTT_MGR_ESP_START_RETRY_MS;
        s_status.runtime.last_error = ESP_ERR_NO_MEM;
        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_esp_internal_heap_low");
        ESP_LOGW(
            TAG,
            "skip esp mqtt start internal_largest=%" PRIu32 " required=%u",
            internal_largest,
            (unsigned)(MQTT_MGR_ESP_CLIENT_STACK_LEN + MQTT_MGR_ESP_START_INTERNAL_MARGIN_BYTES)
        );
        return ESP_ERR_NO_MEM;
    }
    mqtt_mgr_log_internal_heap("before_start");
    ESP_LOGI(TAG, "starting client broker=%s", s_status.broker[0] != '\0' ? s_status.broker : "<unset>");
    esp_err_t start_err = esp_mqtt_client_start(s_client);
    if (start_err != ESP_OK) {
        mqtt_mgr_log_internal_heap("start_failed");
        s_next_esp_start_retry_ms = now_ms + MQTT_MGR_ESP_START_RETRY_MS;
        s_status.runtime.last_error = start_err;
        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_start_failed");
        return start_err;
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
    s_modem_endpoint_failure_count = 0U;
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
        esp_err_t stop_err = esp_mqtt_client_stop(s_client);
        if (stop_err != ESP_OK) {
            s_status.runtime.last_error = stop_err;
            snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_stop_failed");
            return stop_err;
        }
    }

    s_client_started = false;
    s_transport = MQTT_MGR_TRANSPORT_NONE;
    s_disconnect_modem_after_esp_connected = false;
    s_modem_connection_seen = false;
    s_esp_connect_started_ms = 0U;
    s_esp_connected_since_ms = 0U;
    s_last_modem_subscribe_ms = 0U;
    s_next_modem_connect_retry_ms = 0U;
    s_next_esp_start_retry_ms = 0U;
    /* The ESP client's outbox no longer proves delivery after a controlled
     * stop or transport switch. Leave the sequence watermark pending so the
     * next connected transport replays the same action ID. */
    s_action_result_inflight_msg_id = -1;
    s_action_result_inflight_sequence = 0U;
    s_action_result_ack_deadline_ms = 0U;
    s_next_action_result_retry_ms = 0U;
    s_modem_connect_failure_count = 0U;
    s_modem_endpoint_failure_count = 0U;
    s_modem_reset_pending = false;
    s_status.connected = false;
    s_status.subscribed = false;
    s_suback_deadline_ms = 0U;
    for (size_t index = 0U; index < MQTT_SUBSCRIBE_TOPIC_COUNT; ++index) {
        s_subscribe_ids[index] = -1;
    }
    memset(s_subscribe_acked, 0, sizeof(s_subscribe_acked));
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

    if (strcmp(suffix, "command/#") == 0) {
        s_subscribe_ids[MQTT_SUBSCRIBE_PRIMARY_COMMAND] = msg_id;
    } else if (strcmp(suffix, "cmd/#") == 0) {
        s_subscribe_ids[MQTT_SUBSCRIBE_LEGACY_CMD] = msg_id;
    }
    return ESP_OK;
}

static bool mqtt_mgr_primary_subscription_ready_locked(void) {
    return mqtt_primary_subscription_ready(
        s_status.subscribed,
        s_subscribe_acked[MQTT_SUBSCRIBE_PRIMARY_COMMAND]);
}

static esp_err_t mqtt_mgr_subscribe_commands_locked(void) {
    s_status.subscribed = false;
    for (size_t index = 0U; index < MQTT_SUBSCRIBE_TOPIC_COUNT; ++index) {
        s_subscribe_ids[index] = -1;
    }
    memset(s_subscribe_acked, 0, sizeof(s_subscribe_acked));
    s_suback_deadline_ms = 0U;
    /* command/# is the active dashboard/device contract. Subscribe it first so
     * loss of the historical cmd/# alias cannot block command readiness or
     * trigger reconnect churn on an otherwise working session. */
    if (mqtt_mgr_subscribe_topic_locked("command/#") != ESP_OK) {
        return ESP_FAIL;
    }
    if (mqtt_mgr_subscribe_topic_locked("cmd/#") != ESP_OK) {
        s_subscribe_ids[MQTT_SUBSCRIBE_LEGACY_CMD] = -1;
        ESP_LOGW(TAG, "legacy cmd/# subscription unavailable; primary command/# remains pending");
    }

    s_suback_deadline_ms = unified_tick_now_ms() + MQTT_MGR_SUBACK_TIMEOUT_MS;

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
        const unsigned char value = (unsigned char)*src++;
        const char *escape = NULL;
        switch (value) {
            case '\\': escape = "\\\\"; break;
            case '"':  escape = "\\\""; break;
            case '\b': escape = "\\b"; break;
            case '\f': escape = "\\f"; break;
            case '\n': escape = "\\n"; break;
            case '\r': escape = "\\r"; break;
            case '\t': escape = "\\t"; break;
            default: break;
        }
        if (escape) {
            const size_t escape_len = strlen(escape);
            if (write_index + escape_len >= dest_len) break;
            memcpy(dest + write_index, escape, escape_len);
            write_index += escape_len;
        } else if (value < 0x20U) {
            if (write_index + 6U >= dest_len) break;
            const int written = snprintf(dest + write_index, dest_len - write_index,
                                         "\\u%04x", (unsigned)value);
            if (written != 6) break;
            write_index += 6U;
        } else {
            dest[write_index++] = (char)value;
        }
    }

    dest[write_index] = '\0';
}

static esp_err_t mqtt_mgr_format_json(char *dest, size_t dest_len, const char *format, ...) {
    va_list args;
    int written = 0;

    if (!dest || dest_len == 0U || !format) {
        return ESP_ERR_INVALID_ARG;
    }

    va_start(args, format);
    written = vsnprintf(dest, dest_len, format, args);
    va_end(args);

    if (written < 0 || (size_t)written >= dest_len) {
        dest[0] = '\0';
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
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
    char *port_parse_end = NULL;
    char port_text[8] = {0};
    int written = 0;
    unsigned long parsed_port = 0UL;

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
    if (host_end == start) {
        return ESP_ERR_INVALID_ARG;
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
        written = snprintf(port_text, sizeof(port_text), "%.*s", (int)port_len, port_start);
        if (written <= 0 || (size_t)written >= sizeof(port_text)) {
            return ESP_ERR_INVALID_SIZE;
        }
        parsed_port = strtoul(port_text, &port_parse_end, 10);
        if (!port_parse_end || *port_parse_end != '\0' || parsed_port == 0UL || parsed_port > UINT16_MAX) {
            return ESP_ERR_INVALID_ARG;
        }
        *port = (uint16_t)parsed_port;
    }

    return ESP_OK;
}

static esp_err_t mqtt_mgr_publish_text_tracked(const char *suffix, const char *payload, int *out_message_id) {
    char topic[160] = {0};
    int publish_id = -1;
    char *response = s_publish_response;   /* guarded by s_lock below */
    esp_err_t err = ESP_OK;
    esp_err_t topic_err = ESP_OK;

    if (!suffix || !payload || !s_lock) {
        return ESP_ERR_INVALID_ARG;
    }
    if (out_message_id) {
        *out_message_id = 0;
    }
    if (!s_ready || !s_client) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    response[0] = '\0';
    topic_err = mqtt_mgr_build_topic_locked(suffix, topic, sizeof(topic));
    if (topic_err != ESP_OK) {
        s_status.publish_failures++;
        s_status.runtime.last_error = topic_err;
        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_topic_build_failed");
        xSemaphoreGive(s_lock);
        return topic_err;
    }
    if (!s_status.connected) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_STATE;
    }

    if (s_transport == MQTT_MGR_TRANSPORT_MODEM) {
        err = modem_a7670_mqtt_publish(topic, payload, 1, response, MQTT_MGR_MODEM_RESPONSE_LEN, 15000U);
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
        if (out_message_id) {
            *out_message_id = publish_id;
        }
    }

    s_status.published_count++;
    xSemaphoreGive(s_lock);
    return ESP_OK;
}

static esp_err_t mqtt_mgr_publish_text(const char *suffix, const char *payload) {
    return mqtt_mgr_publish_text_tracked(suffix, payload, NULL);
}

static void mqtt_mgr_process_modem_messages(void) {
    if (!s_modem_rx_payload) {
        return;
    }

    while (true) {
        bool has_message = false;

        memset(s_modem_rx_topic, 0, sizeof(s_modem_rx_topic));
        memset(s_modem_rx_payload, 0, CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN);
        has_message = modem_a7670_pop_mqtt_message(
            s_modem_rx_topic,
            sizeof(s_modem_rx_topic),
            s_modem_rx_payload,
            CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN
        );
        if (!has_message) {
            break;
        }

        ESP_LOGI(
            TAG,
            "processing modem mqtt topic=%s payload_len=%u",
            s_modem_rx_topic,
            (unsigned)strlen(s_modem_rx_payload)
        );
        if (mqtt_mgr_is_result_ack_topic(s_modem_rx_topic)) {
            (void)mqtt_mgr_process_result_ack(s_modem_rx_topic, s_modem_rx_payload);
            continue;
        }
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
    } else if (!s_status.subscribed) {
        module_state = HEALTH_MODULE_STATE_DEGRADED;
        detail = "mqtt_command_subscription_pending";
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
    s_esp_connected_since_ms = 0U;
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
    scratch->mqtt_config.task.stack_size = MQTT_MGR_ESP_CLIENT_STACK_LEN;
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

    ++s_client_generation;
    ESP_ERROR_CHECK(esp_mqtt_client_register_event(
        s_client, MQTT_EVENT_ANY, mqtt_event_handler, (void *)(uintptr_t)s_client_generation));
    s_config_revision = config_revision;
    s_status.runtime.last_error = ESP_OK;
    s_status.runtime.last_error_text[0] = '\0';
    return ESP_OK;
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data) {
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;
    (void)base;
    if (!s_ingress_queue || !s_ingress || !event) {
        return;
    }
    if (event_id != MQTT_EVENT_CONNECTED && event_id != MQTT_EVENT_DISCONNECTED &&
        event_id != MQTT_EVENT_ERROR && event_id != MQTT_EVENT_SUBSCRIBED &&
        event_id != MQTT_EVENT_PUBLISHED &&
        event_id != MQTT_EVENT_DATA) {
        return;
    }
    /* ESP-MQTT owns all event pointers only for this callback. Copy into a
     * preallocated queue; never take s_lock, call MQTT APIs, or dispatch here.
     * One ESP client exists at a time and its callbacks are serialized. */
    mqtt_mgr_ingress_event_t *copy = &s_ingress->producer;
    memset(copy, 0, sizeof(*copy));
    copy->event_id = event_id;
    copy->generation = (uint32_t)(uintptr_t)handler_args;
    copy->msg_id = event->msg_id;
    copy->retained = event->retain;
    copy->error = event->error_handle ? event->error_handle->esp_tls_last_esp_err : ESP_FAIL;
    if (event_id == MQTT_EVENT_SUBSCRIBED) {
        copy->invalid = event->data_len < 1 || !event->data;
        for (int index = 0; event->data && index < event->data_len; ++index) {
            if ((unsigned char)event->data[index] > 2U) {
                copy->invalid = true;
            }
        }
    } else if (event_id == MQTT_EVENT_DATA) {
        copy->offset = event->current_data_offset;
        copy->total = event->total_data_len;
        copy->invalid = event->data_len <= 0 || !event->data ||
            event->total_data_len <= 0 || event->total_data_len > (int)MQTT_MGR_INGRESS_PAYLOAD_LEN ||
            event->current_data_offset < 0 || event->current_data_offset > event->total_data_len ||
            event->data_len > event->total_data_len - event->current_data_offset ||
            event->topic_len < 0 || event->topic_len >= (int)sizeof(copy->topic) ||
            (event->current_data_offset == 0 && (!event->topic || event->topic_len == 0));
        if (!copy->invalid) {
            copy->length = (size_t)event->data_len;
            copy->topic_length = (size_t)event->topic_len;
            memcpy(copy->data, event->data, copy->length);
            if (copy->topic_length && event->topic) {
                memcpy(copy->topic, event->topic, copy->topic_length);
            }
        }
    }
    if (xQueueSend(s_ingress_queue, copy, 0) != pdTRUE) {
        atomic_fetch_add(&s_ingress_overflow, 1U);
    }
    if (s_mqtt_task_handle) {
        xTaskNotifyGive(s_mqtt_task_handle);
    }
}

/* Caller retains pending until this returns. All state transitions occur on
 * mqtt_task under s_lock; DATA dispatch explicitly releases the state lock. */
static void mqtt_mgr_process_esp_event_locked(const mqtt_mgr_ingress_event_t *event) {
    uint32_t now_ms = unified_tick_now_ms();
    if (event->generation != s_client_generation || !s_client_started) {
        return;
    }
    if (s_transport != MQTT_MGR_TRANSPORT_ESP && event->event_id != MQTT_EVENT_CONNECTED) {
        return;
    }
    switch ((esp_mqtt_event_id_t)event->event_id) {
        case MQTT_EVENT_CONNECTED:
            ota_validation_reset(&s_ota_validation);
            ESP_LOGI(TAG, "connected to broker=%s", s_status.broker[0] != '\0' ? s_status.broker : "<unset>");
            s_transport = MQTT_MGR_TRANSPORT_ESP;
            s_disconnect_modem_after_esp_connected = false;
            s_esp_connect_started_ms = 0U;
            s_esp_connected_since_ms = 0U;
            s_status.connected = true;
            s_status.subscribed = false;
            s_status.runtime.running = true;
            s_status.runtime.last_error = ESP_OK;
            s_status.runtime.last_error_text[0] = '\0';
            s_ingress->received = 0U;
            s_ingress->total = 0U;
            if (mqtt_mgr_subscribe_commands_locked() != ESP_OK) {
                s_status.command_rejects++;
                s_status.runtime.last_error = ESP_FAIL;
                snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_subscribe_failed");
                mqtt_recovery_request(&s_esp_recovery, now_ms);
            }
            mqtt_mgr_set_health_locked();
            return;
        case MQTT_EVENT_SUBSCRIBED:
            for (size_t index = 0U; index < MQTT_SUBSCRIBE_TOPIC_COUNT; ++index) {
                if (event->msg_id != s_subscribe_ids[index] || s_subscribe_ids[index] < 0) {
                    continue;
                }
                if (event->invalid) {
                    const bool primary = index == MQTT_SUBSCRIBE_PRIMARY_COMMAND;
                    s_subscribe_ids[index] = -1;
                    if (mqtt_subscription_rejection_requires_recovery(primary, true)) {
                        s_status.runtime.last_error = ESP_FAIL;
                        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_suback_rejected");
                        s_suback_deadline_ms = 0U;
                        mqtt_recovery_request(&s_esp_recovery, now_ms);
                    } else {
                        ESP_LOGW(TAG, "legacy cmd/# subscription rejected; primary command/# remains authoritative");
                    }
                    return;
                }
                if (!s_subscribe_acked[index]) {
                    s_subscribe_acked[index] = true;
                    s_status.subscribed_count++;
                }
            }
            if (s_subscribe_acked[MQTT_SUBSCRIBE_PRIMARY_COMMAND]) {
                s_status.subscribed = true;
                s_suback_deadline_ms = 0U;
                s_esp_connected_since_ms = now_ms;
                s_disconnect_modem_after_esp_connected = modem_a7670_mqtt_is_connected();
            }
            return;
        case MQTT_EVENT_DISCONNECTED:
            ESP_LOGW(TAG, "disconnected from broker");
            s_esp_connect_started_ms = unified_tick_now_ms();
            s_esp_connected_since_ms = 0U;
            s_disconnect_modem_after_esp_connected = false;
            s_status.connected = false;
            s_status.subscribed = false;
            s_action_result_inflight_msg_id = -1;
            s_action_result_inflight_sequence = 0U;
            ota_validation_reset(&s_ota_validation);
            s_action_result_ack_deadline_ms = 0U;
            s_next_action_result_retry_ms = 0U;
            s_suback_deadline_ms = 0U;
            s_esp_recovery = (mqtt_recovery_t){0};
            s_ingress->received = 0U;
            s_ingress->total = 0U;
            s_status.reconnect_count++;
            s_status.runtime.last_error = ESP_FAIL;
            snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_disconnected");
            mqtt_mgr_set_health_locked();
            return;
        case MQTT_EVENT_ERROR:
            ESP_LOGW(TAG, "broker error");
            s_esp_connect_started_ms = unified_tick_now_ms();
            s_esp_connected_since_ms = 0U;
            s_disconnect_modem_after_esp_connected = false;
            s_status.connected = false;
            s_status.subscribed = false;
            s_action_result_inflight_msg_id = -1;
            s_action_result_inflight_sequence = 0U;
            ota_validation_reset(&s_ota_validation);
            s_action_result_ack_deadline_ms = 0U;
            s_next_action_result_retry_ms = 0U;
            s_suback_deadline_ms = 0U;
            s_esp_recovery = (mqtt_recovery_t){0};
            s_ingress->received = 0U;
            s_ingress->total = 0U;
            s_status.publish_failures++;
            s_status.runtime.last_error = ESP_FAIL;
            snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_error");
            s_status.runtime.last_error = event->error;
            mqtt_mgr_set_health_locked();
            return;
        case MQTT_EVENT_PUBLISHED:
            if (!s_ota_confirmed && ota_validation_puback(&s_ota_validation,
                event->msg_id, now_ms,
                mqtt_mgr_primary_subscription_ready_locked())) {
                esp_err_t mark_err = state_mgr_request_ota_validation();
                if (mark_err == ESP_OK) {
                    ESP_LOGI(TAG, "running app validation requested after current-boot health PUBACK");
                } else if (mark_err == ESP_ERR_INVALID_STATE) {
                    s_ota_confirmed = true;
                } else {
                    ESP_LOGW(TAG, "ota durable-result validation request err=%s", esp_err_to_name(mark_err));
                }
            }
            if (event->msg_id == s_action_result_inflight_msg_id &&
                s_action_result_inflight_sequence > s_last_action_result_sequence) {
                s_last_action_result_sequence = s_action_result_inflight_sequence;
                s_status.action_results_published++;
                s_action_result_inflight_msg_id = -1;
                s_action_result_inflight_sequence = 0U;
                s_action_result_ack_deadline_ms = 0U;
                s_next_action_result_retry_ms = 0U;
            }
            return;
        case MQTT_EVENT_DATA:
            {
                esp_err_t submit_err = ESP_OK;
                if (event->offset == 0) {
                    s_ingress->retained = event->retained;
                    s_ingress->received = 0U;
                    s_ingress->total = (size_t)event->total;
                    s_ingress->msg_id = event->msg_id;
                    memcpy(s_ingress->topic, event->topic, sizeof(s_ingress->topic));
                }
                if (event->invalid || s_ingress->total == 0U ||
                    (size_t)event->offset != s_ingress->received ||
                    (size_t)event->total != s_ingress->total || event->msg_id != s_ingress->msg_id) {
                    s_ingress->received = 0U;
                    s_ingress->total = 0U;
                    s_status.command_rejects++;
                    s_status.runtime.last_error = ESP_ERR_INVALID_SIZE;
                    snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_invalid_command_fragment");
                    mqtt_mgr_set_health_locked();
                    return;
                }
                memcpy(s_ingress->payload + s_ingress->received, event->data, event->length);
                s_ingress->received += event->length;
                if (s_ingress->received != s_ingress->total) {
                    return;
                }
                s_ingress->payload[s_ingress->received] = '\0';
                if (!s_ota_confirmed && !s_ingress->retained &&
                    mqtt_mgr_primary_subscription_ready_locked()) {
                    const char *suffix = strrchr(s_ingress->topic, '/');
                    if (suffix && (strcmp(suffix, "/get-status") == 0 || strcmp(suffix, "/get_status") == 0)) {
                        cJSON *command = cJSON_Parse(s_ingress->payload);
                        const cJSON *id = cJSON_GetObjectItemCaseSensitive(command, "action_id");
                        if (cJSON_IsString(id)) {
                            ota_validation_observe(&s_ota_validation, id->valuestring, now_ms, true, false);
                        }
                        cJSON_Delete(command);
                    }
                }
                s_status.command_messages++;
                xSemaphoreGive(s_lock);
                if (mqtt_mgr_is_result_ack_topic(s_ingress->topic)) {
                    submit_err = mqtt_mgr_process_result_ack(s_ingress->topic, s_ingress->payload);
                } else {
                    submit_err = automation_bridge_submit_mqtt_command(
                        s_ingress->topic, strlen(s_ingress->topic),
                        s_ingress->payload, s_ingress->received
                    );
                }
                /* Restore caller's lock ownership, never resubmit a consumed
                 * command because telemetry accounting was briefly busy. */
                xSemaphoreTake(s_lock, portMAX_DELAY);
                s_ingress->received = 0U;
                s_ingress->total = 0U;
                if (submit_err != ESP_OK) {
                    s_status.command_rejects++;
                    s_status.runtime.last_error = submit_err;
                    snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_command_submit_failed");
                } else {
                    s_status.runtime.last_error = ESP_OK;
                    s_status.runtime.last_error_text[0] = '\0';
                }
                mqtt_mgr_set_health_locked();
                return;
            }
        default:
            break;
    }
}

static void mqtt_mgr_process_esp_events(void) {
    for (size_t count = 0U; count < MQTT_MGR_INGRESS_DEPTH; ++count) {
        if (!s_ingress->have_pending) {
            s_ingress->have_pending = xQueueReceive(s_ingress_queue, &s_ingress->pending, 0) == pdTRUE;
        }
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
            return; /* Preserve the removed event across lock contention. */
        }
        unsigned overflow = atomic_exchange(&s_ingress_overflow, 0U);
        if (overflow != 0U) {
            /* QoS ACK is owned by IDF, so queue overload cannot promise
             * execution. Surface the loss and force a fresh session; durable
             * dashboard action IDs/timeouts own retry, not a false success. */
            s_status.command_rejects += overflow;
            s_status.runtime.last_error = ESP_ERR_NO_MEM;
            snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_ingress_queue_full");
            s_status.subscribed = false;
            s_suback_deadline_ms = 0U;
            s_ingress->received = 0U;
            s_ingress->total = 0U;
            s_ingress->have_pending = false;
            xQueueReset(s_ingress_queue);
            mqtt_recovery_request(&s_esp_recovery, unified_tick_now_ms());
            mqtt_mgr_set_health_locked();
            xSemaphoreGive(s_lock);
            return;
        }
        if (!s_ingress->have_pending) {
            if (s_transport == MQTT_MGR_TRANSPORT_ESP && s_status.connected && !s_status.subscribed &&
                mqtt_subscription_expired(s_suback_deadline_ms, unified_tick_now_ms())) {
                s_suback_deadline_ms = 0U;
                s_status.runtime.last_error = ESP_ERR_TIMEOUT;
                snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_suback_timeout");
                mqtt_recovery_request(&s_esp_recovery, unified_tick_now_ms());
            }
            xSemaphoreGive(s_lock);
            return;
        }
        mqtt_mgr_process_esp_event_locked(&s_ingress->pending);
        s_ingress->have_pending = false;
        xSemaphoreGive(s_lock);
    }
    /* A bounded batch preserves fairness without sleeping over a backlog. */
    if (uxQueueMessagesWaiting(s_ingress_queue) != 0U) {
        xTaskNotifyGive(s_mqtt_task_handle);
    }
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
        mqtt_mgr_process_esp_events();
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
                mqtt_recovery_action_t recovery_action = mqtt_recovery_next(&s_esp_recovery, unified_tick_now_ms());
                if (recovery_action != MQTT_RECOVERY_NONE) {
                    esp_err_t recovery_err = recovery_action == MQTT_RECOVERY_STOP
                        ? mqtt_mgr_stop_transport_locked()
                        : mqtt_mgr_start_esp_client_locked();
                    mqtt_recovery_result(
                        &s_esp_recovery,
                        recovery_action,
                        recovery_err == ESP_OK,
                        unified_tick_now_ms()
                    );
                    if (recovery_err == ESP_OK && recovery_action == MQTT_RECOVERY_STOP) {
                        s_status.reconnect_count++;
                    }
                    if (recovery_err != ESP_OK) {
                        s_status.runtime.last_error = recovery_err;
                        snprintf(
                            s_status.runtime.last_error_text,
                            sizeof(s_status.runtime.last_error_text),
                            "%s",
                            recovery_action == MQTT_RECOVERY_STOP
                                ? "mqtt_recovery_stop_failed"
                                : "mqtt_recovery_start_failed"
                        );
                    }
                }
                if (mqtt_mgr_policy_allows_wifi(&scratch->config) &&
                    mqtt_mgr_wifi_primary_usable(&scratch->wifi) &&
                    !(mqtt_mgr_policy_prefers_cellular(&scratch->config) &&
                      mqtt_mgr_modem_fallback_ready(&scratch->config, &scratch->modem))) {
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
                    } else if (!s_esp_recovery.pending && mqtt_mgr_start_esp_client_locked() != ESP_OK) {
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
                    if (s_transport == MQTT_MGR_TRANSPORT_ESP &&
                        s_status.connected &&
                        mqtt_subscription_due(
                            s_status.connected,
                            s_status.subscribed,
                            s_suback_deadline_ms,
                            s_esp_recovery.pending
                        )) {
                        if (mqtt_mgr_subscribe_commands_locked() == ESP_OK) {
                            s_esp_connected_since_ms = now_ms;
                            s_disconnect_modem_after_esp_connected = modem_mqtt_connected;
                            s_status.runtime.last_error = ESP_OK;
                            s_status.runtime.last_error_text[0] = '\0';
                        } else {
                            s_status.command_rejects++;
                            s_status.runtime.last_error = ESP_FAIL;
                            snprintf(
                                s_status.runtime.last_error_text,
                                sizeof(s_status.runtime.last_error_text),
                                "%s",
                                "mqtt_subscribe_failed"
                            );
                            mqtt_recovery_request(&s_esp_recovery, now_ms);
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
                        if (mqtt_failover_retry_pending(s_next_modem_connect_retry_ms, now_ms)) {
                            s_status.runtime.last_error = ESP_ERR_TIMEOUT;
                            snprintf(
                                s_status.runtime.last_error_text,
                                sizeof(s_status.runtime.last_error_text),
                                "%s",
                                "mqtt_modem_retry_wait"
                            );
                        } else if (mqtt_mgr_start_modem_client_locked() != ESP_OK) {
                            if (mqtt_failover_is_bearer_failure(s_status.runtime.last_error_text)) {
                                s_modem_endpoint_failure_count = 0U;
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
                                if (s_modem_endpoint_failure_count < UINT8_MAX) {
                                    s_modem_endpoint_failure_count++;
                                }
                                s_next_modem_connect_retry_ms = now_ms + mqtt_failover_retry_delay_ms(
                                    s_modem_endpoint_failure_count,
                                    MQTT_MGR_MODEM_RETRY_BACKOFF_MS,
                                    MQTT_MGR_MODEM_RETRY_MAX_MS
                                );
                            }
                        } else {
                            modem_mqtt_connected = modem_a7670_mqtt_is_connected();
                            s_modem_endpoint_failure_count = 0U;
                        }
                    }
                } else {
                    if (wait_for_wifi_primary &&
                        s_transport == MQTT_MGR_TRANSPORT_MODEM &&
                        modem_mqtt_connected) {
                        s_status.connected = true;
                        s_status.runtime.running = true;
                        s_status.runtime.last_error = ESP_OK;
                        s_status.runtime.last_error_text[0] = '\0';
                    } else {
                        (void)mqtt_mgr_stop_transport_locked();
                        s_status.runtime.last_error = ESP_ERR_INVALID_STATE;
                        snprintf(
                            s_status.runtime.last_error_text,
                            sizeof(s_status.runtime.last_error_text),
                            "%s",
                            mqtt_mgr_broker_is_lan_scoped(s_broker_host)
                                ? "mqtt_lan_broker_requires_wifi"
                                : strncmp(scratch->config.mqtt_uri, "mqtts://", 8) == 0 ||
                                  strncmp(scratch->config.mqtt_uri, "ssl://", 6) == 0
                                ? "mqtt_tls_modem_fallback_unsupported"
                                : wait_for_wifi_primary
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
                s_status.connected &&
                s_status.subscribed) {
                uint32_t now_ms = unified_tick_now_ms();
                if (s_esp_connected_since_ms == 0U) {
                    s_esp_connected_since_ms = now_ms;
                } else if ((now_ms - s_esp_connected_since_ms) >= MQTT_MGR_WIFI_PROMOTION_HOLD_MS) {
                    s_disconnect_modem_after_esp_connected = false;
                    disconnect_modem_after_esp_connected = true;
                }
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
                s_modem_endpoint_failure_count = 0U;
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
                if (s_transport == MQTT_MGR_TRANSPORT_ESP && s_status.connected && s_status.subscribed) {
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

        mqtt_mgr_publish_durable_result();
        mqtt_mgr_publish_recent_action_results();

        /* FW-02: settle pending Wi-Fi command transitions (connect /
         * reconnect / disconnect) into terminal action results. */
        api_bridge_poll_async_transitions();

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
        if (s_ingress->have_pending || uxQueueMessagesWaiting(s_ingress_queue) != 0U) {
            publish_delay = pdMS_TO_TICKS(MQTT_MGR_MIN_RETRY_CHECK_MS);
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

    if (!s_ingress) {
        s_ingress = heap_caps_calloc(1U, sizeof(*s_ingress), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!s_ingress) {
            s_ingress = heap_caps_calloc(1U, sizeof(*s_ingress), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        }
    }
    if (!s_ingress_queue_storage) {
        s_ingress_queue_storage = heap_caps_calloc(MQTT_MGR_INGRESS_DEPTH,
            sizeof(mqtt_mgr_ingress_event_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!s_ingress_queue_storage) {
            s_ingress_queue_storage = heap_caps_calloc(MQTT_MGR_INGRESS_DEPTH,
                sizeof(mqtt_mgr_ingress_event_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        }
    }
    if (!s_ingress || !s_ingress_queue_storage) {
        vSemaphoreDelete(s_lock);
        s_lock = NULL;
        return ESP_ERR_NO_MEM;
    }
    s_ingress_queue = xQueueCreateStatic(MQTT_MGR_INGRESS_DEPTH, sizeof(mqtt_mgr_ingress_event_t),
        s_ingress_queue_storage, &s_ingress_queue_control);
    if (!s_ingress_queue) {
        vSemaphoreDelete(s_lock);
        s_lock = NULL;
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
    s_last_action_result_sequence = 0U;
    s_pending_action_result_sequence = 0U;
    s_next_action_result_retry_ms = 0U;
    s_action_result_inflight_msg_id = -1;
    s_action_result_inflight_sequence = 0U;
    ota_validation_reset(&s_ota_validation);
    s_action_result_ack_deadline_ms = 0U;
    atomic_store(&s_result_sequence_watermark, 0U);
    atomic_store(&s_ingress_overflow, 0U);
    s_esp_recovery = (mqtt_recovery_t){0};
    s_ota_confirmed = false;
    s_transport = MQTT_MGR_TRANSPORT_NONE;
    s_broker_port = 1883U;
    s_broker_host[0] = '\0';
    s_modem_connection_seen = false;
    s_last_modem_subscribe_ms = 0U;
    s_next_modem_connect_retry_ms = 0U;
    s_modem_connect_failure_count = 0U;
    s_modem_endpoint_failure_count = 0U;
    s_modem_reset_pending = false;
    if (mqtt_mgr_refresh_config_locked() != ESP_OK && !s_client) {
        ESP_LOGW(TAG, "initial mqtt config invalid or incomplete");
    }

    /* The worker handles OTA image confirmation after broker connect. Flash
     * mapping disables caches, so this stack MUST remain in internal SRAM.
     * Keep the large ingress/history buffers in PSRAM, not the task stack. */
    task_ok = xTaskCreatePinnedToCoreWithCaps(
        mqtt_mgr_task,
        "mqtt_task",
        MQTT_MGR_TASK_STACK_LEN,
        NULL,
        4,
        NULL,
        1,
        MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT
    );
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

/* FW-13: sms timestamps are epoch seconds when the modem SCTS was parsed,
 * otherwise uptime milliseconds. The dashboard accepts ISO strings; publish
 * those for real message times and keep the numeric fallback unchanged. */
static void mqtt_mgr_render_sms_timestamp(uint32_t timestamp_ms, char *out, size_t out_len) {
    if (timestamp_ms >= 1000000000U) {
        time_t seconds = (time_t)timestamp_ms;
        struct tm utc = {0};

        if (gmtime_r(&seconds, &utc) != NULL &&
            strftime(out, out_len, "%Y-%m-%dT%H:%M:%SZ", &utc) > 0) {
            return;
        }
    }
    snprintf(out, out_len, "%" PRIu32, timestamp_ms);
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

    char rendered_timestamp[32] = {0};

    mqtt_mgr_copy_json_string(scratch->from, sizeof(scratch->from), payload->from);
    mqtt_mgr_copy_json_string(scratch->text, sizeof(scratch->text), payload->text);
    mqtt_mgr_copy_json_string(scratch->detail, sizeof(scratch->detail), payload->detail);
    mqtt_mgr_copy_json_string(scratch->multipart_ref, sizeof(scratch->multipart_ref), payload->multipart_ref);
    mqtt_mgr_render_sms_timestamp(payload->timestamp_ms, rendered_timestamp, sizeof(rendered_timestamp));
    if (payload->multipart_part_count > 1U || scratch->multipart_ref[0] != '\0') {
        err = mqtt_mgr_format_json(
            scratch->json,
            sizeof(scratch->json),
            "{\"type\":\"sms_incoming\",\"storage_id\":%" PRIu32 ",\"storage_index\":%d,\"from\":\"%s\",\"text\":\"%s\",\"detail\":\"%s\",\"sim_slot\":%u,\"timestamp\":\"%s\",\"multipart_ref\":\"%s\",\"multipart_part_index\":%u,\"multipart_part_count\":%u}",
            storage_mgr_sms_storage_id(payload),
            (int)payload->storage_index,
            scratch->from,
            scratch->text,
            scratch->detail,
            (unsigned)payload->sim_slot,
            rendered_timestamp,
            scratch->multipart_ref,
            (unsigned)payload->multipart_part_index,
            (unsigned)payload->multipart_part_count
        );
    } else {
        err = mqtt_mgr_format_json(
            scratch->json,
            sizeof(scratch->json),
            "{\"type\":\"sms_incoming\",\"storage_id\":%" PRIu32 ",\"storage_index\":%d,\"from\":\"%s\",\"text\":\"%s\",\"detail\":\"%s\",\"sim_slot\":%u,\"timestamp\":\"%s\"}",
            storage_mgr_sms_storage_id(payload),
            (int)payload->storage_index,
            scratch->from,
            scratch->text,
            scratch->detail,
            (unsigned)payload->sim_slot,
            rendered_timestamp
        );
    }
    if (err == ESP_OK) {
        err = mqtt_mgr_publish_text("sms/incoming", scratch->json);
    }
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
    esp_err_t err = mqtt_mgr_format_json(
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
    if (err != ESP_OK) {
        return err;
    }
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
    esp_err_t err = mqtt_mgr_format_json(
        json,
        sizeof(json),
        "{\"type\":\"call_event\",\"number\":\"%s\",\"state\":\"%s\",\"sim_slot\":%u,\"timestamp\":%" PRIu32 "}",
        number,
        state,
        (unsigned)payload->sim_slot,
        payload->timestamp_ms
    );
    if (err != ESP_OK) {
        return err;
    }
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
    esp_err_t err = mqtt_mgr_format_json(
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
    if (err != ESP_OK) {
        return err;
    }
    return mqtt_mgr_publish_text("ussd/result", json);
}

static esp_err_t mqtt_mgr_publish_action_result_tracked(
    const unified_action_response_t *response,
    const char *payload_json,
    int *out_message_id
) {
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
            "{\"schema_version\":1,\"action_id\":\"%s\",\"device_id\":\"%s\",\"command\":\"%s\",\"result\":\"%s\",\"result_code\":%" PRId32 ",\"feature_reason\":%u,\"detail\":\"%s\",\"created_ms\":%" PRIu32 ",\"timeout_ms\":%" PRIu32 ",\"payload\":%s}",
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
            "{\"schema_version\":1,\"action_id\":\"%s\",\"device_id\":\"%s\",\"command\":\"%s\",\"result\":\"%s\",\"result_code\":%" PRId32 ",\"feature_reason\":%u,\"detail\":\"%s\",\"created_ms\":%" PRIu32 ",\"timeout_ms\":%" PRIu32 "}",
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

    publish_err = mqtt_mgr_publish_text_tracked("action/result", json, out_message_id);
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

esp_err_t mqtt_mgr_publish_action_result(const unified_action_response_t *response, const char *payload_json) {
    int message_id = 0;
    return mqtt_mgr_publish_action_result_tracked(response, payload_json, &message_id);
}

esp_err_t mqtt_mgr_publish_json(const char *suffix, const char *json) {
    if (!suffix || !json) {
        return ESP_ERR_INVALID_ARG;
    }

    return mqtt_mgr_publish_text(suffix, json);
}

static bool mqtt_mgr_is_result_ack_topic(const char *topic) {
    char expected[sizeof(s_command_topic)] = {0};
    if (!topic || !s_topic_prefix[0] || !s_client_id[0]) return false;
    int written = snprintf(expected, sizeof(expected), "%s/%s/command/action-result-ack",
                           s_topic_prefix, s_client_id);
    return written > 0 && (size_t)written < sizeof(expected) && strcmp(topic, expected) == 0;
}

static esp_err_t mqtt_mgr_process_result_ack(const char *topic, const char *payload) {
    cJSON *root = NULL;
    cJSON *version = NULL;
    cJSON *device = NULL;
    cJSON *action = NULL;
    cJSON *command = NULL;
    esp_err_t err = ESP_ERR_INVALID_ARG;
    unified_action_command_t parsed = UNIFIED_ACTION_CMD_NONE;
    if (!mqtt_mgr_is_result_ack_topic(topic) || !payload) return err;
    root = cJSON_Parse(payload);
    if (!cJSON_IsObject(root)) goto done;
    version = cJSON_GetObjectItemCaseSensitive(root, "schema_version");
    device = cJSON_GetObjectItemCaseSensitive(root, "device_id");
    action = cJSON_GetObjectItemCaseSensitive(root, "action_id");
    command = cJSON_GetObjectItemCaseSensitive(root, "command");
    if (!cJSON_IsNumber(version) || version->valuedouble != 1.0 ||
        !cJSON_IsString(device) || !device->valuestring ||
        !cJSON_IsString(action) || !action->valuestring ||
        !cJSON_IsString(command) || !command->valuestring ||
        strlen(device->valuestring) >= UNIFIED_DEVICE_ID_LEN ||
        strlen(action->valuestring) >= UNIFIED_CORRELATION_ID_LEN ||
        strcmp(device->valuestring, s_client_id) != 0) goto done;
    for (int candidate = UNIFIED_ACTION_CMD_GET_STATUS;
         candidate <= UNIFIED_ACTION_CMD_DELETE_SMS; ++candidate) {
        if (strcmp(command->valuestring, unified_action_command_name((unified_action_command_t)candidate)) == 0) {
            parsed = (unified_action_command_t)candidate;
            break;
        }
    }
    if (parsed == UNIFIED_ACTION_CMD_NONE) goto done;
    err = storage_mgr_result_ack(device->valuestring, action->valuestring, parsed);
    if (err == ESP_OK) s_next_durable_result_retry_ms = 0U;
done:
    cJSON_Delete(root);
    return err;
}

/* Re-send the oldest committed result until a dashboard DB acknowledgement
 * removes it. ESP-MQTT's PUBACK only proves broker receipt and never advances
 * this journal. One result per retry interval bounds broker/outbox pressure. */
static void mqtt_mgr_publish_durable_result(void) {
    uint32_t now_ms = unified_tick_now_ms();
    int message_id = 0;
    if (!s_ready || !s_status.connected || !s_action_records ||
        (s_next_durable_result_retry_ms != 0U &&
         !mqtt_subscription_expired(s_next_durable_result_retry_ms, now_ms))) {
        return;
    }
    s_next_durable_result_retry_ms = now_ms + 10000U;
    api_bridge_action_record_t *record = &s_action_records[0];
    esp_err_t err = storage_mgr_result_next(&record->response, record->payload, sizeof(record->payload));
    if (err != ESP_OK) {
        return;
    }
    err = mqtt_mgr_publish_action_result_tracked(
        &record->response, record->payload[0] ? record->payload : NULL, &message_id);
    if (err == ESP_OK && message_id > 0 &&
        xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        if (s_transport == MQTT_MGR_TRANSPORT_ESP && !s_ota_confirmed &&
            record->response.action.command == UNIFIED_ACTION_CMD_GET_STATUS &&
            record->response.result == UNIFIED_ACTION_RESULT_COMPLETED &&
            record->response.result_code == ESP_OK &&
            strcmp(record->response.action.correlation.device_id, s_client_id) == 0) {
            /* This record came from the committed journal. Its boot identity
             * and original admission time must match a command observed on
             * this subscribed connection, not an old/cached/anonymous result. */
            cJSON *health = cJSON_Parse(record->payload);
            const cJSON *boot = cJSON_GetObjectItemCaseSensitive(health, "boot_id");
            bool current_boot = cJSON_IsString(boot) && state_mgr_boot_id()[0] &&
                strcmp(boot->valuestring, state_mgr_boot_id()) == 0;
            if (ota_validation_match(&s_ota_validation,
                record->response.action.correlation.correlation_id,
                record->response.action.correlation.created_ms, unified_tick_now_ms(), true, current_boot)) {
                s_ota_validation.message_id = message_id;
            }
            cJSON_Delete(health);
        }
        xSemaphoreGive(s_lock);
    }
    if (err != ESP_OK && xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        s_status.action_result_failures++;
        s_status.runtime.last_error = err;
        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text),
                 "%s", "durable_result_publish_failed");
        xSemaphoreGive(s_lock);
    }
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
    mqtt_mgr_transport_t transport = MQTT_MGR_TRANSPORT_NONE;

    if (!s_ready || !s_lock) {
        return;
    }

    now_ms = unified_tick_now_ms();
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    uint32_t observed_sequence = atomic_load(&s_result_sequence_watermark);
    if (observed_sequence > s_pending_action_result_sequence) {
        s_pending_action_result_sequence = observed_sequence;
        s_next_action_result_retry_ms = 0U;
    }
    pending_sequence = s_pending_action_result_sequence;
    retry_ms = s_next_action_result_retry_ms;
    connected = s_status.connected;
    transport = s_transport;
    last_published_sequence = s_last_action_result_sequence;
    if (s_action_result_inflight_sequence != 0U) {
        if (!mqtt_subscription_expired(s_action_result_ack_deadline_ms, now_ms)) {
            xSemaphoreGive(s_lock);
            return;
        }
        s_status.action_result_failures++;
        s_status.runtime.last_error = ESP_ERR_TIMEOUT;
        snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_action_result_puback_timeout");
        s_action_result_inflight_msg_id = -1;
        s_action_result_inflight_sequence = 0U;
        s_action_result_ack_deadline_ms = 0U;
        mqtt_recovery_request(&s_esp_recovery, now_ms);
        mqtt_mgr_set_health_locked();
        xSemaphoreGive(s_lock);
        return;
    }
    if (pending_sequence != 0U &&
        pending_sequence > s_last_action_result_sequence &&
        !connected &&
        (retry_ms == 0U || mqtt_subscription_expired(retry_ms, now_ms))) {
        s_next_action_result_retry_ms = now_ms + MQTT_MGR_RECOVERY_LOOP_MS;
        retry_ms = s_next_action_result_retry_ms;
    }
    xSemaphoreGive(s_lock);

    if (!connected) {
        return;
    }
    if (retry_ms != 0U && !mqtt_subscription_expired(retry_ms, now_ms)) {
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

        if (s_action_records[index].response.action.correlation.correlation_id[0] &&
            s_action_records[index].response.result != UNIFIED_ACTION_RESULT_ACCEPTED &&
            strcmp(s_action_records[index].response.detail, "result_journal_full") != 0 &&
            strcmp(s_action_records[index].response.detail, "result_journal_unavailable") != 0 &&
            strcmp(s_action_records[index].response.detail, "duplicate_action_uncertain") != 0) {
            /* This terminal record is delivered by the private journal. */
            last_published_sequence = s_action_records[index].sequence;
            skipped_background_count++;
            continue;
        }

        background_record = mqtt_mgr_is_background_action_command(s_action_records[index].response.action.command);
        /* Correlated commands need their own terminal response, even when
         * a newer status snapshot exists. Only anonymous observations may
         * coalesce; the dashboard settles by action_id, never by topic. */
        superseded_background = background_record &&
            s_action_records[index].response.action.correlation.correlation_id[0] == '\0' &&
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

        int message_id = 0;
        err = mqtt_mgr_publish_action_result_tracked(
            &s_action_records[index].response,
            s_action_records[index].payload[0] != '\0' ? s_action_records[index].payload : NULL,
            &message_id
        );

        if (err == ESP_OK) {
            if (transport == MQTT_MGR_TRANSPORT_ESP && message_id > 0) {
                if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
                    return;
                }
                s_action_result_inflight_msg_id = message_id;
                s_action_result_inflight_sequence = s_action_records[index].sequence;
                s_action_result_ack_deadline_ms = now_ms + MQTT_MGR_ACTION_RESULT_ACK_TIMEOUT_MS;
                xSemaphoreGive(s_lock);
                return;
            }
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

    /* Keep action execution light: the automation bridge can call this listener
     * from its command task. An atomic high-water mark cannot lose the sole
     * terminal notification while a slow publish holds the manager lock. */
    unsigned observed = atomic_load(&s_result_sequence_watermark);
    while (record->sequence > observed && !atomic_compare_exchange_weak(
        &s_result_sequence_watermark, &observed, record->sequence)) {
        /* Retry only if another result listener advanced the watermark. */
    }
    mqtt_task_handle = s_mqtt_task_handle;

    if (mqtt_task_handle) {
        xTaskNotifyGive(mqtt_task_handle);
    }
}
