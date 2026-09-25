#include "device_status.h"

#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "battery_monitor.h"
#include "board_bsp.h"
#include "config_mgr.h"
#include "diagnostics.h"
#include "esp_heap_caps.h"
#include "esp_random.h"
#include "health_monitor.h"
#include "modem_a7670.h"
#include "mqtt_mgr.h"
#include "sms_service.h"
#include "state_mgr.h"
#include "storage_mgr.h"
#include "task_registry.h"
#include "wifi_mgr.h"

#define DEVICE_STATUS_JSON_BUFFER_LEN DEVICE_STATUS_JSON_MAX_LEN

static bool s_ready;
static char *s_status_log_buffer;
static SemaphoreHandle_t s_json_lock;
static char s_boot_id[17];
static uint32_t s_status_sequence;

typedef struct {
    char device_id[UNIFIED_DEVICE_ID_LEN * 2U];
    char boot_id[sizeof(((device_status_snapshot_t *)0)->boot_id) * 2U];
    char hardware_uid[48];
    char board_name[96];
    char board_chip[48];
    char firmware_version[66];
    char ota_slot[32];
    char ota_state[48];
    char ota_validation_action_id[64];
    char wifi_reason[UNIFIED_TEXT_MEDIUM_LEN * 2U];
    char wifi_scan_summary[UNIFIED_TEXT_LONG_LEN * 2U];
    char wifi_ssid[UNIFIED_WIFI_SSID_LEN * 2U];
    char wifi_ip[UNIFIED_IPV4_ADDR_LEN * 2U];
    char wifi_security[48];
    char mqtt_last_error_text[UNIFIED_TEXT_MEDIUM_LEN * 2U];
    char storage_total[24];
    char storage_used[24];
    char storage_free[24];
    char sd_capacity[24];
    char sd_total[24];
    char sd_used[24];
    char sd_free[24];
    char storage_media_label[48];
    char storage_media_type[32];
    char storage_media_bus[32];
    char health_reason[UNIFIED_TEXT_MEDIUM_LEN * 2U];
    char modem_operator[UNIFIED_TEXT_SHORT_LEN * 2U];
    char modem_network_type[48];
    char modem_ip[UNIFIED_IPV4_ADDR_LEN * 2U];
    char modem_data_ip[UNIFIED_IPV4_ADDR_LEN * 2U];
    char modem_pdp_ip[UNIFIED_IPV4_ADDR_LEN * 2U];
    char modem_sms_storage_name[16];
    char modem_sms_read_storage_name[16];
    char modem_sms_write_storage_name[16];
    char modem_sms_report_storage_name[16];
    char imei[UNIFIED_TEXT_SHORT_LEN * 2U];
    char subscriber[UNIFIED_TEXT_SHORT_LEN * 2U];
    char sms_last_detail[UNIFIED_TEXT_MEDIUM_LEN * 2U];
    char sms_last_destination[UNIFIED_TEXT_SHORT_LEN * 2U];
    char reboot_reason[UNIFIED_TEXT_SHORT_LEN * 2U];
    char min_stack_task_name[DEVICE_STATUS_TASK_NAME_LEN * 2U];
} device_status_json_scratch_t;

static device_status_json_scratch_t *s_json_scratch;

static void *device_status_alloc_zeroed(size_t size) {
    void *buffer = heap_caps_calloc(1U, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);

    if (!buffer) {
        buffer = heap_caps_calloc(1U, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }

    return buffer;
}

static const char *device_status_bool_json(bool value) {
    return value ? "true" : "false";
}

static const char *device_status_reset_reason_name(esp_reset_reason_t reason) {
    switch (reason) {
        case ESP_RST_POWERON: return "power_on";
        case ESP_RST_SW: return "software";
        case ESP_RST_PANIC: return "panic";
        case ESP_RST_TASK_WDT: return "task_wdt";
        case ESP_RST_BROWNOUT: return "brownout";
        default: return "other";
    }
}

static const char *device_status_active_path_name(
    const wifi_mgr_status_t *wifi,
    const modem_a7670_status_t *modem
) {
    if (wifi && wifi->connected && wifi->ip_assigned && wifi->ip_address[0] != '\0') {
        return "wifi";
    }

    if (modem &&
        modem->data_session_open &&
        modem->ip_bearer_ready &&
        modem->data_ip_address[0] != '\0') {
        return "modem";
    }

    return "offline";
}

static void device_status_escape_json(const char *input, char *output, size_t output_len) {
    const char *cursor = input ? input : "";
    size_t write_index = 0U;

    if (!output || output_len == 0U) {
        return;
    }

    while (*cursor != '\0' && write_index + 1U < output_len) {
        unsigned char current = (unsigned char)*cursor++;

        /* Never fall through and emit an unescaped quote at the boundary. */
        if ((current == '\\' || current == '"' || current == '\n' ||
             current == '\r' || current == '\t') && write_index + 2U >= output_len) {
            break;
        }
        if (current == '\\') {
            output[write_index++] = '\\';
            output[write_index++] = '\\';
        } else if (current == '"') {
            output[write_index++] = '\\';
            output[write_index++] = '"';
        } else if (current == '\n') {
            output[write_index++] = '\\';
            output[write_index++] = 'n';
        } else if (current == '\r') {
            output[write_index++] = '\\';
            output[write_index++] = 'r';
        } else if (current == '\t') {
            output[write_index++] = '\\';
            output[write_index++] = 't';
        } else if (current >= 0x20U) {
            output[write_index++] = (char)current;
        }
    }

    output[write_index] = '\0';
}

static esp_err_t device_status_append_json(
    char *buffer,
    size_t buffer_len,
    size_t *used,
    const char *format,
    ...
) {
    va_list args;
    int written = 0;

    if (!buffer || !used || !format || *used >= buffer_len) {
        return ESP_ERR_INVALID_ARG;
    }

    va_start(args, format);
    written = vsnprintf(buffer + *used, buffer_len - *used, format, args);
    va_end(args);

    if (written < 0) {
        return ESP_FAIL;
    }
    if ((size_t)written >= (buffer_len - *used)) {
        return ESP_ERR_INVALID_SIZE;
    }

    *used += (size_t)written;
    return ESP_OK;
}

static void device_status_u64_to_dec(uint64_t value, char *output, size_t output_len) {
    char reversed[21];
    size_t count = 0U;
    size_t index = 0U;

    if (!output || output_len == 0U) {
        return;
    }

    if (value == 0U) {
        output[0] = '\0';
        if (output_len > 1U) {
            output[0] = '0';
            output[1] = '\0';
        }
        return;
    }

    while (value > 0U && count + 1U < sizeof(reversed)) {
        reversed[count++] = (char)('0' + (value % 10U));
        value /= 10U;
    }

    while (count > 0U && index + 1U < output_len) {
        output[index++] = reversed[--count];
    }

    output[index] = '\0';
}

esp_err_t device_status_init(void) {
    if (!s_json_lock) {
        s_json_lock = xSemaphoreCreateMutex();
        if (!s_json_lock) {
            return ESP_ERR_NO_MEM;
        }
    }

    if (!s_status_log_buffer) {
        s_status_log_buffer = heap_caps_calloc(
            DEVICE_STATUS_JSON_BUFFER_LEN,
            sizeof(char),
            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
        );
        if (!s_status_log_buffer) {
            s_status_log_buffer = heap_caps_calloc(
                DEVICE_STATUS_JSON_BUFFER_LEN,
                sizeof(char),
                MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT
            );
        }
        if (!s_status_log_buffer) {
            return ESP_ERR_NO_MEM;
        }
    }

    if (!s_json_scratch) {
        s_json_scratch = device_status_alloc_zeroed(sizeof(*s_json_scratch));
        if (!s_json_scratch) {
            return ESP_ERR_NO_MEM;
        }
    }

    snprintf(s_boot_id, sizeof(s_boot_id), "%s", state_mgr_boot_id());
    s_status_sequence = 0U;
    s_ready = true;
    return ESP_OK;
}

esp_err_t device_status_snapshot(device_status_snapshot_t *out_snapshot) {
    board_bsp_identity_t identity = {0};
    char device_id_override[CONFIG_MGR_DEVICE_ID_LEN] = {0};
    diagnostics_runtime_t diagnostics = {0};
    health_monitor_summary_t health = {0};
    battery_monitor_status_t battery = {0};
    config_mgr_data_t config = {0};
    modem_a7670_status_t modem = {0};
    mqtt_mgr_status_t mqtt = {0};
    sms_service_status_t sms = {0};
    state_mgr_snapshot_t state = {0};
    storage_mgr_status_t storage = {0};
    task_registry_summary_t tasks = {0};
    wifi_mgr_status_t wifi = {0};

    if (!out_snapshot || !s_ready) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(out_snapshot, 0, sizeof(*out_snapshot));

    board_bsp_get_identity(&identity);
    config_mgr_get_device_id_override(device_id_override, sizeof(device_id_override));
    diagnostics_snapshot(&diagnostics);
    task_registry_get_summary(&tasks);
    health_monitor_get_summary_with_context(&diagnostics, &tasks, &health);
    battery_monitor_get_status(&battery);
    config_mgr_snapshot(&config);
    modem_a7670_get_status(&modem);
    mqtt_mgr_get_status(&mqtt);
    sms_service_get_status(&sms);
    state_mgr_get_snapshot(&state);
    storage_mgr_get_status(&storage);
    wifi_mgr_get_status(&wifi);

    snprintf(
        out_snapshot->device_id,
        sizeof(out_snapshot->device_id),
        "%s",
        device_id_override[0] ? device_id_override : identity.device_id
    );
    snprintf(out_snapshot->boot_id, sizeof(out_snapshot->boot_id), "%s", s_boot_id);
    out_snapshot->status_sequence = __atomic_add_fetch(&s_status_sequence, 1U, __ATOMIC_RELAXED);
    snprintf(out_snapshot->hardware_uid, sizeof(out_snapshot->hardware_uid), "%s", identity.hardware_uid);
    snprintf(out_snapshot->board_name, sizeof(out_snapshot->board_name), "%s", identity.board_name);
    snprintf(out_snapshot->board_chip, sizeof(out_snapshot->board_chip), "%s", identity.chip_name);
    snprintf(out_snapshot->ota_slot, sizeof(out_snapshot->ota_slot), "%s", state.ota_slot);
    snprintf(out_snapshot->ota_state, sizeof(out_snapshot->ota_state), "%s", state.ota_state);
    snprintf(out_snapshot->ota_validation_action_id, sizeof(out_snapshot->ota_validation_action_id), "%s", mqtt.ota_validation_action_id);
    out_snapshot->ota_address = state.ota_address;
    snprintf(
        out_snapshot->active_path,
        sizeof(out_snapshot->active_path),
        "%s",
        device_status_active_path_name(&wifi, &modem)
    );
    snprintf(
        out_snapshot->connection_policy,
        sizeof(out_snapshot->connection_policy),
        "%s",
        config_mgr_connection_policy_name((config_connection_policy_t)config.connection_policy)
    );
    out_snapshot->connection_development_mode =
        config.connection_policy == CONFIG_CONNECTION_DUAL_ACTIVE_DEVELOPMENT;
    out_snapshot->wifi_policy_enabled =
        config.connection_policy != CONFIG_CONNECTION_CELLULAR_ONLY;
    out_snapshot->modem_policy_enabled =
        config.connection_policy != CONFIG_CONNECTION_WIFI_ONLY;
    out_snapshot->concurrent_links_ready =
        wifi.connected && wifi.ip_assigned && modem.data_session_open &&
        modem.ip_bearer_ready && modem.data_ip_address[0] != '\0';
    out_snapshot->static_ram_bytes = identity.static_ram_bytes;
    out_snapshot->rom_bytes = identity.rom_bytes;
    out_snapshot->flash_size_bytes = identity.flash_size_bytes;
    out_snapshot->psram_size_bytes = identity.psram_size_bytes;
    out_snapshot->psram_available = identity.psram_available;
    out_snapshot->uptime_ms = diagnostics.uptime_ms;
    out_snapshot->heap_total_bytes = diagnostics.heap_total_bytes;
    out_snapshot->heap_used_bytes = diagnostics.heap_used_bytes;
    out_snapshot->heap_free_bytes = diagnostics.heap_free_bytes;
    out_snapshot->heap_largest_free_block_bytes = diagnostics.heap_largest_free_block_bytes;
    out_snapshot->runtime_ram_total_bytes = diagnostics.runtime_ram_total_bytes;
    out_snapshot->runtime_ram_used_bytes = diagnostics.runtime_ram_used_bytes;
    out_snapshot->runtime_ram_free_bytes = diagnostics.runtime_ram_free_bytes;
    out_snapshot->runtime_ram_largest_free_block_bytes = diagnostics.runtime_ram_largest_free_block_bytes;
    out_snapshot->psram_total_bytes = diagnostics.psram_total_bytes;
    out_snapshot->psram_used_bytes = diagnostics.psram_used_bytes;
    out_snapshot->psram_free_bytes = diagnostics.psram_free_bytes;
    out_snapshot->psram_largest_free_block_bytes = diagnostics.psram_largest_free_block_bytes;
    out_snapshot->other_heap_total_bytes = diagnostics.other_heap_total_bytes;
    out_snapshot->other_heap_used_bytes = diagnostics.other_heap_used_bytes;
    out_snapshot->other_heap_free_bytes = diagnostics.other_heap_free_bytes;
    out_snapshot->free_heap_bytes = diagnostics.free_heap_bytes;
    out_snapshot->largest_free_block_bytes = diagnostics.largest_free_block_bytes;
    out_snapshot->internal_free_heap_bytes = diagnostics.internal_free_heap_bytes;
    out_snapshot->internal_largest_free_block_bytes = diagnostics.internal_largest_free_block_bytes;
    out_snapshot->free_psram_bytes = diagnostics.free_psram_bytes;
    out_snapshot->wifi_configured = wifi.configured;
    out_snapshot->wifi_profiles_revision = wifi.profiles_revision;
    out_snapshot->wifi_profiles_count = wifi.profiles_count;
    out_snapshot->wifi_started = wifi.started;
    out_snapshot->wifi_connected = wifi.connected;
    out_snapshot->wifi_ip_assigned = wifi.ip_assigned;
    out_snapshot->wifi_reconnect_suppressed = wifi.reconnect_suppressed;
    out_snapshot->wifi_last_scan_target_visible = wifi.last_scan_target_visible;
    out_snapshot->wifi_rssi = wifi.rssi;
    out_snapshot->wifi_connect_attempt_count = wifi.connect_attempt_count;
    out_snapshot->wifi_reconnect_count = wifi.reconnect_count;
    out_snapshot->wifi_last_disconnect_reason = wifi.last_disconnect_reason;
    out_snapshot->wifi_last_scan_elapsed_ms = wifi.last_scan_elapsed_ms;
    out_snapshot->wifi_last_scan_visible_count = wifi.last_scan_visible_count;
    snprintf(
        out_snapshot->wifi_last_disconnect_reason_text,
        sizeof(out_snapshot->wifi_last_disconnect_reason_text),
        "%s",
        wifi.last_disconnect_reason_text
    );
    snprintf(
        out_snapshot->wifi_last_scan_summary,
        sizeof(out_snapshot->wifi_last_scan_summary),
        "%s",
        wifi.last_scan_summary
    );
    snprintf(out_snapshot->wifi_ssid, sizeof(out_snapshot->wifi_ssid), "%s", wifi.ssid);
    snprintf(out_snapshot->wifi_ip_address, sizeof(out_snapshot->wifi_ip_address), "%s", wifi.ip_address);
    snprintf(out_snapshot->wifi_security, sizeof(out_snapshot->wifi_security), "%s", wifi.security);
    out_snapshot->mqtt_configured = mqtt.configured;
    out_snapshot->mqtt_connected = mqtt.connected;
    out_snapshot->mqtt_subscribed = mqtt.subscribed;
    snprintf(
        out_snapshot->mqtt_last_error_text,
        sizeof(out_snapshot->mqtt_last_error_text),
        "%s",
        mqtt.runtime.last_error_text
    );
    out_snapshot->mqtt_reconnect_count = mqtt.reconnect_count;
    out_snapshot->mqtt_published_count = mqtt.published_count;
    out_snapshot->mqtt_publish_failures = mqtt.publish_failures;
    out_snapshot->mqtt_command_messages = mqtt.command_messages;
    out_snapshot->mqtt_command_rejects = mqtt.command_rejects;
    out_snapshot->mqtt_action_results_published = mqtt.action_results_published;
    out_snapshot->mqtt_action_result_failures = mqtt.action_result_failures;
    /* Physical removable media is independent of the internal flash spool. */
    out_snapshot->sd_mounted = storage.sd.mounted;
    out_snapshot->sd_detected = storage.sd.detected;
    out_snapshot->sd_capacity_bytes = storage.sd.capacity_bytes;
    out_snapshot->sd_total_bytes = storage.sd.total_bytes;
    out_snapshot->sd_used_bytes = storage.sd.used_bytes;
    out_snapshot->sd_free_bytes = storage.sd.free_bytes;
    snprintf(out_snapshot->sd_error, sizeof(out_snapshot->sd_error), "%s", storage.sd.error);
    out_snapshot->storage_media_mounted = state.sd_mounted;
    out_snapshot->storage_media_available = storage.media_available;
    out_snapshot->storage_buffered_only = storage.buffered_only;
    /* Queue means pending SD flush work, not the durable history ring. */
    out_snapshot->storage_queue_depth = storage.pending_flush_count;
    out_snapshot->storage_record_count = storage.record_count;
    out_snapshot->storage_dropped_count = storage.dropped_count;
    out_snapshot->storage_persist_failures = storage.persist_failures;
    out_snapshot->storage_mount_failures = storage.mount_failures;
    out_snapshot->storage_sd_write_failures = storage.sd_write_failures;
    out_snapshot->storage_sd_flush_count = storage.sd_flush_count;
    out_snapshot->storage_total_bytes = storage.total_bytes;
    out_snapshot->storage_used_bytes = storage.used_bytes;
    out_snapshot->storage_free_bytes = storage.free_bytes;
    snprintf(out_snapshot->storage_media_label, sizeof(out_snapshot->storage_media_label), "%s", "Onboard Flash");
    snprintf(out_snapshot->storage_media_type, sizeof(out_snapshot->storage_media_type), "%s", "flash");
    snprintf(out_snapshot->storage_media_bus, sizeof(out_snapshot->storage_media_bus), "%s", "spi");
    out_snapshot->task_count = tasks.total_count;
    out_snapshot->missing_task_count = tasks.missing_count;
    out_snapshot->stack_tracked_task_count = tasks.stack_tracked_count;
    out_snapshot->low_stack_task_count = tasks.low_stack_count;
    out_snapshot->min_stack_high_water_bytes = tasks.min_stack_high_water_bytes;
    snprintf(out_snapshot->min_stack_task_name, sizeof(out_snapshot->min_stack_task_name), "%s", tasks.min_stack_task_name);
    out_snapshot->health_degraded = health.degraded;
    out_snapshot->health_module_count = health.module_count;
    out_snapshot->degraded_module_count = health.degraded_count;
    out_snapshot->failed_module_count = health.failed_count;
    out_snapshot->stub_module_count = health.stub_count;
    snprintf(
        out_snapshot->health_last_reason,
        sizeof(out_snapshot->health_last_reason),
        "%s",
        health.last_reason
    );
    out_snapshot->modem_registered = modem.network_registered;
    out_snapshot->telephony_supported = modem_a7670_telephony_supported();
    out_snapshot->telephony_enabled = state.telephony_enabled;
    out_snapshot->data_mode_enabled = state.data_mode_enabled;
    out_snapshot->modem_data_session_open = modem.data_session_open;
    out_snapshot->modem_ip_bearer_ready = modem.ip_bearer_ready;
    out_snapshot->modem_signal = (int8_t)modem.signal_quality;
    out_snapshot->battery_percent =
        (battery.present && battery.battery_percent >= 0 && battery.battery_percent <= 100)
            ? (int8_t)battery.battery_percent
            : -1;
    out_snapshot->charging_state =
        (battery.present && battery.charging_state >= 0 && battery.charging_state <= 1)
            ? (int8_t)battery.charging_state
            : -1;
    out_snapshot->voltage_mv =
        (battery.present && battery.voltage_mv > 0)
            ? battery.voltage_mv
            : -1;
    out_snapshot->temperature_c = modem.temperature_c;
    snprintf(out_snapshot->modem_operator, sizeof(out_snapshot->modem_operator), "%s", modem.operator_name);
    snprintf(out_snapshot->modem_network_type, sizeof(out_snapshot->modem_network_type), "%s", modem.network_type);
    snprintf(out_snapshot->modem_imei, sizeof(out_snapshot->modem_imei), "%s", modem.imei);
    snprintf(
        out_snapshot->modem_subscriber_number,
        sizeof(out_snapshot->modem_subscriber_number),
        "%s",
        modem.subscriber_number
    );
    snprintf(out_snapshot->modem_ip_address, sizeof(out_snapshot->modem_ip_address), "%s", modem.data_ip_address);
    snprintf(out_snapshot->modem_data_ip, sizeof(out_snapshot->modem_data_ip), "%s", modem.data_ip_address);
    snprintf(
        out_snapshot->modem_pdp_ip_address,
        sizeof(out_snapshot->modem_pdp_ip_address),
        "%s",
        modem.pdp_ip_address
    );
    snprintf(
        out_snapshot->modem_sms_storage_name,
        sizeof(out_snapshot->modem_sms_storage_name),
        "%s",
        modem.sms_storage_name
    );
    out_snapshot->modem_sms_storage_used = modem.sms_storage_used;
    out_snapshot->modem_sms_storage_total = modem.sms_storage_total;
    snprintf(
        out_snapshot->modem_sms_read_storage_name,
        sizeof(out_snapshot->modem_sms_read_storage_name),
        "%s",
        modem.sms_read_storage_name
    );
    out_snapshot->modem_sms_read_storage_used = modem.sms_read_storage_used;
    out_snapshot->modem_sms_read_storage_total = modem.sms_read_storage_total;
    snprintf(
        out_snapshot->modem_sms_write_storage_name,
        sizeof(out_snapshot->modem_sms_write_storage_name),
        "%s",
        modem.sms_write_storage_name
    );
    out_snapshot->modem_sms_write_storage_used = modem.sms_write_storage_used;
    out_snapshot->modem_sms_write_storage_total = modem.sms_write_storage_total;
    snprintf(
        out_snapshot->modem_sms_report_storage_name,
        sizeof(out_snapshot->modem_sms_report_storage_name),
        "%s",
        modem.sms_report_storage_name
    );
    out_snapshot->modem_sms_report_storage_used = modem.sms_report_storage_used;
    out_snapshot->modem_sms_report_storage_total = modem.sms_report_storage_total;
    out_snapshot->sms_ready = sms.ready;
    out_snapshot->sms_poll_count = sms.poll_count;
    out_snapshot->sms_sent_count = sms.sent_count;
    out_snapshot->sms_received_count = sms.received_count;
    out_snapshot->sms_failure_count = sms.failure_count;
    snprintf(out_snapshot->sms_last_detail, sizeof(out_snapshot->sms_last_detail), "%s", sms.last_detail);
    snprintf(out_snapshot->sms_last_destination, sizeof(out_snapshot->sms_last_destination), "%s", sms.last_destination);
    snprintf(
        out_snapshot->reboot_reason,
        sizeof(out_snapshot->reboot_reason),
        "%s",
        device_status_reset_reason_name(diagnostics.reset_reason)
    );

    return ESP_OK;
}

esp_err_t device_status_build_json_from_snapshot(
    const device_status_snapshot_t *snapshot,
    char *buffer,
    size_t buffer_len
) {
    device_status_json_scratch_t *scratch = NULL;
    bool scratch_locked = false;
    bool scratch_owned = false;
    size_t used = 0U;
    esp_err_t err = ESP_OK;

    if (!buffer || buffer_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!snapshot) {
        return ESP_ERR_INVALID_ARG;
    }
    buffer[0] = '\0';

    if (s_json_scratch && s_json_lock && xSemaphoreTake(s_json_lock, pdMS_TO_TICKS(500)) == pdTRUE) {
        scratch = s_json_scratch;
        scratch_locked = true;
        memset(scratch, 0, sizeof(*scratch));
    } else {
        scratch = device_status_alloc_zeroed(sizeof(*scratch));
        scratch_owned = true;
    }
    if (!scratch) {
        return ESP_ERR_NO_MEM;
    }

    device_status_escape_json(snapshot->device_id, scratch->device_id, sizeof(scratch->device_id));
    device_status_escape_json(snapshot->boot_id, scratch->boot_id, sizeof(scratch->boot_id));
    device_status_escape_json(snapshot->hardware_uid, scratch->hardware_uid, sizeof(scratch->hardware_uid));
    device_status_escape_json(snapshot->board_name, scratch->board_name, sizeof(scratch->board_name));
    device_status_escape_json(snapshot->board_chip, scratch->board_chip, sizeof(scratch->board_chip));
    device_status_escape_json(state_mgr_firmware_version(), scratch->firmware_version, sizeof(scratch->firmware_version));
    device_status_escape_json(snapshot->ota_slot, scratch->ota_slot, sizeof(scratch->ota_slot));
    device_status_escape_json(snapshot->ota_state, scratch->ota_state, sizeof(scratch->ota_state));
    device_status_escape_json(snapshot->ota_validation_action_id, scratch->ota_validation_action_id, sizeof(scratch->ota_validation_action_id));
    device_status_escape_json(
        snapshot->wifi_last_disconnect_reason_text,
        scratch->wifi_reason,
        sizeof(scratch->wifi_reason)
    );
    device_status_escape_json(snapshot->wifi_last_scan_summary, scratch->wifi_scan_summary, sizeof(scratch->wifi_scan_summary));
    device_status_escape_json(snapshot->wifi_ssid, scratch->wifi_ssid, sizeof(scratch->wifi_ssid));
    device_status_escape_json(snapshot->wifi_ip_address, scratch->wifi_ip, sizeof(scratch->wifi_ip));
    device_status_escape_json(snapshot->wifi_security, scratch->wifi_security, sizeof(scratch->wifi_security));
    device_status_escape_json(
        snapshot->mqtt_last_error_text,
        scratch->mqtt_last_error_text,
        sizeof(scratch->mqtt_last_error_text)
    );
    device_status_escape_json(snapshot->storage_media_label, scratch->storage_media_label, sizeof(scratch->storage_media_label));
    device_status_escape_json(snapshot->storage_media_type, scratch->storage_media_type, sizeof(scratch->storage_media_type));
    device_status_escape_json(snapshot->storage_media_bus, scratch->storage_media_bus, sizeof(scratch->storage_media_bus));
    device_status_escape_json(snapshot->health_last_reason, scratch->health_reason, sizeof(scratch->health_reason));
    device_status_escape_json(snapshot->modem_operator, scratch->modem_operator, sizeof(scratch->modem_operator));
    device_status_escape_json(snapshot->modem_network_type, scratch->modem_network_type, sizeof(scratch->modem_network_type));
    device_status_escape_json(snapshot->modem_ip_address, scratch->modem_ip, sizeof(scratch->modem_ip));
    device_status_escape_json(snapshot->modem_data_ip, scratch->modem_data_ip, sizeof(scratch->modem_data_ip));
    device_status_escape_json(snapshot->modem_pdp_ip_address, scratch->modem_pdp_ip, sizeof(scratch->modem_pdp_ip));
    device_status_escape_json(
        snapshot->modem_sms_storage_name,
        scratch->modem_sms_storage_name,
        sizeof(scratch->modem_sms_storage_name)
    );
    device_status_escape_json(
        snapshot->modem_sms_read_storage_name,
        scratch->modem_sms_read_storage_name,
        sizeof(scratch->modem_sms_read_storage_name)
    );
    device_status_escape_json(
        snapshot->modem_sms_write_storage_name,
        scratch->modem_sms_write_storage_name,
        sizeof(scratch->modem_sms_write_storage_name)
    );
    device_status_escape_json(
        snapshot->modem_sms_report_storage_name,
        scratch->modem_sms_report_storage_name,
        sizeof(scratch->modem_sms_report_storage_name)
    );
    device_status_escape_json(snapshot->modem_imei, scratch->imei, sizeof(scratch->imei));
    device_status_escape_json(snapshot->modem_subscriber_number, scratch->subscriber, sizeof(scratch->subscriber));
    device_status_escape_json(snapshot->sms_last_detail, scratch->sms_last_detail, sizeof(scratch->sms_last_detail));
    device_status_escape_json(snapshot->sms_last_destination, scratch->sms_last_destination, sizeof(scratch->sms_last_destination));
    device_status_escape_json(snapshot->reboot_reason, scratch->reboot_reason, sizeof(scratch->reboot_reason));
    device_status_escape_json(snapshot->min_stack_task_name, scratch->min_stack_task_name, sizeof(scratch->min_stack_task_name));
    device_status_u64_to_dec(snapshot->storage_total_bytes, scratch->storage_total, sizeof(scratch->storage_total));
    device_status_u64_to_dec(snapshot->storage_used_bytes, scratch->storage_used, sizeof(scratch->storage_used));
    device_status_u64_to_dec(snapshot->storage_free_bytes, scratch->storage_free, sizeof(scratch->storage_free));
    device_status_u64_to_dec(snapshot->sd_capacity_bytes, scratch->sd_capacity, sizeof(scratch->sd_capacity));
    device_status_u64_to_dec(snapshot->sd_total_bytes, scratch->sd_total, sizeof(scratch->sd_total));
    device_status_u64_to_dec(snapshot->sd_used_bytes, scratch->sd_used, sizeof(scratch->sd_used));
    device_status_u64_to_dec(snapshot->sd_free_bytes, scratch->sd_free, sizeof(scratch->sd_free));

    err = device_status_append_json(buffer, buffer_len, &used, "{");
    if (err != ESP_OK) {
        goto cleanup;
    }
    err = device_status_append_json(
        buffer,
        buffer_len,
        &used,
        "\"type\":\"device_status\",\"device_id\":\"%s\",\"boot_id\":\"%s\""
        ",\"status_sequence\":%" PRIu32 ",\"hardware_uid\":\"%s\""
        ",\"board_name\":\"%s\",\"board_chip\":\"%s\",\"firmware_version\":\"%s\""
        ",\"ota_slot\":\"%s\",\"ota_state\":\"%s\",\"ota_address\":%" PRIu32
        ",\"ota_validation_action_id\":\"%s\""
        ",\"firmware_elf_sha256\":\"%s\",\"active_path\":\"%s\""
        ",\"connection_policy\":\"%s\",\"connection_development_mode\":%s"
        ",\"wifi_policy_enabled\":%s,\"modem_policy_enabled\":%s"
        ",\"concurrent_links_ready\":%s"
        ",\"static_ram_bytes\":%" PRIu32
        ",\"rom_bytes\":%" PRIu32
        ",\"flash_size_bytes\":%" PRIu32
        ",\"psram_size_bytes\":%" PRIu32
        ",\"psram_available\":%s",
        scratch->device_id,
        scratch->boot_id,
        snapshot->status_sequence,
        scratch->hardware_uid,
        scratch->board_name,
        scratch->board_chip,
        scratch->firmware_version,
        scratch->ota_slot,
        scratch->ota_state,
        snapshot->ota_address,
        scratch->ota_validation_action_id,
        state_mgr_firmware_elf_sha256(),
        snapshot->active_path,
        snapshot->connection_policy,
        device_status_bool_json(snapshot->connection_development_mode),
        device_status_bool_json(snapshot->wifi_policy_enabled),
        device_status_bool_json(snapshot->modem_policy_enabled),
        device_status_bool_json(snapshot->concurrent_links_ready),
        snapshot->static_ram_bytes,
        snapshot->rom_bytes,
        snapshot->flash_size_bytes,
        snapshot->psram_size_bytes,
        device_status_bool_json(snapshot->psram_available)
    );
    if (err != ESP_OK) {
        goto cleanup;
    }
    err = device_status_append_json(
        buffer,
        buffer_len,
        &used,
        ",\"uptime_ms\":%" PRIu32
        ",\"heap_total_bytes\":%" PRIu32
        ",\"heap_used_bytes\":%" PRIu32
        ",\"heap_free_bytes\":%" PRIu32
        ",\"heap_largest_free_block_bytes\":%" PRIu32
        ",\"runtime_ram_total_bytes\":%" PRIu32
        ",\"runtime_ram_used_bytes\":%" PRIu32
        ",\"runtime_ram_free_bytes\":%" PRIu32
        ",\"runtime_ram_largest_free_block_bytes\":%" PRIu32
        ",\"psram_total_bytes\":%" PRIu32
        ",\"psram_used_bytes\":%" PRIu32
        ",\"psram_free_bytes\":%" PRIu32
        ",\"psram_largest_free_block_bytes\":%" PRIu32
        ",\"other_heap_total_bytes\":%" PRIu32
        ",\"other_heap_used_bytes\":%" PRIu32
        ",\"other_heap_free_bytes\":%" PRIu32
        ",\"free_heap_bytes\":%" PRIu32
        ",\"largest_free_block_bytes\":%" PRIu32
        ",\"internal_free_heap_bytes\":%" PRIu32
        ",\"internal_largest_free_block_bytes\":%" PRIu32
        ",\"free_psram_bytes\":%" PRIu32,
        snapshot->uptime_ms,
        snapshot->heap_total_bytes,
        snapshot->heap_used_bytes,
        snapshot->heap_free_bytes,
        snapshot->heap_largest_free_block_bytes,
        snapshot->runtime_ram_total_bytes,
        snapshot->runtime_ram_used_bytes,
        snapshot->runtime_ram_free_bytes,
        snapshot->runtime_ram_largest_free_block_bytes,
        snapshot->psram_total_bytes,
        snapshot->psram_used_bytes,
        snapshot->psram_free_bytes,
        snapshot->psram_largest_free_block_bytes,
        snapshot->other_heap_total_bytes,
        snapshot->other_heap_used_bytes,
        snapshot->other_heap_free_bytes,
        snapshot->free_heap_bytes,
        snapshot->largest_free_block_bytes,
        snapshot->internal_free_heap_bytes,
        snapshot->internal_largest_free_block_bytes,
        snapshot->free_psram_bytes
    );
    if (err != ESP_OK) {
        goto cleanup;
    }
    err = device_status_append_json(
        buffer,
        buffer_len,
        &used,
        ",\"wifi_configured\":%s,\"wifi_started\":%s,\"wifi_connected\":%s,\"wifi_ip_assigned\":%s"
        ",\"wifi_reconnect_suppressed\":%s"
        ",\"wifi_profiles_revision\":%" PRIu32 ",\"wifi_profiles_count\":%u"
        ",\"wifi_rssi\":%d,\"wifi_connect_attempt_count\":%" PRIu32 ",\"wifi_reconnect_count\":%" PRIu32
        ",\"wifi_last_disconnect_reason\":%" PRIu32 ",\"wifi_last_disconnect_reason_text\":\"%s\""
        ",\"wifi_last_scan_target_visible\":%s,\"wifi_last_scan_visible_count\":%" PRIu16
        ",\"wifi_last_scan_elapsed_ms\":%" PRIu32 ",\"wifi_last_scan_summary\":\"%s\""
        ",\"wifi_ssid\":\"%s\",\"wifi_ip_address\":\"%s\",\"wifi_security\":\"%s\"",
        device_status_bool_json(snapshot->wifi_configured),
        device_status_bool_json(snapshot->wifi_started),
        device_status_bool_json(snapshot->wifi_connected),
        device_status_bool_json(snapshot->wifi_ip_assigned),
        device_status_bool_json(snapshot->wifi_reconnect_suppressed),
        snapshot->wifi_profiles_revision,
        (unsigned)snapshot->wifi_profiles_count,
        (int)snapshot->wifi_rssi,
        snapshot->wifi_connect_attempt_count,
        snapshot->wifi_reconnect_count,
        snapshot->wifi_last_disconnect_reason,
        scratch->wifi_reason,
        device_status_bool_json(snapshot->wifi_last_scan_target_visible),
        snapshot->wifi_last_scan_visible_count,
        snapshot->wifi_last_scan_elapsed_ms,
        scratch->wifi_scan_summary,
        scratch->wifi_ssid,
        scratch->wifi_ip,
        scratch->wifi_security
    );
    if (err != ESP_OK) {
        goto cleanup;
    }
    err = device_status_append_json(
        buffer,
        buffer_len,
        &used,
        ",\"sd_detected\":%s,\"sd_capacity_bytes\":%s"
        ",\"sd_total_bytes\":%s,\"sd_used_bytes\":%s,\"sd_free_bytes\":%s"
        ",\"sd_error\":\"%s\",\"sd_mounted\":%s,\"storage_media_mounted\":%s"
        ",\"storage_media_available\":%s,\"storage_buffered_only\":%s"
        ",\"storage_queue_depth\":%" PRIu32 ",\"storage_record_count\":%" PRIu32
        ",\"storage_dropped_count\":%" PRIu32 ",\"storage_persist_failures\":%" PRIu32
        ",\"storage_mount_failures\":%" PRIu32 ",\"storage_sd_write_failures\":%" PRIu32
        ",\"storage_sd_flush_count\":%" PRIu32
        ",\"storage_total_bytes\":%s,\"storage_used_bytes\":%s,\"storage_free_bytes\":%s"
        ",\"storage_media_label\":\"%s\",\"storage_media_type\":\"%s\",\"storage_media_bus\":\"%s\"",
        device_status_bool_json(snapshot->sd_detected),
        scratch->sd_capacity,
        scratch->sd_total,
        scratch->sd_used,
        scratch->sd_free,
        snapshot->sd_error,
        device_status_bool_json(snapshot->sd_mounted),
        device_status_bool_json(snapshot->storage_media_mounted),
        device_status_bool_json(snapshot->storage_media_available),
        device_status_bool_json(snapshot->storage_buffered_only),
        snapshot->storage_queue_depth,
        snapshot->storage_record_count,
        snapshot->storage_dropped_count,
        snapshot->storage_persist_failures,
        snapshot->storage_mount_failures,
        snapshot->storage_sd_write_failures,
        snapshot->storage_sd_flush_count,
        scratch->storage_total,
        scratch->storage_used,
        scratch->storage_free,
        scratch->storage_media_label,
        scratch->storage_media_type,
        scratch->storage_media_bus
    );
    if (err != ESP_OK) {
        goto cleanup;
    }
    err = device_status_append_json(
        buffer,
        buffer_len,
        &used,
        ",\"mqtt_configured\":%s,\"mqtt_connected\":%s,\"mqtt_subscribed\":%s"
        ",\"mqtt_last_error_text\":\"%s\""
        ",\"mqtt_reconnect_count\":%" PRIu32 ",\"mqtt_published_count\":%" PRIu32
        ",\"mqtt_publish_failures\":%" PRIu32 ",\"mqtt_command_messages\":%" PRIu32
        ",\"mqtt_command_rejects\":%" PRIu32 ",\"mqtt_action_results_published\":%" PRIu32
        ",\"mqtt_action_result_failures\":%" PRIu32,
        device_status_bool_json(snapshot->mqtt_configured),
        device_status_bool_json(snapshot->mqtt_connected),
        device_status_bool_json(snapshot->mqtt_subscribed),
        scratch->mqtt_last_error_text,
        snapshot->mqtt_reconnect_count,
        snapshot->mqtt_published_count,
        snapshot->mqtt_publish_failures,
        snapshot->mqtt_command_messages,
        snapshot->mqtt_command_rejects,
        snapshot->mqtt_action_results_published,
        snapshot->mqtt_action_result_failures
    );
    if (err != ESP_OK) {
        goto cleanup;
    }
    err = device_status_append_json(
        buffer,
        buffer_len,
        &used,
        ",\"task_count\":%" PRIu32 ",\"missing_task_count\":%" PRIu32
        ",\"stack_tracked_task_count\":%" PRIu32
        ",\"low_stack_task_count\":%" PRIu32
        ",\"min_stack_high_water_bytes\":%" PRIu32
        ",\"min_stack_task_name\":\"%s\""
        ",\"health_degraded\":%s,\"health_module_count\":%" PRIu32
        ",\"degraded_module_count\":%" PRIu32 ",\"failed_module_count\":%" PRIu32
        ",\"stub_module_count\":%" PRIu32 ",\"health_last_reason\":\"%s\"",
        (uint32_t)snapshot->task_count,
        (uint32_t)snapshot->missing_task_count,
        (uint32_t)snapshot->stack_tracked_task_count,
        (uint32_t)snapshot->low_stack_task_count,
        snapshot->min_stack_high_water_bytes,
        scratch->min_stack_task_name,
        device_status_bool_json(snapshot->health_degraded),
        (uint32_t)snapshot->health_module_count,
        (uint32_t)snapshot->degraded_module_count,
        (uint32_t)snapshot->failed_module_count,
        (uint32_t)snapshot->stub_module_count,
        scratch->health_reason
    );
    if (err != ESP_OK) {
        goto cleanup;
    }
    err = device_status_append_json(
        buffer,
        buffer_len,
        &used,
        ",\"modem_registered\":%s,\"telephony_supported\":%s,\"telephony_enabled\":%s"
        ",\"data_mode_enabled\":%s,\"modem_data_session_open\":%s"
        ",\"modem_ip_bearer_ready\":%s,\"modem_signal\":%d"
        ",\"modem_operator\":\"%s\",\"modem_operator_name\":\"%s\",\"modem_network_type\":\"%s\",\"networkType\":\"%s\""
        ",\"modem_ip_address\":\"%s\",\"modem_data_ip\":\"%s\""
        ",\"modem_pdp_ip_address\":\"%s\""
        ",\"modem_sms_storage_name\":\"%s\",\"modem_sms_storage_used\":%" PRIu32
        ",\"modem_sms_storage_total\":%" PRIu32
        ",\"modem_sms_read_storage_name\":\"%s\",\"modem_sms_read_storage_used\":%" PRIu32
        ",\"modem_sms_read_storage_total\":%" PRIu32
        ",\"modem_sms_write_storage_name\":\"%s\",\"modem_sms_write_storage_used\":%" PRIu32
        ",\"modem_sms_write_storage_total\":%" PRIu32
        ",\"modem_sms_report_storage_name\":\"%s\",\"modem_sms_report_storage_used\":%" PRIu32
        ",\"modem_sms_report_storage_total\":%" PRIu32,
        device_status_bool_json(snapshot->modem_registered),
        device_status_bool_json(snapshot->telephony_supported),
        device_status_bool_json(snapshot->telephony_enabled),
        device_status_bool_json(snapshot->data_mode_enabled),
        device_status_bool_json(snapshot->modem_data_session_open),
        device_status_bool_json(snapshot->modem_ip_bearer_ready),
        (int)snapshot->modem_signal,
        scratch->modem_operator,
        scratch->modem_operator,
        scratch->modem_network_type,
        scratch->modem_network_type,
        scratch->modem_ip,
        scratch->modem_data_ip,
        scratch->modem_pdp_ip,
        scratch->modem_sms_storage_name,
        (uint32_t)snapshot->modem_sms_storage_used,
        (uint32_t)snapshot->modem_sms_storage_total,
        scratch->modem_sms_read_storage_name,
        (uint32_t)snapshot->modem_sms_read_storage_used,
        (uint32_t)snapshot->modem_sms_read_storage_total,
        scratch->modem_sms_write_storage_name,
        (uint32_t)snapshot->modem_sms_write_storage_used,
        (uint32_t)snapshot->modem_sms_write_storage_total,
        scratch->modem_sms_report_storage_name,
        (uint32_t)snapshot->modem_sms_report_storage_used,
        (uint32_t)snapshot->modem_sms_report_storage_total
    );
    if (err != ESP_OK) {
        goto cleanup;
    }
    err = device_status_append_json(
        buffer,
        buffer_len,
        &used,
        ",\"sms_ready\":%s,\"sms_poll_count\":%" PRIu32
        ",\"sms_sent_count\":%" PRIu32 ",\"sms_received_count\":%" PRIu32
        ",\"sms_failure_count\":%" PRIu32 ",\"sms_last_detail\":\"%s\"",
        device_status_bool_json(snapshot->sms_ready),
        snapshot->sms_poll_count,
        snapshot->sms_sent_count,
        snapshot->sms_received_count,
        snapshot->sms_failure_count,
        scratch->sms_last_detail
    );
    if (err != ESP_OK) {
        goto cleanup;
    }

    if (snapshot->modem_imei[0] != '\0') {
        err = device_status_append_json(buffer, buffer_len, &used, ",\"imei\":\"%s\"", scratch->imei);
        if (err != ESP_OK) {
            goto cleanup;
        }
    }
    if (snapshot->modem_subscriber_number[0] != '\0') {
        err = device_status_append_json(buffer, buffer_len, &used, ",\"modem_subscriber_number\":\"%s\"", scratch->subscriber);
        if (err != ESP_OK) {
            goto cleanup;
        }
    }
    if (snapshot->battery_percent >= 0 && snapshot->battery_percent <= 100) {
        err = device_status_append_json(buffer, buffer_len, &used, ",\"battery\":%d", (int)snapshot->battery_percent);
        if (err != ESP_OK) {
            goto cleanup;
        }
    }
    if (snapshot->charging_state == 0 || snapshot->charging_state == 1) {
        err = device_status_append_json(
            buffer,
            buffer_len,
            &used,
            ",\"charging\":%s",
            device_status_bool_json(snapshot->charging_state == 1)
        );
        if (err != ESP_OK) {
            goto cleanup;
        }
    }
    if (snapshot->sms_last_destination[0] != '\0') {
        err = device_status_append_json(buffer, buffer_len, &used, ",\"sms_last_destination\":\"%s\"", scratch->sms_last_destination);
        if (err != ESP_OK) {
            goto cleanup;
        }
    }
    /* The main firmware publishes gauge-backed battery voltage here. Only
     * surface values that look like a plausible single-cell Li-ion reading. */
    if (snapshot->voltage_mv >= 3000 && snapshot->voltage_mv <= 5000) {
        err = device_status_append_json(buffer, buffer_len, &used, ",\"voltage_mV\":%" PRId32, snapshot->voltage_mv);
        if (err != ESP_OK) {
            goto cleanup;
        }
    }
    if (snapshot->temperature_c > -100 && snapshot->temperature_c < 200) {
        err = device_status_append_json(buffer, buffer_len, &used, ",\"temperature\":%" PRId32, snapshot->temperature_c);
        if (err != ESP_OK) {
            goto cleanup;
        }
    }
    if (snapshot->reboot_reason[0] != '\0') {
        err = device_status_append_json(buffer, buffer_len, &used, ",\"reboot_reason\":\"%s\"", scratch->reboot_reason);
        if (err != ESP_OK) {
            goto cleanup;
        }
    }

    err = device_status_append_json(buffer, buffer_len, &used, "}");
    if (err != ESP_OK) {
        goto cleanup;
    }

cleanup:
    if (err != ESP_OK && buffer && buffer_len > 0U) {
        buffer[0] = '\0'; /* A truncated document is never a status snapshot. */
    }
    if (scratch_locked) {
        xSemaphoreGive(s_json_lock);
    } else if (scratch_owned) {
        heap_caps_free(scratch);
    }
    return err;
}

esp_err_t device_status_build_json(char *buffer, size_t buffer_len) {
    device_status_snapshot_t snapshot;
    esp_err_t err = device_status_snapshot(&snapshot);

    if (err != ESP_OK) {
        return err;
    }

    return device_status_build_json_from_snapshot(&snapshot, buffer, buffer_len);
}

void device_status_log_json(void) {
    if (!s_status_log_buffer) {
        printf("STATUS_JSON unavailable\r\n");
        return;
    }

    s_status_log_buffer[0] = '\0';
    if (device_status_build_json(s_status_log_buffer, DEVICE_STATUS_JSON_BUFFER_LEN) != ESP_OK) {
        return;
    }

    printf("STATUS_JSON %s\r\n", s_status_log_buffer);
}
