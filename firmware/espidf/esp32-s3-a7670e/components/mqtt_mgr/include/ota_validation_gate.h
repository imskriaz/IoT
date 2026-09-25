#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

/* Owned by mqtt_task. One bounded, current-connection health exchange; no
 * persisted result, anonymous event or retained command may create a witness. */
#define OTA_VALIDATION_EXCHANGE_MS 60000U
typedef struct {
    char action_id[32];
    uint32_t received_ms;
    int message_id;
} ota_validation_gate_t;

static inline void ota_validation_reset(ota_validation_gate_t *gate) {
    memset(gate, 0, sizeof(*gate));
}

static inline void ota_validation_observe(ota_validation_gate_t *gate,
    const char *action_id, uint32_t now_ms, bool subscribed, bool retained) {
    if (!subscribed || retained || !action_id || !action_id[0] ||
        strlen(action_id) >= sizeof(gate->action_id)) return;
    /* Do not let duplicate delivery extend the witness lifetime. */
    if (gate->action_id[0] &&
        (uint32_t)(now_ms - gate->received_ms) < OTA_VALIDATION_EXCHANGE_MS) return;
    ota_validation_reset(gate);
    memcpy(gate->action_id, action_id, strlen(action_id) + 1U);
    gate->received_ms = now_ms;
}

static inline bool ota_validation_match(const ota_validation_gate_t *gate,
    const char *action_id, uint32_t created_ms, uint32_t now_ms,
    bool successful_health, bool current_boot) {
    return successful_health && current_boot && gate->action_id[0] && action_id &&
        strcmp(gate->action_id, action_id) == 0 &&
        (uint32_t)(now_ms - gate->received_ms) < OTA_VALIDATION_EXCHANGE_MS &&
        (uint32_t)(created_ms - gate->received_ms) < OTA_VALIDATION_EXCHANGE_MS;
}

static inline bool ota_validation_puback(ota_validation_gate_t *gate,
    int message_id, uint32_t now_ms, bool subscribed) {
    if (!subscribed || message_id <= 0 || gate->message_id != message_id ||
        !gate->action_id[0] ||
        (uint32_t)(now_ms - gate->received_ms) >= OTA_VALIDATION_EXCHANGE_MS) return false;
    ota_validation_reset(gate);
    return true;
}
