#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define TASK_REGISTRY_NAME_LEN   24

typedef struct {
    char name[TASK_REGISTRY_NAME_LEN];
    bool expected;
    bool initialized;
    bool running;
    uint32_t stack_high_water_bytes;
    uint32_t last_metrics_refresh_ms;
    uint32_t last_heartbeat_ms;
    uint32_t health_min_stack_bytes;
    bool heartbeat_seen;
    bool health_stack_sampled;
} task_registry_record_t;

typedef struct {
    size_t total_count;
    size_t expected_count;
    size_t running_count;
    size_t missing_count;
    size_t stack_tracked_count;
    size_t low_stack_count;
    uint32_t min_stack_high_water_bytes;
    char min_stack_task_name[TASK_REGISTRY_NAME_LEN];
} task_registry_summary_t;

esp_err_t task_registry_init(void);
esp_err_t task_registry_register_expected(const char *name);
esp_err_t task_registry_mark_running(const char *name, bool running);
esp_err_t task_registry_heartbeat(const char *name);
/* All mandatory workers and any other expected workers must be running,
 * recently observed, and have >1024 bytes of measured stack headroom.
 * max_age_ms must be in [1, INT32_MAX]; elapsed time is wrap-safe provided
 * observations are separated by less than one full uint32 millisecond cycle.
 * Missing registry/worker/measurement or lock timeout fails closed. */
bool task_registry_required_healthy(uint32_t max_age_ms);
void task_registry_get_summary(task_registry_summary_t *out_summary);
