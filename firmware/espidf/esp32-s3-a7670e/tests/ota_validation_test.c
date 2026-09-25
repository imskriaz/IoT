#include <assert.h>
#include <stdio.h>
#include "../components/mqtt_mgr/include/ota_validation_gate.h"

int main(void) {
    ota_validation_gate_t gate = {0};
    assert(!ota_validation_match(&gate, "health", 10, 20, true, true));
    ota_validation_observe(&gate, "health", 10, false, false);
    assert(!gate.action_id[0]);
    ota_validation_observe(&gate, "health", 10, true, true);
    assert(!gate.action_id[0]);
    ota_validation_observe(&gate, "", 10, true, false);
    assert(!gate.action_id[0]);
    ota_validation_observe(&gate, "1234567890123456789012345678901234", 10, true, false);
    assert(!gate.action_id[0]);
    ota_validation_observe(&gate, "health", 10, true, false);
    assert(!ota_validation_match(&gate, "other", 11, 20, true, true));
    assert(!ota_validation_match(&gate, "health", 9, 20, true, true)); /* cached */
    assert(!ota_validation_match(&gate, "health", 11, 20, true, false)); /* prior boot */
    assert(!ota_validation_match(&gate, "health", 11, 20, false, true)); /* rejected/accepted */
    assert(ota_validation_match(&gate, "health", 11, 20, true, true));
    gate.message_id = 42;
    assert(!ota_validation_puback(&gate, 43, 30, true));
    assert(!ota_validation_puback(&gate, 42, 30, false));
    assert(ota_validation_puback(&gate, 42, 30, true));
    assert(!ota_validation_puback(&gate, 42, 30, true)); /* consume once */
    ota_validation_observe(&gate, "health", 10, true, false);
    ota_validation_observe(&gate, "health", 50000, true, false);
    assert(gate.received_ms == 10); /* duplicates cannot extend deadline */
    assert(!ota_validation_match(&gate, "health", 10, 60010, true, true));
    gate.message_id = 42;
    assert(!ota_validation_puback(&gate, 42, 60010, true));
    ota_validation_reset(&gate); /* disconnect, rejected subscription or new client */
    assert(!ota_validation_puback(&gate, 42, 30, true));
    ota_validation_observe(&gate, "wrap", UINT32_MAX - 10U, true, false);
    assert(ota_validation_match(&gate, "wrap", 1U, 20U, true, true));
    gate.message_id = 99;
    assert(ota_validation_puback(&gate, 99, 21U, true));
    puts("OTA validation gate: current-boot correlation, replay, failure, retention, subscription, expiry, reconnect and wrap PASS");
    return 0;
}
