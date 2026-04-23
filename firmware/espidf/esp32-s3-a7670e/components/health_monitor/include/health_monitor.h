#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "diagnostics.h"
#include "task_registry.h"

#define HEALTH_MODULE_NAME_LEN   24
#define HEALTH_MODULE_ERROR_LEN  48

typedef enum {
    HEALTH_MODULE_STATE_INIT = 0,
    HEALTH_MODULE_STATE_OK,
    HEALTH_MODULE_STATE_DEGRADED,
    HEALTH_MODULE_STATE_RESTARTING,
    HEALTH_MODULE_STATE_FAILED,
    HEALTH_MODULE_STATE_STUB,
} health_module_state_t;

typedef struct {
    char name[HEALTH_MODULE_NAME_LEN];
    bool initialized;
    bool running;
    health_module_state_t state;
    char last_error[HEALTH_MODULE_ERROR_LEN];
} health_module_record_t;

typedef struct {
    bool ready;
    bool degraded;
    size_t module_count;
    size_t degraded_count;
    size_t failed_count;
    size_t stub_count;
    size_t missing_task_count;
    char last_reason[HEALTH_MODULE_ERROR_LEN];
} health_monitor_summary_t;

esp_err_t health_monitor_init(void);
esp_err_t health_monitor_register_module(const char *name);
esp_err_t health_monitor_set_module_state(const char *name, health_module_state_t state, const char *reason);
void health_monitor_get_summary_with_context(
    const diagnostics_runtime_t *runtime,
    const task_registry_summary_t *task_summary,
    health_monitor_summary_t *out_summary
);
