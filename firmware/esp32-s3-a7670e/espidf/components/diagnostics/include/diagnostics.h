#pragma once

#include <stdint.h>

#include "esp_err.h"
#include "esp_system.h"

#define DIAGNOSTICS_BREADCRUMB_LEN  48

typedef struct {
    uint32_t uptime_ms;
    uint32_t free_heap_bytes;
    uint32_t min_free_heap_bytes;
    uint32_t largest_free_block_bytes;
    uint32_t internal_free_heap_bytes;
    uint32_t internal_largest_free_block_bytes;
    uint32_t free_psram_bytes;
    esp_reset_reason_t reset_reason;
    char last_boot_breadcrumb[DIAGNOSTICS_BREADCRUMB_LEN];
} diagnostics_runtime_t;

esp_err_t diagnostics_init(void);
void diagnostics_snapshot(diagnostics_runtime_t *out_runtime);
