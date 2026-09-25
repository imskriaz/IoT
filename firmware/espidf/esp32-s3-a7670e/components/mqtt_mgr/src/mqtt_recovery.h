#pragma once
#include <stdbool.h>
#include <stdint.h>

/* Worker-owned stop/start recovery. IDF reconnect() is only legal while it is
 * already waiting to reconnect, not for a connected client with lost ingress. */
typedef enum { MQTT_RECOVERY_NONE, MQTT_RECOVERY_STOP, MQTT_RECOVERY_START } mqtt_recovery_action_t;
typedef struct {
    bool pending;
    bool stopped;
    uint32_t retry_at_ms;
} mqtt_recovery_t;

#define MQTT_RECOVERY_RETRY_MS 1000U

static inline void mqtt_recovery_request(mqtt_recovery_t *state, uint32_t now_ms) {
    if (!state->pending) {
        state->pending = true;
        state->stopped = false;
        state->retry_at_ms = now_ms;
    }
}

static inline mqtt_recovery_action_t mqtt_recovery_next(const mqtt_recovery_t *state, uint32_t now_ms) {
    if (!state->pending || (int32_t)(now_ms - state->retry_at_ms) < 0) return MQTT_RECOVERY_NONE;
    return state->stopped ? MQTT_RECOVERY_START : MQTT_RECOVERY_STOP;
}

static inline void mqtt_recovery_result(mqtt_recovery_t *state, mqtt_recovery_action_t action,
        bool success, uint32_t now_ms) {
    if (action == MQTT_RECOVERY_NONE) return;
    if (!success) {
        state->retry_at_ms = now_ms + MQTT_RECOVERY_RETRY_MS;
    } else if (action == MQTT_RECOVERY_STOP) {
        state->stopped = true;
        state->retry_at_ms = now_ms;
    } else {
        *state = (mqtt_recovery_t){0};
    }
}

static inline bool mqtt_subscription_due(bool connected, bool subscribed,
        uint32_t deadline_ms, bool recovering) {
    return connected && !subscribed && deadline_ms == 0U && !recovering;
}

static inline bool mqtt_subscription_expired(uint32_t deadline_ms, uint32_t now_ms) {
    return deadline_ms != 0U && (int32_t)(now_ms - deadline_ms) >= 0;
}

/* Only the active command/# contract gates readiness. The cmd/# alias is
 * retained for compatibility, but a missing or rejected alias must not cycle
 * a client that can already receive current dashboard commands. */
static inline bool mqtt_primary_subscription_ready(bool connected, bool primary_acked) {
    return connected && primary_acked;
}

static inline bool mqtt_subscription_rejection_requires_recovery(bool primary, bool invalid) {
    return primary && invalid;
}
