#include "config_mgr.h"

#include <ctype.h>
#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "esp_log.h"
#include "nvs.h"

#define CONFIG_NAMESPACE "unified_cfg"
#define CONFIG_KEY       "runtime"
#define CONFIG_VERSION   2U

static const char *TAG = "config_mgr";

typedef struct {
    uint32_t schema_version;
    bool wifi_primary;
    bool modem_fallback_enabled;
    bool mqtt_enabled;
    bool storage_enabled;
    bool gpio_enabled;
    bool sensors_enabled;
    bool voip_enabled;
    bool camera_stub_enabled;
    bool nfc_stub_enabled;
    bool display_stub_enabled;
    bool ui_enabled;
    bool touch_enabled;
    bool provisional_touch_backend_enabled;
    bool camera_installed;
    bool nfc_installed;
    bool display_installed;
    uint32_t health_heartbeat_interval_ms;
    uint32_t health_timeout_ms;
    uint32_t device_status_interval_ms;
    uint32_t sync_heartbeat_interval_ms;
    uint32_t dashboard_ack_timeout_ms;
    char device_id_override[CONFIG_MGR_DEVICE_ID_LEN];
    char mqtt_topic_prefix[64];
    char wifi_ssid[CONFIG_MGR_WIFI_SSID_LEN];
    char wifi_password[CONFIG_MGR_WIFI_PASS_LEN];
    char mqtt_uri[128];
    char mqtt_username[64];
    char mqtt_password[64];
    char modem_apn[CONFIG_MGR_APN_LEN];
} legacy_config_mgr_data_t;

typedef struct {
    uint32_t schema_version;
    bool storage_enabled;
    uint32_t health_heartbeat_interval_ms;
    uint32_t health_timeout_ms;
    char device_id_override[CONFIG_MGR_DEVICE_ID_LEN];
    char wifi_ssid[CONFIG_MGR_WIFI_SSID_LEN];
    char wifi_password[CONFIG_MGR_WIFI_PASS_LEN];
    char modem_apn[CONFIG_MGR_APN_LEN];
} minimal_v1_config_mgr_data_t;

static SemaphoreHandle_t s_lock;
static config_mgr_data_t s_config;
static uint32_t s_revision;
static bool s_ready;

esp_err_t config_mgr_validate(const config_mgr_data_t *config);

static bool config_mgr_copy_string_value(const char *value, char *dest, size_t dest_len) {
    size_t value_len = 0;

    if (!value || !dest || dest_len == 0U) {
        return false;
    }

    value_len = strlen(value);
    if (value_len >= dest_len) {
        return false;
    }

    memcpy(dest, value, value_len + 1U);
    return true;
}

static bool config_mgr_parse_bool_value(const char *value, bool *out_value) {
    char lowered[8] = {0};
    size_t index = 0;

    if (!value || !out_value) {
        return false;
    }

    for (index = 0; value[index] != '\0' && index + 1U < sizeof(lowered); ++index) {
        lowered[index] = (char)tolower((unsigned char)value[index]);
    }
    lowered[index] = '\0';

    if (strcmp(lowered, "1") == 0 || strcmp(lowered, "true") == 0 || strcmp(lowered, "yes") == 0 || strcmp(lowered, "on") == 0) {
        *out_value = true;
        return true;
    }
    if (strcmp(lowered, "0") == 0 || strcmp(lowered, "false") == 0 || strcmp(lowered, "no") == 0 || strcmp(lowered, "off") == 0) {
        *out_value = false;
        return true;
    }

    return false;
}

static bool config_mgr_parse_u32_value(const char *value, uint32_t *out_value) {
    char *end = NULL;
    unsigned long parsed = 0;

    if (!value || !out_value || value[0] == '\0') {
        return false;
    }
    if (value[0] < '0' || value[0] > '9') {
        return false;
    }

    errno = 0;
    parsed = strtoul(value, &end, 10);
    if (errno == ERANGE || parsed > UINT32_MAX || !end || *end != '\0') {
        return false;
    }

    *out_value = (uint32_t)parsed;
    return true;
}

static bool config_mgr_copy_legacy_string(
    const char *value,
    size_t value_len,
    char *dest,
    size_t dest_len
) {
    size_t copy_len = 0U;

    if (!value || !dest || dest_len == 0U) {
        return false;
    }

    copy_len = strnlen(value, value_len);
    if (copy_len >= dest_len) {
        return false;
    }

    memcpy(dest, value, copy_len);
    dest[copy_len] = '\0';
    return true;
}

static void reset_defaults(config_mgr_data_t *config) {
    memset(config, 0, sizeof(*config));
    config->schema_version = CONFIG_VERSION;
    config->wifi_primary = true;
    config->modem_fallback_enabled = true;
    config->mqtt_enabled = true;
    config->storage_enabled = true;
    config->health_heartbeat_interval_ms = CONFIG_UNIFIED_HEALTH_INTERVAL_MS;
    config->health_timeout_ms = 15000;
    config->device_status_interval_ms = CONFIG_UNIFIED_DEVICE_STATUS_INTERVAL_MS;
    snprintf(config->mqtt_topic_prefix, sizeof(config->mqtt_topic_prefix), "%s", "device");
    config->wifi_ssid[0] = '\0';
    config->wifi_password[0] = '\0';
    config->mqtt_uri[0] = '\0';
    config->mqtt_username[0] = '\0';
    config->mqtt_password[0] = '\0';
    /* Default APN is empty — carrier auto-detect works on most networks. Override per carrier. */
    config->modem_apn[0] = '\0';
}

static void config_mgr_migrate_legacy_config(
    const legacy_config_mgr_data_t *legacy,
    config_mgr_data_t *config
) {
    if (!legacy || !config) {
        return;
    }

    reset_defaults(config);
    config->storage_enabled = legacy->storage_enabled;
    config->wifi_primary = legacy->wifi_primary;
    config->modem_fallback_enabled = legacy->modem_fallback_enabled;
    config->mqtt_enabled = legacy->mqtt_enabled;
    config->health_heartbeat_interval_ms = legacy->health_heartbeat_interval_ms;
    config->health_timeout_ms = legacy->health_timeout_ms;
    config->device_status_interval_ms = legacy->device_status_interval_ms;

    (void)config_mgr_copy_legacy_string(
        legacy->device_id_override,
        sizeof(legacy->device_id_override),
        config->device_id_override,
        sizeof(config->device_id_override)
    );
    (void)config_mgr_copy_legacy_string(
        legacy->wifi_ssid,
        sizeof(legacy->wifi_ssid),
        config->wifi_ssid,
        sizeof(config->wifi_ssid)
    );
    (void)config_mgr_copy_legacy_string(
        legacy->wifi_password,
        sizeof(legacy->wifi_password),
        config->wifi_password,
        sizeof(config->wifi_password)
    );
    (void)config_mgr_copy_legacy_string(
        legacy->mqtt_topic_prefix,
        sizeof(legacy->mqtt_topic_prefix),
        config->mqtt_topic_prefix,
        sizeof(config->mqtt_topic_prefix)
    );
    (void)config_mgr_copy_legacy_string(
        legacy->mqtt_uri,
        sizeof(legacy->mqtt_uri),
        config->mqtt_uri,
        sizeof(config->mqtt_uri)
    );
    (void)config_mgr_copy_legacy_string(
        legacy->mqtt_username,
        sizeof(legacy->mqtt_username),
        config->mqtt_username,
        sizeof(config->mqtt_username)
    );
    (void)config_mgr_copy_legacy_string(
        legacy->mqtt_password,
        sizeof(legacy->mqtt_password),
        config->mqtt_password,
        sizeof(config->mqtt_password)
    );
    (void)config_mgr_copy_legacy_string(
        legacy->modem_apn,
        sizeof(legacy->modem_apn),
        config->modem_apn,
        sizeof(config->modem_apn)
    );

    if (config_mgr_validate(config) != ESP_OK) {
        ESP_LOGW(TAG, "legacy config migration invalid, using defaults");
        reset_defaults(config);
    }
}

static void config_mgr_migrate_minimal_v1_config(
    const minimal_v1_config_mgr_data_t *legacy,
    config_mgr_data_t *config
) {
    if (!legacy || !config) {
        return;
    }

    reset_defaults(config);
    config->storage_enabled = legacy->storage_enabled;
    config->health_heartbeat_interval_ms = legacy->health_heartbeat_interval_ms;
    config->health_timeout_ms = legacy->health_timeout_ms;
    (void)config_mgr_copy_legacy_string(legacy->device_id_override, sizeof(legacy->device_id_override), config->device_id_override, sizeof(config->device_id_override));
    (void)config_mgr_copy_legacy_string(legacy->wifi_ssid, sizeof(legacy->wifi_ssid), config->wifi_ssid, sizeof(config->wifi_ssid));
    (void)config_mgr_copy_legacy_string(legacy->wifi_password, sizeof(legacy->wifi_password), config->wifi_password, sizeof(config->wifi_password));
    (void)config_mgr_copy_legacy_string(legacy->modem_apn, sizeof(legacy->modem_apn), config->modem_apn, sizeof(config->modem_apn));

    if (config_mgr_validate(config) != ESP_OK) {
        ESP_LOGW(TAG, "minimal v1 config migration invalid, using defaults");
        reset_defaults(config);
    }
}

esp_err_t config_mgr_validate(const config_mgr_data_t *config) {
    if (!config) {
        return ESP_ERR_INVALID_ARG;
    }
    if (config->schema_version != CONFIG_VERSION) {
        return ESP_ERR_INVALID_VERSION;
    }
    /* Lower and upper bounds to prevent disabling health monitoring or excessive intervals. */
    if (config->health_heartbeat_interval_ms < 1000 || config->health_heartbeat_interval_ms > 300000) {
        return ESP_ERR_INVALID_ARG;
    }
    if (config->health_timeout_ms < config->health_heartbeat_interval_ms ||
        config->health_timeout_ms > 600000) {
        return ESP_ERR_INVALID_ARG;
    }
    if (config->device_status_interval_ms < 1000 || config->device_status_interval_ms > 300000) {
        return ESP_ERR_INVALID_ARG;
    }
    if (config->device_id_override[sizeof(config->device_id_override) - 1U] != '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    if (config->wifi_ssid[sizeof(config->wifi_ssid) - 1U] != '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    if (config->wifi_password[sizeof(config->wifi_password) - 1U] != '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    if (config->mqtt_topic_prefix[sizeof(config->mqtt_topic_prefix) - 1U] != '\0' ||
        config->mqtt_uri[sizeof(config->mqtt_uri) - 1U] != '\0' ||
        config->mqtt_username[sizeof(config->mqtt_username) - 1U] != '\0' ||
        config->mqtt_password[sizeof(config->mqtt_password) - 1U] != '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    if (config->wifi_password[0] != '\0') {
        size_t password_len = strnlen(config->wifi_password, sizeof(config->wifi_password));

        if (password_len < 8U || password_len > 64U) {
            return ESP_ERR_INVALID_ARG;
        }
    }
    if (config->modem_apn[sizeof(config->modem_apn) - 1U] != '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    return ESP_OK;
}

esp_err_t config_mgr_init(void) {
    nvs_handle_t handle = 0;
    size_t stored_size = 0U;
    esp_err_t err = ESP_OK;
    config_mgr_data_t loaded = {0};
    legacy_config_mgr_data_t legacy = {0};
    minimal_v1_config_mgr_data_t minimal_v1 = {0};

    if (s_ready) {
        return ESP_OK;
    }

    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) {
        return ESP_ERR_NO_MEM;
    }

    reset_defaults(&s_config);
    s_revision = 1U;
    err = nvs_open(CONFIG_NAMESPACE, NVS_READONLY, &handle);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        s_ready = true;
        return ESP_OK;
    }
    if (err != ESP_OK) {
        return err;
    }

    err = nvs_get_blob(handle, CONFIG_KEY, NULL, &stored_size);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(handle);
        s_ready = true;
        return ESP_OK;
    }
    if (err != ESP_OK) {
        nvs_close(handle);
        return err;
    }

    if (stored_size == sizeof(loaded)) {
        size_t actual_size = stored_size;
        err = nvs_get_blob(handle, CONFIG_KEY, &loaded, &actual_size);
        nvs_close(handle);
        if (err != ESP_OK) {
            return err;
        }

        if (config_mgr_validate(&loaded) != ESP_OK) {
            ESP_LOGW(TAG, "stored config invalid, using defaults");
            s_ready = true;
            return ESP_OK;
        }

        s_config = loaded;
        s_ready = true;
        return ESP_OK;
    }

    if (stored_size == sizeof(legacy)) {
        size_t actual_size = stored_size;
        err = nvs_get_blob(handle, CONFIG_KEY, &legacy, &actual_size);
        nvs_close(handle);
        if (err != ESP_OK) {
            return err;
        }

        ESP_LOGW(TAG, "migrating legacy config blob (%u bytes -> %u bytes)",
                 (unsigned)stored_size, (unsigned)sizeof(s_config));
        config_mgr_migrate_legacy_config(&legacy, &s_config);
        s_ready = true;
        (void)config_mgr_store(&s_config);
        return ESP_OK;
    }

    if (stored_size == sizeof(minimal_v1)) {
        size_t actual_size = stored_size;
        err = nvs_get_blob(handle, CONFIG_KEY, &minimal_v1, &actual_size);
        nvs_close(handle);
        if (err != ESP_OK) {
            return err;
        }

        ESP_LOGW(TAG, "migrating minimal v1 config blob (%u bytes -> %u bytes)",
                 (unsigned)stored_size, (unsigned)sizeof(s_config));
        config_mgr_migrate_minimal_v1_config(&minimal_v1, &s_config);
        s_ready = true;
        (void)config_mgr_store(&s_config);
        return ESP_OK;
    }

    nvs_close(handle);
    ESP_LOGW(TAG, "stored config size %u incompatible with main lane, using defaults",
             (unsigned)stored_size);
    s_ready = true;
    if (config_mgr_store(&s_config) != ESP_OK) {
        ESP_LOGW(TAG, "failed to persist repaired default config");
    }
    return ESP_OK;
}

void config_mgr_snapshot(config_mgr_data_t *out_config) {
    if (!out_config) {
        return;
    }

    memset(out_config, 0, sizeof(*out_config));
    if (!s_ready || !s_lock) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    *out_config = s_config;
    xSemaphoreGive(s_lock);
}

void config_mgr_get_device_id_override(char *out_value, size_t out_len) {
    if (!out_value || out_len == 0U) {
        return;
    }

    out_value[0] = '\0';
    if (!s_ready || !s_lock) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    snprintf(out_value, out_len, "%s", s_config.device_id_override);
    xSemaphoreGive(s_lock);
}

void config_mgr_get_mqtt_topic_prefix(char *out_value, size_t out_len) {
    if (!out_value || out_len == 0U) {
        return;
    }

    out_value[0] = '\0';
    if (!s_ready || !s_lock) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    snprintf(out_value, out_len, "%s", s_config.mqtt_topic_prefix);
    xSemaphoreGive(s_lock);
}

void config_mgr_get_modem_apn(char *out_value, size_t out_len) {
    if (!out_value || out_len == 0U) {
        return;
    }

    out_value[0] = '\0';
    if (!s_ready || !s_lock) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    snprintf(out_value, out_len, "%s", s_config.modem_apn);
    xSemaphoreGive(s_lock);
}

uint32_t config_mgr_device_status_interval_ms(void) {
    uint32_t value = CONFIG_UNIFIED_DEVICE_STATUS_INTERVAL_MS;

    if (!s_ready || !s_lock) {
        return value;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return value;
    }

    value = s_config.device_status_interval_ms;
    xSemaphoreGive(s_lock);
    return value;
}

bool config_mgr_modem_fallback_enabled(void) {
    bool value = true;

    if (!s_ready || !s_lock) {
        return value;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return value;
    }

    value = s_config.modem_fallback_enabled;
    xSemaphoreGive(s_lock);
    return value;
}

bool config_mgr_storage_enabled(void) {
    bool value = true;

    if (!s_ready || !s_lock) {
        return value;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return value;
    }

    value = s_config.storage_enabled;
    xSemaphoreGive(s_lock);
    return value;
}

esp_err_t config_mgr_store(const config_mgr_data_t *config) {
    nvs_handle_t handle = 0;
    esp_err_t err = ESP_OK;
    config_mgr_data_t next = {0};

    if (!config || !s_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }

    next = *config;
    next.schema_version = CONFIG_VERSION;
    err = config_mgr_validate(&next);
    if (err != ESP_OK) {
        return err;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    err = nvs_open(CONFIG_NAMESPACE, NVS_READWRITE, &handle);
    if (err == ESP_OK) {
        err = nvs_set_blob(handle, CONFIG_KEY, &next, sizeof(next));
        if (err == ESP_OK) {
            err = nvs_commit(handle);
        }
        nvs_close(handle);
    }
    if (err == ESP_OK) {
        s_config = next;
        if (s_revision < UINT32_MAX) {
            s_revision++;
        }
    }

    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t config_mgr_apply_key_value(
    const char *key,
    const char *value,
    bool *out_restart_required,
    bool *out_sensitive
) {
    config_mgr_data_t next = {0};
    bool bool_value = false;
    uint32_t u32_value = 0;
    bool restart_required = false;
    bool sensitive = false;
    esp_err_t err = ESP_OK;

    if (!key || !value || key[0] == '\0' || !s_ready) {
        return ESP_ERR_INVALID_ARG;
    }

    config_mgr_snapshot(&next);
    if (strcmp(key, "storage_enabled") == 0) {
        if (!config_mgr_parse_bool_value(value, &bool_value)) {
            return ESP_ERR_INVALID_ARG;
        }
        next.storage_enabled = bool_value;
        restart_required = true;
    } else if (strcmp(key, "wifi_primary") == 0) {
        if (!config_mgr_parse_bool_value(value, &bool_value)) {
            return ESP_ERR_INVALID_ARG;
        }
        next.wifi_primary = bool_value;
    } else if (strcmp(key, "modem_fallback_enabled") == 0) {
        if (!config_mgr_parse_bool_value(value, &bool_value)) {
            return ESP_ERR_INVALID_ARG;
        }
        next.modem_fallback_enabled = bool_value;
    } else if (strcmp(key, "mqtt_enabled") == 0) {
        if (!config_mgr_parse_bool_value(value, &bool_value)) {
            return ESP_ERR_INVALID_ARG;
        }
        next.mqtt_enabled = bool_value;
    } else if (strcmp(key, "health_heartbeat_interval_ms") == 0) {
        if (!config_mgr_parse_u32_value(value, &u32_value)) {
            return ESP_ERR_INVALID_ARG;
        }
        next.health_heartbeat_interval_ms = u32_value;
    } else if (strcmp(key, "health_timeout_ms") == 0) {
        if (!config_mgr_parse_u32_value(value, &u32_value)) {
            return ESP_ERR_INVALID_ARG;
        }
        next.health_timeout_ms = u32_value;
    } else if (strcmp(key, "device_status_interval_ms") == 0) {
        if (!config_mgr_parse_u32_value(value, &u32_value)) {
            return ESP_ERR_INVALID_ARG;
        }
        next.device_status_interval_ms = u32_value;
    } else if (strcmp(key, "device_id_override") == 0) {
        if (!config_mgr_copy_string_value(value, next.device_id_override, sizeof(next.device_id_override))) {
            return ESP_ERR_INVALID_ARG;
        }
        restart_required = true;
    } else if (strcmp(key, "wifi_ssid") == 0) {
        if (!config_mgr_copy_string_value(value, next.wifi_ssid, sizeof(next.wifi_ssid))) {
            return ESP_ERR_INVALID_ARG;
        }
        restart_required = true;
    } else if (strcmp(key, "wifi_password") == 0) {
        if (!config_mgr_copy_string_value(value, next.wifi_password, sizeof(next.wifi_password))) {
            return ESP_ERR_INVALID_ARG;
        }
        restart_required = true;
        sensitive = true;
    } else if (strcmp(key, "mqtt_topic_prefix") == 0) {
        if (!config_mgr_copy_string_value(value, next.mqtt_topic_prefix, sizeof(next.mqtt_topic_prefix))) {
            return ESP_ERR_INVALID_ARG;
        }
    } else if (strcmp(key, "mqtt_uri") == 0) {
        if (!config_mgr_copy_string_value(value, next.mqtt_uri, sizeof(next.mqtt_uri))) {
            return ESP_ERR_INVALID_ARG;
        }
    } else if (strcmp(key, "mqtt_username") == 0) {
        if (!config_mgr_copy_string_value(value, next.mqtt_username, sizeof(next.mqtt_username))) {
            return ESP_ERR_INVALID_ARG;
        }
    } else if (strcmp(key, "mqtt_password") == 0) {
        if (!config_mgr_copy_string_value(value, next.mqtt_password, sizeof(next.mqtt_password))) {
            return ESP_ERR_INVALID_ARG;
        }
        sensitive = true;
    } else if (strcmp(key, "modem_apn") == 0) {
        if (!config_mgr_copy_string_value(value, next.modem_apn, sizeof(next.modem_apn))) {
            return ESP_ERR_INVALID_ARG;
        }
        restart_required = true;
    } else {
        return ESP_ERR_NOT_SUPPORTED;
    }

    err = config_mgr_store(&next);
    if (err != ESP_OK) {
        return err;
    }

    if (out_restart_required) {
        *out_restart_required = restart_required;
    }
    if (out_sensitive) {
        *out_sensitive = sensitive;
    }
    return ESP_OK;
}

uint32_t config_mgr_schema_version(void) {
    return s_config.schema_version;
}

uint32_t config_mgr_revision(void) {
    uint32_t value = 0U;

    if (!s_ready || !s_lock) {
        return value;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return value;
    }

    value = s_revision;
    xSemaphoreGive(s_lock);
    return value;
}
