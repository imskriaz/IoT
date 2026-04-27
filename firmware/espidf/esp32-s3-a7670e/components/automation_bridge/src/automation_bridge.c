#include "automation_bridge.h"

#include <inttypes.h>
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

typedef struct {
    char topic[CONFIG_UNIFIED_AUTOMATION_TOPIC_LEN];
    TickType_t suppress_until;
} automation_bridge_background_state_t;

typedef struct {
    char topic[CONFIG_UNIFIED_AUTOMATION_TOPIC_LEN];
    char payload[CONFIG_UNIFIED_AUTOMATION_MESSAGE_LEN];
    uint16_t priority;
    uint32_t sequence;
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
    uint32_t last_action_key;
    unified_action_response_t last_response;
    char last_topic[CONFIG_UNIFIED_AUTOMATION_TOPIC_LEN];
    char last_payload[CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN];
} automation_bridge_status_t;

static SemaphoreHandle_t s_lock;
static automation_bridge_status_t s_status;
static automation_bridge_task_context_t s_task_context;
static TaskHandle_t s_task_handle;
static automation_bridge_queue_item_t *s_pending_queue;
static automation_bridge_background_state_t *s_background_state;
static size_t s_pending_count;
static uint32_t s_queue_sequence;
static char s_active_background_topic[CONFIG_UNIFIED_AUTOMATION_TOPIC_LEN];
static bool s_ready;

static void *automation_bridge_alloc_zeroed(size_t size) {
    void *buffer = heap_caps_calloc(1U, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);

    if (!buffer) {
        buffer = heap_caps_calloc(1U, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }

    return buffer;
}

static void automation_bridge_set_health_locked(const char *detail) {
    s_status.runtime.running = true;
    s_status.runtime.state = UNIFIED_MODULE_STATE_RUNNING;
    (void)health_monitor_set_module_state("automation_bridge", HEALTH_MODULE_STATE_OK, detail ? detail : "running");
}

static void automation_bridge_record_failure_locked(esp_err_t err, const char *detail) {
    s_status.runtime.last_error = err;
    snprintf(
        s_status.runtime.last_error_text,
        sizeof(s_status.runtime.last_error_text),
        "%.*s",
        (int)sizeof(s_status.runtime.last_error_text) - 1,
        detail ? detail : esp_err_to_name(err)
    );
    automation_bridge_set_health_locked(detail);
}

static uint16_t automation_bridge_command_priority(unified_action_command_t command) {
    switch (command) {
        case UNIFIED_ACTION_CMD_SEND_SMS:
        case UNIFIED_ACTION_CMD_SEND_SMS_MULTIPART:
        case UNIFIED_ACTION_CMD_SEND_USSD:
        case UNIFIED_ACTION_CMD_CANCEL_USSD:
        case UNIFIED_ACTION_CMD_DIAL_NUMBER:
        case UNIFIED_ACTION_CMD_HANGUP_CALL:
            return 10U;
        case UNIFIED_ACTION_CMD_WIFI_RECONNECT:
        case UNIFIED_ACTION_CMD_WIFI_TOGGLE:
        case UNIFIED_ACTION_CMD_WIFI_DISCONNECT:
        case UNIFIED_ACTION_CMD_WIFI_SCAN:
        case UNIFIED_ACTION_CMD_MOBILE_TOGGLE:
        case UNIFIED_ACTION_CMD_MOBILE_APN:
        case UNIFIED_ACTION_CMD_GPIO_WRITE:
        case UNIFIED_ACTION_CMD_GPIO_PULSE:
        case UNIFIED_ACTION_CMD_SENSOR_READ:
            return 40U;
        case UNIFIED_ACTION_CMD_CONFIG_SET:
        case UNIFIED_ACTION_CMD_ROUTING_CONFIGURE:
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

static void automation_bridge_payload_source(char *dest, size_t dest_len, const char *payload) {
    cJSON *root = NULL;
    cJSON *source_node = NULL;

    if (!dest || dest_len == 0U) {
        return;
    }

    dest[0] = '\0';
    if (!payload || payload[0] == '\0') {
        return;
    }

    root = cJSON_Parse(payload);
    if (!root) {
        return;
    }

    source_node = cJSON_GetObjectItemCaseSensitive(root, "source");
    if (cJSON_IsString(source_node) && source_node->valuestring) {
        unified_copy_cstr(dest, dest_len, source_node->valuestring);
    }

    cJSON_Delete(root);
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
        if (entry->suppress_until <= now) {
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
        if (entry->topic[0] == '\0' || entry->suppress_until <= now) {
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

    if (strcmp(normalized, "config_set") == 0) {
        return UNIFIED_ACTION_CMD_CONFIG_SET;
    }
    if (strcmp(normalized, "wifi_reconnect") == 0) {
        return UNIFIED_ACTION_CMD_WIFI_RECONNECT;
    }
    if (strcmp(normalized, "wifi_toggle") == 0) {
        return UNIFIED_ACTION_CMD_WIFI_TOGGLE;
    }
    if (strcmp(normalized, "wifi_disconnect") == 0) {
        return UNIFIED_ACTION_CMD_WIFI_DISCONNECT;
    }
    if (strcmp(normalized, "wifi_scan") == 0) {
        return UNIFIED_ACTION_CMD_WIFI_SCAN;
    }
    if (strcmp(normalized, "mobile_toggle") == 0) {
        return UNIFIED_ACTION_CMD_MOBILE_TOGGLE;
    }
    if (strcmp(normalized, "mobile_apn") == 0) {
        return UNIFIED_ACTION_CMD_MOBILE_APN;
    }
    if (strcmp(normalized, "routing_configure") == 0) {
        return UNIFIED_ACTION_CMD_ROUTING_CONFIGURE;
    }
    if (strcmp(normalized, "status_watch") == 0) {
        return UNIFIED_ACTION_CMD_STATUS_WATCH;
    }
    if (strcmp(normalized, "get_sms_history") == 0) {
        return UNIFIED_ACTION_CMD_GET_SMS_HISTORY;
    }
    if (strcmp(normalized, "get_status") == 0) {
        return UNIFIED_ACTION_CMD_GET_STATUS;
    }
    if (strcmp(normalized, "ota_update") == 0) {
        return UNIFIED_ACTION_CMD_OTA_UPDATE;
    }
    if (strcmp(normalized, "send_sms") == 0) {
        return UNIFIED_ACTION_CMD_SEND_SMS;
    }
    if (strcmp(normalized, "send_sms_multipart") == 0) {
        return UNIFIED_ACTION_CMD_SEND_SMS_MULTIPART;
    }
    if (strcmp(normalized, "send_ussd") == 0) {
        return UNIFIED_ACTION_CMD_SEND_USSD;
    }
    if (strcmp(normalized, "cancel_ussd") == 0) {
        return UNIFIED_ACTION_CMD_CANCEL_USSD;
    }
    if (strcmp(normalized, "dial_number") == 0) {
        return UNIFIED_ACTION_CMD_DIAL_NUMBER;
    }
    if (strcmp(normalized, "hangup_call") == 0) {
        return UNIFIED_ACTION_CMD_HANGUP_CALL;
    }
    if (strcmp(normalized, "reboot_device") == 0) {
        return UNIFIED_ACTION_CMD_REBOOT_DEVICE;
    }
    if (strcmp(normalized, "gpio_write") == 0) {
        return UNIFIED_ACTION_CMD_GPIO_WRITE;
    }
    if (strcmp(normalized, "gpio_pulse") == 0) {
        return UNIFIED_ACTION_CMD_GPIO_PULSE;
    }
    if (strcmp(normalized, "sensor_read") == 0) {
        return UNIFIED_ACTION_CMD_SENSOR_READ;
    }
    if (strcmp(normalized, "file_list") == 0) {
        return UNIFIED_ACTION_CMD_FILE_LIST;
    }
    if (strcmp(normalized, "file_read_meta") == 0) {
        return UNIFIED_ACTION_CMD_FILE_READ_META;
    }
    if (strcmp(normalized, "file_delete") == 0) {
        return UNIFIED_ACTION_CMD_FILE_DELETE;
    }
    if (strcmp(normalized, "file_export") == 0) {
        return UNIFIED_ACTION_CMD_FILE_EXPORT;
    }
    if (strcmp(normalized, "start_camera") == 0) {
        return UNIFIED_ACTION_CMD_START_CAMERA;
    }
    if (strcmp(normalized, "stop_camera") == 0) {
        return UNIFIED_ACTION_CMD_STOP_CAMERA;
    }
    if (strcmp(normalized, "take_snapshot") == 0) {
        return UNIFIED_ACTION_CMD_TAKE_SNAPSHOT;
    }
    if (strcmp(normalized, "start_stream") == 0) {
        return UNIFIED_ACTION_CMD_START_STREAM;
    }
    if (strcmp(normalized, "stop_stream") == 0) {
        return UNIFIED_ACTION_CMD_STOP_STREAM;
    }
    if (strcmp(normalized, "card_scan_start") == 0) {
        return UNIFIED_ACTION_CMD_CARD_SCAN_START;
    }
    if (strcmp(normalized, "card_scan_stop") == 0) {
        return UNIFIED_ACTION_CMD_CARD_SCAN_STOP;
    }
    if (strcmp(normalized, "card_read") == 0) {
        return UNIFIED_ACTION_CMD_CARD_READ;
    }
    if (strcmp(normalized, "card_write") == 0) {
        return UNIFIED_ACTION_CMD_CARD_WRITE;
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
        ESP_LOGW(
            TAG,
            "parse failed topic=%s payload=%s error_at=%s",
            item->topic,
            item->payload[0] != '\0' ? item->payload : "<empty>",
            error_ptr ? error_ptr : "<unknown>"
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
            "unsupported command topic=%s topic_command=%s payload_command=%s payload=%s",
            item->topic,
            topic_command[0] != '\0' ? topic_command : "<none>",
            command_name ? command_name : "<none>",
            item->payload[0] != '\0' ? item->payload : "<empty>"
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
        now_ms = unified_tick_now_ms();
        snprintf(
            out_action->correlation.correlation_id,
            sizeof(out_action->correlation.correlation_id),
            "%s-%" PRIu32,
            command_name,
            now_ms
        );
    }

    node = cJSON_GetObjectItemCaseSensitive(root, "timeout");
    out_action->timeout_ms = cJSON_IsNumber(node) && node->valuedouble > 0 ? (uint32_t)node->valuedouble : 15000U;
    if (now_ms == 0U) {
        now_ms = unified_tick_now_ms();
    }
    out_action->correlation.created_ms = now_ms;

    payload = cJSON_GetObjectItemCaseSensitive(root, "payload");
    if (!cJSON_IsObject(payload)) {
        payload = root;
    }

    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "path"), out_request->path, sizeof(out_request->path));
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
    automation_bridge_copy_json_string(cJSON_GetObjectItemCaseSensitive(payload, "url"), out_request->url, sizeof(out_request->url));
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

static void automation_bridge_task(void *arg) {
    automation_bridge_task_context_t *ctx = &s_task_context;
    esp_err_t err = ESP_OK;
    bool response_recorded = false;
    bool parse_failed = false;
    bool dispatch_failed = false;
    esp_err_t recorded_error = ESP_OK;
    const char *error_detail = NULL;

    (void)arg;

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
        recorded_error = ESP_OK;
        error_detail = NULL;
        err = automation_bridge_parse_item(&ctx->item, &ctx->action, &ctx->request);
        if (err == ESP_OK) {
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
        } else {
            ctx->response = automation_bridge_build_parse_error(&ctx->item, err);
            parse_failed = true;
            recorded_error = err;
            error_detail = ctx->response.detail;
        }

        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            if (dispatch_failed) {
                s_status.dispatch_failures++;
            }
            if (parse_failed) {
                s_status.parse_failures++;
            }
            if (dispatch_failed || parse_failed) {
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
    s_active_background_topic[0] = '\0';
    s_pending_queue = automation_bridge_alloc_zeroed(
        sizeof(automation_bridge_queue_item_t) * CONFIG_UNIFIED_AUTOMATION_QUEUE_DEPTH
    );
    s_background_state = automation_bridge_alloc_zeroed(
        sizeof(automation_bridge_background_state_t) * CONFIG_UNIFIED_AUTOMATION_QUEUE_DEPTH
    );
    if (!s_pending_queue || !s_background_state) {
        heap_caps_free(s_pending_queue);
        heap_caps_free(s_background_state);
        s_pending_queue = NULL;
        s_background_state = NULL;
        vSemaphoreDelete(s_lock);
        s_lock = NULL;
        return ESP_ERR_NO_MEM;
    }

    #if CONFIG_SPIRAM && CONFIG_SPIRAM_ALLOW_STACK_EXTERNAL_MEMORY
    task_ok = xTaskCreatePinnedToCoreWithCaps(
        automation_bridge_task,
        "automation_bridge_task",
        CONFIG_UNIFIED_TASK_STACK_MEDIUM,
        NULL,
        4,
        &s_task_handle,
        1,
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
    );
    #endif
    if (task_ok != pdPASS) {
        task_ok = xTaskCreatePinnedToCore(
            automation_bridge_task,
            "automation_bridge_task",
            CONFIG_UNIFIED_TASK_STACK_MEDIUM,
            NULL,
            4,
            &s_task_handle,
            1
        );
    }
    if (task_ok != pdPASS) {
        heap_caps_free(s_pending_queue);
        heap_caps_free(s_background_state);
        s_pending_queue = NULL;
        s_background_state = NULL;
        vSemaphoreDelete(s_lock);
        s_lock = NULL;
        return ESP_ERR_NO_MEM;
    }

    s_ready = true;
    ESP_LOGI(TAG, "ready queue=%d", CONFIG_UNIFIED_AUTOMATION_QUEUE_DEPTH);
    return ESP_OK;
}

esp_err_t automation_bridge_submit_mqtt_command(const char *topic, size_t topic_len, const char *payload, size_t payload_len) {
    automation_bridge_queue_item_t item = {0};
    char topic_suffix[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    char source[UNIFIED_TEXT_SHORT_LEN] = {0};
    const char *command_name = NULL;
    unified_action_command_t command = UNIFIED_ACTION_CMD_NONE;
    bool incoming_background = false;
    bool queued = false;
    bool dropped_background = false;
    size_t insert_index = 0U;

    if (!s_ready || !s_lock || !s_pending_queue) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!topic || topic_len == 0U || topic_len >= sizeof(item.topic)) {
        return ESP_ERR_INVALID_ARG;
    }
    if ((payload_len > 0U && !payload) || payload_len >= sizeof(item.payload)) {
        return ESP_ERR_INVALID_SIZE;
    }

    memcpy(item.topic, topic, topic_len);
    item.topic[topic_len] = '\0';
    if (payload && payload_len > 0U) {
        memcpy(item.payload, payload, payload_len);
        item.payload[payload_len] = '\0';
    }
    command_name = automation_bridge_command_name_from_topic(item.topic, topic_suffix, sizeof(topic_suffix));
    command = automation_bridge_parse_command_name(command_name);
    automation_bridge_payload_source(source, sizeof(source), item.payload);
    incoming_background = automation_bridge_command_is_background(command, source);
    item.background = incoming_background;
    item.priority = automation_bridge_effective_priority(command, incoming_background);
    ESP_LOGI(
        TAG,
        "submit topic=%s command=%s background=%d payload_len=%u",
        item.topic,
        command_name ? command_name : "<unknown>",
        incoming_background ? 1 : 0,
        (unsigned)payload_len
    );

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        const TickType_t now = xTaskGetTickCount();
        if (incoming_background) {
            if ((s_active_background_topic[0] != '\0' &&
                strncmp(s_active_background_topic, item.topic, sizeof(s_active_background_topic)) == 0) ||
                automation_bridge_find_pending_topic_locked(item.topic) >= 0 ||
                automation_bridge_background_is_suppressed_locked(item.topic, now)) {
                automation_bridge_note_background_locked(item.topic, now);
                automation_bridge_set_health_locked("background_coalesced");
                xSemaphoreGive(s_lock);
                ESP_LOGD(TAG, "coalesced background command topic=%s", item.topic);
                return ESP_OK;
            }
        }

        item.sequence = ++s_queue_sequence;
        if (s_pending_count >= CONFIG_UNIFIED_AUTOMATION_QUEUE_DEPTH) {
            automation_bridge_queue_item_t *worst = &s_pending_queue[s_pending_count - 1U];
            bool can_replace = !incoming_background &&
                worst->background &&
                automation_bridge_item_precedes(&item, worst);

            if (can_replace) {
                insert_index = s_pending_count - 1U;
                while (insert_index > 0U && automation_bridge_item_precedes(&item, &s_pending_queue[insert_index - 1U])) {
                    s_pending_queue[insert_index] = s_pending_queue[insert_index - 1U];
                    insert_index--;
                }
                s_pending_queue[insert_index] = item;
                dropped_background = true;
                queued = true;
            } else {
                s_status.queue_overflows++;
                automation_bridge_record_failure_locked(ESP_ERR_NO_MEM, "automation_queue_full");
            }
        } else {
            insert_index = s_pending_count;
            while (insert_index > 0U && automation_bridge_item_precedes(&item, &s_pending_queue[insert_index - 1U])) {
                s_pending_queue[insert_index] = s_pending_queue[insert_index - 1U];
                insert_index--;
            }
            s_pending_queue[insert_index] = item;
            s_pending_count++;
            queued = true;
        }

        if (queued) {
            if (incoming_background) {
                automation_bridge_note_background_locked(item.topic, now);
            }
            if (dropped_background) {
                ESP_LOGW(TAG, "priority command preempted queued background task topic=%s", item.topic);
            }
            if (s_task_handle) {
                xTaskNotifyGive(s_task_handle);
            }
        }

        if (!queued) {
            xSemaphoreGive(s_lock);
            return ESP_ERR_NO_MEM;
        }

        s_status.queued_count++;
        unified_copy_cstr(s_status.last_topic, sizeof(s_status.last_topic), item.topic);
        automation_bridge_set_health_locked("queued");
        xSemaphoreGive(s_lock);
    } else {
        return ESP_ERR_TIMEOUT;
    }

    return ESP_OK;
}
