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
#include "unified_json_text.h"

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
/* The queue is bounded and serialized, so retain every queued action plus
 * active/background headroom. A fixed eight-entry cache could evict an
 * in-flight action while the queue was full and allow a QoS1 retry to repeat
 * a modem operation. */
#define AUTOMATION_BRIDGE_DEDUP_DEPTH             (CONFIG_UNIFIED_AUTOMATION_QUEUE_DEPTH + 4U)

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
static esp_err_t automation_bridge_parse_command_metadata(
    const char *topic,
    const char *payload,
    automation_bridge_command_metadata_t *out_metadata
);
static void automation_bridge_build_queue_full_response(
    const automation_bridge_command_metadata_t *metadata,
    unified_action_response_t *out_response
);
static bool automation_bridge_action_id_is_valid(const char *action_id);

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
        case UNIFIED_ACTION_CMD_WIFI_PROFILES_APPLY:
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
    const char *topic_group = "command";

    if (!topic || !topic_suffix || topic_suffix_len == 0U) {
        return NULL;
    }

    board_bsp_get_identity(&identity);
    config_mgr_get_device_id_override(device_id_override, sizeof(device_id_override));
    config_mgr_get_mqtt_topic_prefix(mqtt_topic_prefix, sizeof(mqtt_topic_prefix));
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
    }
    if (!suffix || suffix[0] == '\0' || strlen(suffix) >= topic_suffix_len) {
        return NULL;
    }

    unified_copy_cstr(topic_suffix, topic_suffix_len, suffix);
    return topic_suffix;
}

static unified_action_command_t automation_bridge_parse_command_name(const char *command_name) {
    int candidate = 0;

    if (!command_name || command_name[0] == '\0') {
        return UNIFIED_ACTION_CMD_NONE;
    }
    /* The shared action registry is the only command vocabulary. */
    for (candidate = UNIFIED_ACTION_CMD_GET_STATUS;
         candidate <= UNIFIED_ACTION_CMD_WIFI_PROFILES_APPLY;
         ++candidate) {
        const unified_action_command_t command = (unified_action_command_t)candidate;
        if (strcmp(command_name, unified_action_command_name(command)) == 0) {
            return command;
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
    bool target_found = false;

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
            target_found = true;
            break;
        }
        /* Never evict an action whose terminal result has not been recorded.
         * The configured queue plus the active headroom keeps this path
         * bounded; if it is nevertheless exhausted, leave the in-flight
         * entries intact and let the caller's existing backpressure apply. */
        if (candidate->response.result == UNIFIED_ACTION_RESULT_NONE) {
            continue;
        }
        if (candidate->remember_sequence < oldest) {
            oldest = candidate->remember_sequence;
            target = index;
            target_found = true;
        }
    }

    if (!target_found) {
        ESP_LOGW(TAG, "dedup cache full of in-flight actions; preserving entries");
        return;
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

/* Admission and execution use the same strict envelope check. The MQTT topic
 * selects the action; the payload must independently name that exact action. */
static esp_err_t automation_bridge_validate_envelope(
    const cJSON *root,
    const char *topic,
    unified_action_command_t *out_command
) {
    board_bsp_identity_t identity = {0};
    char device_id_override[CONFIG_MGR_DEVICE_ID_LEN] = {0};
    char topic_command[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    const cJSON *node = NULL;
    unified_action_command_t command = UNIFIED_ACTION_CMD_NONE;
    const char *action_id = NULL;
    static const char *allowed_keys[] = {
        "schema", "device_id", "command", "action_id", "payload",
        "source", "timeout", "ttl_ms"
    };
    uint8_t seen = 0U;

    if (!cJSON_IsObject(root) || !topic || !out_command) {
        return ESP_ERR_INVALID_ARG;
    }
    for (const cJSON *field = root->child; field; field = field->next) {
        bool allowed = false;
        for (size_t i = 0U; i < sizeof(allowed_keys) / sizeof(allowed_keys[0]); ++i) {
            if (field->string && strcmp(field->string, allowed_keys[i]) == 0) {
                const uint8_t bit = (uint8_t)(1U << i);
                if ((seen & bit) != 0U) {
                    return ESP_ERR_INVALID_ARG;
                }
                seen |= bit;
                allowed = true;
                break;
            }
        }
        if (!allowed) {
            return ESP_ERR_INVALID_ARG;
        }
    }
    if ((seen & 0x1FU) != 0x1FU) {
        return ESP_ERR_INVALID_ARG;
    }
    node = cJSON_GetObjectItemCaseSensitive(root, "source");
    if (node && (!cJSON_IsString(node) || !node->valuestring ||
                 strnlen(node->valuestring, UNIFIED_TEXT_SHORT_LEN) >= UNIFIED_TEXT_SHORT_LEN)) {
        return ESP_ERR_INVALID_ARG;
    }
    /* Validate before integer conversion; retain the documented runtime clamp
     * for valid integer metadata. Zero keeps the existing default/no-TTL meaning. */
    static const char *duration_keys[] = { "timeout", "ttl_ms" };
    for (size_t i = 0U; i < sizeof(duration_keys) / sizeof(duration_keys[0]); ++i) {
        node = cJSON_GetObjectItemCaseSensitive(root, duration_keys[i]);
        if (node && (!cJSON_IsNumber(node) ||
                     !(node->valuedouble >= 0.0 && node->valuedouble <= UINT32_MAX) ||
                     node->valuedouble != (double)(uint32_t)node->valuedouble)) {
            return ESP_ERR_INVALID_ARG;
        }
    }
    node = cJSON_GetObjectItemCaseSensitive(root, "schema");
    if (!cJSON_IsNumber(node) || node->valuedouble != 1.0) {
        return ESP_ERR_INVALID_ARG;
    }
    board_bsp_get_identity(&identity);
    config_mgr_get_device_id_override(device_id_override, sizeof(device_id_override));
    node = cJSON_GetObjectItemCaseSensitive(root, "device_id");
    if (!cJSON_IsString(node) || !node->valuestring ||
        strcmp(node->valuestring, device_id_override[0] ? device_id_override : identity.device_id) != 0) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!automation_bridge_command_name_from_topic(topic, topic_command, sizeof(topic_command))) {
        return ESP_ERR_INVALID_ARG;
    }
    command = automation_bridge_parse_command_name(topic_command);
    if (command == UNIFIED_ACTION_CMD_NONE) {
        return ESP_ERR_NOT_SUPPORTED;
    }
    node = cJSON_GetObjectItemCaseSensitive(root, "command");
    if (!cJSON_IsString(node) || !node->valuestring ||
        strcmp(node->valuestring, unified_action_command_name(command)) != 0) {
        return ESP_ERR_INVALID_ARG;
    }
    node = cJSON_GetObjectItemCaseSensitive(root, "action_id");
    if (!cJSON_IsString(node) || !node->valuestring || node->valuestring[0] == '\0' ||
        strnlen(node->valuestring, UNIFIED_CORRELATION_ID_LEN) >= UNIFIED_CORRELATION_ID_LEN) {
        return ESP_ERR_INVALID_ARG;
    }
    action_id = node->valuestring;
    if (!automation_bridge_action_id_is_valid(action_id)) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(root, "payload"))) {
        return ESP_ERR_INVALID_ARG;
    }
    *out_command = command;
    return ESP_OK;
}

static bool automation_bridge_action_id_is_valid(const char *action_id) {
    if (!action_id || action_id[0] == '\0' ||
        strnlen(action_id, UNIFIED_CORRELATION_ID_LEN) >= UNIFIED_CORRELATION_ID_LEN) {
        return false;
    }

    for (size_t i = 0U; action_id[i] != '\0'; ++i) {
        const char c = action_id[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.' || c == ':')) {
            return false;
        }
    }
    return true;
}

/* One bounded parse before admission captures identity and queue timing. The
 * worker checks the same envelope again before any physical execution. */
static esp_err_t automation_bridge_parse_command_metadata(
    const char *topic,
    const char *payload,
    automation_bridge_command_metadata_t *out_metadata
) {
    cJSON *root = NULL;
    cJSON *node = NULL;
    double ttl = 0.0;
    unified_action_command_t command = UNIFIED_ACTION_CMD_NONE;
    esp_err_t err = ESP_OK;

    if (!out_metadata || !topic || !payload) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(out_metadata, 0, sizeof(*out_metadata));
    if (!unified_json_text_is_cstring_safe(payload, strlen(payload))) {
        return ESP_ERR_INVALID_ARG;
    }
    root = cJSON_ParseWithOpts(payload, NULL, true);
    if (!root) {
        return ESP_ERR_INVALID_ARG;
    }
    err = automation_bridge_validate_envelope(root, topic, &command);
    if (err != ESP_OK) {
        cJSON_Delete(root);
        return err;
    }
    node = cJSON_GetObjectItemCaseSensitive(root, "action_id");
    unified_copy_cstr(out_metadata->action_id, sizeof(out_metadata->action_id), node->valuestring);

    node = cJSON_GetObjectItemCaseSensitive(root, "source");
    if (cJSON_IsString(node) && node->valuestring) {
        unified_copy_cstr(out_metadata->source, sizeof(out_metadata->source), node->valuestring);
    }

    node = cJSON_GetObjectItemCaseSensitive(root, "ttl_ms");
    if (cJSON_IsNumber(node)) {
        ttl = node->valuedouble;
    }
    cJSON_Delete(root);

    if (ttl > 0.0) {
        out_metadata->ttl_ms = ttl >= AUTOMATION_BRIDGE_MAX_TTL_MS
            ? AUTOMATION_BRIDGE_MAX_TTL_MS
            : ttl <= AUTOMATION_BRIDGE_MIN_TTL_MS
                ? AUTOMATION_BRIDGE_MIN_TTL_MS
                : (uint32_t)ttl;
    }
    return ESP_OK;
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

/* Exact object shape: reject unknown, duplicate and missing fields. */
static bool automation_bridge_exact_keys(const cJSON *object, const char *const *keys, size_t count) {
    if (!cJSON_IsObject(object) || count > 32U) return false;
    uint32_t seen = 0U;
    for (const cJSON *field = object->child; field; field = field->next) {
        size_t index = 0U;
        while (index < count && (!field->string || strcmp(field->string, keys[index]) != 0)) ++index;
        if (index == count || (seen & (UINT32_C(1) << index))) return false;
        seen |= UINT32_C(1) << index;
    }
    return seen == (count == 32U ? UINT32_MAX : (UINT32_C(1) << count) - 1U);
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
    unified_action_command_t topic_action = UNIFIED_ACTION_CMD_NONE;
    esp_err_t envelope_err = ESP_OK;

    if (!item || !out_action || !out_request) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(out_action, 0, sizeof(*out_action));
    memset(out_request, 0, sizeof(*out_request));

    const size_t payload_length = strnlen(item->payload, sizeof(item->payload));
    if (payload_length == sizeof(item->payload) ||
        !unified_json_text_is_cstring_safe(item->payload, payload_length)) {
        return ESP_ERR_INVALID_ARG;
    }
    root = cJSON_ParseWithOpts(item->payload[0] != '\0' ? item->payload : "{}", NULL, true);
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

    envelope_err = automation_bridge_validate_envelope(root, item->topic, &topic_action);
    if (envelope_err != ESP_OK) {
        cJSON_Delete(root);
        return envelope_err;
    }

    board_bsp_get_identity(&identity);
    config_mgr_get_device_id_override(device_id_override, sizeof(device_id_override));
    out_action->command = topic_action;
    snprintf(
        out_action->correlation.device_id,
        sizeof(out_action->correlation.device_id),
        "%s",
        device_id_override[0] ? device_id_override : identity.device_id
    );

    node = cJSON_GetObjectItemCaseSensitive(root, "action_id");
    unified_copy_cstr(
        out_action->correlation.correlation_id,
        sizeof(out_action->correlation.correlation_id),
        node->valuestring
    );

    node = cJSON_GetObjectItemCaseSensitive(root, "timeout");
    out_action->timeout_ms = cJSON_IsNumber(node) && node->valuedouble > 0.0
        ? node->valuedouble >= AUTOMATION_BRIDGE_MAX_TIMEOUT_MS
            ? AUTOMATION_BRIDGE_MAX_TIMEOUT_MS
            : node->valuedouble <= AUTOMATION_BRIDGE_MIN_TIMEOUT_MS
                ? AUTOMATION_BRIDGE_MIN_TIMEOUT_MS
                : (uint32_t)node->valuedouble
        : AUTOMATION_BRIDGE_DEFAULT_TIMEOUT_MS;
    if (now_ms == 0U) {
        now_ms = unified_tick_now_ms();
    }
    out_action->correlation.created_ms = now_ms;

    payload = cJSON_GetObjectItemCaseSensitive(root, "payload");

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
    node = cJSON_GetObjectItemCaseSensitive(payload, "revision");
    cJSON *profiles = cJSON_GetObjectItemCaseSensitive(payload, "profiles");
    static const char *const profile_set_keys[] = { "revision", "profiles" };
    static const char *const profile_keys[] = { "ssid", "password", "priority", "enabled" };
    if (topic_action == UNIFIED_ACTION_CMD_WIFI_PROFILES_APPLY &&
        automation_bridge_exact_keys(payload, profile_set_keys, 2U) &&
        cJSON_IsNumber(node) && node->valuedouble >= 1.0 && node->valuedouble <= UINT32_MAX &&
        node->valuedouble == (double)(uint32_t)node->valuedouble && cJSON_IsArray(profiles)) {
        int profile_count = cJSON_GetArraySize(profiles);
        if (profile_count >= 0 && profile_count <= (int)WIFI_MGR_PROFILE_MAX) {
            out_request->wifi_profiles.revision = (uint32_t)node->valuedouble;
            out_request->wifi_profiles.count = (uint8_t)profile_count;
            out_request->wifi_profiles_present = true;
            for (int profile_index = 0; profile_index < profile_count; ++profile_index) {
                cJSON *profile_node = cJSON_GetArrayItem(profiles, profile_index);
                cJSON *ssid_node = cJSON_GetObjectItemCaseSensitive(profile_node, "ssid");
                cJSON *password_node = cJSON_GetObjectItemCaseSensitive(profile_node, "password");
                cJSON *priority_node = cJSON_GetObjectItemCaseSensitive(profile_node, "priority");
                cJSON *enabled_node = cJSON_GetObjectItemCaseSensitive(profile_node, "enabled");
                if (!automation_bridge_exact_keys(profile_node, profile_keys, 4U) || !cJSON_IsString(ssid_node) || !ssid_node->valuestring ||
                    strlen(ssid_node->valuestring) == 0U || strlen(ssid_node->valuestring) >= WIFI_MGR_PROFILE_SSID_LEN ||
                    !cJSON_IsNumber(priority_node) || !(priority_node->valuedouble >= 1.0 && priority_node->valuedouble <= 999.0) ||
                    priority_node->valuedouble != (double)(uint16_t)priority_node->valuedouble ||
                    !cJSON_IsBool(enabled_node) || !cJSON_IsString(password_node) || !password_node->valuestring ||
                    strlen(password_node->valuestring) >= WIFI_MGR_PROFILE_PASSWORD_LEN) {
                    out_request->wifi_profiles_present = false;
                    break;
                }
                wifi_mgr_profile_t *profile = &out_request->wifi_profiles.profiles[profile_index];
                profile->enabled = cJSON_IsTrue(enabled_node);
                profile->priority = (uint16_t)priority_node->valuedouble;
                unified_copy_cstr(profile->ssid, sizeof(profile->ssid), ssid_node->valuestring);
                unified_copy_cstr(profile->password, sizeof(profile->password), password_node ? password_node->valuestring : "");
            }
        }
    }
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "url"), out_request->url, sizeof(out_request->url));
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "raw_line"), out_request->raw_line, sizeof(out_request->raw_line));
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
    node = cJSON_GetObjectItemCaseSensitive(payload, "load_balancing");
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
    if (cJSON_IsNumber(node) && node->valuedouble >= 0 && node->valuedouble <= UINT16_MAX) {
        out_request->sms_storage_index_present = true;
        out_request->sms_storage_index = (uint16_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "storage_id");
    if (cJSON_IsNumber(node) && node->valuedouble > 0 && node->valuedouble <= UINT32_MAX) {
        out_request->sms_storage_id_present = true;
        out_request->sms_storage_id = (uint32_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "delete_flag");
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
    if (cJSON_IsString(node) && node->valuestring) {
        if (strcmp(node->valuestring, "all") == 0 || strcmp(node->valuestring, "ALL") == 0) {
            out_request->sms_delete_all = true;
        } else if (strcmp(node->valuestring, "read") == 0 || strcmp(node->valuestring, "READ") == 0 ||
                   strcmp(node->valuestring, "incoming") == 0 || strcmp(node->valuestring, "INCOMING") == 0) {
            out_request->sms_delete_read = true;
        }
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "ttl_ms");
    if (cJSON_IsNumber(node) && node->valuedouble > 0 && node->valuedouble <= UINT32_MAX) {
        out_request->ttl_ms = (uint32_t)node->valuedouble;
    }
    node = cJSON_GetObjectItemCaseSensitive(payload, "interval_ms");
    if (cJSON_IsNumber(node) && node->valuedouble > 0 && node->valuedouble <= UINT32_MAX) {
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
    if (item && unified_json_text_is_cstring_safe(item->payload, strlen(item->payload))) {
        root = cJSON_ParseWithOpts(item->payload, NULL, true);
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

/* Admission failures happen before the queue owns the command. If the
 * envelope still carries a valid action ID, publish one correlated terminal
 * rejection so the dashboard settles immediately instead of waiting for its
 * request timeout. Invalid or missing IDs are intentionally not reflected. */
static void automation_bridge_record_admission_rejection(
    const char *topic,
    const char *payload,
    esp_err_t err
) {
    automation_bridge_queue_item_t item = {0};
    unified_action_response_t response = {0};
    cJSON *root = NULL;
    cJSON *node = NULL;

    if (!topic || !payload || strlen(topic) >= sizeof(item.topic) ||
        strlen(payload) >= sizeof(item.payload) ||
        !unified_json_text_is_cstring_safe(payload, strlen(payload))) {
        return;
    }

    root = cJSON_ParseWithOpts(payload, NULL, true);
    node = root ? cJSON_GetObjectItemCaseSensitive(root, "action_id") : NULL;
    if (!cJSON_IsString(node) || !automation_bridge_action_id_is_valid(node->valuestring)) {
        cJSON_Delete(root);
        return;
    }

    unified_copy_cstr(item.topic, sizeof(item.topic), topic);
    unified_copy_cstr(item.payload, sizeof(item.payload), payload);
    response = automation_bridge_build_parse_error(&item, err);
    if (strcmp(response.action.correlation.correlation_id, node->valuestring) == 0) {
        (void)api_bridge_record_external_response(&response, NULL);
    }
    cJSON_Delete(root);
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
    (void)payload; /* Full responses already live in the PSRAM action history. */
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
            "response action_id=%s command=%s result=%s code=%ld detail_len=%u",
            ctx->response.action.correlation.correlation_id,
            unified_action_command_name(ctx->response.action.command),
            unified_action_result_name(ctx->response.result),
            (long)ctx->response.result_code,
            (unsigned)strnlen(ctx->response.detail, sizeof(ctx->response.detail))
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
    if (memchr(topic, '\0', topic_len) ||
        !unified_json_text_is_cstring_safe(payload, payload_len)) {
        return ESP_ERR_INVALID_ARG;
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
    result = automation_bridge_parse_command_metadata(item->topic, item->payload, &metadata);
    if (result != ESP_OK) {
        automation_bridge_record_admission_rejection(item->topic, item->payload, result);
        heap_caps_free(item);
        return result;
    }
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
        result = duplicate_replay ? api_bridge_replay_response(&duplicate_response)
                                  : api_bridge_record_external_response(&duplicate_response, NULL);
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
