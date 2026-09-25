#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* These tests exercise extracted production decisions serially. Atomic loads,
 * task identity and RTOS locks are mocks, not a concurrency-safety proof. */
typedef int esp_err_t;
typedef void *TaskHandle_t;
#define ESP_OK 0
#define ESP_ERR_INVALID_STATE 1
#define ESP_ERR_TIMEOUT 2
#define ESP_ERR_INVALID_ARG 3
#define ESP_ERR_NOT_SUPPORTED 4
#define pdTRUE 1
#define pdMS_TO_TICKS(value) (value)
#define __ATOMIC_ACQUIRE 0
#define __atomic_load_n(address, order) (*(address))

static bool s_ready, s_uart_control_ready;
static void *s_lock;
static bool s_ppp_reserved, s_ppp_starting, s_ppp_active, s_ppp_stopping, s_ppp_mode_uncertain;
static TaskHandle_t s_ppp_owner;
static struct { bool ppp_reserved; } s_status;
static int owner_a, owner_b, lock_object;
static TaskHandle_t current_owner;
static bool fail_lock, lock_held;
static unsigned publishes;

static TaskHandle_t xTaskGetCurrentTaskHandle(void) { return current_owner; }
static int xSemaphoreTake(void *lock, uint32_t ticks) {
    (void)ticks;
    assert(lock == &lock_object);
    assert(!lock_held);
    if (fail_lock) return 0;
    lock_held = true;
    return pdTRUE;
}
static void xSemaphoreGive(void *lock) {
    assert(lock == &lock_object && lock_held);
    lock_held = false;
}
static void modem_a7670_publish_status_locked(void) {
    assert(lock_held);
    publishes++;
}

#include "ppp_lease_functions.inc"

static void reset_fixture(void) {
    assert(!lock_held);
    s_ready = true;
    s_uart_control_ready = true;
    s_lock = &lock_object;
    s_ppp_reserved = s_ppp_starting = s_ppp_active = s_ppp_stopping = s_ppp_mode_uncertain = false;
    s_ppp_owner = NULL;
    s_status.ppp_reserved = false;
    current_owner = &owner_a;
    fail_lock = false;
    publishes = 0U;
}

static void assert_reserved_by_a(void) {
    assert(modem_a7670_ppp_uart_owned());
    assert(s_ppp_reserved && s_status.ppp_reserved);
    assert(s_ppp_owner == &owner_a);
    assert(!lock_held);
}

int main(void) {
    char response[96];
    size_t i;
    bool *transition_flags[] = { &s_ppp_starting, &s_ppp_active, &s_ppp_stopping, &s_ppp_mode_uncertain };

    reset_fixture();
    assert(!modem_a7670_ppp_uart_owned() && modem_a7670_ppp_at_allowed());
    assert(modem_a7670_ppp_reserve() == ESP_OK);
    assert_reserved_by_a();
    assert(modem_a7670_ppp_at_allowed());
    assert(publishes == 1U);
    assert(modem_a7670_ppp_reserve() == ESP_ERR_INVALID_STATE);
    assert_reserved_by_a();
    assert(publishes == 1U);
    current_owner = &owner_b;
    assert(!modem_a7670_ppp_at_allowed());
    assert(modem_a7670_ppp_reserve() == ESP_ERR_INVALID_STATE);
    modem_a7670_ppp_release();
    assert_reserved_by_a();
    assert(publishes == 1U);
    assert(modem_a7670_ppp_stop(response, sizeof(response), 100U) == ESP_ERR_INVALID_STATE);
    assert(strcmp(response, "ppp_wrong_owner") == 0);
    assert_reserved_by_a();
    current_owner = &owner_a;
    modem_a7670_ppp_release();
    assert(!modem_a7670_ppp_uart_owned() && !s_status.ppp_reserved && s_ppp_owner == NULL);
    assert(modem_a7670_ppp_at_allowed() && publishes == 2U);
    assert(modem_a7670_ppp_reserve() == ESP_OK);
    assert_reserved_by_a();

    /* No recovery path may silently give the UART back in any binary or
     * uncertain transition state, even when the original owner requests it. */
    for (i = 0U; i < sizeof(transition_flags) / sizeof(transition_flags[0]); ++i) {
        reset_fixture();
        assert(modem_a7670_ppp_reserve() == ESP_OK);
        *transition_flags[i] = true;
        assert(!modem_a7670_ppp_at_allowed());
        current_owner = &owner_b;
        assert(!modem_a7670_ppp_at_allowed());
        current_owner = &owner_a;
        modem_a7670_ppp_release();
        assert_reserved_by_a();
        assert(modem_a7670_ppp_stop(response, sizeof(response), 100U) == ESP_ERR_NOT_SUPPORTED);
        assert(strcmp(response, "ppp_recovery_not_validated") == 0);
        assert_reserved_by_a();
        assert(*transition_flags[i] && publishes == 1U);
    }

    /* Fail closed even if a partial transition lost the reservation flag.
     * Uncertain mode itself must remain an ownership/admission barrier. */
    for (i = 0U; i < sizeof(transition_flags) / sizeof(transition_flags[0]); ++i) {
        reset_fixture();
        *transition_flags[i] = true;
        s_ppp_owner = &owner_a;
        assert(modem_a7670_ppp_uart_owned());
        assert(!modem_a7670_ppp_at_allowed());
        assert(modem_a7670_ppp_reserve() == ESP_ERR_INVALID_STATE);
        modem_a7670_ppp_release();
        assert(*transition_flags[i] && s_ppp_owner == &owner_a);
        assert(modem_a7670_ppp_stop(response, sizeof(response), 100U) == ESP_ERR_NOT_SUPPORTED);
        assert(modem_a7670_ppp_uart_owned() && !s_ppp_reserved && publishes == 0U);
    }

    reset_fixture();
    assert(modem_a7670_ppp_reserve() == ESP_OK);
    fail_lock = true;
    modem_a7670_ppp_release();
    assert_reserved_by_a();
    assert(modem_a7670_ppp_stop(response, sizeof(response), 100U) == ESP_ERR_TIMEOUT);
    assert(strcmp(response, "ppp_release_failed") == 0);
    assert_reserved_by_a();
    assert(publishes == 1U);
    fail_lock = false;
    assert(modem_a7670_ppp_stop(response, sizeof(response), 100U) == ESP_OK);
    assert(strcmp(response, "ppp_not_active") == 0);
    assert(!modem_a7670_ppp_uart_owned() && !s_status.ppp_reserved && s_ppp_owner == NULL);
    assert(publishes == 2U && !lock_held);

    reset_fixture();
    fail_lock = true;
    assert(modem_a7670_ppp_reserve() == ESP_ERR_TIMEOUT);
    assert(!modem_a7670_ppp_uart_owned() && s_ppp_owner == NULL && publishes == 0U);
    fail_lock = false;
    s_ready = false;
    assert(modem_a7670_ppp_reserve() == ESP_ERR_INVALID_STATE);
    s_ready = true;
    s_uart_control_ready = false;
    assert(modem_a7670_ppp_reserve() == ESP_ERR_INVALID_STATE);
    s_uart_control_ready = true;
    s_lock = NULL;
    assert(modem_a7670_ppp_reserve() == ESP_ERR_INVALID_STATE);
    modem_a7670_ppp_release();
    assert(publishes == 0U && !lock_held);
    assert(modem_a7670_ppp_stop(NULL, sizeof(response), 100U) == ESP_ERR_INVALID_ARG);
    assert(modem_a7670_ppp_stop(response, 0U, 100U) == ESP_ERR_INVALID_ARG);

    puts("modem PPP lease decision tests passed (mocked single-thread execution)");
    return 0;
}
