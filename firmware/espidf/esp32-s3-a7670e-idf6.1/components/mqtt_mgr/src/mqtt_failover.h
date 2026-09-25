#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

/* All deadlines must stay within INT32_MAX milliseconds of the current tick.
 * Signed subtraction keeps the comparison correct when the 32-bit tick wraps. */
static inline bool mqtt_failover_retry_pending(uint32_t deadline_ms, uint32_t now_ms) {
    return deadline_ms != 0U && (int32_t)(now_ms - deadline_ms) < 0;
}

static inline bool mqtt_failover_retry_due(uint32_t deadline_ms, uint32_t now_ms) {
    return deadline_ms == 0U || !mqtt_failover_retry_pending(deadline_ms, now_ms);
}

static inline uint32_t mqtt_failover_retry_deadline(uint32_t now_ms, uint32_t delay_ms) {
    uint32_t deadline_ms = now_ms + delay_ms;
    return deadline_ms == 0U ? 1U : deadline_ms;
}

/* Endpoint failures must not occupy the shared modem lane every few seconds.
 * Exponential backoff is capped, deterministic, and reset after a successful
 * connection or an explicit transport change. */
static inline uint32_t mqtt_failover_retry_delay_ms(
    uint8_t consecutive_failures,
    uint32_t base_delay_ms,
    uint32_t max_delay_ms
) {
    uint32_t delay_ms = base_delay_ms;
    uint8_t shifts = consecutive_failures > 0U ? (uint8_t)(consecutive_failures - 1U) : 0U;

    if (base_delay_ms == 0U || max_delay_ms < base_delay_ms) {
        return max_delay_ms;
    }
    while (shifts-- > 0U && delay_ms < max_delay_ms) {
        if (delay_ms > max_delay_ms / 2U) {
            return max_delay_ms;
        }
        delay_ms *= 2U;
    }
    return delay_ms > max_delay_ms ? max_delay_ms : delay_ms;
}

static inline bool mqtt_failover_is_bearer_failure(const char *detail) {
    if (!detail || detail[0] == '\0') {
        return false;
    }

    /* MQTT CONNACK/CMQTT result 3 means the broker is unavailable. Resetting
     * the modem cannot repair that endpoint and disrupts SMS/call service. */
    return strstr(detail, "+IP ERROR") != NULL ||
           strstr(detail, "netopen_no_ip") != NULL ||
           strstr(detail, "pdp_not_ready") != NULL;
}
