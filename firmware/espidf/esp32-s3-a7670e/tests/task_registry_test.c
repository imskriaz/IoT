#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "task_registry.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

/* Only RTOS/clock observations are faked; the real task_registry.c and
 * unified_runtime.h are compiled separately by the runner. */
static uint32_t now_ms;
static uint32_t stack_bytes = 4096U;
static bool create_fails;
static bool lock_fails;
static bool locked;
static int mutex_token;
static unsigned stack_reads;
static const char *const workers[] = {
    "battery_task", "storage_task", "modem_task", "sms_task",
    "wifi_task", "automation_bridge_task", "mqtt_task", "telemetry_task"
};

SemaphoreHandle_t xSemaphoreCreateMutex(void) { return create_fails ? NULL : &mutex_token; }
int xSemaphoreTake(SemaphoreHandle_t handle, TickType_t timeout) {
    assert(handle == &mutex_token);
    assert(timeout <= 100U);
    assert(!locked);
    if (lock_fails) return 0;
    locked = true;
    return pdTRUE;
}
void xSemaphoreGive(SemaphoreHandle_t handle) {
    assert(handle == &mutex_token && locked);
    locked = false;
}
UBaseType_t uxTaskGetStackHighWaterMark(void *task) {
    assert(task == NULL && locked);
    ++stack_reads;
    return stack_bytes;
}
TickType_t xTaskGetTickCount(void) { return now_ms; }
int64_t esp_timer_get_time(void) { return (int64_t)now_ms * 1000; }

static void start_workers(void) {
    size_t i;
    for (i = 0; i < sizeof(workers) / sizeof(workers[0]); ++i) {
        assert(task_registry_register_expected(workers[i]) == ESP_OK);
        assert(task_registry_mark_running(workers[i], true) == ESP_OK);
    }
}
static void heartbeat_workers(void) {
    size_t i;
    for (i = 0; i < sizeof(workers) / sizeof(workers[0]); ++i)
        assert(task_registry_heartbeat(workers[i]) == ESP_OK);
}

static void test_liveness(void) {
    size_t i;
    task_registry_summary_t summary;
    unsigned reads_before;
    assert(!task_registry_required_healthy(120000U));
    create_fails = true;
    assert(task_registry_init() == ESP_ERR_NO_MEM);
    assert(!task_registry_required_healthy(120000U));
    create_fails = false;
    assert(task_registry_init() == ESP_OK);
    assert(!task_registry_required_healthy(120000U));
    /* A partially self-registered set must fail even when all known tasks run. */
    for (i = 0; i < sizeof(workers) / sizeof(workers[0]) - 1; ++i) {
        assert(task_registry_register_expected(workers[i]) == ESP_OK);
        assert(task_registry_mark_running(workers[i], true) == ESP_OK);
        assert(!task_registry_required_healthy(120000U));
    }
    assert(task_registry_heartbeat("telemetry_task") == ESP_OK);
    assert(!task_registry_required_healthy(120000U)); /* Not expected yet. */
    assert(task_registry_register_expected("telemetry_task") == ESP_OK);
    assert(task_registry_required_healthy(120000U)); /* tick zero is valid. */
    assert(!task_registry_required_healthy(0U));
    assert(!task_registry_required_healthy(UINT32_MAX));
    lock_fails = true;
    assert(!task_registry_required_healthy(120000U));
    lock_fails = false;
    assert(task_registry_required_healthy(120000U));
    now_ms = 120000U;
    assert(task_registry_required_healthy(120000U));
    ++now_ms;
    assert(!task_registry_required_healthy(120000U));
    /* Refresh every worker except one: a healthy majority must not mask it. */
    for (i = 1; i < sizeof(workers) / sizeof(workers[0]); ++i)
        assert(task_registry_heartbeat(workers[i]) == ESP_OK);
    assert(!task_registry_required_healthy(120000U));
    heartbeat_workers();
    assert(task_registry_required_healthy(120000U));
    assert(task_registry_mark_running("modem_task", false) == ESP_OK);
    assert(!task_registry_required_healthy(120000U));
    assert(task_registry_heartbeat("modem_task") == ESP_OK);
    assert(task_registry_required_healthy(120000U));
    assert(task_registry_register_expected("future_worker") == ESP_OK);
    assert(!task_registry_required_healthy(120000U));
    assert(task_registry_mark_running("future_worker", true) == ESP_OK);
    assert(task_registry_required_healthy(120000U));
    now_ms = UINT32_MAX - 50U;
    heartbeat_workers();
    assert(task_registry_heartbeat("future_worker") == ESP_OK);
    now_ms = 49U; /* 100 milliseconds after wrap. */
    assert(task_registry_required_healthy(100U));
    assert(!task_registry_required_healthy(99U));
    reads_before = stack_reads;
    assert(task_registry_required_healthy(120000U));
    assert(stack_reads == reads_before); /* Gate never scans another task's stack. */
    task_registry_get_summary(&summary);
    assert(summary.expected_count == 9U && summary.running_count == 9U);
    assert(summary.low_stack_count == 0U && summary.min_stack_high_water_bytes == 4096U);
    assert(!locked);
}

static void test_stack(uint32_t observed_bytes) {
    task_registry_summary_t summary;
    assert(task_registry_init() == ESP_OK);
    start_workers();
    assert(task_registry_required_healthy(120000U));
    stack_bytes = observed_bytes;
    assert(task_registry_mark_running("mqtt_task", true) == ESP_OK);
    assert(task_registry_required_healthy(120000U) == (observed_bytes > 1024U));
    /* A later larger measurement cannot erase earlier low/zero headroom. */
    stack_bytes = 8192U;
    now_ms = 30000U;
    heartbeat_workers();
    assert(task_registry_required_healthy(120000U) == (observed_bytes > 1024U));
    task_registry_get_summary(&summary);
    if (observed_bytes == 0U) {
        assert(summary.min_stack_high_water_bytes == 4096U);
        assert(summary.low_stack_count == 0U); /* Existing telemetry unchanged. */
    }
    assert(!locked);
}

int main(int argc, char **argv) {
    assert(argc == 2);
    if (strcmp(argv[1], "liveness") == 0) test_liveness();
    else if (strcmp(argv[1], "zero") == 0) test_stack(0U);
    else if (strcmp(argv[1], "low") == 0) test_stack(1024U);
    else if (strcmp(argv[1], "healthy-boundary") == 0) test_stack(1025U);
    else assert(!"Unknown scenario");
    printf("task registry production health gate: %s PASS\n", argv[1]);
    return 0;
}
