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
void task_registry_get_summary(task_registry_summary_t *out_summary);
