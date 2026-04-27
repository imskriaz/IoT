#include "telemetry_service.h"

#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "common_models.h"
#include "config_mgr.h"
#include "device_status.h"
#include "esp_heap_caps.h"
#include "health_monitor.h"
#include "mqtt_mgr.h"
#include "status_watch.h"
#include "task_registry.h"
#include "unified_runtime.h"

#define TELEMETRY_STATUS_BUFFER_LEN              3072U
#define TELEMETRY_STABLE_HEARTBEAT_INTERVAL_MS  60000U
#define TELEMETRY_HEAP_BUCKET_BYTES              4096U
#define TELEMETRY_SIGNAL_BUCKET_PERCENT          5
#define TELEMETRY_RSSI_BUCKET_DBM                5
#define TELEMETRY_VOLTAGE_BUCKET_MV             50
#define TELEMETRY_TEMPERATURE_BUCKET_C           2
#define TELEMETRY_HASH_SEED               2166136261U
#define TELEMETRY_HASH_PRIME               16777619U

typedef struct {
    unified_service_runtime_t runtime;
    uint32_t status_publish_count;
    uint32_t forced_publish_count;
    uint32_t change_publish_count;
    uint32_t publish_failures;
    uint32_t skipped_cycles;
    uint32_t unchanged_skip_count;
    uint32_t last_publish_ms;
    uint32_t stable_publish_interval_ms;
    char last_publish_reason[24];
} telemetry_service_status_t;

static telemetry_service_status_t s_status;
static SemaphoreHandle_t s_lock;
static bool s_ready;
static char *s_status_json_buffer;
static uint32_t s_last_publish_fingerprint;
static uint32_t s_last_publish_ms;
static bool s_have_last_publish;
static bool s_last_mqtt_connected;
static bool s_publish_retry_pending;
static TaskHandle_t s_task_handle;
static uint32_t s_cached_status_interval_ms;
static uint32_t s_cached_status_interval_revision;

static void telemetry_service_handle_status_watch_update(void) {
    TaskHandle_t task_handle = s_task_handle;

    if (task_handle) {
        xTaskNotifyGive(task_handle);
    }
}

static void telemetry_service_set_health_locked(bool ready, const char *detail) {
    s_status.runtime.running = ready;
    s_status.runtime.state = ready ? UNIFIED_MODULE_STATE_RUNNING : UNIFIED_MODULE_STATE_DEGRADED;
    (void)health_monitor_set_module_state(
        "telemetry_service",
        ready ? HEALTH_MODULE_STATE_OK : HEALTH_MODULE_STATE_DEGRADED,
        detail ? detail : (ready ? "running" : "mqtt_not_connected")
    );
}

static uint32_t telemetry_configured_status_interval_ms(void) {
    uint32_t config_revision = config_mgr_revision();

    if (s_cached_status_interval_ms != 0U &&
        config_revision != 0U &&
        s_cached_status_interval_revision == config_revision) {
        return s_cached_status_interval_ms;
    }

    s_cached_status_interval_ms = config_mgr_device_status_interval_ms();
    s_cached_status_interval_revision = config_revision;
    return s_cached_status_interval_ms;
}

static uint32_t telemetry_bucket_u32(uint32_t value, uint32_t bucket_size) {
    if (bucket_size <= 1U) {
        return value;
    }

    return (value / bucket_size) * bucket_size;
}

static int32_t telemetry_bucket_i32(int32_t value, int32_t bucket_size) {
    int32_t magnitude = 0;

    if (bucket_size <= 1) {
        return value;
    }
    if (value == 0) {
        return 0;
    }

    magnitude = value > 0 ? value : -value;
    magnitude = (magnitude / bucket_size) * bucket_size;
    if (magnitude == 0) {
        magnitude = bucket_size;
    }

    return value > 0 ? magnitude : -magnitude;
}

static uint32_t telemetry_hash_bytes(uint32_t hash, const void *data, size_t len) {
    const uint8_t *cursor = (const uint8_t *)data;
    size_t index = 0U;

    for (index = 0U; index < len; ++index) {
        hash ^= (uint32_t)cursor[index];
        hash *= TELEMETRY_HASH_PRIME;
    }

    return hash;
}

static uint32_t telemetry_hash_bool(uint32_t hash, bool value) {
    const uint8_t encoded = value ? 1U : 0U;
    return telemetry_hash_bytes(hash, &encoded, sizeof(encoded));
}

static uint32_t telemetry_hash_u32(uint32_t hash, uint32_t value) {
    return telemetry_hash_bytes(hash, &value, sizeof(value));
}

static uint32_t telemetry_hash_i32(uint32_t hash, int32_t value) {
    return telemetry_hash_bytes(hash, &value, sizeof(value));
}

static uint32_t telemetry_hash_text(uint32_t hash, const char *value) {
    size_t len = value ? strlen(value) : 0U;
    hash = telemetry_hash_u32(hash, (uint32_t)len);
    if (len == 0U) {
        return hash;
    }
    return telemetry_hash_bytes(hash, value, len);
}

static uint32_t telemetry_snapshot_fingerprint(const device_status_snapshot_t *snapshot) {
    uint32_t hash = TELEMETRY_HASH_SEED;

    if (!snapshot) {
        return 0U;
    }

    hash = telemetry_hash_text(hash, snapshot->device_id);
    hash = telemetry_hash_text(hash, snapshot->active_path);
    hash = telemetry_hash_u32(hash, telemetry_bucket_u32(snapshot->internal_free_heap_bytes, TELEMETRY_HEAP_BUCKET_BYTES));
    hash = telemetry_hash_u32(hash, telemetry_bucket_u32(snapshot->internal_largest_free_block_bytes, TELEMETRY_HEAP_BUCKET_BYTES));
    hash = telemetry_hash_u32(hash, telemetry_bucket_u32(snapshot->free_psram_bytes, TELEMETRY_HEAP_BUCKET_BYTES));
    hash = telemetry_hash_bool(hash, snapshot->wifi_configured);
    hash = telemetry_hash_bool(hash, snapshot->wifi_started);
    hash = telemetry_hash_bool(hash, snapshot->wifi_connected);
    hash = telemetry_hash_bool(hash, snapshot->wifi_ip_assigned);
    hash = telemetry_hash_bool(hash, snapshot->wifi_last_scan_target_visible);
    hash = telemetry_hash_i32(hash, telemetry_bucket_i32((int32_t)snapshot->wifi_rssi, TELEMETRY_RSSI_BUCKET_DBM));
    hash = telemetry_hash_u32(hash, snapshot->wifi_last_disconnect_reason);
    hash = telemetry_hash_u32(hash, snapshot->wifi_last_scan_visible_count);
    hash = telemetry_hash_text(hash, snapshot->wifi_last_disconnect_reason_text);
    hash = telemetry_hash_text(hash, snapshot->wifi_last_scan_summary);
    hash = telemetry_hash_text(hash, snapshot->wifi_ssid);
    hash = telemetry_hash_text(hash, snapshot->wifi_ip_address);
    hash = telemetry_hash_text(hash, snapshot->wifi_security);
    hash = telemetry_hash_bool(hash, snapshot->mqtt_configured);
    hash = telemetry_hash_bool(hash, snapshot->mqtt_connected);
    hash = telemetry_hash_bool(hash, snapshot->mqtt_subscribed);
    hash = telemetry_hash_u32(hash, snapshot->mqtt_reconnect_count);
    hash = telemetry_hash_bool(hash, snapshot->sd_mounted);
    hash = telemetry_hash_bool(hash, snapshot->storage_media_available);
    hash = telemetry_hash_bool(hash, snapshot->storage_buffered_only);
    hash = telemetry_hash_u32(hash, snapshot->storage_queue_depth);
    hash = telemetry_hash_u32(hash, (uint32_t)snapshot->low_stack_task_count);
    hash = telemetry_hash_u32(hash, snapshot->min_stack_high_water_bytes);
    hash = telemetry_hash_text(hash, snapshot->min_stack_task_name);
    hash = telemetry_hash_bool(hash, snapshot->health_degraded);
    hash = telemetry_hash_u32(hash, (uint32_t)snapshot->degraded_module_count);
    hash = telemetry_hash_u32(hash, (uint32_t)snapshot->failed_module_count);
    hash = telemetry_hash_text(hash, snapshot->health_last_reason);
    hash = telemetry_hash_bool(hash, snapshot->modem_registered);
    hash = telemetry_hash_bool(hash, snapshot->telephony_supported);
    hash = telemetry_hash_bool(hash, snapshot->telephony_enabled);
    hash = telemetry_hash_bool(hash, snapshot->data_mode_enabled);
    hash = telemetry_hash_bool(hash, snapshot->modem_ip_bearer_ready);
    hash = telemetry_hash_i32(hash, telemetry_bucket_i32((int32_t)snapshot->modem_signal, TELEMETRY_SIGNAL_BUCKET_PERCENT));
    hash = telemetry_hash_i32(hash, snapshot->battery_percent);
    hash = telemetry_hash_i32(hash, snapshot->charging_state);
    hash = telemetry_hash_i32(hash, telemetry_bucket_i32(snapshot->voltage_mv, TELEMETRY_VOLTAGE_BUCKET_MV));
    hash = telemetry_hash_i32(hash, telemetry_bucket_i32(snapshot->temperature_c, TELEMETRY_TEMPERATURE_BUCKET_C));
    hash = telemetry_hash_text(hash, snapshot->modem_operator);
    hash = telemetry_hash_text(hash, snapshot->modem_network_type);
    hash = telemetry_hash_text(hash, snapshot->modem_subscriber_number);
    hash = telemetry_hash_text(hash, snapshot->modem_ip_address);
    hash = telemetry_hash_text(hash, snapshot->modem_data_ip);
    hash = telemetry_hash_bool(hash, snapshot->sms_ready);
    hash = telemetry_hash_u32(hash, snapshot->sms_sent_count);
    hash = telemetry_hash_u32(hash, snapshot->sms_received_count);
    hash = telemetry_hash_u32(hash, snapshot->sms_failure_count);
    hash = telemetry_hash_text(hash, snapshot->sms_last_detail);
    hash = telemetry_hash_text(hash, snapshot->sms_last_destination);
    hash = telemetry_hash_text(hash, snapshot->reboot_reason);

    return hash == 0U ? 1U : hash;
}

static uint32_t telemetry_stable_publish_interval_ms(uint32_t configured_interval_ms) {
    if (configured_interval_ms > TELEMETRY_STABLE_HEARTBEAT_INTERVAL_MS) {
        return configured_interval_ms;
    }
    return TELEMETRY_STABLE_HEARTBEAT_INTERVAL_MS;
}

static void telemetry_service_task(void *arg) {
    mqtt_mgr_status_t mqtt = {0};
    device_status_snapshot_t snapshot;
    status_watch_policy_t watch_policy = {0};
    uint32_t now_ms = 0U;
    uint32_t stable_publish_interval_ms = TELEMETRY_STABLE_HEARTBEAT_INTERVAL_MS;
    uint32_t sample_interval_ms = CONFIG_UNIFIED_DEVICE_STATUS_INTERVAL_MS;
    uint32_t fingerprint = 0U;
    bool mqtt_reconnected = false;
    bool force_publish = false;
    bool changed = false;
    bool should_publish = false;
    const char *publish_reason = "unchanged";
    esp_err_t err = ESP_OK;

    (void)arg;
    s_task_handle = xTaskGetCurrentTaskHandle();

    ESP_ERROR_CHECK(task_registry_register_expected("telemetry_task"));
    ESP_ERROR_CHECK(task_registry_mark_running("telemetry_task", true));
    ESP_ERROR_CHECK(health_monitor_register_module("telemetry_service"));

    while (true) {
        mqtt_mgr_get_status(&mqtt);
        status_watch_get_policy(&watch_policy);
        now_ms = unified_tick_now_ms();
        sample_interval_ms = watch_policy.active ? watch_policy.active_interval_ms : watch_policy.idle_interval_ms;
        stable_publish_interval_ms = watch_policy.active
            ? telemetry_stable_publish_interval_ms(telemetry_configured_status_interval_ms())
            : watch_policy.idle_interval_ms;

        if (!mqtt.connected) {
            s_last_mqtt_connected = false;
            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                if (s_status.stable_publish_interval_ms != stable_publish_interval_ms) {
                    s_status.stable_publish_interval_ms = stable_publish_interval_ms;
                }
                s_status.skipped_cycles++;
                s_status.runtime.last_error = ESP_ERR_INVALID_STATE;
                snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", "mqtt_not_connected");
                snprintf(s_status.last_publish_reason, sizeof(s_status.last_publish_reason), "%s", "mqtt_offline");
                telemetry_service_set_health_locked(false, "mqtt_not_connected");
                xSemaphoreGive(s_lock);
            }
        } else {
            if (!s_last_mqtt_connected) {
                if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                    s_status.runtime.last_error = ESP_OK;
                    s_status.runtime.last_error_text[0] = '\0';
                    telemetry_service_set_health_locked(true, "running");
                    xSemaphoreGive(s_lock);
                }
            }
            err = device_status_snapshot(&snapshot);
            if (err == ESP_OK) {
                fingerprint = telemetry_snapshot_fingerprint(&snapshot);
                mqtt_reconnected = !s_last_mqtt_connected;
                force_publish = !s_have_last_publish
                    || s_publish_retry_pending
                    || mqtt_reconnected
                    || ((now_ms - s_last_publish_ms) >= stable_publish_interval_ms);
                changed = !s_have_last_publish || (fingerprint != s_last_publish_fingerprint);
                should_publish = force_publish || changed;

                if (!s_have_last_publish) {
                    publish_reason = "initial";
                } else if (s_publish_retry_pending) {
                    publish_reason = "retry_pending";
                } else if (mqtt_reconnected) {
                    publish_reason = "mqtt_reconnected";
                } else if (changed) {
                    publish_reason = "state_changed";
                } else if (force_publish) {
                    publish_reason = "heartbeat_due";
                } else {
                    publish_reason = "unchanged";
                }

                if (should_publish) {
                    err = device_status_build_json_from_snapshot(&snapshot, s_status_json_buffer, TELEMETRY_STATUS_BUFFER_LEN);
                    if (err == ESP_OK) {
                        err = mqtt_mgr_publish_json("status", s_status_json_buffer);
                    }
                }
            }

            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                if (s_status.stable_publish_interval_ms != stable_publish_interval_ms) {
                    s_status.stable_publish_interval_ms = stable_publish_interval_ms;
                }
                if (err == ESP_OK && should_publish) {
                    s_status.status_publish_count++;
                    if (changed) {
                        s_status.change_publish_count++;
                    }
                    if (force_publish && !changed) {
                        s_status.forced_publish_count++;
                    }
                    s_status.last_publish_ms = now_ms;
                    snprintf(s_status.last_publish_reason, sizeof(s_status.last_publish_reason), "%s", publish_reason);
                    s_status.runtime.last_error = ESP_OK;
                    s_status.runtime.last_error_text[0] = '\0';
                    telemetry_service_set_health_locked(true, "running");
                    s_last_publish_fingerprint = fingerprint;
                    s_last_publish_ms = now_ms;
                    s_have_last_publish = true;
                    s_publish_retry_pending = false;
                } else if (err == ESP_OK) {
                    s_status.skipped_cycles++;
                    s_status.unchanged_skip_count++;
                    s_status.runtime.last_error = ESP_OK;
                    s_status.runtime.last_error_text[0] = '\0';
                    snprintf(s_status.last_publish_reason, sizeof(s_status.last_publish_reason), "%s", "unchanged");
                    telemetry_service_set_health_locked(true, "running");
                } else {
                    s_status.publish_failures++;
                    s_publish_retry_pending = true;
                    s_status.runtime.last_error = err;
                    snprintf(
                        s_status.runtime.last_error_text,
                        sizeof(s_status.runtime.last_error_text),
                        "%s",
                        should_publish ? "status_publish_failed" : "status_snapshot_failed"
                    );
                    snprintf(
                        s_status.last_publish_reason,
                        sizeof(s_status.last_publish_reason),
                        "%s",
                        should_publish ? publish_reason : "snapshot_failed"
                    );
                    telemetry_service_set_health_locked(false, should_publish ? "status_publish_failed" : "status_snapshot_failed");
                }
                xSemaphoreGive(s_lock);
            }

            s_last_mqtt_connected = true;
        }

        ESP_ERROR_CHECK(task_registry_heartbeat("telemetry_task"));
        (void)ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(sample_interval_ms));
    }
}

esp_err_t telemetry_service_init(void) {
    BaseType_t task_ok = pdFAIL;

    if (s_ready) {
        return ESP_OK;
    }

    memset(&s_status, 0, sizeof(s_status));
    s_status.runtime.initialized = true;
    s_status.runtime.state = UNIFIED_MODULE_STATE_INITIALIZED;

    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) {
        return ESP_ERR_NO_MEM;
    }

    if (!s_status_json_buffer) {
        s_status_json_buffer = heap_caps_calloc(
            TELEMETRY_STATUS_BUFFER_LEN,
            sizeof(char),
            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
        );
        if (!s_status_json_buffer) {
            s_status_json_buffer = heap_caps_calloc(
                TELEMETRY_STATUS_BUFFER_LEN,
                sizeof(char),
                MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT
            );
        }
        if (!s_status_json_buffer) {
            return ESP_ERR_NO_MEM;
        }
    }

    #if CONFIG_SPIRAM && CONFIG_SPIRAM_ALLOW_STACK_EXTERNAL_MEMORY
    task_ok = xTaskCreatePinnedToCoreWithCaps(
        telemetry_service_task,
        "telemetry_task",
        CONFIG_UNIFIED_TASK_STACK_XLARGE,
        NULL,
        4,
        NULL,
        1,
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT
    );
    #endif
    if (task_ok != pdPASS) {
        task_ok = xTaskCreatePinnedToCore(
            telemetry_service_task,
            "telemetry_task",
            CONFIG_UNIFIED_TASK_STACK_XLARGE,
            NULL,
            4,
            NULL,
            1
        );
    }
    if (task_ok != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    status_watch_set_update_listener(telemetry_service_handle_status_watch_update);
    mqtt_mgr_set_status_listener(telemetry_service_handle_status_watch_update);
    s_ready = true;
    return ESP_OK;
}
