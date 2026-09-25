#include <assert.h>
#include <stdint.h>
#include <stdio.h>

#include "../components/mqtt_mgr/src/mqtt_failover.h"
#include "../components/mqtt_mgr/src/mqtt_recovery.h"

int main(void) {
    mqtt_recovery_t recovery = {0};

    assert(mqtt_recovery_next(&recovery, 10U) == MQTT_RECOVERY_NONE);
    mqtt_recovery_request(&recovery, 100U);
    assert(mqtt_recovery_next(&recovery, 100U) == MQTT_RECOVERY_STOP);
    mqtt_recovery_result(&recovery, MQTT_RECOVERY_STOP, false, 100U);
    assert(mqtt_recovery_next(&recovery, 1099U) == MQTT_RECOVERY_NONE);
    assert(mqtt_recovery_next(&recovery, 1100U) == MQTT_RECOVERY_STOP);
    mqtt_recovery_result(&recovery, MQTT_RECOVERY_STOP, true, 1100U);
    assert(mqtt_recovery_next(&recovery, 1100U) == MQTT_RECOVERY_START);
    mqtt_recovery_result(&recovery, MQTT_RECOVERY_START, false, 1100U);
    assert(mqtt_recovery_next(&recovery, 2099U) == MQTT_RECOVERY_NONE);
    assert(mqtt_recovery_next(&recovery, 2100U) == MQTT_RECOVERY_START);
    mqtt_recovery_result(&recovery, MQTT_RECOVERY_START, true, 2100U);
    assert(!recovery.pending);

    assert(mqtt_subscription_due(true, false, 0U, false));
    assert(!mqtt_subscription_due(true, false, 500U, false));
    assert(!mqtt_subscription_due(true, false, 0U, true));
    assert(!mqtt_subscription_due(false, false, 0U, false));
    assert(mqtt_esp_subscription_pending(true, false, 500U, false));
    assert(!mqtt_esp_subscription_pending(true, false, 0U, false));
    assert(!mqtt_esp_subscription_pending(true, true, 500U, false));
    assert(!mqtt_esp_subscription_pending(true, false, 500U, true));
    assert(!mqtt_modem_ingress_allowed(true, true, true, 0U, false));
    assert(!mqtt_modem_ingress_allowed(true, true, false, 500U, false));
    assert(mqtt_modem_ingress_allowed(true, false, false, 0U, false));
    assert(mqtt_modem_ingress_allowed(true, true, false, 0U, false));
    assert(mqtt_modem_ingress_allowed(true, true, false, 500U, true));
    assert(mqtt_modem_ingress_allowed(false, true, true, 0U, false));
    assert(mqtt_suback_current_session(true, 500U, false));
    assert(!mqtt_suback_current_session(false, 500U, false));
    assert(!mqtt_suback_current_session(true, 0U, false));
    assert(!mqtt_suback_current_session(true, 500U, true));
    assert(mqtt_subscription_expired(UINT32_MAX - 5U, 3U));
    assert(!mqtt_subscription_expired(100U, 99U));
    assert(!mqtt_subscription_expired(0U, UINT32_MAX));
    assert(mqtt_subscription_deadline(100U, 15U) == 115U);
    assert(mqtt_subscription_deadline(UINT32_MAX - 14U, 15U) == 1U);

    assert(mqtt_primary_subscription_ready(true, true));
    assert(!mqtt_primary_subscription_ready(true, false));
    assert(!mqtt_primary_subscription_ready(false, true));
    assert(mqtt_subscription_rejection_requires_recovery(true, true));
    assert(!mqtt_subscription_rejection_requires_recovery(false, true));
    assert(!mqtt_subscription_rejection_requires_recovery(true, false));

    assert(mqtt_failover_retry_delay_ms(0U, 15000U, 300000U) == 15000U);
    assert(mqtt_failover_retry_delay_ms(1U, 15000U, 300000U) == 15000U);
    assert(mqtt_failover_retry_delay_ms(2U, 15000U, 300000U) == 30000U);
    assert(mqtt_failover_retry_delay_ms(5U, 15000U, 300000U) == 240000U);
    assert(mqtt_failover_retry_delay_ms(6U, 15000U, 300000U) == 300000U);
    assert(mqtt_failover_retry_delay_ms(UINT8_MAX, 15000U, 300000U) == 300000U);
    assert(mqtt_failover_retry_pending(UINT32_MAX - 5U, UINT32_MAX - 6U));
    assert(!mqtt_failover_retry_pending(UINT32_MAX - 5U, 3U));
    assert(!mqtt_failover_retry_pending(0U, UINT32_MAX));
    assert(mqtt_failover_retry_due(0U, 100U));
    assert(!mqtt_failover_retry_due(115U, 100U));
    assert(mqtt_failover_retry_due(115U, 115U));
    assert(!mqtt_failover_retry_due(UINT32_MAX - 5U, UINT32_MAX - 6U));
    assert(mqtt_failover_retry_due(UINT32_MAX - 5U, 3U));
    assert(mqtt_failover_retry_deadline(100U, 15U) == 115U);
    assert(mqtt_failover_retry_deadline(UINT32_MAX - 14U, 15U) == 1U);
    assert(mqtt_failover_is_bearer_failure("+IP ERROR: Network is not opened"));
    assert(mqtt_failover_is_bearer_failure("netopen_no_ip"));
    assert(!mqtt_failover_is_bearer_failure("+CMQTTCONNECT: 0,3"));
    assert(!mqtt_failover_is_bearer_failure("mqtt_auth_failed"));

    puts("MQTT recovery, failover backoff, deadline, and primary subscription checks passed");
    return 0;
}
