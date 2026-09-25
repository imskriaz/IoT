#include <string.h>

#include "config_mgr_persistence.h"

void config_mgr_project_rollback_v2(
    const config_mgr_data_t *runtime,
    config_mgr_v2_data_t *persisted
) {
    if (!runtime || !persisted) {
        return;
    }

    memset(persisted, 0, sizeof(*persisted));
    persisted->schema_version = CONFIG_MGR_ROLLBACK_SCHEMA_VERSION;
    persisted->wifi_primary = runtime->wifi_primary;
    persisted->modem_fallback_enabled = runtime->modem_fallback_enabled;
    persisted->mqtt_enabled = runtime->mqtt_enabled;
    persisted->storage_enabled = runtime->storage_enabled;
    persisted->health_heartbeat_interval_ms = runtime->health_heartbeat_interval_ms;
    persisted->health_timeout_ms = runtime->health_timeout_ms;
    persisted->device_status_interval_ms = runtime->device_status_interval_ms;
    memcpy(persisted->device_id_override, runtime->device_id_override,
           sizeof(persisted->device_id_override));
    memcpy(persisted->mqtt_topic_prefix, runtime->mqtt_topic_prefix,
           sizeof(persisted->mqtt_topic_prefix));
    memcpy(persisted->wifi_ssid, runtime->wifi_ssid, sizeof(persisted->wifi_ssid));
    memcpy(persisted->wifi_password, runtime->wifi_password, sizeof(persisted->wifi_password));
    memcpy(persisted->mqtt_uri, runtime->mqtt_uri, sizeof(persisted->mqtt_uri));
    memcpy(persisted->mqtt_username, runtime->mqtt_username, sizeof(persisted->mqtt_username));
    memcpy(persisted->mqtt_password, runtime->mqtt_password, sizeof(persisted->mqtt_password));
    memcpy(persisted->modem_apn, runtime->modem_apn, sizeof(persisted->modem_apn));
}

void config_mgr_expand_rollback_v2(
    const config_mgr_v2_data_t *persisted,
    config_connection_policy_t policy,
    config_mgr_data_t *runtime
) {
    if (!persisted || !runtime) {
        return;
    }

    memset(runtime, 0, sizeof(*runtime));
    runtime->schema_version = CONFIG_MGR_RUNTIME_SCHEMA_VERSION;
    runtime->wifi_primary = persisted->wifi_primary;
    runtime->modem_fallback_enabled = persisted->modem_fallback_enabled;
    runtime->mqtt_enabled = persisted->mqtt_enabled;
    runtime->storage_enabled = persisted->storage_enabled;
    runtime->health_heartbeat_interval_ms = persisted->health_heartbeat_interval_ms;
    runtime->health_timeout_ms = persisted->health_timeout_ms;
    runtime->device_status_interval_ms = persisted->device_status_interval_ms;
    memcpy(runtime->device_id_override, persisted->device_id_override,
           sizeof(runtime->device_id_override));
    memcpy(runtime->mqtt_topic_prefix, persisted->mqtt_topic_prefix,
           sizeof(runtime->mqtt_topic_prefix));
    memcpy(runtime->wifi_ssid, persisted->wifi_ssid, sizeof(runtime->wifi_ssid));
    memcpy(runtime->wifi_password, persisted->wifi_password, sizeof(runtime->wifi_password));
    memcpy(runtime->mqtt_uri, persisted->mqtt_uri, sizeof(runtime->mqtt_uri));
    memcpy(runtime->mqtt_username, persisted->mqtt_username, sizeof(runtime->mqtt_username));
    memcpy(runtime->mqtt_password, persisted->mqtt_password, sizeof(runtime->mqtt_password));
    memcpy(runtime->modem_apn, persisted->modem_apn, sizeof(runtime->modem_apn));
    runtime->connection_policy = (uint32_t)policy;
}
