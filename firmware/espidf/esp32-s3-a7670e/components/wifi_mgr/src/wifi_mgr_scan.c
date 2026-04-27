#include "wifi_mgr_internal.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"

#include "unified_runtime.h"

#define WIFI_MGR_PRECONNECT_RECORDS_MAX 8U
#define WIFI_MGR_PRECONNECT_ACTIVE_MIN_MS 120U
#define WIFI_MGR_PRECONNECT_ACTIVE_MAX_MS 180U
#define WIFI_MGR_PRECONNECT_ACTIVE_EXT_MIN_MS 300U
#define WIFI_MGR_PRECONNECT_ACTIVE_EXT_MAX_MS 450U
#define WIFI_MGR_PRECONNECT_PASSIVE_MS 180U
#define WIFI_MGR_PRECONNECT_RESET_SETTLE_MS 180U
#define WIFI_MGR_SCAN_RESET_SETTLE_MS 150U

typedef struct {
    wifi_ap_record_t records[WIFI_MGR_PRECONNECT_RECORDS_MAX];
    uint16_t visible_count;
    uint16_t record_count;
    uint16_t selected_index;
    uint32_t elapsed_ms;
} wifi_mgr_preconnect_scan_result_t;

typedef struct {
    config_mgr_data_t config;
    wifi_scan_config_t active_scan_config;
    wifi_scan_config_t active_ext_scan_config;
    wifi_scan_config_t passive_scan_config;
    wifi_mgr_preconnect_scan_result_t active_result;
    wifi_mgr_preconnect_scan_result_t active_ext_result;
    wifi_mgr_preconnect_scan_result_t passive_result;
    wifi_config_t wifi_config;
    char active_summary[UNIFIED_TEXT_LONG_LEN];
    char active_ext_summary[UNIFIED_TEXT_LONG_LEN];
    char passive_summary[UNIFIED_TEXT_LONG_LEN];
    char final_summary[UNIFIED_TEXT_LONG_LEN];
} wifi_mgr_prepare_connect_scratch_t;

static wifi_mgr_prepare_connect_scratch_t s_prepare_connect_scratch;

const char *wifi_mgr_scan_mode_name(wifi_mgr_scan_mode_t mode) {
    switch (mode) {
        case WIFI_MGR_SCAN_MODE_PASSIVE:
            return "passive";
        case WIFI_MGR_SCAN_MODE_ACTIVE:
        default:
            return "active";
    }
}

const char *wifi_mgr_wifi_mode_name(wifi_mode_t mode) {
    switch (mode) {
        case WIFI_MODE_NULL:
            return "null";
        case WIFI_MODE_STA:
            return "sta";
        case WIFI_MODE_AP:
            return "ap";
        case WIFI_MODE_APSTA:
            return "apsta";
        default:
            return "unknown";
    }
}

const char *wifi_mgr_auth_mode_name(wifi_auth_mode_t authmode) {
    switch (authmode) {
        case WIFI_AUTH_OPEN:
            return "open";
        case WIFI_AUTH_WEP:
            return "wep";
        case WIFI_AUTH_WPA_PSK:
            return "wpa_psk";
        case WIFI_AUTH_WPA2_PSK:
            return "wpa2_psk";
        case WIFI_AUTH_WPA_WPA2_PSK:
            return "wpa_wpa2_psk";
        case WIFI_AUTH_WPA3_PSK:
            return "wpa3_psk";
        case WIFI_AUTH_WPA2_WPA3_PSK:
            return "wpa2_wpa3_psk";
        case WIFI_AUTH_WAPI_PSK:
            return "wapi_psk";
        case WIFI_AUTH_OWE:
            return "owe";
        case WIFI_AUTH_WPA3_EXT_PSK:
            return "wpa3_ext_psk";
        case WIFI_AUTH_WPA3_EXT_PSK_MIXED_MODE:
            return "wpa3_ext_psk_mixed";
        case WIFI_AUTH_DPP:
            return "dpp";
        default:
            return "unknown";
    }
}

static bool wifi_mgr_auth_mode_is_wpa2(wifi_auth_mode_t authmode) {
    return authmode == WIFI_AUTH_WPA2_PSK || authmode == WIFI_AUTH_WPA_WPA2_PSK;
}

static bool wifi_mgr_auth_mode_is_wpa3(wifi_auth_mode_t authmode) {
    return authmode == WIFI_AUTH_WPA3_PSK || authmode == WIFI_AUTH_WPA3_EXT_PSK;
}

static bool wifi_mgr_auth_mode_is_wpa2_wpa3_transition(wifi_auth_mode_t authmode) {
    return authmode == WIFI_AUTH_WPA2_WPA3_PSK || authmode == WIFI_AUTH_WPA3_EXT_PSK_MIXED_MODE;
}

static const char *wifi_mgr_auth_profile_name(const wifi_ap_record_t *target_ap, bool secure_network) {
    if (!secure_network) {
        return "open";
    }
    if (!target_ap) {
        return "secure";
    }
    if (wifi_mgr_auth_mode_is_wpa2(target_ap->authmode)) {
        return "wpa2";
    }
    if (wifi_mgr_auth_mode_is_wpa3(target_ap->authmode)) {
        return "wpa3";
    }
    if (wifi_mgr_auth_mode_is_wpa2_wpa3_transition(target_ap->authmode)) {
        return "wpa2_wpa3";
    }
    return "secure";
}

static void wifi_mgr_append_scan_summary(
    char *buffer,
    size_t buffer_len,
    size_t *used,
    const wifi_ap_record_t *record
) {
    const char *ssid = NULL;
    int written = 0;

    if (!buffer || !used || !record || *used >= buffer_len) {
        return;
    }

    ssid = record->ssid[0] != '\0' ? (const char *)record->ssid : "<hidden>";
    written = snprintf(
        buffer + *used,
        buffer_len - *used,
        "%s%s@ch%u/%ddBm",
        *used == 0U ? "" : " | ",
        ssid,
        (unsigned)record->primary,
        (int)record->rssi
    );
    if (written < 0) {
        return;
    }
    *used += (size_t)written < (buffer_len - *used) ? (size_t)written : (buffer_len - *used - 1U);
}

static void wifi_mgr_append_text(
    char *buffer,
    size_t buffer_len,
    size_t *used,
    const char *text
) {
    size_t text_len = 0U;
    size_t copy_len = 0U;

    if (!buffer || !used || !text || *used >= buffer_len) {
        return;
    }

    text_len = strlen(text);
    if (text_len == 0U) {
        return;
    }

    copy_len = text_len < (buffer_len - *used - 1U) ? text_len : (buffer_len - *used - 1U);
    memcpy(buffer + *used, text, copy_len);
    *used += copy_len;
    buffer[*used] = '\0';
}

static void wifi_mgr_build_scan_summary(
    char *buffer,
    size_t buffer_len,
    const wifi_ap_record_t *records,
    size_t summary_count,
    uint16_t visible_count
) {
    size_t used = 0U;

    if (!buffer || buffer_len == 0U) {
        return;
    }

    buffer[0] = '\0';

    if (!records || summary_count == 0U) {
        snprintf(
            buffer,
            buffer_len,
            "%s",
            visible_count == 0U ? "none_visible" : "visible_but_no_records"
        );
        return;
    }

    for (size_t index = 0; index < summary_count && index < 4U; ++index) {
        wifi_mgr_append_scan_summary(
            buffer,
            buffer_len,
            &used,
            &records[index]
        );
    }
}

static void wifi_mgr_set_last_scan_locked(
    bool target_visible,
    uint16_t visible_count,
    uint32_t elapsed_ms,
    const char *summary
) {
    s_status.last_scan_target_visible = target_visible;
    s_status.last_scan_visible_count = visible_count;
    s_status.last_scan_elapsed_ms = elapsed_ms;
    snprintf(
        s_status.last_scan_summary,
        sizeof(s_status.last_scan_summary),
        "%s",
        summary && summary[0] != '\0'
            ? summary
            : (visible_count == 0U ? "none_visible" : "visible_but_no_records")
    );
}

static void wifi_mgr_reset_scan_runtime(bool disconnect_station, uint32_t settle_ms) {
    bool should_settle = false;
    esp_err_t err = esp_wifi_scan_stop();

    if (err == ESP_OK) {
        should_settle = true;
    } else if (err != ESP_ERR_WIFI_NOT_INIT && err != ESP_ERR_WIFI_NOT_STARTED) {
        ESP_LOGD(WIFI_MGR_TAG, "esp_wifi_scan_stop ignored during cleanup: %s", esp_err_to_name(err));
    }

    err = esp_wifi_clear_ap_list();
    if (err == ESP_OK) {
        should_settle = true;
    } else if (err != ESP_ERR_WIFI_NOT_INIT
        && err != ESP_ERR_WIFI_NOT_STARTED
        && err != ESP_ERR_WIFI_MODE
        && err != ESP_ERR_INVALID_ARG) {
        ESP_LOGD(WIFI_MGR_TAG, "esp_wifi_clear_ap_list ignored during cleanup: %s", esp_err_to_name(err));
    }

    if (disconnect_station) {
        err = esp_wifi_disconnect();
        if (err == ESP_OK) {
            should_settle = true;
        } else if (err != ESP_ERR_WIFI_NOT_INIT && err != ESP_ERR_WIFI_NOT_STARTED && err != ESP_FAIL) {
            ESP_LOGD(WIFI_MGR_TAG, "esp_wifi_disconnect ignored during cleanup: %s", esp_err_to_name(err));
        }
    }

    if (should_settle && settle_ms > 0U) {
        vTaskDelay(pdMS_TO_TICKS(settle_ms));
    }
}

esp_err_t wifi_mgr_issue_connect(const char *detail) {
    char ssid[sizeof(s_status.ssid)] = {0};
    uint32_t connect_attempt = 0U;
    esp_err_t err = ESP_OK;

    if (!s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    s_status.connect_attempt_count++;
    connect_attempt = s_status.connect_attempt_count;
    snprintf(ssid, sizeof(ssid), "%s", s_status.ssid);
    xSemaphoreGive(s_lock);

    ESP_LOGI(
        WIFI_MGR_TAG,
        "%s attempt=%" PRIu32 " ssid=%s",
        detail && detail[0] != '\0' ? detail : "connect requested",
        connect_attempt,
        ssid[0] != '\0' ? ssid : "<unset>"
    );

    err = esp_wifi_connect();
    if (err != ESP_OK && err != ESP_ERR_WIFI_CONN && err != ESP_ERR_WIFI_STATE) {
        ESP_LOGW(WIFI_MGR_TAG, "esp_wifi_connect failed: %s", esp_err_to_name(err));
    }

    return err;
}

void wifi_mgr_build_sta_config(
    const config_mgr_data_t *config,
    wifi_config_t *wifi_config,
    const wifi_ap_record_t *target_ap
) {
    wifi_auth_mode_t threshold_authmode = WIFI_AUTH_OPEN;
    bool secure_network = false;
    bool pure_wpa3_target = false;
    bool transition_target = false;

    memset(wifi_config, 0, sizeof(*wifi_config));
    memcpy(wifi_config->sta.ssid, config->wifi_ssid, strnlen(config->wifi_ssid, sizeof(wifi_config->sta.ssid)));
    memcpy(
        wifi_config->sta.password,
        config->wifi_password,
        strnlen(config->wifi_password, sizeof(wifi_config->sta.password))
    );
    wifi_config->sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    wifi_config->sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    wifi_config->sta.threshold.rssi = -127;
    secure_network = config->wifi_password[0] != '\0';
    pure_wpa3_target = target_ap && wifi_mgr_auth_mode_is_wpa3(target_ap->authmode);
    transition_target = target_ap && wifi_mgr_auth_mode_is_wpa2_wpa3_transition(target_ap->authmode);
    if (!secure_network) {
        threshold_authmode = WIFI_AUTH_OPEN;
    } else if (pure_wpa3_target) {
        threshold_authmode = WIFI_AUTH_WPA3_PSK;
    } else {
        threshold_authmode = WIFI_AUTH_WPA2_PSK;
    }
    wifi_config->sta.threshold.authmode = threshold_authmode;
    wifi_config->sta.pmf_cfg.capable = pure_wpa3_target || transition_target;
    wifi_config->sta.pmf_cfg.required = pure_wpa3_target;
    wifi_config->sta.sae_pwe_h2e = (pure_wpa3_target || transition_target)
        ? WPA3_SAE_PWE_BOTH
        : WPA3_SAE_PWE_HUNT_AND_PECK;
    wifi_config->sta.sae_pk_mode = (pure_wpa3_target || transition_target)
        ? WPA3_SAE_PK_MODE_AUTOMATIC
        : WPA3_SAE_PK_MODE_DISABLED;
    wifi_config->sta.failure_retry_cnt = secure_network ? 2U : 0U;

    /*
     * Keep the pre-connect scan for diagnostics and target visibility, but do not
     * pin the STA config to one BSSID/channel. Android hotspots can rotate or
     * present transition/security behavior that makes a freshly scanned BSSID
     * too brittle for reconnects, which looks like a stale-cache/auth problem.
     */
    wifi_config->sta.channel = 0U;
    wifi_config->sta.bssid_set = false;

    ESP_LOGI(
        WIFI_MGR_TAG,
        "sta config ssid=%s profile=%s threshold=%s target_auth=%s pmf_capable=%d pmf_required=%d sae_pwe=%d retry=%u",
        config->wifi_ssid,
        wifi_mgr_auth_profile_name(target_ap, secure_network),
        wifi_mgr_auth_mode_name(threshold_authmode),
        target_ap ? wifi_mgr_auth_mode_name(target_ap->authmode) : "unknown",
        wifi_config->sta.pmf_cfg.capable ? 1 : 0,
        wifi_config->sta.pmf_cfg.required ? 1 : 0,
        (int)wifi_config->sta.sae_pwe_h2e,
        (unsigned)wifi_config->sta.failure_retry_cnt
    );
}

static uint16_t wifi_mgr_find_target_record(
    const wifi_ap_record_t *records,
    uint16_t record_count,
    const char *target_ssid
) {
    if (!records || !target_ssid || target_ssid[0] == '\0') {
        return UINT16_MAX;
    }

    for (uint16_t index = 0; index < record_count; ++index) {
        if (strcmp((const char *)records[index].ssid, target_ssid) == 0) {
            return index;
        }
    }

    return UINT16_MAX;
}

static esp_err_t wifi_mgr_run_preconnect_scan(
    const config_mgr_data_t *config,
    const wifi_scan_config_t *scan_config,
    wifi_mgr_preconnect_scan_result_t *out_result
) {
    int64_t started_us = 0;
    esp_err_t err = ESP_OK;

    if (!config || !scan_config || !out_result) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(out_result, 0, sizeof(*out_result));
    out_result->selected_index = UINT16_MAX;
    out_result->record_count = (uint16_t)(sizeof(out_result->records) / sizeof(out_result->records[0]));

    started_us = esp_timer_get_time();
    err = esp_wifi_scan_start(scan_config, true);
    if (err != ESP_OK) {
        goto done;
    }

    err = esp_wifi_scan_get_ap_num(&out_result->visible_count);
    if (err != ESP_OK) {
        goto done;
    }

    if (out_result->visible_count == 0U) {
        out_result->record_count = 0U;
        err = ESP_OK;
        goto done;
    }

    err = esp_wifi_scan_get_ap_records(&out_result->record_count, out_result->records);
    if (err != ESP_OK) {
        goto done;
    }

    out_result->selected_index = wifi_mgr_find_target_record(
        out_result->records,
        out_result->record_count,
        config->wifi_ssid
    );

done:
    out_result->elapsed_ms = (uint32_t)((esp_timer_get_time() - started_us) / 1000LL);
    return err;
}

static esp_err_t wifi_mgr_prepare_connect_config(char *ssid, size_t ssid_size) {
    wifi_mgr_prepare_connect_scratch_t *scratch = &s_prepare_connect_scratch;
    wifi_ap_record_t *selected_ap = NULL;
    wifi_mode_t current_mode = WIFI_MODE_NULL;
    esp_err_t err = ESP_OK;
    bool claimed_scan_slot = false;
    bool used_passive_fallback = false;
    bool selected_on_passive = false;
    uint16_t final_visible_count = 0U;
    uint32_t total_elapsed_ms = 0U;
    size_t final_summary_used = 0U;

    memset(scratch, 0, sizeof(*scratch));

    config_mgr_snapshot(&scratch->config);
    if (scratch->config.wifi_ssid[0] == '\0') {
        return ESP_ERR_INVALID_STATE;
    }

    unified_copy_cstr(ssid, ssid_size, scratch->config.wifi_ssid);
    err = esp_wifi_get_mode(&current_mode);
    if (err != ESP_OK) {
        return err;
    }
    if (current_mode != WIFI_MODE_STA && current_mode != WIFI_MODE_APSTA) {
        ESP_LOGW(WIFI_MGR_TAG, "connect preparation skipped because wifi mode is %s", wifi_mgr_wifi_mode_name(current_mode));
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    if (s_scan_in_progress) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_STATE;
    }
    s_scan_in_progress = true;
    claimed_scan_slot = true;
    xSemaphoreGive(s_lock);

    /* Start every pre-connect scan from a clean driver/runtime state. */
    wifi_mgr_reset_scan_runtime(true, WIFI_MGR_PRECONNECT_RESET_SETTLE_MS);

    scratch->active_scan_config.ssid = (uint8_t *)scratch->config.wifi_ssid;
    scratch->active_scan_config.bssid = NULL;
    scratch->active_scan_config.channel = 0U;
    scratch->active_scan_config.show_hidden = true;
    scratch->active_scan_config.scan_type = WIFI_SCAN_TYPE_ACTIVE;
    scratch->active_scan_config.scan_time.active.min = WIFI_MGR_PRECONNECT_ACTIVE_MIN_MS;
    scratch->active_scan_config.scan_time.active.max = WIFI_MGR_PRECONNECT_ACTIVE_MAX_MS;

    err = wifi_mgr_run_preconnect_scan(&scratch->config, &scratch->active_scan_config, &scratch->active_result);
    if (err != ESP_OK) {
        goto done;
    }

    wifi_mgr_build_scan_summary(
        scratch->active_summary,
        sizeof(scratch->active_summary),
        scratch->active_result.records,
        scratch->active_result.record_count,
        scratch->active_result.visible_count
    );

    if (scratch->active_result.selected_index != UINT16_MAX) {
        selected_ap = &scratch->active_result.records[scratch->active_result.selected_index];
        final_visible_count = scratch->active_result.visible_count;
        total_elapsed_ms = scratch->active_result.elapsed_ms;
        unified_copy_cstr(scratch->final_summary, sizeof(scratch->final_summary), scratch->active_summary);
    } else {
        scratch->active_ext_scan_config = scratch->active_scan_config;
        scratch->active_ext_scan_config.scan_time.active.min = WIFI_MGR_PRECONNECT_ACTIVE_EXT_MIN_MS;
        scratch->active_ext_scan_config.scan_time.active.max = WIFI_MGR_PRECONNECT_ACTIVE_EXT_MAX_MS;
        err = wifi_mgr_run_preconnect_scan(&scratch->config, &scratch->active_ext_scan_config, &scratch->active_ext_result);
        if (err != ESP_OK) {
            goto done;
        }

        wifi_mgr_build_scan_summary(
            scratch->active_ext_summary,
            sizeof(scratch->active_ext_summary),
            scratch->active_ext_result.records,
            scratch->active_ext_result.record_count,
            scratch->active_ext_result.visible_count
        );

        if (scratch->active_ext_result.selected_index != UINT16_MAX) {
            selected_ap = &scratch->active_ext_result.records[scratch->active_ext_result.selected_index];
            final_visible_count = scratch->active_ext_result.visible_count;
            total_elapsed_ms = scratch->active_result.elapsed_ms + scratch->active_ext_result.elapsed_ms;
            wifi_mgr_append_text(
                scratch->final_summary,
                sizeof(scratch->final_summary),
                &final_summary_used,
                "active_ext "
            );
            wifi_mgr_append_text(
                scratch->final_summary,
                sizeof(scratch->final_summary),
                &final_summary_used,
                scratch->active_ext_summary
            );
        } else {
        used_passive_fallback = true;

        /* Clear any stale association state before the broader fallback scan. */
        (void)esp_wifi_disconnect();
        vTaskDelay(pdMS_TO_TICKS(150));

        scratch->passive_scan_config.ssid = NULL;
        scratch->passive_scan_config.bssid = NULL;
        scratch->passive_scan_config.channel = 0U;
        scratch->passive_scan_config.show_hidden = true;
        scratch->passive_scan_config.scan_type = WIFI_SCAN_TYPE_PASSIVE;
        scratch->passive_scan_config.scan_time.passive = WIFI_MGR_PRECONNECT_PASSIVE_MS;

        err = wifi_mgr_run_preconnect_scan(&scratch->config, &scratch->passive_scan_config, &scratch->passive_result);
        if (err != ESP_OK) {
            goto done;
        }

        wifi_mgr_build_scan_summary(
            scratch->passive_summary,
            sizeof(scratch->passive_summary),
            scratch->passive_result.records,
            scratch->passive_result.record_count,
            scratch->passive_result.visible_count
        );

        final_visible_count = scratch->passive_result.visible_count;
        total_elapsed_ms = scratch->active_result.elapsed_ms + scratch->active_ext_result.elapsed_ms + scratch->passive_result.elapsed_ms;

        if (scratch->passive_result.selected_index != UINT16_MAX) {
            selected_ap = &scratch->passive_result.records[scratch->passive_result.selected_index];
            selected_on_passive = true;
            wifi_mgr_append_text(
                scratch->final_summary,
                sizeof(scratch->final_summary),
                &final_summary_used,
                "passive_fallback "
            );
            wifi_mgr_append_text(
                scratch->final_summary,
                sizeof(scratch->final_summary),
                &final_summary_used,
                scratch->passive_summary
            );
        } else {
            wifi_mgr_append_text(
                scratch->final_summary,
                sizeof(scratch->final_summary),
                &final_summary_used,
                "active:"
            );
            wifi_mgr_append_text(
                scratch->final_summary,
                sizeof(scratch->final_summary),
                &final_summary_used,
                scratch->active_summary
            );
            wifi_mgr_append_text(
                scratch->final_summary,
                sizeof(scratch->final_summary),
                &final_summary_used,
                " -> active_ext:"
            );
            wifi_mgr_append_text(
                scratch->final_summary,
                sizeof(scratch->final_summary),
                &final_summary_used,
                scratch->active_ext_summary
            );
            wifi_mgr_append_text(
                scratch->final_summary,
                sizeof(scratch->final_summary),
                &final_summary_used,
                " -> passive:"
            );
            wifi_mgr_append_text(
                scratch->final_summary,
                sizeof(scratch->final_summary),
                &final_summary_used,
                scratch->passive_summary
            );
        }
        }
    }

    wifi_mgr_build_sta_config(&scratch->config, &scratch->wifi_config, selected_ap);
    err = esp_wifi_set_config(WIFI_IF_STA, &scratch->wifi_config);
    if (err != ESP_OK) {
        goto done;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        wifi_mgr_set_last_scan_locked(
            selected_ap != NULL,
            final_visible_count,
            total_elapsed_ms,
            scratch->final_summary
        );
        xSemaphoreGive(s_lock);
    }

    if (selected_ap) {
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            snprintf(
                s_status.security,
                sizeof(s_status.security),
                "%s",
                wifi_mgr_auth_mode_name(selected_ap->authmode)
            );
            xSemaphoreGive(s_lock);
        }
        ESP_LOGI(
            WIFI_MGR_TAG,
            "target %s visible via %s scan channel=%u rssi=%d auth=%s bssid=%02x:%02x:%02x:%02x:%02x:%02x visible=%u top=%s",
            scratch->config.wifi_ssid,
            selected_on_passive ? "passive_fallback" : "active",
            (unsigned)selected_ap->primary,
            (int)selected_ap->rssi,
            wifi_mgr_auth_mode_name(selected_ap->authmode),
            selected_ap->bssid[0],
            selected_ap->bssid[1],
            selected_ap->bssid[2],
            selected_ap->bssid[3],
            selected_ap->bssid[4],
            selected_ap->bssid[5],
            (unsigned)final_visible_count,
            s_status.last_scan_summary
        );
    } else {
        ESP_LOGW(
            WIFI_MGR_TAG,
            "target %s not visible during pre-connect scan%s visible=%u top=%s",
            scratch->config.wifi_ssid,
            used_passive_fallback ? " (active+passive)" : "",
            (unsigned)final_visible_count,
            s_status.last_scan_summary[0] != '\0' ? s_status.last_scan_summary : "none_visible"
        );
    }

done:
    if (err != ESP_OK && xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        wifi_mgr_set_last_scan_locked(
            false,
            scratch->passive_result.visible_count != 0U ? scratch->passive_result.visible_count : scratch->active_result.visible_count,
            total_elapsed_ms != 0U
                ? total_elapsed_ms
                : (scratch->active_result.elapsed_ms + scratch->passive_result.elapsed_ms),
            "scan_error"
        );
        if (selected_ap == NULL) {
            s_status.security[0] = '\0';
        }
        xSemaphoreGive(s_lock);
    }

    if (claimed_scan_slot && xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        s_scan_in_progress = false;
        xSemaphoreGive(s_lock);
    }
    return err;
}

esp_err_t wifi_mgr_scan_networks(
    const wifi_mgr_scan_request_t *request,
    wifi_mgr_scan_result_t *results,
    size_t max_results,
    size_t *out_count,
    wifi_mgr_scan_report_t *out_report
) {
    wifi_mgr_scan_request_t effective_request = {
        .mode = WIFI_MGR_SCAN_MODE_ACTIVE,
        .channel = 0U,
        .dwell_time_ms = 80U,
    };
    uint16_t ap_count = 0;
    size_t copy_count = 0;
    wifi_ap_record_t *records = NULL;
    wifi_scan_config_t scan_config = {0};
    esp_err_t err = ESP_OK;
    esp_err_t mode_err = ESP_OK;
    wifi_mode_t current_mode = WIFI_MODE_NULL;
    wifi_mode_t mode_after = WIFI_MODE_NULL;
    bool temporary_apsta = false;
    bool should_reconnect = false;
    int64_t started_us = 0;

    if (!results || max_results == 0U || !out_count) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }

    if (request) {
        effective_request = *request;
    }
    if (effective_request.mode != WIFI_MGR_SCAN_MODE_ACTIVE
        && effective_request.mode != WIFI_MGR_SCAN_MODE_PASSIVE) {
        return ESP_ERR_INVALID_ARG;
    }
    if (effective_request.channel > 14U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (effective_request.dwell_time_ms == 0U) {
        effective_request.dwell_time_ms = effective_request.mode == WIFI_MGR_SCAN_MODE_PASSIVE ? 120U : 80U;
    }

    scan_config.ssid = NULL;
    scan_config.bssid = NULL;
    scan_config.channel = effective_request.channel;
    scan_config.show_hidden = true;
    scan_config.scan_type = effective_request.mode == WIFI_MGR_SCAN_MODE_PASSIVE
        ? WIFI_SCAN_TYPE_PASSIVE
        : WIFI_SCAN_TYPE_ACTIVE;
    if (effective_request.mode == WIFI_MGR_SCAN_MODE_PASSIVE) {
        scan_config.scan_time.passive = effective_request.dwell_time_ms;
    } else {
        scan_config.scan_time.active.min = effective_request.dwell_time_ms > 40U
            ? (uint16_t)(effective_request.dwell_time_ms / 2U)
            : effective_request.dwell_time_ms;
        scan_config.scan_time.active.max = effective_request.dwell_time_ms;
    }

    *out_count = 0U;
    memset(results, 0, sizeof(*results) * max_results);
    if (out_report) {
        memset(out_report, 0, sizeof(*out_report));
        out_report->mode = effective_request.mode;
        out_report->channel = effective_request.channel;
        out_report->dwell_time_ms = effective_request.dwell_time_ms;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    if (s_scan_in_progress) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_STATE;
    }

    s_scan_in_progress = true;
    s_scan_suppress_connect = false;
    /* Runtime scans are diagnostic/orchestration operations. Do not tear down
     * the active STA path here; reconnect policy belongs to the Wi-Fi manager. */
    should_reconnect = false;
    xSemaphoreGive(s_lock);

    mode_err = esp_wifi_get_mode(&current_mode);
    if (mode_err != ESP_OK) {
        err = mode_err;
        goto done;
    }
    if (out_report) {
        out_report->wifi_mode_before = current_mode;
    }
    started_us = esp_timer_get_time();

    if (current_mode == WIFI_MODE_AP) {
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            s_scan_suppress_connect = true;
            xSemaphoreGive(s_lock);
        }
        should_reconnect = false;
        err = esp_wifi_set_mode(WIFI_MODE_APSTA);
        if (err != ESP_OK) {
            goto done;
        }
        temporary_apsta = true;
        vTaskDelay(pdMS_TO_TICKS(300));
    }

    wifi_mgr_reset_scan_runtime(should_reconnect, WIFI_MGR_SCAN_RESET_SETTLE_MS);

    err = esp_wifi_scan_start(&scan_config, true);
    if (err != ESP_OK) {
        goto done;
    }

    err = esp_wifi_scan_get_ap_num(&ap_count);
    if (err != ESP_OK) {
        goto done;
    }
    if (ap_count == 0U) {
        err = ESP_OK;
        goto done;
    }

    records = heap_caps_calloc(ap_count, sizeof(*records), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!records) {
        records = heap_caps_calloc(ap_count, sizeof(*records), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }
    if (!records) {
        err = ESP_ERR_NO_MEM;
        goto done;
    }

    err = esp_wifi_scan_get_ap_records(&ap_count, records);
    if (err != ESP_OK) {
        goto done;
    }

    copy_count = ap_count < max_results ? ap_count : max_results;
    for (size_t index = 0; index < copy_count; ++index) {
        snprintf(results[index].ssid, sizeof(results[index].ssid), "%s", (const char *)records[index].ssid);
        results[index].rssi = records[index].rssi;
        results[index].primary_channel = records[index].primary;
        results[index].authmode = records[index].authmode;
    }

    *out_count = copy_count;

done:
    if (records) {
        heap_caps_free(records);
    }
    if (out_report) {
        out_report->total_visible = ap_count;
        out_report->temporary_apsta = temporary_apsta;
        out_report->reconnect_after_scan = should_reconnect;
    }

    if (temporary_apsta) {
        esp_err_t restore_err = esp_wifi_set_mode(WIFI_MODE_AP);

        if (restore_err != ESP_OK && err == ESP_OK) {
            err = restore_err;
        }
        vTaskDelay(pdMS_TO_TICKS(250));
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        s_scan_in_progress = false;
        s_scan_suppress_connect = false;
        xSemaphoreGive(s_lock);
    }

    if (should_reconnect) {
        (void)wifi_mgr_issue_connect("scan reconnect requested");
    }
    if (esp_wifi_get_mode(&mode_after) == ESP_OK && out_report) {
        out_report->wifi_mode_after = mode_after;
    }
    if (out_report && started_us != 0) {
        out_report->elapsed_ms = (uint32_t)((esp_timer_get_time() - started_us) / 1000);
    }
    return err;
}

esp_err_t wifi_mgr_run_connect_attempt(void) {
    char ssid[sizeof(s_status.ssid)] = {0};
    esp_err_t err = wifi_mgr_prepare_connect_config(ssid, sizeof(ssid));

    if (err != ESP_OK) {
        return err;
    }

    /* Clear any stale association before connecting to a freshly scanned AP. */
    (void)esp_wifi_disconnect();
    vTaskDelay(pdMS_TO_TICKS(150));

    return wifi_mgr_issue_connect("connect requested");
}
