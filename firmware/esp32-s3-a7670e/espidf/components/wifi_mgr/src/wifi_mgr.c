#include "wifi_mgr.h"
#include "wifi_mgr_internal.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "lwip/ip4_addr.h"

#include "config_mgr.h"
#include "health_monitor.h"
#include "task_registry.h"
#include "unified_runtime.h"

static const char *TAG = WIFI_MGR_TAG;
static const uint32_t WIFI_MGR_ABSENT_RETRY_DELAY_MS = 30000U;
static const uint32_t WIFI_MGR_ABSENT_RETRY_MAX_DELAY_MS = 300000U;
static const uint32_t WIFI_MGR_CONNECTED_REFRESH_INTERVAL_MS = 15000U;
static const uint32_t WIFI_MGR_IDLE_REFRESH_INTERVAL_MS = 30000U;

SemaphoreHandle_t s_lock;
TaskHandle_t s_task_handle;
wifi_mgr_status_t s_status;
static esp_netif_t *s_wifi_netif;
static uint8_t s_absent_retry_streak;
static uint32_t s_config_revision;
bool s_scan_in_progress;
bool s_scan_suppress_connect;
bool s_startup_connect_suppressed;
bool s_runtime_connect_suppressed;
bool s_connect_requested;
static uint32_t s_next_connect_attempt_ms;
bool s_ready;

void wifi_mgr_notify_task(void);
bool wifi_mgr_refresh_config_locked(config_mgr_data_t *out_config);
static void wifi_mgr_request_connect_locked(void);

static bool wifi_mgr_disconnect_reason_is_ap_absent(uint32_t reason) {
    switch ((wifi_err_reason_t)reason) {
        case WIFI_REASON_NO_AP_FOUND:
        case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY:
        case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
        case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD:
            return true;
        default:
            return false;
    }
}

static uint32_t wifi_mgr_next_absent_retry_delay_ms(void) {
    uint32_t delay_ms = WIFI_MGR_ABSENT_RETRY_DELAY_MS;

    if (s_absent_retry_streak < 8U) {
        s_absent_retry_streak++;
    }

    for (uint8_t index = 1U; index < s_absent_retry_streak; ++index) {
        if (delay_ms >= WIFI_MGR_ABSENT_RETRY_MAX_DELAY_MS / 2U) {
            return WIFI_MGR_ABSENT_RETRY_MAX_DELAY_MS;
        }
        delay_ms *= 2U;
    }

    return delay_ms > WIFI_MGR_ABSENT_RETRY_MAX_DELAY_MS
        ? WIFI_MGR_ABSENT_RETRY_MAX_DELAY_MS
        : delay_ms;
}

static void wifi_mgr_reset_absent_retry_backoff(void) {
    s_absent_retry_streak = 0U;
}

const char *wifi_mgr_disconnect_reason_name(uint32_t reason) {
    if (reason == 0U) {
        return "";
    }

    switch ((wifi_err_reason_t)reason) {
        case WIFI_REASON_UNSPECIFIED: return "unspecified";
        case WIFI_REASON_AUTH_EXPIRE: return "auth_expire";
        case WIFI_REASON_AUTH_LEAVE: return "auth_leave";
        case WIFI_REASON_ASSOC_EXPIRE: return "assoc_expire";
        case WIFI_REASON_ASSOC_TOOMANY: return "assoc_too_many";
        case WIFI_REASON_NOT_AUTHED: return "not_authed";
        case WIFI_REASON_NOT_ASSOCED: return "not_assoced";
        case WIFI_REASON_ASSOC_LEAVE: return "assoc_leave";
        case WIFI_REASON_ASSOC_NOT_AUTHED: return "assoc_not_authed";
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT: return "4way_handshake_timeout";
        case WIFI_REASON_GROUP_KEY_UPDATE_TIMEOUT: return "group_key_update_timeout";
        case WIFI_REASON_802_1X_AUTH_FAILED: return "8021x_auth_failed";
        case WIFI_REASON_TIMEOUT: return "timeout";
        case WIFI_REASON_BEACON_TIMEOUT: return "beacon_timeout";
        case WIFI_REASON_NO_AP_FOUND: return "no_ap_found";
        case WIFI_REASON_AUTH_FAIL: return "auth_fail";
        case WIFI_REASON_ASSOC_FAIL: return "assoc_fail";
        case WIFI_REASON_HANDSHAKE_TIMEOUT: return "handshake_timeout";
        case WIFI_REASON_CONNECTION_FAIL: return "connection_fail";
        case WIFI_REASON_AP_TSF_RESET: return "ap_tsf_reset";
        case WIFI_REASON_ROAMING: return "roaming";
        case WIFI_REASON_ASSOC_COMEBACK_TIME_TOO_LONG: return "assoc_comeback_too_long";
        case WIFI_REASON_SA_QUERY_TIMEOUT: return "sa_query_timeout";
        case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY: return "no_ap_with_compatible_security";
        case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD: return "no_ap_in_authmode_threshold";
        case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD: return "no_ap_in_rssi_threshold";
        default:
            return "unknown";
    }
}

static void wifi_mgr_set_error_locked(esp_err_t err, const char *detail, unified_module_state_t state) {
    s_status.runtime.last_error = err;
    s_status.runtime.state = state;
    snprintf(
        s_status.runtime.last_error_text,
        sizeof(s_status.runtime.last_error_text),
        "%s",
        detail ? detail : ""
    );
}

static void wifi_mgr_set_disconnect_reason_locked(uint32_t reason) {
    s_status.last_disconnect_reason = reason;
    snprintf(
        s_status.last_disconnect_reason_text,
        sizeof(s_status.last_disconnect_reason_text),
        "%s",
        wifi_mgr_disconnect_reason_name(reason)
    );
}

static void wifi_mgr_update_health_locked(void) {
    health_module_state_t module_state = HEALTH_MODULE_STATE_OK;
    const char *detail = "running";

    if (!s_status.configured) {
        module_state = HEALTH_MODULE_STATE_DEGRADED;
        detail = "ssid_not_configured";
        s_status.runtime.state = UNIFIED_MODULE_STATE_DEGRADED;
    } else if (!s_status.started) {
        detail = "disabled";
        s_status.runtime.state = UNIFIED_MODULE_STATE_INITIALIZED;
    } else if (!s_status.connected) {
        module_state = HEALTH_MODULE_STATE_DEGRADED;
        detail = "wifi_disconnected";
        s_status.runtime.state = UNIFIED_MODULE_STATE_DEGRADED;
    } else {
        s_status.runtime.state = UNIFIED_MODULE_STATE_RUNNING;
    }

    health_monitor_set_module_state("wifi_mgr", module_state, detail);
}

bool wifi_mgr_refresh_config_locked(config_mgr_data_t *out_config) {
    config_mgr_data_t config = {0};
    bool changed = false;
    uint32_t config_revision = config_mgr_revision();

    if (!out_config && config_revision != 0U && s_config_revision == config_revision) {
        return false;
    }

    config_mgr_snapshot(&config);
    s_config_revision = config_revision;

    if (out_config) {
        *out_config = config;
    }

    if (s_status.configured != (config.wifi_ssid[0] != '\0')) {
        changed = true;
    } else if (strncmp(s_status.ssid, config.wifi_ssid, sizeof(s_status.ssid)) != 0) {
        changed = true;
    }

    s_status.configured = config.wifi_ssid[0] != '\0';
    snprintf(s_status.ssid, sizeof(s_status.ssid), "%s", config.wifi_ssid);

    if (!s_status.configured) {
        s_status.connected = false;
        s_status.ip_assigned = false;
        s_status.ip_address[0] = '\0';
        s_status.rssi = 0;
        s_status.security[0] = '\0';
    }
    if (changed) {
        wifi_mgr_update_health_locked();
    }

    return changed;
}

static esp_err_t wifi_mgr_create_default_loop(void) {
    esp_err_t err = esp_event_loop_create_default();

    if (err == ESP_ERR_INVALID_STATE) {
        return ESP_OK;
    }
    return err;
}

static void wifi_mgr_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data) {
    (void)arg;

    if (!s_lock) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        char ssid[sizeof(s_status.ssid)] = {0};
        bool configured = false;
        bool suppress_connect = false;

        s_status.started = true;
        s_status.runtime.running = true;
        configured = s_status.configured;
        suppress_connect = s_scan_suppress_connect || s_startup_connect_suppressed || s_runtime_connect_suppressed;
        snprintf(ssid, sizeof(ssid), "%s", s_status.ssid);
        if (configured && !suppress_connect) {
            s_next_connect_attempt_ms = 0U;
            wifi_mgr_request_connect_locked();
        }
        wifi_mgr_update_health_locked();
        xSemaphoreGive(s_lock);
        if (configured && !suppress_connect) {
            ESP_LOGI(TAG, "startup connect scheduled ssid=%s", ssid);
            wifi_mgr_notify_task();
        } else if (configured && suppress_connect) {
            ESP_LOGI(TAG, "startup connect deferred, waiting for explicit release");
        }
        return;
    }

    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_STOP) {
        s_status.started = false;
        s_status.connected = false;
        s_status.ip_assigned = false;
        s_status.ip_address[0] = '\0';
        s_status.rssi = 0;
        s_status.security[0] = '\0';
        s_status.reconnect_suppressed = s_runtime_connect_suppressed || s_startup_connect_suppressed;
        s_next_connect_attempt_ms = 0U;
        wifi_mgr_reset_absent_retry_backoff();
        s_status.runtime.running = false;
        s_status.runtime.last_error = ESP_OK;
        s_status.runtime.last_error_text[0] = '\0';
        wifi_mgr_update_health_locked();
        xSemaphoreGive(s_lock);
        return;
    }

    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *disconnected = (const wifi_event_sta_disconnected_t *)event_data;
        uint32_t reconnect_count = 0;
        uint32_t disconnect_reason = 0;
        uint32_t now_ms = unified_tick_now_ms();
        uint32_t retry_delay_ms = 0U;
        char ssid[sizeof(s_status.ssid)] = {0};
        bool configured = false;
        bool started = false;
        bool reconnect_scheduled = false;

        s_status.connected = false;
        s_status.ip_assigned = false;
        s_status.ip_address[0] = '\0';
        s_status.rssi = 0;
        s_status.security[0] = '\0';
        wifi_mgr_set_disconnect_reason_locked(disconnected ? (uint32_t)disconnected->reason : 0U);
        disconnect_reason = s_status.last_disconnect_reason;
        configured = s_status.configured;
        started = s_status.started;
        snprintf(ssid, sizeof(ssid), "%s", s_status.ssid);
        if (configured && started && !s_scan_in_progress && !s_runtime_connect_suppressed && !s_startup_connect_suppressed) {
            s_status.reconnect_count++;
            reconnect_count = s_status.reconnect_count;
            if (wifi_mgr_disconnect_reason_is_ap_absent(disconnect_reason) ||
                (s_status.last_scan_elapsed_ms > 0U && !s_status.last_scan_target_visible)) {
                retry_delay_ms = wifi_mgr_next_absent_retry_delay_ms();
                s_next_connect_attempt_ms = now_ms + retry_delay_ms;
            } else {
                wifi_mgr_reset_absent_retry_backoff();
                s_next_connect_attempt_ms = 0U;
            }
            reconnect_scheduled = true;
            wifi_mgr_request_connect_locked();
        } else {
            s_next_connect_attempt_ms = 0U;
        }
        wifi_mgr_set_error_locked(ESP_FAIL, "wifi_disconnected", UNIFIED_MODULE_STATE_DEGRADED);
        wifi_mgr_update_health_locked();
        xSemaphoreGive(s_lock);
        ESP_LOGW(
            TAG,
            "disconnect reason=%" PRIu32 " (%s) reconnect_scheduled=%d reconnect_count=%" PRIu32,
            disconnect_reason,
            s_status.last_disconnect_reason_text[0] != '\0' ? s_status.last_disconnect_reason_text : "none",
            reconnect_scheduled ? 1 : 0,
            reconnect_count
        );
        if (reconnect_scheduled && retry_delay_ms > 0U) {
            ESP_LOGI(
                TAG,
                "reconnect cooldown applied ssid=%s retry_in_ms=%" PRIu32,
                ssid[0] != '\0' ? ssid : "<unset>",
                retry_delay_ms
            );
        }
        if (reconnect_scheduled) {
            ESP_LOGI(TAG, "reconnect scheduled ssid=%s", ssid);
            wifi_mgr_notify_task();
        }
        return;
    }

    if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *got_ip = (ip_event_got_ip_t *)event_data;
        char ip_address[sizeof(s_status.ip_address)] = {0};
        char ssid[sizeof(s_status.ssid)] = {0};

        s_status.connected = true;
        s_status.ip_assigned = true;
        s_status.runtime.running = true;
        s_status.runtime.last_error = ESP_OK;
        s_status.runtime.last_error_text[0] = '\0';
        s_status.runtime.state = UNIFIED_MODULE_STATE_RUNNING;
        wifi_mgr_set_disconnect_reason_locked(0U);
        s_next_connect_attempt_ms = 0U;
        wifi_mgr_reset_absent_retry_backoff();
        if (got_ip) {
            snprintf(
                s_status.ip_address,
                sizeof(s_status.ip_address),
                IPSTR,
                IP2STR(&got_ip->ip_info.ip)
            );
        }
        snprintf(ip_address, sizeof(ip_address), "%s", s_status.ip_address);
        snprintf(ssid, sizeof(ssid), "%s", s_status.ssid);
        wifi_mgr_update_health_locked();
        xSemaphoreGive(s_lock);
        ESP_LOGI(TAG, "got ip=%s ssid=%s", ip_address, ssid);
        return;
    }

    xSemaphoreGive(s_lock);
}

static void wifi_mgr_task(void *arg) {
    wifi_ap_record_t ap_info = {0};
    bool should_connect = false;
    TickType_t delay_ticks = 0;
    uint32_t delay_ms = 0U;
    uint32_t now_ms = 0U;
    uint32_t connect_due_in_ms = 0U;

    (void)arg;

    s_task_handle = xTaskGetCurrentTaskHandle();
    ESP_ERROR_CHECK(task_registry_register_expected("wifi_task"));
    ESP_ERROR_CHECK(task_registry_mark_running("wifi_task", true));
    ESP_ERROR_CHECK(health_monitor_register_module("wifi_mgr"));

    while (true) {
        delay_ms = WIFI_MGR_IDLE_REFRESH_INTERVAL_MS;
        delay_ticks = pdMS_TO_TICKS(delay_ms);
        should_connect = false;
        connect_due_in_ms = 0U;
        now_ms = unified_tick_now_ms();

        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            if (s_status.connected && esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
                s_status.rssi = ap_info.rssi;
                snprintf(
                    s_status.security,
                    sizeof(s_status.security),
                    "%s",
                    wifi_mgr_auth_mode_name(ap_info.authmode)
                );
                delay_ms = WIFI_MGR_CONNECTED_REFRESH_INTERVAL_MS;
            } else {
                delay_ms = WIFI_MGR_IDLE_REFRESH_INTERVAL_MS;
            }

            if (s_connect_requested
                && s_status.configured
                && s_status.started
                && !s_status.connected
                && !s_scan_in_progress
                && !s_runtime_connect_suppressed
                && !s_startup_connect_suppressed) {
                if (s_next_connect_attempt_ms != 0U && now_ms < s_next_connect_attempt_ms) {
                    connect_due_in_ms = s_next_connect_attempt_ms - now_ms;
                } else {
                    s_connect_requested = false;
                    s_next_connect_attempt_ms = 0U;
                    should_connect = true;
                }
            } else if (s_runtime_connect_suppressed || s_startup_connect_suppressed) {
                s_connect_requested = false;
                s_next_connect_attempt_ms = 0U;
            }

            xSemaphoreGive(s_lock);
        }

        if (connect_due_in_ms > 0U) {
            delay_ms = connect_due_in_ms;
            delay_ticks = pdMS_TO_TICKS(delay_ms);
        }

        if (should_connect) {
            esp_err_t connect_err = wifi_mgr_run_connect_attempt();

            if (connect_err != ESP_OK && connect_err != ESP_ERR_WIFI_CONN && connect_err != ESP_ERR_WIFI_STATE) {
                ESP_LOGW(TAG, "connect attempt failed: %s", esp_err_to_name(connect_err));
            }
        }

        ESP_ERROR_CHECK(task_registry_heartbeat("wifi_task"));
        (void)ulTaskNotifyTake(pdTRUE, delay_ticks);
    }
}

esp_err_t wifi_mgr_init(void) {
    BaseType_t task_ok = pdFAIL;
    config_mgr_data_t config = {0};
    wifi_init_config_t wifi_init = WIFI_INIT_CONFIG_DEFAULT();
    wifi_config_t wifi_config = {0};
    esp_err_t err = ESP_OK;

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

    config_mgr_snapshot(&config);
    s_status.configured = config.wifi_ssid[0] != '\0';
    snprintf(s_status.ssid, sizeof(s_status.ssid), "%s", config.wifi_ssid);
    s_startup_connect_suppressed =
#if defined(CONFIG_UNIFIED_WIFI_DEFER_STARTUP_CONNECT)
        s_status.configured;
#else
        false;
#endif

    ESP_ERROR_CHECK(esp_netif_init());
    err = wifi_mgr_create_default_loop();
    if (err != ESP_OK) {
        return err;
    }

    s_wifi_netif = esp_netif_create_default_wifi_sta();
    if (!s_wifi_netif) {
        return ESP_ERR_NO_MEM;
    }

    ESP_ERROR_CHECK(esp_wifi_init(&wifi_init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_mgr_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_mgr_event_handler, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));

    if (s_status.configured) {
        wifi_mgr_build_sta_config(&config, &wifi_config, NULL);
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    }

    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_max_tx_power(84));
#if defined(CONFIG_UNIFIED_WIFI_DISABLE_POWER_SAVE)
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    ESP_LOGI(TAG, "power save disabled for stability, tx_power=max");
#else
    ESP_LOGI(TAG, "power save left at ESP-IDF default, tx_power=max");
#endif

    task_ok = xTaskCreatePinnedToCore(
        wifi_mgr_task,
        "wifi_task",
        CONFIG_UNIFIED_TASK_STACK_MEDIUM,
        NULL,
        4,
        NULL,
        1
    );
    if (task_ok != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    s_ready = true;
    ESP_LOGI(TAG, "ready configured=%d ssid=%s", s_status.configured ? 1 : 0, s_status.configured ? s_status.ssid : "<unset>");
    return ESP_OK;
}

esp_err_t wifi_mgr_request_connect(void) {
    config_mgr_data_t config = {0};
    wifi_config_t wifi_config = {0};
    char ssid[sizeof(s_status.ssid)] = {0};
    bool configured = false;
    bool started = false;
    bool connected = false;
    bool config_changed = false;
    bool reconnect_for_config_change = false;
    bool reconnect_was_suppressed = false;

    if (!s_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    config_changed = wifi_mgr_refresh_config_locked(&config);
    if (config_changed && s_status.configured) {
        wifi_mgr_build_sta_config(&config, &wifi_config, NULL);
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    }
    configured = s_status.configured;
    started = s_status.started;
    connected = s_status.connected;
    reconnect_was_suppressed = s_runtime_connect_suppressed;
    s_runtime_connect_suppressed = false;
    s_status.reconnect_suppressed = false;
    s_next_connect_attempt_ms = 0U;
    wifi_mgr_reset_absent_retry_backoff();
    reconnect_for_config_change = config_changed && configured && started && connected;
    if (reconnect_for_config_change) {
        s_status.connected = false;
        s_status.ip_assigned = false;
        s_status.ip_address[0] = '\0';
    }
    s_startup_connect_suppressed = false;
    if (!connected || reconnect_for_config_change) {
        wifi_mgr_request_connect_locked();
    }
    snprintf(ssid, sizeof(ssid), "%s", s_status.ssid);
    xSemaphoreGive(s_lock);

    if (!configured || !started) {
        return ESP_OK;
    }

    if (reconnect_was_suppressed) {
        ESP_LOGI(TAG, "manual connect request cleared runtime reconnect suppression ssid=%s", ssid[0] ? ssid : "<unset>");
    }

    if (reconnect_for_config_change) {
        ESP_LOGI(TAG, "manual reconnect requested after config change ssid=%s", ssid);
        (void)esp_wifi_disconnect();
        vTaskDelay(pdMS_TO_TICKS(150));
        wifi_mgr_notify_task();
        return ESP_OK;
    }

    if (connected) {
        return ESP_OK;
    }

    ESP_LOGI(TAG, "manual connect request scheduled ssid=%s", ssid);
    wifi_mgr_notify_task();
    return ESP_OK;
}

esp_err_t wifi_mgr_set_enabled(bool enabled) {
    bool configured = false;
    bool started = false;
    bool connected = false;
    char ssid[sizeof(s_status.ssid)] = {0};

    if (!s_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    configured = s_status.configured;
    started = s_status.started;
    connected = s_status.connected;
    snprintf(ssid, sizeof(ssid), "%s", s_status.ssid);

    if (enabled) {
        s_runtime_connect_suppressed = false;
        s_status.reconnect_suppressed = false;
        s_startup_connect_suppressed = false;
        wifi_mgr_reset_absent_retry_backoff();
        if (configured && !started) {
            s_connect_requested = true;
        } else if (configured && started && !connected) {
            wifi_mgr_request_connect_locked();
        }
    } else {
        s_runtime_connect_suppressed = true;
        s_startup_connect_suppressed = true;
        s_status.reconnect_suppressed = true;
        s_connect_requested = false;
        s_next_connect_attempt_ms = 0U;
        wifi_mgr_reset_absent_retry_backoff();
        s_status.started = false;
        s_status.connected = false;
        s_status.ip_assigned = false;
        s_status.ip_address[0] = '\0';
        s_status.rssi = 0;
        s_status.security[0] = '\0';
        s_status.runtime.running = false;
        s_status.runtime.last_error = ESP_OK;
        s_status.runtime.last_error_text[0] = '\0';
        wifi_mgr_update_health_locked();
    }

    xSemaphoreGive(s_lock);

    if (enabled) {
        if (!started) {
            esp_err_t err = esp_wifi_start();
            if (err == ESP_ERR_WIFI_CONN || err == ESP_ERR_WIFI_STATE) {
                err = ESP_OK;
            }
            return err;
        }
        if (configured && !connected) {
            ESP_LOGI(TAG, "runtime Wi-Fi enable requested ssid=%s", ssid[0] ? ssid : "<unset>");
            wifi_mgr_notify_task();
        }
        return ESP_OK;
    }

    if (!started) {
        return ESP_OK;
    }

    ESP_LOGI(TAG, "runtime Wi-Fi disable requested ssid=%s", ssid[0] ? ssid : "<unset>");
    {
        esp_err_t err = esp_wifi_stop();
        if (err == ESP_ERR_WIFI_CONN || err == ESP_ERR_WIFI_STATE) {
            err = ESP_OK;
        }
        return err;
    }
}

esp_err_t wifi_mgr_disconnect(bool suppress_reconnect) {
    bool configured = false;
    bool started = false;
    bool connected = false;
    bool ip_assigned = false;
    char ssid[sizeof(s_status.ssid)] = {0};
    esp_err_t err = ESP_OK;

    if (!s_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    s_runtime_connect_suppressed = suppress_reconnect;
    s_status.reconnect_suppressed = suppress_reconnect;
    if (suppress_reconnect) {
        s_connect_requested = false;
        s_next_connect_attempt_ms = 0U;
        wifi_mgr_reset_absent_retry_backoff();
    }
    configured = s_status.configured;
    started = s_status.started;
    connected = s_status.connected;
    ip_assigned = s_status.ip_assigned;
    snprintf(ssid, sizeof(ssid), "%s", s_status.ssid);
    xSemaphoreGive(s_lock);

    if (suppress_reconnect) {
        ESP_LOGI(TAG, "runtime reconnect suppressed for disconnect ssid=%s", ssid[0] ? ssid : "<unset>");
    }

    if (!configured || !started || (!connected && !ip_assigned)) {
        return ESP_OK;
    }

    err = esp_wifi_disconnect();
    if (err == ESP_ERR_WIFI_NOT_CONNECT || err == ESP_ERR_WIFI_CONN) {
        return ESP_OK;
    }
    return err;
}

void wifi_mgr_get_status(wifi_mgr_status_t *out_status) {
    if (!out_status) {
        return;
    }

    memset(out_status, 0, sizeof(*out_status));
    if (!s_lock) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    (void)wifi_mgr_refresh_config_locked(NULL);
    *out_status = s_status;
    xSemaphoreGive(s_lock);
}

void wifi_mgr_notify_task(void) {
    if (s_task_handle) {
        xTaskNotifyGive(s_task_handle);
    }
}

static void wifi_mgr_request_connect_locked(void) {
    if (!s_status.configured || !s_status.started || s_status.connected || s_scan_in_progress) {
        return;
    }
    s_connect_requested = true;
}

