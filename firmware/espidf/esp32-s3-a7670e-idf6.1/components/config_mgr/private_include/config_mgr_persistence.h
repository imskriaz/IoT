#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "config_mgr.h"

#define CONFIG_MGR_RUNTIME_SCHEMA_VERSION 3U
#define CONFIG_MGR_ROLLBACK_SCHEMA_VERSION 2U

/*
 * Persistent runtime credentials intentionally retain the schema-2 layout.
 * The previous production image can therefore boot after an OTA rollback.
 * Fields introduced by schema 3 and later belong in separate NVS keys.
 */
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
} config_mgr_v2_data_t;

_Static_assert(sizeof(config_mgr_v2_data_t) == 536U,
               "rollback config layout changed; this would break production rollback");
_Static_assert(sizeof(config_mgr_data_t) == 540U,
               "runtime config layout changed; update migration explicitly");

void config_mgr_project_rollback_v2(
    const config_mgr_data_t *runtime,
    config_mgr_v2_data_t *persisted
);

void config_mgr_expand_rollback_v2(
    const config_mgr_v2_data_t *persisted,
    config_connection_policy_t policy,
    config_mgr_data_t *runtime
);
