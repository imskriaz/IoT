#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#include "common_models.h"

#define DEVICE_STATUS_TASK_NAME_LEN 24U

typedef struct {
    char device_id[UNIFIED_DEVICE_ID_LEN];
    char hardware_uid[24];
    char active_path[8];
    uint32_t uptime_ms;
    uint32_t free_heap_bytes;
    uint32_t largest_free_block_bytes;
    uint32_t internal_free_heap_bytes;
    uint32_t internal_largest_free_block_bytes;
    uint32_t free_psram_bytes;
    bool wifi_configured;
    bool wifi_started;
    bool wifi_connected;
    bool wifi_ip_assigned;
    bool wifi_reconnect_suppressed;
    bool wifi_last_scan_target_visible;
    int8_t wifi_rssi;
    uint32_t wifi_connect_attempt_count;
    uint32_t wifi_reconnect_count;
    uint32_t wifi_last_disconnect_reason;
    uint32_t wifi_last_scan_elapsed_ms;
    uint16_t wifi_last_scan_visible_count;
    char wifi_last_disconnect_reason_text[UNIFIED_TEXT_MEDIUM_LEN];
    char wifi_last_scan_summary[UNIFIED_TEXT_LONG_LEN];
    char wifi_ssid[UNIFIED_WIFI_SSID_LEN];
    char wifi_ip_address[UNIFIED_IPV4_ADDR_LEN];
    char wifi_security[24];
    bool mqtt_configured;
    bool mqtt_connected;
    bool mqtt_subscribed;
    uint32_t mqtt_reconnect_count;
    uint32_t mqtt_published_count;
    uint32_t mqtt_publish_failures;
    uint32_t mqtt_command_messages;
    uint32_t mqtt_command_rejects;
    uint32_t mqtt_action_results_published;
    uint32_t mqtt_action_result_failures;
    bool sd_mounted;
    bool storage_media_mounted;
    bool storage_media_available;
    bool storage_buffered_only;
    uint32_t storage_queue_depth;
    uint32_t storage_dropped_count;
    uint32_t storage_mount_failures;
    uint32_t storage_sd_write_failures;
    uint32_t storage_sd_flush_count;
    uint64_t storage_total_bytes;
    uint64_t storage_used_bytes;
    uint64_t storage_free_bytes;
    char storage_media_label[24];
    char storage_media_type[16];
    char storage_media_bus[16];
    size_t task_count;
    size_t missing_task_count;
    size_t stack_tracked_task_count;
    size_t low_stack_task_count;
    uint32_t min_stack_high_water_bytes;
    char min_stack_task_name[DEVICE_STATUS_TASK_NAME_LEN];
    bool health_degraded;
    size_t health_module_count;
    size_t degraded_module_count;
    size_t failed_module_count;
    size_t stub_module_count;
    char health_last_reason[UNIFIED_TEXT_MEDIUM_LEN];
    bool modem_registered;
    bool telephony_supported;
    bool telephony_enabled;
    bool data_mode_enabled;
    bool modem_ip_bearer_ready;
    int8_t modem_signal;
    int8_t battery_percent;
    int8_t charging_state;
    int32_t voltage_mv;
    int32_t temperature_c;
    char modem_operator[UNIFIED_TEXT_SHORT_LEN];
    char modem_network_type[24];
    char modem_imei[UNIFIED_TEXT_SHORT_LEN];
    char modem_subscriber_number[UNIFIED_TEXT_SHORT_LEN];
    char modem_ip_address[UNIFIED_IPV4_ADDR_LEN];
    char modem_data_ip[UNIFIED_IPV4_ADDR_LEN];
    bool sms_ready;
    uint32_t sms_poll_count;
    uint32_t sms_sent_count;
    uint32_t sms_received_count;
    uint32_t sms_failure_count;
    char sms_last_detail[UNIFIED_TEXT_MEDIUM_LEN];
    char sms_last_destination[UNIFIED_TEXT_SHORT_LEN];
    char reboot_reason[UNIFIED_TEXT_SHORT_LEN];
} device_status_snapshot_t;

esp_err_t device_status_init(void);
esp_err_t device_status_snapshot(device_status_snapshot_t *out_snapshot);
esp_err_t device_status_build_json_from_snapshot(
    const device_status_snapshot_t *snapshot,
    char *buffer,
    size_t buffer_len
);
esp_err_t device_status_build_json(char *buffer, size_t buffer_len);
void device_status_log_json(void);
