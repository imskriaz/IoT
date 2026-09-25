#include "wifi_mgr_internal.h"

#include <string.h>
#include <stdio.h>

#include "nvs.h"
#include "nvs_flash.h"
#include "config_mgr.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#define WIFI_PROFILE_NAMESPACE "wifi_profiles"
#define WIFI_PROFILE_KEY "set"
#define WIFI_PROFILE_MAGIC 0x57504631U

typedef struct {
    uint32_t magic;
    wifi_mgr_profile_set_t set;
} wifi_mgr_profile_blob_t;

static wifi_mgr_profile_set_t s_profiles;
static bool s_loaded;
static SemaphoreHandle_t s_profiles_lock;
static portMUX_TYPE s_profiles_init_lock = portMUX_INITIALIZER_UNLOCKED;

static esp_err_t lock_profiles(void) {
    portENTER_CRITICAL(&s_profiles_init_lock);
    SemaphoreHandle_t lock = s_profiles_lock;
    portEXIT_CRITICAL(&s_profiles_init_lock);
    if (!lock) {
        SemaphoreHandle_t candidate = xSemaphoreCreateMutex();
        if (!candidate) return ESP_ERR_NO_MEM;
        portENTER_CRITICAL(&s_profiles_init_lock);
        if (!s_profiles_lock) { s_profiles_lock = candidate; candidate = NULL; }
        lock = s_profiles_lock;
        portEXIT_CRITICAL(&s_profiles_init_lock);
        if (candidate) vSemaphoreDelete(candidate);
    }
    return xSemaphoreTake(lock, pdMS_TO_TICKS(500)) == pdTRUE
        ? ESP_OK : ESP_ERR_TIMEOUT;
}

static esp_err_t validate_set(const wifi_mgr_profile_set_t *set) {
    if (!set || set->count > WIFI_MGR_PROFILE_MAX || set->revision == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    for (size_t i = 0; i < set->count; ++i) {
        const wifi_mgr_profile_t *profile = &set->profiles[i];
        size_t ssid_len = strnlen(profile->ssid, sizeof(profile->ssid));
        size_t pass_len = strnlen(profile->password, sizeof(profile->password));
        if (ssid_len == 0U || ssid_len >= sizeof(profile->ssid) || pass_len >= sizeof(profile->password)) {
            return ESP_ERR_INVALID_ARG;
        }
        if (profile->priority < 1U || profile->priority > 999U || (pass_len != 0U && pass_len < 8U)) {
            return ESP_ERR_INVALID_ARG;
        }
        if (pass_len == 64U && strspn(profile->password, "0123456789abcdefABCDEF") != 64U) return ESP_ERR_INVALID_ARG;
        for (size_t j = 0; j < i; ++j) {
            if (strcmp(profile->ssid, set->profiles[j].ssid) == 0) {
                return ESP_ERR_INVALID_ARG;
            }
        }
    }
    return ESP_OK;
}

static esp_err_t commit_verified(nvs_handle_t handle, const wifi_mgr_profile_blob_t *blob) {
    esp_err_t err = nvs_set_blob(handle, WIFI_PROFILE_KEY, blob, sizeof(*blob));
    if (err == ESP_OK) err = nvs_commit(handle);
    if (err == ESP_OK) {
        wifi_mgr_profile_blob_t verified = {0};
        size_t size = sizeof(verified);
        err = nvs_get_blob(handle, WIFI_PROFILE_KEY, &verified, &size);
        if (err == ESP_OK && (size != sizeof(*blob) || memcmp(&verified, blob, sizeof(*blob)) != 0)) {
            err = ESP_ERR_INVALID_STATE;
        }
    }
    return err;
}

static esp_err_t ensure_loaded(void) {
    if (s_loaded) return ESP_OK;
    memset(&s_profiles, 0, sizeof(s_profiles));
    nvs_handle_t handle = 0;
    esp_err_t err = nvs_open(WIFI_PROFILE_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) return err;
    wifi_mgr_profile_blob_t blob = {0};
    size_t size = sizeof(blob);
    err = nvs_get_blob(handle, WIFI_PROFILE_KEY, &blob, &size);
    if (err == ESP_OK && size == sizeof(blob) && blob.magic == WIFI_PROFILE_MAGIC && validate_set(&blob.set) == ESP_OK) {
        s_profiles = blob.set;
    } else if (err == ESP_ERR_NVS_NOT_FOUND) {
        config_mgr_data_t config = {0};
        config_mgr_snapshot(&config);
        s_profiles.revision = 1U;
        if (config.wifi_ssid[0] != '\0') {
            s_profiles.count = 1U;
            s_profiles.profiles[0].enabled = true;
            s_profiles.profiles[0].priority = 1U;
            snprintf(s_profiles.profiles[0].ssid, sizeof(s_profiles.profiles[0].ssid), "%s", config.wifi_ssid);
            snprintf(s_profiles.profiles[0].password, sizeof(s_profiles.profiles[0].password), "%s", config.wifi_password);
        }
        blob.magic = WIFI_PROFILE_MAGIC;
        blob.set = s_profiles;
        err = validate_set(&blob.set);
        if (err == ESP_OK) err = commit_verified(handle, &blob);
    } else if (err == ESP_OK) {
        /* Do not reinterpret a corrupt/newer record as empty credentials. */
        err = ESP_ERR_INVALID_STATE;
    }
    nvs_close(handle);
    s_loaded = (err == ESP_OK);
    return err;
}

esp_err_t wifi_mgr_profiles_init(void) {
    esp_err_t err = lock_profiles();
    if (err != ESP_OK) return err;
    err = ensure_loaded();
    xSemaphoreGive(s_profiles_lock);
    return err;
}

esp_err_t wifi_mgr_profiles_get(wifi_mgr_profile_set_t *out_profiles) {
    if (!out_profiles) return ESP_ERR_INVALID_ARG;
    esp_err_t lock_err = lock_profiles();
    if (lock_err != ESP_OK) return lock_err;
    /* Snapshot only: no flash I/O, migration, or config_mgr lock acquisition. */
    esp_err_t err = s_loaded ? ESP_OK : ESP_ERR_INVALID_STATE;
    if (err == ESP_OK) *out_profiles = s_profiles;
    xSemaphoreGive(s_profiles_lock);
    return err;
}

esp_err_t wifi_mgr_profiles_apply(const wifi_mgr_profile_set_t *profiles) {
    esp_err_t err = validate_set(profiles);
    if (err != ESP_OK) return err;
    err = lock_profiles();
    if (err != ESP_OK) return err;
    err = s_loaded ? ESP_OK : ESP_ERR_INVALID_STATE;
    if (err != ESP_OK) { xSemaphoreGive(s_profiles_lock); return err; }
    if (profiles->revision < s_profiles.revision) {
        xSemaphoreGive(s_profiles_lock);
        return ESP_ERR_INVALID_STATE;
    }
    if (profiles->revision == s_profiles.revision) {
        bool equal = profiles->count == s_profiles.count;
        for (size_t i = 0; equal && i < profiles->count; ++i) {
            const wifi_mgr_profile_t *a = &profiles->profiles[i], *b = &s_profiles.profiles[i];
            equal = a->enabled == b->enabled && a->priority == b->priority &&
                strcmp(a->ssid, b->ssid) == 0 && strcmp(a->password, b->password) == 0;
        }
        xSemaphoreGive(s_profiles_lock);
        return equal ? ESP_OK : ESP_ERR_INVALID_STATE;
    }
    nvs_handle_t handle = 0;
    err = nvs_open(WIFI_PROFILE_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) { xSemaphoreGive(s_profiles_lock); return err; }
    wifi_mgr_profile_blob_t blob = { .magic = WIFI_PROFILE_MAGIC, .set = *profiles };
    err = commit_verified(handle, &blob);
    nvs_close(handle);
    if (err == ESP_OK) {
        s_profiles = *profiles;
        s_loaded = true;
    }
    xSemaphoreGive(s_profiles_lock);
    if (err == ESP_OK) wifi_mgr_notify_task();
    return err;
}

/* Status readers never copy credentials or touch flash. Zero revision means
 * metadata unavailable, not a successfully applied empty profile set. */
esp_err_t wifi_mgr_profiles_metadata(uint32_t *revision, uint8_t *count) {
    if (!revision || !count) return ESP_ERR_INVALID_ARG;
    *revision = 0U;
    *count = 0U;
    esp_err_t err = lock_profiles();
    if (err != ESP_OK) return err;
    err = s_loaded ? ESP_OK : ESP_ERR_INVALID_STATE;
    if (err == ESP_OK) { *revision = s_profiles.revision; *count = s_profiles.count; }
    xSemaphoreGive(s_profiles_lock);
    return err;
}

esp_err_t wifi_mgr_profiles_auto_state(bool *available, uint32_t *revision) {
    if (!available || !revision) return ESP_ERR_INVALID_ARG;
    *available = false;
    *revision = 0U;
    esp_err_t err = lock_profiles();
    if (err != ESP_OK) return err;
    err = s_loaded ? ESP_OK : ESP_ERR_INVALID_STATE;
    if (err == ESP_OK) {
        *revision = s_profiles.revision;
        for (size_t i = 0; i < s_profiles.count; ++i) {
            if (s_profiles.profiles[i].enabled) { *available = true; break; }
        }
    }
    xSemaphoreGive(s_profiles_lock);
    return err;
}
