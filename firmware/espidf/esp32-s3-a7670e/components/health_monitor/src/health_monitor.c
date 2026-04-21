#include "health_monitor.h"

#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_log.h"

#include "diagnostics.h"
#include "task_registry.h"
#include "unified_runtime.h"

#define HEALTH_MODULE_CAPACITY CONFIG_UNIFIED_HEALTH_MODULE_CAPACITY
static const char *TAG = "health_monitor";

static SemaphoreHandle_t s_lock;
static health_module_record_t s_records[HEALTH_MODULE_CAPACITY];
static health_monitor_summary_t s_summary;
static bool s_summary_dirty;
static bool s_ready;

static int find_index(const char *name) {
    size_t index = 0;

    for (index = 0; index < HEALTH_MODULE_CAPACITY; ++index) {
        if (s_records[index].name[0] != '\0' && strncmp(s_records[index].name, name, HEALTH_MODULE_NAME_LEN) == 0) {
            return (int)index;
        }
    }
    return -1;
}

static int find_or_create_index(const char *name) {
    int existing = find_index(name);
    size_t index = 0;

    if (existing >= 0) {
        return existing;
    }

    for (index = 0; index < HEALTH_MODULE_CAPACITY; ++index) {
        if (s_records[index].name[0] == '\0') {
            unified_copy_cstr(s_records[index].name, sizeof(s_records[index].name), name);
            s_records[index].state = HEALTH_MODULE_STATE_INIT;
            return (int)index;
        }
    }
    return -1;
}

static void recompute_summary_locked(void) {
    size_t index = 0;
    bool mqtt_ok = false;

    memset(&s_summary, 0, sizeof(s_summary));
    s_summary.ready = s_ready;

    for (index = 0; index < HEALTH_MODULE_CAPACITY; ++index) {
        if (strncmp(s_records[index].name, "mqtt_mgr", HEALTH_MODULE_NAME_LEN) == 0 &&
            s_records[index].state == HEALTH_MODULE_STATE_OK) {
            mqtt_ok = true;
            break;
        }
    }

    for (index = 0; index < HEALTH_MODULE_CAPACITY; ++index) {
        bool degraded = false;
        bool failed = false;

        if (s_records[index].name[0] == '\0') {
            continue;
        }
        s_summary.module_count++;

        degraded = s_records[index].state == HEALTH_MODULE_STATE_DEGRADED;
        failed = s_records[index].state == HEALTH_MODULE_STATE_FAILED;
        if (mqtt_ok &&
            degraded &&
            strncmp(s_records[index].name, "wifi_mgr", HEALTH_MODULE_NAME_LEN) == 0 &&
            strncmp(s_records[index].last_error, "wifi_disconnected", sizeof(s_records[index].last_error)) == 0) {
            degraded = false;
        }

        if (degraded) {
            s_summary.degraded_count++;
        }
        if (failed) {
            s_summary.failed_count++;
        }
        if (s_records[index].state == HEALTH_MODULE_STATE_STUB) {
            s_summary.stub_count++;
        }
        if (degraded || failed) {
            s_summary.degraded = true;
            unified_copy_cstr(s_summary.last_reason, sizeof(s_summary.last_reason), s_records[index].last_error);
        }
    }
}

static void health_monitor_apply_runtime_overlays(
    health_monitor_summary_t *summary,
    const diagnostics_runtime_t *runtime,
    const task_registry_summary_t *task_summary,
    bool runtime_valid
) {
    if (!summary) {
        return;
    }

    summary->missing_task_count = task_summary ? task_summary->missing_count : 0U;
    if (task_summary && task_summary->missing_count > 0U) {
        summary->degraded = true;
        unified_copy_cstr(summary->last_reason, sizeof(summary->last_reason), "missing_task");
    }
    if (runtime_valid && runtime && runtime->free_heap_bytes < 32768U) {
        summary->degraded = true;
        unified_copy_cstr(summary->last_reason, sizeof(summary->last_reason), "low_heap");
    }
}

static void health_monitor_get_summary_internal(
    const diagnostics_runtime_t *runtime,
    const task_registry_summary_t *task_summary,
    bool runtime_valid,
    health_monitor_summary_t *out_summary
) {
    diagnostics_runtime_t local_runtime = {0};
    task_registry_summary_t local_task_summary = {0};

    if (!out_summary) {
        return;
    }

    memset(out_summary, 0, sizeof(*out_summary));
    if (!s_ready || !s_lock) {
        return;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }
    if (s_summary_dirty) {
        recompute_summary_locked();
        s_summary_dirty = false;
    }
    *out_summary = s_summary;
    xSemaphoreGive(s_lock);

    if (!task_summary) {
        task_registry_get_summary(&local_task_summary);
        task_summary = &local_task_summary;
    }
    if (!runtime_valid || !runtime) {
        diagnostics_snapshot(&local_runtime);
        runtime = &local_runtime;
        runtime_valid = true;
    }

    health_monitor_apply_runtime_overlays(out_summary, runtime, task_summary, runtime_valid);
}

esp_err_t health_monitor_init(void) {
    if (s_ready) {
        return ESP_OK;
    }

    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) {
        return ESP_ERR_NO_MEM;
    }

    memset(s_records, 0, sizeof(s_records));
    memset(&s_summary, 0, sizeof(s_summary));
    s_summary_dirty = true;
    s_ready = true;

    ESP_ERROR_CHECK(health_monitor_register_module("health_monitor"));
    ESP_ERROR_CHECK(health_monitor_set_module_state("health_monitor", HEALTH_MODULE_STATE_OK, "running"));

    ESP_LOGI(TAG, "ready");
    return ESP_OK;
}

esp_err_t health_monitor_register_module(const char *name) {
    int index = -1;
    bool was_initialized = false;

    if (!s_ready || !s_lock || !name || name[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    index = find_or_create_index(name);
    if (index < 0) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_NO_MEM;
    }

    was_initialized = s_records[index].initialized;
    s_records[index].initialized = true;
    if (!was_initialized) {
        s_summary_dirty = true;
    }
    xSemaphoreGive(s_lock);
    return ESP_OK;
}

esp_err_t health_monitor_set_module_state(const char *name, health_module_state_t state, const char *reason) {
    int index = -1;
    bool running = false;
    bool state_changed = false;
    bool reason_changed = false;
    bool was_initialized = false;

    if (!s_ready || !s_lock || !name) {
        return ESP_ERR_INVALID_ARG;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    index = find_or_create_index(name);
    if (index < 0) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_NO_MEM;
    }

    running = (state == HEALTH_MODULE_STATE_OK || state == HEALTH_MODULE_STATE_STUB);
    was_initialized = s_records[index].initialized;
    state_changed = s_records[index].state != state || s_records[index].running != running;
    reason_changed = strncmp(
        s_records[index].last_error,
        reason ? reason : "",
        sizeof(s_records[index].last_error)
    ) != 0;

    if (!state_changed && !reason_changed && was_initialized) {
        xSemaphoreGive(s_lock);
        return ESP_OK;
    }

    s_records[index].initialized = true;
    s_records[index].running = running;
    s_records[index].state = state;
    unified_copy_cstr(s_records[index].last_error, sizeof(s_records[index].last_error), reason);
    if (state_changed || reason_changed || !was_initialized) {
        s_summary_dirty = true;
    }

    xSemaphoreGive(s_lock);
    return ESP_OK;
}

void health_monitor_get_summary_with_context(
    const diagnostics_runtime_t *runtime,
    const task_registry_summary_t *task_summary,
    health_monitor_summary_t *out_summary
) {
    health_monitor_get_summary_internal(runtime, task_summary, runtime != NULL, out_summary);
}
