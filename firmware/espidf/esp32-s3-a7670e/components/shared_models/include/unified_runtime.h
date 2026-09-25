#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_timer.h"

static inline void unified_copy_cstr(char *dest, size_t dest_len, const char *src) {
    size_t copy_len = 0U;

    if (!dest || dest_len == 0U) {
        return;
    }

    if (!src) {
        dest[0] = '\0';
        return;
    }

    copy_len = strnlen(src, dest_len - 1U);
    if (copy_len > 0U) {
        memcpy(dest, src, copy_len);
    }
    dest[copy_len] = '\0';
}

static inline uint32_t unified_tick_now_ms(void) {
    return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
}

static inline uint32_t unified_time_now_ms(void) {
    return (uint32_t)(esp_timer_get_time() / 1000ULL);
}
