#include "automation_bridge.h"

#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_heap_caps.h"
#include "cJSON.h"
#include "esp_log.h"

#include "board_bsp.h"
#include "api_bridge.h"
#include "common_models.h"
#include "config_mgr.h"
#include "health_monitor.h"
#include "task_registry.h"
#include "unified_runtime.h"

static const char *TAG = "automation_bridge";

#define AUTOMATION_BRIDGE_BACKGROUND_COALESCE_MS 1500U

/* FW-11: bound command timeouts and relative expiry so a stale or hostile
 * command cannot pin the serialized hardware lane for minutes. */
#define AUTOMATION_BRIDGE_MIN_TIMEOUT_MS        1000U
#define AUTOMATION_BRIDGE_MAX_TIMEOUT_MS      300000U
#define AUTOMATION_BRIDGE_DEFAULT_TIMEOUT_MS   15000U
#define AUTOMATION_BRIDGE_MIN_TTL_MS            2000U
#define AUTOMATION_BRIDGE_MAX_TTL_MS          600000U

/* FW-01: QoS 1 duplicates are replayed from this cache instead of being
 * re-executed against the serialized hardware lane. */
#define AUTOMATION_BRIDGE_DEDUP_DEPTH             8U

typedef struct {
    char topic[CONFIG_UNIFIED_AUTOMATION_TOPIC_LEN];
    TickType_t suppress_until;
} automation_bridge_background_state_t;

typedef struct {
    char action_id[UNIFIED_CORRELATION_ID_LEN];
    char source[UNIFIED_TEXT_SHORT_LEN];
    uint32_t ttl_ms;
} automation_bridge_command_metadata_t;

typedef struct {
    char action_id[UNIFIED_CORRELATION_ID_LEN];
    uint32_t remember_sequence;
    unified_action_response_t response;
    bool occupied;
} automation_bridge_dedup_entry_t;

typedef struct {
    char topic[CONFIG_UNIFIED_AUTOMATION_TOPIC_LEN];
    char payload[CONFIG_UNIFIED_AUTOMATION_MESSAGE_LEN];
    uint16_t priority;
    uint32_t sequence;
    uint32_t arrival_ms;
    uint32_t expires_at_ms;   /* FW-11: 0 = no relative expiry */
    bool background;
} automation_bridge_queue_item_t;

typedef struct {
    automation_bridge_queue_item_t item;
    unified_action_envelope_t action;
    api_bridge_request_t request;
    unified_action_response_t response;
    char payload[CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN];
} automation_bridge_task_context_t;

typedef struct {
    unified_service_runtime_t runtime;
    uint32_t queued_count;
    uint32_t executed_count;
    uint32_t parse_failures;
    uint32_t queue_overflows;
    uint32_t dispatch_failures;
    uint32_t duplicate_commands;
    uint32_t expired_commands;
    uint32_t last_action_key;
    unified_action_response_t last_response;
    char last_topic[CONFIG_UNIFIED_AUTOMATION_TOPIC_LEN];
    char last_payload[CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN];
} automation_bridge_status_t;

static SemaphoreHandle_t s_lock;
static automation_bridge_status_t s_status;
static automation_bridge_task_context_t *s_task_context;
static TaskHandle_t s_task_handle;
static automation_bridge_queue_item_t *s_pending_queue;
static automation_bridge_background_state_t *s_background_state;
static automation_bridge_dedup_entry_t *s_dedup_cache;
static size_t s_pending_count;
static uint32_t s_queue_sequence;
static uint32_t s_dedup_remember_sequence;
static char s_active_background_topic[CONFIG_UNIFIED_AUTOMATION_TOPIC_LEN];
static bool s_ready;

static void automation_bridge_dedup_remember_locked(
    const char *action_id,
    const unified_action_response_t *response
);
static bool automation_bridge_dedup_lookup_locked(
    const char *action_id,
    unified_action_response_t *out_response
);
static void automation_bridge_parse_command_metadata(
    const char *payload,
    automation_bridge_command_metadata_t *out_metadata
);
static void automation_bridge_build_queue_full_response(
    const automation_bridge_command_metadata_t *metadata,
    unified_action_response_t *out_response
);

static void *automation_bridge_alloc_zeroed(size_t size) {
    void *buffer = heap_caps_calloc(1U, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);

    if (!buffer) {
        buffer = heap_caps_calloc(1U, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }

    return buffer;
}

static void automation_bridge_free_allocated(void) {
    if (s_pending_queue) {
        heap_caps_free(s_pending_queue);
        s_pending_queue = NULL;
    }
    if (s_background_state) {
        heap_caps_free(s_background_state);
        s_background_state = NULL;
    }
    if (s_dedup_cache) {
        heap_caps_free(s_dedup_cache);
        s_dedup_cache = NULL;
    }
    if (s_task_context) {
        heap_caps_free(s_task_context);
        s_task_context = NULL;
    }
}

static void automation_bridge_set_health_locked(const char *detail) {
    s_status.runtime.running = true;
    s_status.runtime.state = UNIFIED_MODULE_STATE_RUNNING;
    (void)health_monitor_set_module_state("automation_bridge", HEALTH_MODULE_STATE_OK, detail ? detail : "running");
}

static void automation_bridge_record_failure_locked(esp_err_t err, const char *detail) {
    const char *reason = detail ? detail : esp_err_to_name(err);

    s_status.runtime.last_error = err;
    snprintf(
        s_status.runtime.last_error_text,
        sizeof(s_status.runtime.last_error_text),
        "%.*s",
        (int)sizeof(s_status.runtime.last_error_text) - 1,
        reason
    );
    /* FW-08: failures must not report RUNNING/OK health. */
    s_status.runtime.state = UNIFIED_MODULE_STATE_DEGRADED;
    (void)health_monitor_set_module_state("automation_bridge", HEALTH_MODULE_STATE_DEGRADED, reason);
}

static uint16_t automation_bridge_command_priority(unified_action_command_t command) {
    switch (command) {
        case UNIFIED_ACTION_CMD_SEND_SMS:
        case UNIFIED_ACTION_CMD_SEND_SMS_MULTIPART:
        case UNIFIED_ACTION_CMD_DELETE_SMS:
        case UNIFIED_ACTION_CMD_SEND_USSD:
        case UNIFIED_ACTION_CMD_CANCEL_USSD:
        case UNIFIED_ACTION_CMD_DIAL_NUMBER:
        case UNIFIED_ACTION_CMD_HANGUP_CALL:
        case UNIFIED_ACTION_CMD_MODEM_AT:
            return 10U;
        case UNIFIED_ACTION_CMD_WIFI_CONNECT:
        case UNIFIED_ACTION_CMD_WIFI_RECONNECT:
        case UNIFIED_ACTION_CMD_WIFI_TOGGLE:
        case UNIFIED_ACTION_CMD_WIFI_DISCONNECT:
        case UNIFIED_ACTION_CMD_WIFI_SCAN:
        case UNIFIED_ACTION_CMD_MOBILE_TOGGLE:
        case UNIFIED_ACTION_CMD_MOBILE_APN:
        case UNIFIED_ACTION_CMD_GPIO_WRITE:
        case UNIFIED_ACTION_CMD_GPIO_PULSE:
        case UNIFIED_ACTION_CMD_GPIO_STATUS:
        case UNIFIED_ACTION_CMD_SENSOR_READ:
            return 40U;
        case UNIFIED_ACTION_CMD_CONFIG_SET:
        case UNIFIED_ACTION_CMD_ROUTING_CONFIGURE:
        case UNIFIED_ACTION_CMD_STORAGE_INFO:
        case UNIFIED_ACTION_CMD_FILE_LIST:
        case UNIFIED_ACTION_CMD_FILE_READ_META:
        case UNIFIED_ACTION_CMD_FILE_DELETE:
        case UNIFIED_ACTION_CMD_FILE_EXPORT:
        case UNIFIED_ACTION_CMD_START_CAMERA:
        case UNIFIED_ACTION_CMD_STOP_CAMERA:
        case UNIFIED_ACTION_CMD_TAKE_SNAPSHOT:
        case UNIFIED_ACTION_CMD_START_STREAM:
        case UNIFIED_ACTION_CMD_STOP_STREAM:
        case UNIFIED_ACTION_CMD_CARD_SCAN_START:
        case UNIFIED_ACTION_CMD_CARD_SCAN_STOP:
        case UNIFIED_ACTION_CMD_CARD_READ:
        case UNIFIED_ACTION_CMD_CARD_WRITE:
            return 80U;
        case UNIFIED_ACTION_CMD_RESTART_MODEM:
        case UNIFIED_ACTION_CMD_REBOOT_DEVICE:
            return 120U;
        case UNIFIED_ACTION_CMD_GET_STATUS:
        case UNIFIED_ACTION_CMD_STATUS_WATCH:
            return 300U;
        case UNIFIED_ACTION_CMD_NONE:
        default:
            return 160U;
    }
}

static bool automation_bridge_source_is_background(const char *source) {
    return source &&
        (strcmp(source, "status-watch") == 0 ||
         strcmp(source, "startup-prime") == 0 ||
         strcmp(source, "system:auto") == 0);
}

static bool automation_bridge_command_is_background(unified_action_command_t command, const char *source) {
    if (command == UNIFIED_ACTION_CMD_STATUS_WATCH) {
        return true;
    }

    if (command == UNIFIED_ACTION_CMD_GET_STATUS) {
        return automation_bridge_source_is_background(source);
    }

    return false;
}

static uint16_t automation_bridge_effective_priority(
    unified_action_command_t command,
    bool background
) {
    if (!background && command == UNIFIED_ACTION_CMD_GET_STATUS) {
        return 30U;
    }

    if (background && command == UNIFIED_ACTION_CMD_GET_STATUS) {
        return 300U;
    }

    return automation_bridge_command_priority(command);
}

static TickType_t automation_bridge_background_window_ticks(void) {
    return pdMS_TO_TICKS(AUTOMATION_BRIDGE_BACKGROUND_COALESCE_MS);
}

static int automation_bridge_find_pending_topic_locked(const char *topic) {
    if (!topic || !s_pending_queue) {
        return -1;
    }

    for (size_t index = 0; index < s_pending_count; ++index) {
        if (strncmp(s_pending_queue[index].topic, topic, sizeof(s_pending_queue[index].topic)) == 0) {
            return (int)index;
        }
    }

    return -1;
}

static bool automation_bridge_background_is_suppressed_locked(const char *topic, TickType_t now) {
    if (!topic || !s_background_state) {
        return false;
    }

    for (size_t index = 0; index < CONFIG_UNIFIED_AUTOMATION_QUEUE_DEPTH; ++index) {
        automation_bridge_background_state_t *entry = &s_background_state[index];
        if (entry->topic[0] == '\0') {
            continue;
        }
        if ((int32_t)(now - entry->suppress_until) >= 0) {
            memset(entry, 0, sizeof(*entry));
            continue;
        }
        if (strncmp(entry->topic, topic, sizeof(entry->topic)) == 0) {
            return true;
        }
    }

    return false;
}

static void automation_bridge_note_background_locked(const char *topic, TickType_t now) {
    size_t target = 0U;

    if (!topic || !s_background_state) {
        return;
    }

    for (size_t index = 0; index < CONFIG_UNIFIED_AUTOMATION_QUEUE_DEPTH; ++index) {
        automation_bridge_background_state_t *entry = &s_background_state[index];
        if (entry->topic[0] == '\0' || (int32_t)(now - entry->suppress_until) >= 0) {
            target = index;
            break;
        }
        if (strncmp(entry->topic, topic, sizeof(entry->topic)) == 0) {
            target = index;
            break;
        }
    }

    unified_copy_cstr(s_background_state[target].topic, sizeof(s_background_state[target].topic), topic);
    s_background_state[target].suppress_until = now + automation_bridge_background_window_ticks();
}

static bool automation_bridge_item_precedes(
    const automation_bridge_queue_item_t *left,
    const automation_bridge_queue_item_t *right
) {
    if (!left || !right) {
        return false;
    }

    if (left->priority != right->priority) {
        return left->priority < right->priority;
    }

    return left->sequence < right->sequence;
}

static bool automation_bridge_try_pop_next_item(automation_bridge_queue_item_t *out_item) {
    if (!out_item || !s_lock || !s_pending_queue) {
        return false;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return false;
    }

    if (s_pending_count == 0U) {
        xSemaphoreGive(s_lock);
        return false;
    }

    *out_item = s_pending_queue[0];
    if (s_pending_count > 1U) {
        memmove(
            &s_pending_queue[0],
            &s_pending_queue[1],
            (s_pending_count - 1U) * sizeof(s_pending_queue[0])
        );
    }
    s_pending_count--;
    memset(&s_pending_queue[s_pending_count], 0, sizeof(s_pending_queue[s_pending_count]));
    xSemaphoreGive(s_lock);
    return true;
}

static const char *automation_bridge_command_name_from_topic(
    const char *topic,
    char *topic_suffix,
    size_t topic_suffix_len
) {
    board_bsp_identity_t identity = {0};
    char device_id_override[CONFIG_MGR_DEVICE_ID_LEN] = {0};
    char mqtt_topic_prefix[CONFIG_MGR_TOPIC_PREFIX] = {0};
    char prefix[CONFIG_UNIFIED_AUTOMATION_TOPIC_LEN] = {0};
    const char *suffix = NULL;
    const char *topic_group = NULL;

    if (!topic || !topic_suffix || topic_suffix_len == 0U) {
        return NULL;
    }

    board_bsp_get_identity(&identity);
    config_mgr_get_device_id_override(device_id_override, sizeof(device_id_override));
    config_mgr_get_mqtt_topic_prefix(mqtt_topic_prefix, sizeof(mqtt_topic_prefix));
    for (size_t index = 0; index < 2U; ++index) {
        topic_group = index == 0U ? "cmd" : "command";
        snprintf(
            prefix,
            sizeof(prefix),
            "%s/%s/%s/",
            mqtt_topic_prefix[0] ? mqtt_topic_prefix : "device",
            device_id_override[0] ? device_id_override : identity.device_id,
            topic_group
        );

        if (strncmp(topic, prefix, strlen(prefix)) == 0) {
            suffix = topic + strlen(prefix);
            break;
        }
    }
    if (!suffix || suffix[0] == '\0' || strlen(suffix) >= topic_suffix_len) {
        return NULL;
    }

    unified_copy_cstr(topic_suffix, topic_suffix_len, suffix);
    return topic_suffix;
}

typedef struct {
    const char *name;
    unified_action_command_t command;
} automation_bridge_command_alias_t;

static const automation_bridge_command_alias_t s_command_aliases[] = {
    {"config_set", UNIFIED_ACTION_CMD_CONFIG_SET},
    {"wifi_connect", UNIFIED_ACTION_CMD_WIFI_CONNECT},
    {"wifi_reconnect", UNIFIED_ACTION_CMD_WIFI_RECONNECT},
    {"wifi_toggle", UNIFIED_ACTION_CMD_WIFI_TOGGLE},
    {"wifi_disconnect", UNIFIED_ACTION_CMD_WIFI_DISCONNECT},
    {"wifi_scan", UNIFIED_ACTION_CMD_WIFI_SCAN},
    {"mobile_toggle", UNIFIED_ACTION_CMD_MOBILE_TOGGLE},
    {"mobile_apn", UNIFIED_ACTION_CMD_MOBILE_APN},
    {"routing_configure", UNIFIED_ACTION_CMD_ROUTING_CONFIGURE},
    {"status_watch", UNIFIED_ACTION_CMD_STATUS_WATCH},
    {"get_sms_history", UNIFIED_ACTION_CMD_GET_SMS_HISTORY},
    {"sync_sms", UNIFIED_ACTION_CMD_GET_SMS_HISTORY},
    {"pull_sms", UNIFIED_ACTION_CMD_GET_SMS_HISTORY},
    {"pull_messages", UNIFIED_ACTION_CMD_GET_SMS_HISTORY},
    {"get_status", UNIFIED_ACTION_CMD_GET_STATUS},
    {"ota_update", UNIFIED_ACTION_CMD_OTA_UPDATE},
    {"storage_info", UNIFIED_ACTION_CMD_STORAGE_INFO},
    {"modem_at", UNIFIED_ACTION_CMD_MODEM_AT},
    {"raw_at", UNIFIED_ACTION_CMD_MODEM_AT},
    {"send_sms", UNIFIED_ACTION_CMD_SEND_SMS},
    {"send_sms_multipart", UNIFIED_ACTION_CMD_SEND_SMS_MULTIPART},
    {"delete_sms", UNIFIED_ACTION_CMD_DELETE_SMS},
    {"sms_delete", UNIFIED_ACTION_CMD_DELETE_SMS},
    {"send_ussd", UNIFIED_ACTION_CMD_SEND_USSD},
    {"cancel_ussd", UNIFIED_ACTION_CMD_CANCEL_USSD},
    {"dial_number", UNIFIED_ACTION_CMD_DIAL_NUMBER},
    {"hangup_call", UNIFIED_ACTION_CMD_HANGUP_CALL},
    {"reboot_device", UNIFIED_ACTION_CMD_REBOOT_DEVICE},
    {"restart_modem", UNIFIED_ACTION_CMD_RESTART_MODEM},
    {"gpio_status", UNIFIED_ACTION_CMD_GPIO_STATUS},
    {"gpio_read", UNIFIED_ACTION_CMD_GPIO_STATUS},
    {"gpio_write", UNIFIED_ACTION_CMD_GPIO_WRITE},
    {"gpio_pulse", UNIFIED_ACTION_CMD_GPIO_PULSE},
    {"sensor_read", UNIFIED_ACTION_CMD_SENSOR_READ},
    {"file_list", UNIFIED_ACTION_CMD_FILE_LIST},
    {"file_read_meta", UNIFIED_ACTION_CMD_FILE_READ_META},
    {"file_delete", UNIFIED_ACTION_CMD_FILE_DELETE},
    {"file_export", UNIFIED_ACTION_CMD_FILE_EXPORT},
    {"start_camera", UNIFIED_ACTION_CMD_START_CAMERA},
    {"stop_camera", UNIFIED_ACTION_CMD_STOP_CAMERA},
    {"take_snapshot", UNIFIED_ACTION_CMD_TAKE_SNAPSHOT},
    {"start_stream", UNIFIED_ACTION_CMD_START_STREAM},
    {"stop_stream", UNIFIED_ACTION_CMD_STOP_STREAM},
    {"card_scan_start", UNIFIED_ACTION_CMD_CARD_SCAN_START},
    {"card_scan_stop", UNIFIED_ACTION_CMD_CARD_SCAN_STOP},
    {"card_read", UNIFIED_ACTION_CMD_CARD_READ},
    {"card_write", UNIFIED_ACTION_CMD_CARD_WRITE},
};

static unified_action_command_t automation_bridge_parse_command_name(const char *command_name) {
    char normalized[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    size_t index = 0U;

    if (!command_name || command_name[0] == '\0') {
        return UNIFIED_ACTION_CMD_NONE;
    }
    unified_copy_cstr(normalized, sizeof(normalized), command_name);
    for (index = 0U; normalized[index] != '\0'; ++index) {
        if (normalized[index] == '-') {
            normalized[index] = '_';
        }
    }

    for (index = 0U; index < sizeof(s_command_aliases) / sizeof(s_command_aliases[0]); ++index) {
        if (strcmp(normalized, s_command_aliases[index].name) == 0) {
            return s_command_aliases[index].command;
        }
    }
    return UNIFIED_ACTION_CMD_NONE;
}

static void automation_bridge_copy_json_string(cJSON *node, char *dest, size_t dest_len) {
    if (!dest || dest_len == 0U) {
        return;
    }

    dest[0] = '\0';
    if (cJSON_IsString(node) && node->valuestring) {
        unified_copy_cstr(dest, dest_len, node->valuestring);
    }
}

static void automation_bridge_copy_json_scalar(cJSON *node, char *dest, size_t dest_len) {
    char *rendered = NULL;

    if (!dest || dest_len == 0U) {
        return;
    }

    dest[0] = '\0';
    if (!node) {
        return;
    }
    if (cJSON_IsString(node) && node->valuestring) {
        unified_copy_cstr(dest, dest_len, node->valuestring);
        return;
    }

    if (cJSON_IsBool(node) || cJSON_IsNumber(node)) {
        rendered = cJSON_PrintUnformatted(node);
        if (rendered) {
            unified_copy_cstr(dest, dest_len, rendered);
            cJSON_free(rendered);
        }
    }
}

static uint32_t automation_bridge_action_key(const unified_action_envelope_t *action) {
    uint32_t hash = 5381U;
    const unsigned char *cursor = NULL;

    if (!action) {
        return 0U;
    }
    if (action->correlation.created_ms != 0U) {
        return action->correlation.created_ms;
    }

    cursor = (const unsigned char *)action->correlation.correlation_id;
    while (cursor && *cursor != '\0') {
        hash = ((hash << 5) + hash) + (uint32_t)(*cursor++);
    }

    return hash == 0U ? 1U : hash;
}

/* FW-01: remember an action id as in-flight (response == NULL) or store its
 * terminal response for later duplicate replay. */
static void automation_bridge_dedup_remember_locked(
    const char *action_id,
    const unified_action_response_t *response
) {
    automation_bridge_dedup_entry_t *entry = NULL;
    size_t target = 0U;
    uint32_t oldest = UINT32_MAX;

    if (!action_id || action_id[0] == '\0' || !s_dedup_cache) {
        return;
    }

    for (size_t index = 0U; index < AUTOMATION_BRIDGE_DEDUP_DEPTH; ++index) {
        automation_bridge_dedup_entry_t *candidate = &s_dedup_cache[index];
        if (candidate->occupied && strncmp(candidate->action_id, action_id, sizeof(candidate->action_id)) == 0) {
            if (response) {
                candidate->response = *response;
            }
            return;
        }
    }

    for (size_t index = 0U; index < AUTOMATION_BRIDGE_DEDUP_DEPTH; ++index) {
        automation_bridge_dedup_entry_t *candidate = &s_dedup_cache[index];
        if (!candidate->occupied) {
            target = index;
            break;
        }
        if (candidate->remember_sequence < oldest) {
            oldest = candidate->remember_sequence;
            target = index;
        }
    }

    entry = &s_dedup_cache[target];
    memset(entry, 0, sizeof(*entry));
    unified_copy_cstr(entry->action_id, sizeof(entry->action_id), action_id);
    if (response) {
        entry->response = *response;
    }
    s_dedup_remember_sequence++;
    entry->remember_sequence = s_dedup_remember_sequence;
    entry->occupied = true;
}

/* FW-01: returns true when the action id is known. out_response carries the
 * cached terminal result, or result NONE while the original is in flight. */
static bool automation_bridge_dedup_lookup_locked(
    const char *action_id,
    unified_action_response_t *out_response
) {
    if (!action_id || action_id[0] == '\0' || !s_dedup_cache) {
        return false;
    }

    for (size_t index = 0U; index < AUTOMATION_BRIDGE_DEDUP_DEPTH; ++index) {
        automation_bridge_dedup_entry_t *entry = &s_dedup_cache[index];
        if (entry->occupied && strncmp(entry->action_id, action_id, sizeof(entry->action_id)) == 0) {
            if (out_response) {
                *out_response = entry->response;
            }
            return true;
        }
    }
    return false;
}

/* Single JSON pass for the submit path: correlation id, source tag, and the
 * relative TTL contract (ttl_ms / ttlMs / expiry_ms). */
static void automation_bridge_parse_command_metadata(
    const char *payload,
    automation_bridge_command_metadata_t *out_metadata
) {
    cJSON *root = NULL;
    cJSON *node = NULL;
    double ttl = 0.0;

    if (!out_metadata) {
        return;
    }
    memset(out_metadata, 0, sizeof(*out_metadata));
    if (!payload || payload[0] == '\0') {
        return;
    }

    root = cJSON_Parse(payload);
    if (!root) {
        return;
    }

    node = cJSON_GetObjectItemCaseSensitive(root, "action_id");
    if (!cJSON_IsString(node) || !node->valuestring) {
        node = cJSON_GetObjectItemCaseSensitive(root, "messageId");
    }
    if (cJSON_IsString(node) && node->valuestring && node->valuestring[0] != '\0') {
        unified_copy_cstr(out_metadata->action_id, sizeof(out_metadata->action_id), node->valuestring);
    }

    node = cJSON_GetObjectItemCaseSensitive(root, "source");
    if (cJSON_IsString(node) && node->valuestring) {
        unified_copy_cstr(out_metadata->source, sizeof(out_metadata->source), node->valuestring);
    }

    node = cJSON_GetObjectItemCaseSensitive(root, "ttl_ms");
    if (!node) {
        node = cJSON_GetObjectItemCaseSensitive(root, "ttlMs");
    }
    if (!node) {
        node = cJSON_GetObjectItemCaseSensitive(root, "expiry_ms");
    }
    if (cJSON_IsNumber(node)) {
        ttl = node->valuedouble;
    }
    cJSON_Delete(root);

    if (ttl > 0.0) {
        uint32_t ttl_ms = (uint32_t)ttl;
        if (ttl_ms < AUTOMATION_BRIDGE_MIN_TTL_MS) {
            ttl_ms = AUTOMATION_BRIDGE_MIN_TTL_MS;
        }
        if (ttl_ms > AUTOMATION_BRIDGE_MAX_TTL_MS) {
            ttl_ms = AUTOMATION_BRIDGE_MAX_TTL_MS;
        }
        out_metadata->ttl_ms = ttl_ms;
    }
}

/* FW-04: queue-full rejections must carry the originating action id so the
 * dashboard can settle the pending command. */
static void automation_bridge_build_queue_full_response(
    const automation_bridge_command_metadata_t *metadata,
    unified_action_response_t *out_response
) {
    board_bsp_identity_t identity = {0};
    char device_id_override[CONFIG_MGR_DEVICE_ID_LEN] = {0};
    uint32_t now_ms = unified_tick_now_ms();

    if (!out_response) {
        return;
    }
    memset(out_response, 0, sizeof(*out_response));

    board_bsp_get_identity(&identity);
    config_mgr_get_device_id_override(device_id_override, sizeof(device_id_override));
    snprintf(
        out_response->action.correlation.device_id,
        sizeof(out_response->action.correlation.device_id),
        "%s",
        device_id_override[0] ? device_id_override : identity.device_id
    );
    if (metadata && metadata->action_id[0] != '\0') {
        unified_copy_cstr(
            out_response->action.correlation.correlation_id,
            sizeof(out_response->action.correlation.correlation_id),
            metadata->action_id
        );
    } else {
        snprintf(
            out_response->action.correlation.correlation_id,
            sizeof(out_response->action.correlation.correlation_id),
            "queue-full-%" PRIu32,
            now_ms
        );
    }
    out_response->action.correlation.created_ms = now_ms;
    out_response->result = UNIFIED_ACTION_RESULT_REJECTED;
    out_response->result_code = ESP_ERR_NO_MEM;
    out_response->feature_reason = UNIFIED_FEATURE_REASON_NONE;
    snprintf(out_response->detail, sizeof(out_response->detail), "%s", "automation_queue_full");
}

static esp_err_t automation_bridge_parse_item(
    const automation_bridge_queue_item_t *item,
    unified_action_envelope_t *out_action,
    api_bridge_request_t *out_request
) {
    cJSON *root = NULL;
    cJSON *payload = NULL;
    cJSON *node = NULL;
    board_bsp_identity_t identity = {0};
    char device_id_override[CONFIG_MGR_DEVICE_ID_LEN] = {0};
    uint32_t now_ms = 0U;
    char topic_command[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    const char *command_name = NULL;

    if (!item || !out_action || !out_request) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(out_action, 0, sizeof(*out_action));
    memset(out_request, 0, sizeof(*out_request));

    command_name = automation_bridge_command_name_from_topic(item->topic, topic_command, sizeof(topic_command));
    root = cJSON_Parse(item->payload[0] != '\0' ? item->payload : "{}");
    if (!root) {
        const char *error_ptr = cJSON_GetErrorPtr();
        size_t error_offset = SIZE_MAX;
        size_t payload_len = strnlen(item->payload, sizeof(item->payload));
        if (error_ptr && error_ptr >= item->payload && error_ptr <= item->payload + payload_len) {
            error_offset = (size_t)(error_ptr - item->payload);
        }
        /* FW-07: never log command payloads verbatim (secrets, SMS, raw AT). */
        ESP_LOGW(
            TAG,
            "parse failed topic=%s payload_len=%u error_offset=%u",
            item->topic,
            (unsigned)payload_len,
            error_offset == SIZE_MAX ? UINT_MAX : (unsigned)error_offset
        );
        return ESP_ERR_INVALID_ARG;
    }

    node = cJSON_GetObjectItemCaseSensitive(root, "command");
    if (cJSON_IsString(node) && node->valuestring && node->valuestring[0] != '\0') {
        command_name = node->valuestring;
    } else if (!command_name) {
        if (!cJSON_IsString(node) || !node->valuestring) {
            cJSON_Delete(root);
            return ESP_ERR_INVALID_ARG;
        }
    }

    out_action->command = automation_bridge_parse_command_name(command_name);
    if (out_action->command == UNIFIED_ACTION_CMD_NONE) {
        ESP_LOGW(
            TAG,
            "unsupported command topic=%s topic_command=%s payload_command=%s payload_len=%u",
            item->topic,
            topic_command[0] != '\0' ? topic_command : "<none>",
            command_name ? command_name : "<none>",
            (unsigned)strnlen(item->payload, sizeof(item->payload))
        );
        cJSON_Delete(root);
        return ESP_ERR_NOT_SUPPORTED;
    }

    board_bsp_get_identity(&identity);
    config_mgr_get_device_id_override(device_id_override, sizeof(device_id_override));
    snprintf(
        out_action->correlation.device_id,
        sizeof(out_action->correlation.device_id),
        "%s",
        device_id_override[0] ? device_id_override : identity.device_id
    );

    node = cJSON_GetObjectItemCaseSensitive(root, "action_id");
    if (cJSON_IsString(node) && node->valuestring) {
        unified_copy_cstr(
            out_action->correlation.correlation_id,
            sizeof(out_action->correlation.correlation_id),
            node->valuestring
        );
    } else {
        if (now_ms == 0U) {
            now_ms = unified_tick_now_ms();
        }
        /* Generated ids must be unique per submission; a tick-only suffix can
         * collide for two commands issued in the same millisecond. */
        snprintf(
            out_action->correlation.correlation_id,
            sizeof(out_action->correlation.correlation_id),
            "%s-%" PRIu32 "-%u",
            command_name,
            now_ms,
            (unsigned)(item ? item->sequence : 0U)
        );
    }

    node = cJSON_GetObjectItemCaseSensitive(root, "timeout");
    out_action->timeout_ms = cJSON_IsNumber(node) && node->valuedouble > 0
        ? (uint32_t)node->valuedouble
        : AUTOMATION_BRIDGE_DEFAULT_TIMEOUT_MS;
    if (out_action->timeout_ms < AUTOMATION_BRIDGE_MIN_TIMEOUT_MS) {
        out_action->timeout_ms = AUTOMATION_BRIDGE_MIN_TIMEOUT_MS;
    }
    if (out_action->timeout_ms > AUTOMATION_BRIDGE_MAX_TIMEOUT_MS) {
        out_action->timeout_ms = AUTOMATION_BRIDGE_MAX_TIMEOUT_MS;
    }
    if (now_ms == 0U) {
        now_ms = unified_tick_now_ms();
    }
    out_action->correlation.created_ms = now_ms;

    payload = cJSON_GetObjectItemCaseSensitive(root, "payload");
    if (!cJSON_IsObject(payload)) {
        payload = root;
    }

    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "path"), out_request->path, sizeof(out_request->path));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "ssid"), out_request->ssid, sizeof(out_request->ssid));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "number"), out_request->number, sizeof(out_request->number));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "text"), out_request->text, sizeof(out_request->text));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "sms_encoding"), out_request->sms_encoding, sizeof(out_request->sms_encoding));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "sms_transport_encoding"), out_request->sms_transport_encoding, sizeof(out_request->sms_transport_encoding));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "sms_pdu"), out_request->sms_pdu, sizeof(out_request->sms_pdu));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "sms_pdu_encoding"), out_request->sms_pdu_encoding, sizeof(out_request->sms_pdu_encoding));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "code"), out_request->code, sizeof(out_request->code));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "key"), out_request->key, sizeof(out_request->key));
    automation_bridge_copy_json_scalar(cJSON_GetObjectItemCaseSensitive(payload, "value"), out_request->value, sizeof(out_request->value));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "apn"), out_request->apn, sizeof(out_request->apn));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "username"), out_request->username, sizeof(out_request->username));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "password"), out_request->password, sizeof(out_request->password));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "auth"), out_request->auth, sizeof(out_request->auth));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "connection_policy"), out_request->connection_policy, sizeof(out_request->connection_policy));
    if (out_request->connection_policy[0] == '\0') {
        automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "connectionPolicy"), out_request->connection_policy, sizeof(out_request->connection_policy));
    }
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "url"), out_request->url, sizeof(out_request->url));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "line"), out_request->raw_line, sizeof(out_request->raw_line));
    if (out_request->raw_line[0] == '\0') {
        automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "raw_line"), out_request->raw_line, sizeof(out_request->raw_line));
    }
    if (out_request->raw_line[0] == '\0') {
        automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "rawLine"), out_request->raw_line, sizeof(out_request->raw_line));
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "enabled");
    if (cJSON_IsBool(node)) {
        out_request->enabled_present = true;
        out_request->enabled = cJSON_IsTrue(node);
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "failover");
    if (cJSON_IsBool(node)) {
        out_request->failover_present = true;
        out_request->failover = cJSON_IsTrue(node);
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "loadBalancing");
    if (!node) {
        node = cJSON_GetObjectItemCaseSensitive(payload, "load_balancing");
    }
    if (cJSON_IsBool(node)) {
        out_request->load_balancing_present = true;
        out_request->load_balancing = cJSON_IsTrue(node);
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "nat");
    if (cJSON_IsBool(node)) {
        out_request->nat_present = true;
        out_request->nat = cJSON_IsTrue(node);
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "firewall");
    if (cJSON_IsBool(node)) {
        out_request->firewall_present = true;
        out_request->firewall = cJSON_IsTrue(node);
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "max_entries");
    if (cJSON_IsNumber(node) && node->valuedouble > 0) {
        out_request->max_entries = (uint16_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "before_storage_id");
    if (!node) {
        node = cJSON_GetObjectItemCaseSensitive(payload, "cursor");
    }
    if (cJSON_IsNumber(node) && node->valuedouble > 0 && node->valuedouble <= UINT32_MAX) {
        out_request->sms_cursor_present = true;
        out_request->sms_cursor = (uint32_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "pin");
    if (cJSON_IsNumber(node) && node->valuedouble >= 0 && node->valuedouble <= 255) {
        out_request->gpio_pin_present = true;
        out_request->gpio_pin = (uint8_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "value");
    if (cJSON_IsBool(node)) {
        out_request->gpio_value_present = true;
        out_request->gpio_value = cJSON_IsTrue(node);
    } else if (cJSON_IsNumber(node)) {
        out_request->gpio_value_present = true;
        out_request->gpio_value = node->valuedouble != 0;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "sms_parts");
    if (cJSON_IsNumber(node) && node->valuedouble > 0) {
        out_request->sms_parts = (uint16_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "sms_units");
    if (cJSON_IsNumber(node) && node->valuedouble > 0) {
        out_request->sms_units = (uint16_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "sms_utf8_bytes");
    if (cJSON_IsNumber(node) && node->valuedouble > 0) {
        out_request->sms_utf8_bytes = (uint16_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "sms_characters");
    if (cJSON_IsNumber(node) && node->valuedouble > 0) {
        out_request->sms_characters = (uint16_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "sms_pdu_length");
    if (cJSON_IsNumber(node) && node->valuedouble > 0) {
        out_request->sms_pdu_length = (uint16_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "sms_multipart");
    if (cJSON_IsBool(node)) {
        out_request->sms_multipart_present = true;
        out_request->sms_multipart = cJSON_IsTrue(node);
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "storage_index");
    if (!node) {
        node = cJSON_GetObjectItemCaseSensitive(payload, "sms_storage_index");
    }
    if (!node) {
        node = cJSON_GetObjectItemCaseSensitive(payload, "index");
    }
    if (cJSON_IsNumber(node) && node->valuedouble >= 0 && node->valuedouble <= UINT16_MAX) {
        out_request->sms_storage_index_present = true;
        out_request->sms_storage_index = (uint16_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "storage_id");
    if (!node) {
        node = cJSON_GetObjectItemCaseSensitive(payload, "sms_storage_id");
    }
    if (!node) {
        node = cJSON_GetObjectItemCaseSensitive(payload, "firmware_storage_id");
    }
    if (cJSON_IsNumber(node) && node->valuedouble > 0 && node->valuedouble <= UINT32_MAX) {
        out_request->sms_storage_id_present = true;
        out_request->sms_storage_id = (uint32_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "delete_flag");
    if (!node) {
        node = cJSON_GetObjectItemCaseSensitive(payload, "delflag");
    }
    if (cJSON_IsNumber(node) && node->valuedouble >= 0 && node->valuedouble <= 4) {
        out_request->sms_delete_flag_present = true;
        out_request->sms_delete_flag = (uint8_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "delete_read");
    if (cJSON_IsBool(node)) {
        out_request->sms_delete_read = cJSON_IsTrue(node);
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "delete_all");
    if (cJSON_IsBool(node)) {
        out_request->sms_delete_all = cJSON_IsTrue(node);
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "mode");
    if (!cJSON_IsString(node) || !node->valuestring) {
        node = cJSON_GetObjectItemCaseSensitive(payload, "scope");
    }
    if (cJSON_IsString(node) && node->valuestring) {
        if (strcmp(node->valuestring, "all") == 0 || strcmp(node->valuestring, "ALL") == 0) {
            out_request->sms_delete_all = true;
        } else if (strcmp(node->valuestring, "read") == 0 || strcmp(node->valuestring, "READ") == 0 ||
                   strcmp(node->valuestring, "incoming") == 0 || strcmp(node->valuestring, "INCOMING") == 0) {
            out_request->sms_delete_read = true;
        }
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "ttl_ms");
    if (!node) {
        node = cJSON_GetObjectItemCaseSensitive(payload, "ttlMs");
    }
    if (cJSON_IsNumber(node) && node->valuedouble > 0) {
        out_request->ttl_ms = (uint32_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "interval_ms");
    if (!node) {
        node = cJSON_GetObjectItemCaseSensitive(payload, "intervalMs");
    }
    if (cJSON_IsNumber(node) && node->valuedouble > 0) {
        out_request->interval_ms = (uint32_t)node->valuedouble;
    }

    cJSON_Delete(root);
    return ESP_OK;
}
static unified_action_response_t automation_bridge_build_parse_error(
    const automation_bridge_queue_item_t *item,
    esp_err_t err
) {
    unified_action_response_t response = {0};
    board_bsp_identity_t identity = {0};
    char device_id_override[CONFIG_MGR_DEVICE_ID_LEN] = {0};
    cJSON *root = NULL;
    cJSON *node = NULL;
    uint32_t now_ms = unified_tick_now_ms();

    board_bsp_get_identity(&identity);
    config_mgr_get_device_id_override(device_id_override, sizeof(device_id_override));
    snprintf(
        response.action.correlation.device_id,
        sizeof(response.action.correlation.device_id),
        "%s",
        device_id_override[0] ? device_id_override : identity.device_id
    );
    snprintf(
        response.action.correlation.correlation_id,
        sizeof(response.action.correlation.correlation_id),
        "parse-%" PRIu32,
        now_ms
    );
    response.action.correlation.created_ms = now_ms;
    if (item && item->payload[0] != '\0') {
        root = cJSON_Parse(item->payload);
        if (root) {
            node = cJSON_GetObjectItemCaseSensitive(root, "action_id");
            if (cJSON_IsString(node) && node->valuestring && node->valuestring[0] != '\0') {
                snprintf(
                    response.action.correlation.correlation_id,
                    sizeof(response.action.correlation.correlation_id),
                    "%s",
                    node->valuestring
                );
            }
        }
    }
    response.result = UNIFIED_ACTION_RESULT_REJECTED;
    response.result_code = err;
    snprintf(
        response.detail,
        sizeof(response.detail),
        "%s",
        err == ESP_ERR_NOT_SUPPORTED ? "unsupported_action_command" : "invalid_command_payload"
    );
    if (item && item->topic[0] != '\0') {
        char topic_command[UNIFIED_TEXT_MEDIUM_LEN] = {0};
        const char *command_name = automation_bridge_command_name_from_topic(item->topic, topic_command, sizeof(topic_command));
        response.action.command = automation_bridge_parse_command_name(command_name);
    }
    if (root) {
        cJSON_Delete(root);
    }
    return response;
}

static unified_action_response_t automation_bridge_build_execution_error(
    const unified_action_envelope_t *action,
    esp_err_t err
) {
    unified_action_response_t response = {0};

    if (action) {
        response.action = *action;
    }
    response.result = err == ESP_ERR_TIMEOUT
        ? UNIFIED_ACTION_RESULT_TIMEOUT
        : UNIFIED_ACTION_RESULT_FAILED;
    response.result_code = err;
    response.feature_reason = UNIFIED_FEATURE_REASON_NONE;
    snprintf(
        response.detail,
        sizeof(response.detail),
        "%s",
        err == ESP_ERR_TIMEOUT ? "dispatch_timeout" : "dispatch_failed"
    );
    return response;
}

static void automation_bridge_record_response_locked(
    const automation_bridge_queue_item_t *item,
    const unified_action_response_t *response,
    const char *payload
) {
    if (item) {
        unified_copy_cstr(s_status.last_topic, sizeof(s_status.last_topic), item->topic);
    }
    if (payload) {
        unified_copy_cstr(s_status.last_payload, sizeof(s_status.last_payload), payload);
    } else {
        s_status.last_payload[0] = '\0';
    }
    if (response) {
        s_status.last_response = *response;
        s_status.last_action_key = automation_bridge_action_key(&response->action);
        s_status.executed_count++;
    }
}

static unified_action_response_t automation_bridge_build_response_for_expiry(
    const unified_action_envelope_t *action
) {
    unified_action_response_t response = {0};

    if (action) {
        response.action = *action;
    }
    response.result = UNIFIED_ACTION_RESULT_REJECTED;
    response.result_code = ESP_ERR_INVALID_STATE;
    response.feature_reason = UNIFIED_FEATURE_REASON_NONE;
    snprintf(response.detail, sizeof(response.detail), "%s", "command_expired");
    return response;
}

static void automation_bridge_task(void *arg) {
    automation_bridge_task_context_t *ctx = s_task_context;
    esp_err_t err = ESP_OK;
    bool response_recorded = false;
    bool parse_failed = false;
    bool dispatch_failed = false;
    bool command_expired = false;
    esp_err_t recorded_error = ESP_OK;
    const char *error_detail = NULL;

    (void)arg;

    if (!ctx) {
        ESP_LOGE(TAG, "automation task context missing");
        vTaskDelete(NULL);
        return;
    }

    memset(ctx, 0, sizeof(*ctx));
    s_task_handle = xTaskGetCurrentTaskHandle();

    ESP_ERROR_CHECK(task_registry_register_expected("automation_bridge_task"));
    ESP_ERROR_CHECK(task_registry_mark_running("automation_bridge_task", true));
    ESP_ERROR_CHECK(health_monitor_register_module("automation_bridge"));
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        automation_bridge_set_health_locked("running");
        xSemaphoreGive(s_lock);
    }

    while (true) {
        if (!automation_bridge_try_pop_next_item(&ctx->item)) {
            (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
            continue;
        }

        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            if (ctx->item.background) {
                unified_copy_cstr(
                    s_active_background_topic,
                    sizeof(s_active_background_topic),
                    ctx->item.topic
                );
                automation_bridge_note_background_locked(ctx->item.topic, xTaskGetTickCount());
            } else {
                s_active_background_topic[0] = '\0';
            }
            xSemaphoreGive(s_lock);
        }

        ctx->payload[0] = '\0';
        memset(&ctx->response, 0, sizeof(ctx->response));
        response_recorded = false;
        parse_failed = false;
        dispatch_failed = false;
        command_expired = false;
        recorded_error = ESP_OK;
        error_detail = NULL;
        err = automation_bridge_parse_item(&ctx->item, &ctx->action, &ctx->request);
        if (err == ESP_OK) {
            /* FW-11: drop commands whose relative TTL elapsed while queued. */
            if (ctx->item.expires_at_ms != 0U &&
                (int32_t)(unified_tick_now_ms() - ctx->item.expires_at_ms) >= 0) {
                ctx->response = automation_bridge_build_response_for_expiry(&ctx->action);
                err = ESP_ERR_INVALID_STATE;
                command_expired = true;
            }
        }
        if (err == ESP_OK) {
            /* FW-01: mark in-flight so a QoS 1 redelivery is dropped instead of
             * re-executing the hardware command. */
            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                automation_bridge_dedup_remember_locked(ctx->action.correlation.correlation_id, NULL);
                xSemaphoreGive(s_lock);
            }
            ESP_LOGI(
                TAG,
                "dispatch action_id=%s command=%s topic=%s",
                ctx->action.correlation.correlation_id,
                unified_action_command_name(ctx->action.command),
                ctx->item.topic
            );
            err = api_bridge_execute_action(
                &ctx->action,
                &ctx->request,
                &ctx->response,
                ctx->payload,
                sizeof(ctx->payload)
            );
            if (err != ESP_OK) {
                ctx->response = automation_bridge_build_execution_error(&ctx->action, err);
                dispatch_failed = true;
                recorded_error = err;
                error_detail = "dispatch_failed";
            } else {
                response_recorded = true;
            }
        } else if (!command_expired) {
            ctx->response = automation_bridge_build_parse_error(&ctx->item, err);
            parse_failed = true;
            recorded_error = err;
            error_detail = ctx->response.detail;
        } else {
            recorded_error = ESP_ERR_INVALID_STATE;
            error_detail = "command_expired";
        }

        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            if (dispatch_failed) {
                s_status.dispatch_failures++;
            }
            if (parse_failed) {
                s_status.parse_failures++;
            }
            if (command_expired) {
                s_status.expired_commands++;
            }
            if (dispatch_failed || parse_failed || command_expired) {
                s_status.runtime.last_error = recorded_error;
                snprintf(
                    s_status.runtime.last_error_text,
                    sizeof(s_status.runtime.last_error_text),
                    "%.*s",
                    (int)sizeof(s_status.runtime.last_error_text) - 1,
                    error_detail ? error_detail : esp_err_to_name(recorded_error)
                );
            }
            automation_bridge_record_response_locked(&ctx->item, &ctx->response, ctx->payload);
            /* FW-01: cache the terminal result so duplicates replay instead of
             * re-executing. */
            automation_bridge_dedup_remember_locked(
                ctx->response.action.correlation.correlation_id,
                &ctx->response
            );
            automation_bridge_set_health_locked(unified_action_command_name(ctx->response.action.command));
            xSemaphoreGive(s_lock);
        }

        if (!response_recorded) {
            (void)api_bridge_record_external_response(
                &ctx->response,
                ctx->payload[0] != '\0' ? ctx->payload : NULL
            );
        }
        ESP_LOGI(
            TAG,
            "response action_id=%s command=%s result=%s code=%ld detail=%s",
            ctx->response.action.correlation.correlation_id,
            unified_action_command_name(ctx->response.action.command),
            unified_action_result_name(ctx->response.result),
            (long)ctx->response.result_code,
            ctx->response.detail
        );

        /* Update the true worst-case watermark after nested command handling
         * unwinds instead of retaining only the lightweight startup sample. */
        (void)task_registry_heartbeat("automation_bridge_task");

        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(50)) == pdTRUE) {
            s_active_background_topic[0] = '\0';
            automation_bridge_set_health_locked("idle");
            xSemaphoreGive(s_lock);
        }

    }
}

esp_err_t automation_bridge_init(void) {
    BaseType_t task_ok = pdFAIL;

    if (s_ready) {
        return ESP_OK;
    }

    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) {
        return ESP_ERR_NO_MEM;
    }

    memset(&s_status, 0, sizeof(s_status));
    s_status.runtime.initialized = true;
    s_status.runtime.state = UNIFIED_MODULE_STATE_INITIALIZED;
    s_task_handle = NULL;
    s_pending_count = 0U;
    s_queue_sequence = 0U;
    s_dedup_remember_sequence = 0U;
    s_active_background_topic[0] = '\0';
    s_pending_queue = automation_bridge_alloc_zeroed(
        sizeof(automation_bridge_queue_item_t) * CONFIG_UNIFIED_AUTOMATION_QUEUE_DEPTH
    );
    s_background_state = automation_bridge_alloc_zeroed(
        sizeof(automation_bridge_background_state_t) * CONFIG_UNIFIED_AUTOMATION_QUEUE_DEPTH
    );
    s_task_context = automation_bridge_alloc_zeroed(sizeof(*s_task_context));
    s_dedup_cache = automation_bridge_alloc_zeroed(
        sizeof(automation_bridge_dedup_entry_t) * AUTOMATION_BRIDGE_DEDUP_DEPTH
    );
    if (!s_pending_queue || !s_background_state || !s_task_context || !s_dedup_cache) {
        automation_bridge_free_allocated();
        vSemaphoreDelete(s_lock);
        s_lock = NULL;
        return ESP_ERR_NO_MEM;
    }

    task_ok = xTaskCreatePinnedToCore(
        automation_bridge_task,
        "automation_bridge_task",
        CONFIG_UNIFIED_TASK_STACK_XLARGE,
        NULL,
        4,
        &s_task_handle,
        1
    );
    if (task_ok != pdPASS) {
        automation_bridge_free_allocated();
        vSemaphoreDelete(s_lock);
        s_lock = NULL;
        return ESP_ERR_NO_MEM;
    }

    s_ready = true;
    ESP_LOGI(TAG, "ready queue=%d", CONFIG_UNIFIED_AUTOMATION_QUEUE_DEPTH);
    return ESP_OK;
}

esp_err_t automation_bridge_submit_mqtt_command(const char *topic, size_t topic_len, const char *payload, size_t payload_len) {
    automation_bridge_queue_item_t *item = NULL;
    char topic_suffix[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    automation_bridge_command_metadata_t metadata = {0};
    unified_action_response_t duplicate_response = {0};
    const char *command_name = NULL;
    unified_action_command_t command = UNIFIED_ACTION_CMD_NONE;
    uint32_t arrival_ms = 0U;
    bool incoming_background = false;
    bool queued = false;
    bool dropped_background = false;
    bool duplicate_replay = false;
    bool duplicate_in_flight = false;
    bool queue_full = false;
    size_t insert_index = 0U;
    esp_err_t result = ESP_OK;

    if (!s_ready || !s_lock || !s_pending_queue) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!topic || topic_len == 0U || topic_len >= CONFIG_UNIFIED_AUTOMATION_TOPIC_LEN) {
        return ESP_ERR_INVALID_ARG;
    }
    if ((payload_len > 0U && !payload) || payload_len >= CONFIG_UNIFIED_AUTOMATION_MESSAGE_LEN) {
        return ESP_ERR_INVALID_SIZE;
    }

    /* The queue item is ~2.2KB; keep it off the caller stack (mqtt event task
     * and modem RX path both land here). */
    item = automation_bridge_alloc_zeroed(sizeof(*item));
    if (!item) {
        return ESP_ERR_NO_MEM;
    }

    memcpy(item->topic, topic, topic_len);
    item->topic[topic_len] = '\0';
    if (payload && payload_len > 0U) {
        memcpy(item->payload, payload, payload_len);
        item->payload[payload_len] = '\0';
    }

    command_name = automation_bridge_command_name_from_topic(item->topic, topic_suffix, sizeof(topic_suffix));
    command = automation_bridge_parse_command_name(command_name);
    automation_bridge_parse_command_metadata(item->payload, &metadata);
    arrival_ms = unified_tick_now_ms();
    item->arrival_ms = arrival_ms;
    item->expires_at_ms = metadata.ttl_ms > 0U ? arrival_ms + metadata.ttl_ms : 0U;
    incoming_background = automation_bridge_command_is_background(command, metadata.source);
    item->background = incoming_background;
    item->priority = automation_bridge_effective_priority(command, incoming_background);
    /* FW-07: log correlation and size, never payload content. */
    ESP_LOGI(
        TAG,
        "submit topic=%s command=%s background=%d payload_len=%u action_id=%s ttl_ms=%" PRIu32,
        item->topic,
        command_name ? command_name : "<unknown>",
        incoming_background ? 1 : 0,
        (unsigned)payload_len,
        metadata.action_id[0] != '\0' ? metadata.action_id : "<generated>",
        metadata.ttl_ms
    );

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        const TickType_t now = xTaskGetTickCount();

        /* FW-01: QoS 1 duplicate handling. Terminal results are replayed;
         * duplicates that are still executing are dropped (the original
         * execution will publish the terminal result). */
        if (metadata.action_id[0] != '\0' &&
            automation_bridge_dedup_lookup_locked(metadata.action_id, &duplicate_response)) {
            if (duplicate_response.result != UNIFIED_ACTION_RESULT_NONE) {
                duplicate_replay = true;
            } else {
                duplicate_in_flight = true;
            }
            s_status.duplicate_commands++;
        }

        if (!duplicate_replay && !duplicate_in_flight && incoming_background) {
            if ((s_active_background_topic[0] != '\0' &&
                strncmp(s_active_background_topic, item->topic, sizeof(s_active_background_topic)) == 0) ||
                automation_bridge_find_pending_topic_locked(item->topic) >= 0 ||
                automation_bridge_background_is_suppressed_locked(item->topic, now)) {
                automation_bridge_note_background_locked(item->topic, now);
                automation_bridge_set_health_locked("background_coalesced");
                xSemaphoreGive(s_lock);
                ESP_LOGD(TAG, "coalesced background command topic=%s", item->topic);
                heap_caps_free(item);
                return ESP_OK;
            }
        }

        if (!duplicate_replay && !duplicate_in_flight) {
            item->sequence = ++s_queue_sequence;
            if (s_pending_count >= CONFIG_UNIFIED_AUTOMATION_QUEUE_DEPTH) {
                automation_bridge_queue_item_t *worst = &s_pending_queue[s_pending_count - 1U];
                bool can_replace = !incoming_background &&
                    worst->background &&
                    automation_bridge_item_precedes(item, worst);

                if (can_replace) {
                    insert_index = s_pending_count - 1U;
                    while (insert_index > 0U && automation_bridge_item_precedes(item, &s_pending_queue[insert_index - 1U])) {
                        s_pending_queue[insert_index] = s_pending_queue[insert_index - 1U];
                        insert_index--;
                    }
                    s_pending_queue[insert_index] = *item;
                    dropped_background = true;
                    queued = true;
                    automation_bridge_dedup_remember_locked(metadata.action_id, NULL);
                } else {
                    queue_full = true;
                    s_status.queue_overflows++;
                    automation_bridge_record_failure_locked(ESP_ERR_NO_MEM, "automation_queue_full");
                    automation_bridge_build_queue_full_response(&metadata, &duplicate_response);
                    automation_bridge_dedup_remember_locked(metadata.action_id, &duplicate_response);
                }
            } else {
                insert_index = s_pending_count;
                while (insert_index > 0U && automation_bridge_item_precedes(item, &s_pending_queue[insert_index - 1U])) {
                    s_pending_queue[insert_index] = s_pending_queue[insert_index - 1U];
                    insert_index--;
                }
                s_pending_queue[insert_index] = *item;
                s_pending_count++;
                queued = true;
                /* FW-01: mark as in-flight immediately so a QoS 1 redelivery
                 * arriving before dequeue is dropped, not double-executed. */
                automation_bridge_dedup_remember_locked(metadata.action_id, NULL);
            }
        }

        if (queued) {
            if (incoming_background) {
                automation_bridge_note_background_locked(item->topic, now);
            }
            if (dropped_background) {
                ESP_LOGW(TAG, "priority command preempted queued background task topic=%s", item->topic);
            }
            if (s_task_handle) {
                xTaskNotifyGive(s_task_handle);
            }
            s_status.queued_count++;
            unified_copy_cstr(s_status.last_topic, sizeof(s_status.last_topic), item->topic);
            automation_bridge_set_health_locked("queued");
        }
        xSemaphoreGive(s_lock);
    } else {
        heap_caps_free(item);
        return ESP_ERR_TIMEOUT;
    }

    if (duplicate_replay || queue_full) {
        /* Publish the cached terminal result (replay) or the queue-full
         * rejection (FW-04) with the originating action id. */
        result = api_bridge_record_external_response(&duplicate_response, NULL);
        if (result != ESP_OK) {
            ESP_LOGW(
                TAG,
                "duplicate/queue-full result publish failed err=%s",
                esp_err_to_name(result)
            );
        }
    } else if (duplicate_in_flight) {
        ESP_LOGD(TAG, "duplicate command still in flight action_id=%s", metadata.action_id);
    }

    heap_caps_free(item);
    if (queue_full) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
