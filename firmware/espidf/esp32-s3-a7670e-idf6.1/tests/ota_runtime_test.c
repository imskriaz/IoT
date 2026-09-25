#include <assert.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include "../components/mqtt_mgr/include/ota_validation_gate.h"
typedef enum { MQTT_MGR_TRANSPORT_NONE, MQTT_MGR_TRANSPORT_ESP, MQTT_MGR_TRANSPORT_MODEM } mqtt_mgr_transport_t;
typedef enum { UNIFIED_ACTION_CMD_NONE, UNIFIED_ACTION_CMD_GET_STATUS } unified_action_command_t;
typedef struct { char ota_state[24]; } state_mgr_snapshot_t;
static struct { bool subscribed, connected; char ota_validation_action_id[32]; } s_status;
static ota_validation_gate_t s_ota_validation;
static mqtt_mgr_transport_t s_transport, s_ota_validation_transport;
static bool s_ota_confirmed, modem_connected, primary_ready;
static uint32_t s_ota_validation_retry_ms, test_clock_ms, nonce;
static int s_lock, lock_ok = 1, notifications;
static const char *image_state = "pending_verify";
#define pdTRUE 1
#define pdMS_TO_TICKS(x) (x)
static int xSemaphoreTake(int lock, int timeout) { (void)lock; (void)timeout; return lock_ok; }
static void xSemaphoreGive(int lock) { (void)lock; }
static bool mqtt_mgr_primary_subscription_ready_locked(void) { return primary_ready; }
static void state_mgr_get_snapshot(state_mgr_snapshot_t *out) { snprintf(out->ota_state, sizeof(out->ota_state), "%s", image_state); }
static bool modem_a7670_mqtt_is_connected(void) { return modem_connected; }
static uint32_t unified_tick_now_ms(void) { return test_clock_ms; }
static uint32_t esp_random(void) { return ++nonce; }
static bool mqtt_subscription_expired(uint32_t deadline, uint32_t now) { return (int32_t)(now - deadline) >= 0; }
/* Return a failure to prove that notification attempts remain retryable. */
static int state_mgr_request_ota_validation(void) { ++notifications; return -1; }
#include "ota_runtime_production.h"
int main(void) {
    char previous[32];
    for (int lane = MQTT_MGR_TRANSPORT_ESP; lane <= MQTT_MGR_TRANSPORT_MODEM; ++lane) {
        s_ota_confirmed = false; image_state = "pending_verify";
        s_transport = (mqtt_mgr_transport_t)lane;
        primary_ready = modem_connected = s_status.subscribed = s_status.connected = true;
        test_clock_ms = 100; notifications = 0;
        mqtt_mgr_ota_reset_locked(); mqtt_mgr_ota_tick_locked();
        assert(strlen(s_status.ota_validation_action_id) == 28U);
        strcpy(previous, s_status.ota_validation_action_id);
        mqtt_mgr_ota_ack(previous, UNIFIED_ACTION_CMD_GET_STATUS);
        assert(notifications == 0); /* ACK before committed publication */
        assert(ota_validation_published(&s_ota_validation, previous, 101, 102, true, true));
        test_clock_ms = 103;
        mqtt_mgr_ota_ack(previous, UNIFIED_ACTION_CMD_NONE);
        assert(notifications == 0);
        mqtt_mgr_ota_ack(previous, UNIFIED_ACTION_CMD_GET_STATUS);
        assert(notifications == 1);
        test_clock_ms = 5102; mqtt_mgr_ota_tick_locked(); assert(notifications == 1);
        test_clock_ms++; mqtt_mgr_ota_tick_locked(); assert(notifications == 2);
        s_status.subscribed = false; primary_ready = false;
        mqtt_mgr_ota_tick_locked(); assert(!s_ota_validation.action_id[0]);
        primary_ready = s_status.subscribed = true;
        mqtt_mgr_ota_tick_locked(); assert(strcmp(previous, s_ota_validation.action_id));
        mqtt_mgr_ota_ack(previous, UNIFIED_ACTION_CMD_GET_STATUS);
        assert(notifications == 2); /* queued old ACK after reconnect */
        strcpy(previous, s_ota_validation.action_id);
        test_clock_ms += OTA_VALIDATION_EXCHANGE_MS;
        mqtt_mgr_ota_tick_locked(); assert(strcmp(previous, s_ota_validation.action_id));
        image_state = "valid"; mqtt_mgr_ota_tick_locked();
        assert(s_ota_confirmed && !s_status.ota_validation_action_id[0]);
    }
    puts("OTA production runtime: both transports, exact ACK, failed notification retry, reconnect, expiry, valid cleanup PASS");
    return 0;
}
