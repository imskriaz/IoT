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

/* An ESP client that has connected and has an outstanding command/# SUBACK is
 * a live Wi-Fi candidate. Do not let modem maintenance replace it before the
 * callback is drained. */
static inline bool mqtt_esp_subscription_pending(bool connected, bool subscribed,
        uint32_t deadline_ms, bool recovering) {
    return connected && !subscribed && deadline_ms != 0U && !recovering;
}

/* A still-connected Wi-Fi client owns command ingress once its command/#
 * subscription is ready or awaiting SUBACK. The modem may take over only
 * after that candidate is no longer usable. Callers must first obtain the
 * transport-state lock; a failed lock is not evidence that modem is selected. */
static inline bool mqtt_modem_ingress_allowed(bool esp_selected, bool connected,
        bool subscribed, uint32_t deadline_ms, bool recovering) {
    return !esp_selected || !connected ||
        !(subscribed || mqtt_esp_subscription_pending(
            connected, subscribed, deadline_ms, recovering));
}

static inline bool mqtt_suback_current_session(bool connected, uint32_t deadline_ms,
        bool recovering) {
    return connected && deadline_ms != 0U && !recovering;
}

static inline bool mqtt_subscription_expired(uint32_t deadline_ms, uint32_t now_ms) {
    return deadline_ms != 0U && (int32_t)(now_ms - deadline_ms) >= 0;
}

static inline uint32_t mqtt_subscription_deadline(uint32_t now_ms, uint32_t delay_ms) {
    uint32_t deadline_ms = now_ms + delay_ms;
    return deadline_ms == 0U ? 1U : deadline_ms;
}

/* The native 6.1 runtime has one command/# subscription contract. */
static inline bool mqtt_primary_subscription_ready(bool connected, bool primary_acked) {
    return connected && primary_acked;
}

static inline bool mqtt_subscription_rejection_requires_recovery(bool primary, bool invalid) {
    return primary && invalid;
}
