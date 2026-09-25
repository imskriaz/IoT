#include <assert.h>
#include <stdio.h>
#include "../components/mqtt_mgr/include/ota_validation_gate.h"

int main(void) {
    ota_validation_gate_t gate = {0};
    const char *first = "ota_0123456789abcdef01234567";
    const char *next = "ota_0123456789abcdef01234568";
    assert(!ota_validation_live(&gate, 20));
    assert(!ota_validation_begin(&gate, NULL, 10));
    assert(!ota_validation_begin(&gate, "health", 10));
    assert(!ota_validation_begin(&gate, "ota_0123456789abcdef0123456g", 10));
    assert(ota_validation_begin(&gate, first, 10));
    assert(!ota_validation_ack(&gate, first, 20, true)); /* not published */
    assert(!ota_validation_published(&gate, next, 11, 20, true, true));
    assert(!ota_validation_published(&gate, first, 9, 20, true, true)); /* cached */
    assert(!ota_validation_published(&gate, first, 11, 20, true, false)); /* old boot */
    assert(!ota_validation_published(&gate, first, 11, 20, false, true)); /* failed */
    assert(ota_validation_published(&gate, first, 11, 20, true, true));
    assert(!ota_validation_ack(&gate, next, 30, true));
    assert(!ota_validation_ack(&gate, first, 30, false));
    assert(ota_validation_ack(&gate, first, 30, true));
    assert(gate.acknowledged); /* notification failure can retry */
    assert(ota_validation_ack(&gate, first, 50000, true));
    assert(gate.started_ms == 10); /* ACK duplicates cannot extend deadline */
    assert(!ota_validation_ack(&gate, first, 60010, true));
    ota_validation_reset(&gate);
    assert(!gate.acknowledged);
    assert(!ota_validation_ack(&gate, first, 40, true));
    assert(ota_validation_begin(&gate, next, 100));
    assert(!ota_validation_published(&gate, first, 110, 120, true, true));
    assert(!ota_validation_ack(&gate, first, 120, true)); /* queued old ACK */
    assert(ota_validation_begin(&gate, next, UINT32_MAX - 10U));
    assert(ota_validation_published(&gate, next, 1U, 20U, true, true));
    assert(ota_validation_ack(&gate, next, 21U, true));
    puts("OTA challenge gate: current-boot result, exact DB ACK, replay, expiry, reconnect, retry and wrap PASS");
    return 0;
}
