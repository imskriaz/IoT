#include <assert.h>
#include <stdint.h>
#include <string.h>

#include "config_mgr_persistence.h"

static void fill_runtime(config_mgr_data_t *config) {
    memset(config, 0, sizeof(*config));
    config->schema_version = CONFIG_MGR_RUNTIME_SCHEMA_VERSION;
    config->wifi_primary = true;
    config->modem_fallback_enabled = true;
    config->mqtt_enabled = true;
    config->storage_enabled = true;
    config->health_heartbeat_interval_ms = 5000U;
    config->health_timeout_ms = 15000U;
    config->device_status_interval_ms = 10000U;
    strcpy_s(config->device_id_override, sizeof(config->device_id_override), "esp32-test");
    strcpy_s(config->mqtt_topic_prefix, sizeof(config->mqtt_topic_prefix), "device");
    strcpy_s(config->wifi_ssid, sizeof(config->wifi_ssid), "Riaz");
    strcpy_s(config->wifi_password, sizeof(config->wifi_password), "password123");
    strcpy_s(config->mqtt_uri, sizeof(config->mqtt_uri), "mqtt://192.168.0.105:1883");
    strcpy_s(config->mqtt_username, sizeof(config->mqtt_username), "user");
    strcpy_s(config->mqtt_password, sizeof(config->mqtt_password), "secret");
    strcpy_s(config->modem_apn, sizeof(config->modem_apn), "internet");
    config->connection_policy = CONFIG_CONNECTION_DUAL_ACTIVE_DEVELOPMENT;
}

int main(void) {
    config_mgr_data_t source = {0};
    config_mgr_data_t expanded = {0};
    config_mgr_v2_data_t persisted = {0};

    fill_runtime(&source);
    config_mgr_project_rollback_v2(&source, &persisted);
    assert(sizeof(persisted) == 536U);
    assert(persisted.schema_version == CONFIG_MGR_ROLLBACK_SCHEMA_VERSION);
    assert(strcmp(persisted.wifi_ssid, source.wifi_ssid) == 0);
    assert(strcmp(persisted.mqtt_uri, source.mqtt_uri) == 0);

    config_mgr_expand_rollback_v2(
        &persisted,
        CONFIG_CONNECTION_CELLULAR_WIFI_FALLBACK,
        &expanded
    );
    assert(expanded.schema_version == CONFIG_MGR_RUNTIME_SCHEMA_VERSION);
    assert(expanded.connection_policy == CONFIG_CONNECTION_CELLULAR_WIFI_FALLBACK);
    assert(strcmp(expanded.wifi_password, source.wifi_password) == 0);
    assert(strcmp(expanded.mqtt_password, source.mqtt_password) == 0);

    /* The policy is intentionally supplied out-of-band during expansion. */
    assert(expanded.connection_policy != source.connection_policy);
    return 0;
}
