#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

/* Physical removable media, independent of the internal-flash durable spool. */
typedef struct {
    bool detected;
    bool mounted;
    uint64_t capacity_bytes;
    uint64_t total_bytes;
    uint64_t used_bytes;
    uint64_t free_bytes;
    char error[24];
} storage_sd_status_t;

/* Storage worker only. No formatting, file creation, or application writes. */
esp_err_t storage_sd_init(void);
esp_err_t storage_sd_acquire(uint32_t timeout_ms);
void storage_sd_release(void);
void storage_sd_poll(bool enabled, storage_sd_status_t *out_status);
