#include "task_registry.h"

#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "unified_runtime.h"

#define TASK_REGISTRY_CAPACITY CONFIG_UNIFIED_TASK_REGISTRY_CAPACITY
#define TASK_REGISTRY_LOW_STACK_THRESHOLD_BYTES 1024U
#define TASK_REGISTRY_RUNTIME_METRICS_REFRESH_MS 30000U

static SemaphoreHandle_t s_lock;
static task_registry_record_t s_records[TASK_REGISTRY_CAPACITY];
static task_registry_summary_t s_summary;
static bool s_summary_dirty;
static bool s_ready;

static int find_index(const char *name) {
    size_t index = 0;

    for (index = 0; index < TASK_REGISTRY_CAPACITY; ++index) {
        if (s_records[index].name[0] != '\0' && strncmp(s_records[index].name, name, TASK_REGISTRY_NAME_LEN) == 0) {
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

    for (index = 0; index < TASK_REGISTRY_CAPACITY; ++index) {
        if (s_records[index].name[0] == '\0') {
            unified_copy_cstr(s_records[index].name, sizeof(s_records[index].name), name);
            return (int)index;
        }
    }
    return -1;
}

static bool update_runtime_metrics(task_registry_record_t *record, bool force) {
    UBaseType_t stack_bytes = 0U;
    uint32_t now_ms = 0U;

    if (!record) {
        return false;
    }

    now_ms = unified_tick_now_ms();
    if (!force &&
        record->last_metrics_refresh_ms != 0U &&
        (now_ms - record->last_metrics_refresh_ms) < TASK_REGISTRY_RUNTIME_METRICS_REFRESH_MS) {
        return false;
    }

    stack_bytes = uxTaskGetStackHighWaterMark(NULL);
    if (stack_bytes > 0U &&
        (record->stack_high_water_bytes == 0U || stack_bytes < record->stack_high_water_bytes)) {
        record->stack_high_water_bytes = (uint32_t)stack_bytes;
        record->last_metrics_refresh_ms = now_ms;
        return true;
    }
    record->last_metrics_refresh_ms = now_ms;
    return false;
}

static void task_registry_recompute_summary_locked(void) {
    size_t index = 0U;

    memset(&s_summary, 0, sizeof(s_summary));
    for (index = 0; index < TASK_REGISTRY_CAPACITY; ++index) {
        if (s_records[index].name[0] == '\0') {
            continue;
        }
        s_summary.total_count++;
        if (s_records[index].expected) {
            s_summary.expected_count++;
        }
        if (s_records[index].running) {
            s_summary.running_count++;
        }
        if (s_records[index].expected && !s_records[index].running) {
            s_summary.missing_count++;
        }
        if (s_records[index].stack_high_water_bytes > 0U) {
            s_summary.stack_tracked_count++;
            if (s_summary.min_stack_high_water_bytes == 0U ||
                s_records[index].stack_high_water_bytes < s_summary.min_stack_high_water_bytes) {
                s_summary.min_stack_high_water_bytes = s_records[index].stack_high_water_bytes;
                unified_copy_cstr(
                    s_summary.min_stack_task_name,
                    sizeof(s_summary.min_stack_task_name),
                    s_records[index].name
                );
            }
            if (s_records[index].stack_high_water_bytes <= TASK_REGISTRY_LOW_STACK_THRESHOLD_BYTES) {
                s_summary.low_stack_count++;
            }
        }
    }

    s_summary_dirty = false;
}

esp_err_t task_registry_init(void) {
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
    return ESP_OK;
}

esp_err_t task_registry_register_expected(const char *name) {
    int index = -1;
    bool was_expected = false;

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

    was_expected = s_records[index].expected;
    s_records[index].expected = true;
    s_records[index].initialized = true;
    if (!was_expected) {
        s_summary_dirty = true;
    }
    xSemaphoreGive(s_lock);
    return ESP_OK;
}

esp_err_t task_registry_mark_running(const char *name, bool running) {
    int index = -1;

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

    s_records[index].initialized = true;
    if (s_records[index].running != running) {
        s_records[index].running = running;
        s_summary_dirty = true;
    }
    if (running && update_runtime_metrics(&s_records[index], true)) {
        s_summary_dirty = true;
    }
    xSemaphoreGive(s_lock);
    return ESP_OK;
}

esp_err_t task_registry_heartbeat(const char *name) {
    int index = -1;

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

    s_records[index].initialized = true;
    if (!s_records[index].running) {
        s_records[index].running = true;
        s_summary_dirty = true;
    }
    if (update_runtime_metrics(&s_records[index], false)) {
        s_summary_dirty = true;
    }
    xSemaphoreGive(s_lock);
    return ESP_OK;
}

void task_registry_get_summary(task_registry_summary_t *out_summary) {
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
        task_registry_recompute_summary_locked();
    }
    *out_summary = s_summary;

    xSemaphoreGive(s_lock);
}


