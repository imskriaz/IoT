#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define CONFIG_MGR_DEVICE_ID_LEN  32
#define CONFIG_MGR_WIFI_SSID_LEN  33
#define CONFIG_MGR_WIFI_PASS_LEN  65
#define CONFIG_MGR_APN_LEN        64
#define CONFIG_MGR_MQTT_URI_LEN   128
#define CONFIG_MGR_MQTT_AUTH_LEN  64
#define CONFIG_MGR_TOPIC_PREFIX   64

typedef struct {
    uint32_t schema_version;
    bool wifi_primary;
    bool modem_fallback_enabled;
    bool mqtt_enabled;
    bool storage_enabled;
    uint32_t health_heartbeat_interval_ms;
    uint32_t health_timeout_ms;
    uint32_t device_status_interval_ms;
    char device_id_override[CONFIG_MGR_DEVICE_ID_LEN];
    char mqtt_topic_prefix[CONFIG_MGR_TOPIC_PREFIX];
    char wifi_ssid[CONFIG_MGR_WIFI_SSID_LEN];
    char wifi_password[CONFIG_MGR_WIFI_PASS_LEN];
    char mqtt_uri[CONFIG_MGR_MQTT_URI_LEN];
    char mqtt_username[CONFIG_MGR_MQTT_AUTH_LEN];
    char mqtt_password[CONFIG_MGR_MQTT_AUTH_LEN];
    char modem_apn[CONFIG_MGR_APN_LEN];
} config_mgr_data_t;

esp_err_t config_mgr_init(void);
void config_mgr_snapshot(config_mgr_data_t *out_config);
esp_err_t config_mgr_validate(const config_mgr_data_t *config);
esp_err_t config_mgr_store(const config_mgr_data_t *config);
void config_mgr_get_device_id_override(char *out_value, size_t out_len);
void config_mgr_get_mqtt_topic_prefix(char *out_value, size_t out_len);
void config_mgr_get_modem_apn(char *out_value, size_t out_len);
esp_err_t config_mgr_apply_key_value(
    const char *key,
    const char *value,
    bool *out_restart_required,
    bool *out_sensitive
);
uint32_t config_mgr_device_status_interval_ms(void);
bool config_mgr_modem_fallback_enabled(void);
bool config_mgr_storage_enabled(void);
uint32_t config_mgr_schema_version(void);
uint32_t config_mgr_revision(void);
