#include <assert.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* Execute the actual worker loop with deterministic RTOS/driver boundaries.
 * These tests prove scheduling decisions, not hardware timing or SMP safety. */
typedef uint32_t TickType_t;
typedef int esp_err_t;
typedef struct { int rssi, authmode; unsigned char ssid[33]; } wifi_ap_record_t;
#define ESP_OK 0
#define ESP_FAIL 1
#define ESP_ERR_WIFI_CONN 2
#define ESP_ERR_WIFI_STATE 3
#define pdTRUE 1
#define portMAX_DELAY UINT32_MAX
#define pdMS_TO_TICKS(ms) ((ms) / 10U)
#define ESP_ERROR_CHECK(call) assert((call) == ESP_OK)
#define ESP_LOGW(...) ((void)0)

static int lock_object, task_object;
static void *s_lock = &lock_object, *s_task_handle;
static struct {
    bool configured, connected, started;
    int rssi;
    char ssid[33], security[24];
} s_status;
static uint8_t s_absent_retry_streak;
static uint32_t s_next_connect_attempt_ms;
static uint32_t s_runtime_override_started_ms, s_runtime_override_revision;
static uint32_t s_applied_profiles_revision;
static bool s_runtime_override_active;
static char s_runtime_override_ssid[33], s_runtime_override_password[65];
static bool s_connect_requested, s_scan_in_progress;
static bool s_runtime_connect_suppressed, s_startup_connect_suppressed;
static bool lock_held, fail_lock, profile_arrives, suppress_during_attempt;
static bool override_refresh_enabled, saved_profile_available;
static bool new_override_during_attempt;
static bool new_profiles_during_attempt;
static bool notification_pending;
static unsigned iterations, waits, heartbeats, refreshes, attempts;
static uint32_t fixture_now_ms, waited_ms, max_wait_ms;
static esp_err_t connect_result;
static jmp_buf worker_done;

static void *xTaskGetCurrentTaskHandle(void) { return &task_object; }
static esp_err_t task_registry_register_expected(const char *name) {
    assert(strcmp(name, "wifi_task") == 0); return ESP_OK;
}
static esp_err_t task_registry_mark_running(const char *name, bool running) {
    assert(running); return task_registry_register_expected(name);
}
static esp_err_t health_monitor_register_module(const char *name) {
    assert(strcmp(name, "wifi_mgr") == 0); return ESP_OK;
}
static uint32_t unified_tick_now_ms(void) { return fixture_now_ms; }
static int xSemaphoreTake(void *lock, TickType_t ticks) {
    (void)ticks;
    assert(lock == s_lock && !lock_held);
    if (fail_lock) return 0;
    lock_held = true; return pdTRUE;
}
static void xSemaphoreGive(void *lock) {
    assert(lock == s_lock && lock_held); lock_held = false;
}
static bool wifi_mgr_refresh_config_locked(void *output) {
    assert(lock_held && output == NULL);
    refreshes++;
    if (profile_arrives) s_status.configured = true;
    if (override_refresh_enabled && !s_runtime_override_active) s_status.configured = saved_profile_available;
    return profile_arrives;
}
static esp_err_t esp_wifi_sta_get_ap_info(wifi_ap_record_t *ap) {
    assert(lock_held && s_status.connected);
    ap->rssi = -52; ap->authmode = 3;
    memcpy(ap->ssid, "fixture-ap", sizeof("fixture-ap"));
    return ESP_OK;
}
static const char *wifi_mgr_auth_mode_name(int mode) { assert(mode == 3); return "wpa2_psk"; }
static esp_err_t wifi_mgr_run_connect_attempt(void) {
    assert(!lock_held);
    attempts++;
    if (suppress_during_attempt) s_runtime_connect_suppressed = true;
    if (new_override_during_attempt) {
        s_runtime_override_revision++;
        new_override_during_attempt = false;
    }
    if (new_profiles_during_attempt) {
        s_applied_profiles_revision++;
        new_profiles_during_attempt = false;
    }
    return connect_result;
}
static esp_err_t task_registry_heartbeat(const char *name) {
    assert(!lock_held && strcmp(name, "wifi_task") == 0);
    heartbeats++; return ESP_OK;
}
static uint32_t ulTaskNotifyTake(int clear, TickType_t ticks) {
    assert(clear == pdTRUE && !lock_held && heartbeats == waits + 1U);
    waited_ms = ticks * 10U;
    if (waited_ms > max_wait_ms) max_wait_ms = waited_ms;
    if (notification_pending) notification_pending = false;
    else fixture_now_ms += waited_ms;
    if (++waits == iterations) longjmp(worker_done, 1);
    return 0;
}

#include "wifi_worker_production.inc"

static void reset_fixture(void) {
    assert(!lock_held);
    memset(&s_status, 0, sizeof(s_status));
    s_status.configured = s_status.started = true;
    s_task_handle = NULL;
    s_absent_retry_streak = 0;
    s_next_connect_attempt_ms = 0;
    s_runtime_override_started_ms = s_runtime_override_revision = 0;
    s_applied_profiles_revision = 1U;
    s_runtime_override_active = false;
    memset(s_runtime_override_ssid, 0, sizeof(s_runtime_override_ssid));
    memset(s_runtime_override_password, 0, sizeof(s_runtime_override_password));
    s_connect_requested = s_scan_in_progress = false;
    s_runtime_connect_suppressed = s_startup_connect_suppressed = false;
    fail_lock = profile_arrives = suppress_during_attempt = notification_pending = false;
    override_refresh_enabled = saved_profile_available = false;
    new_override_during_attempt = false;
    new_profiles_during_attempt = false;
    waits = heartbeats = refreshes = attempts = 0;
    fixture_now_ms = 1000U; waited_ms = max_wait_ms = 0;
    connect_result = ESP_OK;
}
static void run_worker(unsigned count) {
    iterations = count;
    if (setjmp(worker_done) == 0) wifi_mgr_task(NULL);
    assert(waits == count && heartbeats == count && s_task_handle == &task_object);
}

int main(void) {
    unsigned i;
    reset_fixture();
    s_connect_requested = true;
    s_next_connect_attempt_ms = fixture_now_ms + 300000U;
    run_worker(10);
    assert(attempts == 0 && refreshes == 10 && max_wait_ms == 30000U);
    assert(s_next_connect_attempt_ms == fixture_now_ms); /* Backoff did not get shortened. */
    run_worker(11); /* One more iteration: deadline now reached. */
    assert(attempts == 1 && !s_connect_requested);

    reset_fixture(); s_status.connected = true;
    run_worker(1);
    assert(waited_ms == 15000U && attempts == 0 && s_status.rssi == -52);
    assert(strcmp(s_status.ssid, "fixture-ap") == 0);

    reset_fixture(); s_connect_requested = true;
    s_next_connect_attempt_ms = fixture_now_ms + 1500U;
    run_worker(1); assert(waited_ms == 1500U && attempts == 0);

    reset_fixture(); s_connect_requested = true;
    s_next_connect_attempt_ms = fixture_now_ms + 1U;
    run_worker(2); assert(attempts == 1 && max_wait_ms == 30000U);

    reset_fixture(); fixture_now_ms = UINT32_MAX - 499U; s_connect_requested = true;
    s_next_connect_attempt_ms = fixture_now_ms + 1500U;
    run_worker(2); assert(attempts == 1 && !s_connect_requested);

    reset_fixture(); s_connect_requested = true;
    s_next_connect_attempt_ms = fixture_now_ms - 1U;
    run_worker(1); assert(attempts == 1);

    for (i = 0; i < 2; ++i) {
        reset_fixture(); s_connect_requested = true;
        s_next_connect_attempt_ms = fixture_now_ms + 300000U;
        if (i == 0) s_runtime_connect_suppressed = true;
        else s_startup_connect_suppressed = true;
        run_worker(1);
        assert(attempts == 0 && !s_connect_requested && s_next_connect_attempt_ms == 0);
    }

    reset_fixture(); s_scan_in_progress = s_connect_requested = true;
    run_worker(1); assert(attempts == 0 && s_connect_requested && waited_ms == 30000U);

    reset_fixture(); s_status.configured = false; profile_arrives = true;
    run_worker(1); assert(attempts == 1 && s_status.configured);

    reset_fixture(); fail_lock = true; s_connect_requested = true;
    run_worker(1); assert(attempts == 0 && refreshes == 0 && waited_ms == 30000U);

    reset_fixture(); s_connect_requested = true; connect_result = ESP_FAIL;
    run_worker(20);
    assert(attempts == 5 && s_absent_retry_streak == 5 && max_wait_ms == 30000U);
    assert(s_connect_requested && (int32_t)(s_next_connect_attempt_ms - fixture_now_ms) > 0);

    reset_fixture(); s_connect_requested = true; connect_result = ESP_FAIL;
    suppress_during_attempt = true;
    run_worker(1); assert(attempts == 1 && !s_connect_requested && s_next_connect_attempt_ms == 0);

    reset_fixture(); s_connect_requested = true; connect_result = ESP_FAIL;
    new_override_during_attempt = true;
    run_worker(2);
    assert(attempts == 2 && s_absent_retry_streak == 1U);

    reset_fixture(); s_connect_requested = true; connect_result = ESP_FAIL;
    new_profiles_during_attempt = true;
    run_worker(2);
    assert(attempts == 2 && s_absent_retry_streak == 1U);

    reset_fixture(); notification_pending = true;
    run_worker(1); assert(fixture_now_ms == 1000U && !notification_pending);

    reset_fixture(); s_runtime_override_active = true; s_runtime_override_started_ms = fixture_now_ms;
    strcpy(s_runtime_override_ssid, "manual-ap"); strcpy(s_runtime_override_password, "temporary-secret");
    override_refresh_enabled = saved_profile_available = true;
    s_connect_requested = true; s_next_connect_attempt_ms = fixture_now_ms + 300000U;
    run_worker(3);
    assert(attempts == 1 && !s_runtime_override_active && s_runtime_override_revision == 1U);
    assert(s_runtime_override_ssid[0] == '\0' && s_runtime_override_password[0] == '\0');
    assert(s_absent_retry_streak == 0U);

    reset_fixture(); s_runtime_override_active = true; s_runtime_override_started_ms = fixture_now_ms;
    override_refresh_enabled = true; saved_profile_available = false;
    run_worker(3);
    assert(!s_runtime_override_active && !s_status.configured && attempts == 0);

    reset_fixture(); s_runtime_override_active = true; s_runtime_override_started_ms = 1000U;
    fixture_now_ms = 120000U; s_status.connected = true;
    override_refresh_enabled = saved_profile_available = true;
    run_worker(1); assert(s_runtime_override_active && attempts == 0);
    s_status.connected = false;
    run_worker(2); assert(!s_runtime_override_active && attempts == 1);

    reset_fixture(); fixture_now_ms = UINT32_MAX - 29999U;
    s_runtime_override_active = true; s_runtime_override_started_ms = fixture_now_ms;
    override_refresh_enabled = saved_profile_available = true;
    run_worker(3); assert(!s_runtime_override_active && attempts == 1);

    puts("Wi-Fi production worker: cooldown liveness, bounded manual target expiry, saved-profile recovery, deadlines/wrap, suppression, scan ownership, profile refresh and notification tests passed");
    return 0;
}
