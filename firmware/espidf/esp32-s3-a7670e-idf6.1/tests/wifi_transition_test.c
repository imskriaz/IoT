#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "action_models.h"
#define CONFIG_MGR_WIFI_SSID_LEN 33
#define API_BRIDGE_ASYNC_TRANSITION_MAX 2
#define pdTRUE 1
#define pdMS_TO_TICKS(x) (x)
#define portMAX_DELAY UINT32_MAX
static int s_async_transition_lock = 1;
static bool lock_available = true;
static int lock_depth;
static int xSemaphoreTake(int lock, uint32_t ticks) {
    (void)lock; (void)ticks;
    if (!lock_available) return 0;
    assert(lock_depth == 0); lock_depth++; return pdTRUE;
}
static void xSemaphoreGive(int lock) { (void)lock; assert(lock_depth == 1); lock_depth--; }
static uint32_t unified_tick_now_ms(void) { return 100; }
static uint32_t api_bridge_wifi_transition_timeout_ms(const unified_action_envelope_t *a) {
    (void)a; return 1000;
}
static void unified_copy_cstr(char *dst, size_t n, const char *src) { snprintf(dst, n, "%s", src); }
#include "wifi_transition_production.h"
int main(void) {
    unified_action_envelope_t first = {0}, second = {0};
    first.command = UNIFIED_ACTION_CMD_WIFI_CONNECT;
    second.command = UNIFIED_ACTION_CMD_WIFI_DISCONNECT;
    strcpy(first.correlation.correlation_id, "first");
    strcpy(second.correlation.correlation_id, "second");
    assert(api_bridge_begin_wifi_transition(&first, API_BRIDGE_WIFI_TRANSITION_CONNECT, "ssid") == ESP_OK);
    assert(!s_async_transitions.entries[0].dispatch_complete);
    assert(api_bridge_begin_wifi_transition(&second, API_BRIDGE_WIFI_TRANSITION_DISCONNECT, "ssid") != ESP_OK);
    assert(s_async_transitions.count == 1);
    assert(strcmp(s_async_transitions.entries[0].action.correlation.correlation_id, "first") == 0);
    unified_action_response_t response = {0};
    response.action = second; response.result = UNIFIED_ACTION_RESULT_REJECTED;
    api_bridge_finish_wifi_dispatch(&response);
    assert(s_async_transitions.count == 1);
    response.action = first; response.result = UNIFIED_ACTION_RESULT_FAILED;
    api_bridge_finish_wifi_dispatch(&response);
    assert(s_async_transitions.count == 0);
    assert(api_bridge_begin_wifi_transition(&second, API_BRIDGE_WIFI_TRANSITION_DISCONNECT, "ssid") == ESP_OK);
    response.action = second; response.result = UNIFIED_ACTION_RESULT_ACCEPTED;
    api_bridge_finish_wifi_dispatch(&response);
    assert(s_async_transitions.entries[0].dispatch_complete);
    assert(api_bridge_begin_wifi_transition(&first, API_BRIDGE_WIFI_TRANSITION_CONNECT, "ssid") != ESP_OK);
    assert(s_async_transitions.count == 1);
    lock_available = false;
    assert(api_bridge_begin_wifi_transition(&first, API_BRIDGE_WIFI_TRANSITION_CONNECT, "ssid") == ESP_ERR_TIMEOUT);
    assert(lock_depth == 0);
    puts("Wi-Fi transition ownership: overlap, identity, failed dispatch, arming and contention PASS");
    return 0;
}
