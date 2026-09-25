#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

/* Device-generated connection challenge, owned by mqtt_task under its lock.
 * Only a committed current-boot health result followed by its DB ACK proves
 * the round trip. Broker PUBACK and modem AT success alone are insufficient. */
#define OTA_VALIDATION_EXCHANGE_MS 60000U
typedef struct {
    char action_id[32];
    uint32_t started_ms;
    bool published;
    bool acknowledged;
} ota_validation_gate_t;

static inline void ota_validation_reset(ota_validation_gate_t *gate) {
    memset(gate, 0, sizeof(*gate));
}

static inline bool ota_validation_live(const ota_validation_gate_t *gate, uint32_t now_ms) {
    return gate->action_id[0] &&
        (uint32_t)(now_ms - gate->started_ms) < OTA_VALIDATION_EXCHANGE_MS;
}

static inline bool ota_validation_begin(ota_validation_gate_t *gate,
    const char *challenge, uint32_t now_ms) {
    ota_validation_reset(gate);
    if (!challenge || strlen(challenge) != 28U || strncmp(challenge, "ota_", 4U)) return false;
    for (size_t index = 4U; index < 28U; ++index) {
        if (!((challenge[index] >= '0' && challenge[index] <= '9') ||
              (challenge[index] >= 'a' && challenge[index] <= 'f'))) return false;
    }
    memcpy(gate->action_id, challenge, 29U);
    gate->started_ms = now_ms;
    return true;
}

static inline bool ota_validation_published(ota_validation_gate_t *gate,
    const char *action_id, uint32_t created_ms, uint32_t now_ms,
    bool successful_health, bool current_boot) {
    if (!ota_validation_live(gate, now_ms) || !successful_health || !current_boot ||
        !action_id || strcmp(action_id, gate->action_id) ||
        (uint32_t)(created_ms - gate->started_ms) >= OTA_VALIDATION_EXCHANGE_MS) return false;
    gate->published = true;
    return true;
}

static inline bool ota_validation_ack(ota_validation_gate_t *gate,
    const char *action_id, uint32_t now_ms, bool subscribed) {
    if (!subscribed || !gate->published || !ota_validation_live(gate, now_ms) ||
        !action_id || strcmp(action_id, gate->action_id)) return false;
    /* Retain proof for notification/health retries until expiry or disconnect. */
    gate->acknowledged = true;
    return true;
}
