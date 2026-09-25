#include <assert.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "device_status.h"
#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_INTERNAL 2
#define MALLOC_CAP_8BIT 4
#define pdTRUE 1
#define pdMS_TO_TICKS(x) (x)
#define heap_caps_calloc(n, size, caps) calloc(n, size)
#define heap_caps_free(p) free(p)
static int s_json_lock;
static int xSemaphoreTake(int lock, int timeout) { (void)lock; (void)timeout; return 1; }
static void xSemaphoreGive(int lock) { (void)lock; }
static const char *state_mgr_firmware_elf_sha256(void) {
    return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
}
static const char *state_mgr_firmware_version(void) {
    return "0.2.0";
}
#include "status_functions.inc"
#include "telemetry_fingerprint.inc"

int main(void) {
    char tiny[4] = "xxx";
    char number[24];
    char output[DEVICE_STATUS_JSON_MAX_LEN];
    device_status_snapshot_t snapshot = {0};
    uint32_t original = telemetry_snapshot_fingerprint(&snapshot);
    strcpy(snapshot.ota_state, "pending_verify");
    uint32_t pending = telemetry_snapshot_fingerprint(&snapshot);
    assert(pending != original);
    strcpy(snapshot.ota_validation_action_id, "ota_0123456789abcdef01234567");
    uint32_t challenge = telemetry_snapshot_fingerprint(&snapshot);
    assert(challenge != pending);
    snapshot.uptime_ms++;
    snapshot.status_sequence++;
    assert(telemetry_snapshot_fingerprint(&snapshot) == challenge);
    strcpy(snapshot.ota_validation_action_id, "ota_0123456789abcdef01234568");
    assert(telemetry_snapshot_fingerprint(&snapshot) != challenge);
    device_status_escape_json("a\"", tiny, 3);
    assert(strcmp(tiny, "a") == 0);
    device_status_escape_json("a\\", tiny, 3);
    assert(strcmp(tiny, "a") == 0);
    device_status_escape_json("\"", tiny, 3);
    assert(strcmp(tiny, "\\\"") == 0);
    device_status_escape_json("abc", tiny, 1);
    assert(tiny[0] == 0);
    device_status_u64_to_dec(0, tiny, 1);
    assert(tiny[0] == 0);
    device_status_u64_to_dec(UINT64_MAX, number, sizeof(number));
    assert(strcmp(number, "18446744073709551615") == 0);
    /* Fill every field to its declared bound, using production header types. */
#include "status_max_fields.inc"
    strcpy(snapshot.active_path, "offline");
    strcpy(snapshot.connection_policy, "wifi_cellular_fallback");
    strcpy(snapshot.sd_error, "not_mounted");
    assert(device_status_build_json_from_snapshot(&snapshot, output, sizeof(output)) == ESP_OK);
    snapshot.wifi_profiles_revision = 42U;
    snapshot.wifi_profiles_count = 4U;
    assert(device_status_build_json_from_snapshot(&snapshot, output, sizeof(output)) == ESP_OK);
    assert(strstr(output, "\"wifi_profiles_revision\":42") != NULL);
    assert(strstr(output, "\"wifi_profiles_count\":4") != NULL);
    assert(strlen(output) > 4096U);
    puts(output);
    assert(device_status_build_json_from_snapshot(&snapshot, output, 4096U) == ESP_ERR_INVALID_SIZE);
    assert(output[0] == 0);
    assert(device_status_build_json_from_snapshot(&snapshot, output, 1U) == ESP_ERR_INVALID_SIZE);
    assert(output[0] == 0);
    assert(device_status_build_json_from_snapshot(&snapshot, NULL, 0) == ESP_ERR_INVALID_ARG);
    return 0;
}
