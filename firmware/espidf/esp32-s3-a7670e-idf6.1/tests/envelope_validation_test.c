#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "cJSON.h"
#include "envelope_limits.h"
#include "unified_json_text.h"
#define ESP_OK 0
#define ESP_ERR_INVALID_ARG 258
#define ESP_ERR_NOT_SUPPORTED 262
#define UNIFIED_ACTION_CMD_NONE 0
typedef int esp_err_t;
typedef int unified_action_command_t;
typedef struct { char device_id[48]; } board_bsp_identity_t;
static void board_bsp_get_identity(board_bsp_identity_t *p) { strcpy(p->device_id, "device-a"); }
static void config_mgr_get_device_id_override(char *p, size_t n) { (void)n; p[0] = 0; }
static bool automation_bridge_command_name_from_topic(const char *t, char *out, size_t n) {
    (void)n; if (strcmp(t, "device/device-a/command/get_status")) return false;
    strcpy(out, "get_status"); return true;
}
static int automation_bridge_parse_command_name(const char *s) { return strcmp(s,"get_status") ? 0 : 1; }
static const char *unified_action_command_name(int c) { (void)c; return "get_status"; }
static bool automation_bridge_action_id_is_valid(const char *s);
#include "envelope_production.h"
static unsigned text_cases;
static void check_text(const char *json, size_t length, bool valid) {
    bool accepted = false;
    if (unified_json_text_is_cstring_safe(json, length)) {
        cJSON *root = cJSON_ParseWithOpts(json, NULL, true);
        int command = 0;
        accepted = root && automation_bridge_validate_envelope(
            root, "device/device-a/command/get_status", &command) == ESP_OK;
        cJSON_Delete(root);
    }
    assert(accepted == valid);
    ++text_cases;
}
static void check(const char *extra, bool valid) {
    char json[1024];
    snprintf(json, sizeof(json), "{\"schema\":1,\"device_id\":\"device-a\",\"command\":\"get_status\",\"action_id\":\"test-1\",\"payload\":{}%s}", extra);
    cJSON *root = cJSON_ParseWithOpts(json, NULL, true);
    int command = 0;
    assert(root);
    assert((automation_bridge_validate_envelope(root, "device/device-a/command/get_status", &command) == ESP_OK) == valid);
    cJSON_Delete(root);
}
int main(void) {
    static const char native[] = "{\"schema\":1,\"device_id\":\"device-a\",\"command\":\"get_status\",\"action_id\":\"test-1\",\"payload\":{}}";
    static const char *nul_cases[] = {
        "{\"schema\\u0000unknown\":1,\"device_id\":\"device-a\",\"command\":\"get_status\",\"action_id\":\"test-1\",\"payload\":{}}",
        "{\"schema\":1,\"device_id\":\"device-a\\u0000other\",\"command\":\"get_status\",\"action_id\":\"test-1\",\"payload\":{}}",
        "{\"schema\":1,\"device_id\":\"device-a\",\"command\":\"get_status\\u0000other\",\"action_id\":\"test-1\",\"payload\":{}}",
        "{\"schema\":1,\"device_id\":\"device-a\",\"command\":\"get_status\",\"action_id\":\"test-1\\u0000other\",\"payload\":{}}",
        "{\"schema\":1,\"device_id\":\"device-a\",\"command\":\"get_status\",\"action_id\":\"test-1\",\"payload\":{\"text\":\"a\\u0000b\"}}",
        "{\"schema\":1,\"device_id\":\"device-a\",\"command\":\"get_status\",\"action_id\":\"test-1\",\"payload\":{\"text\\u0000other\":\"ok\"}}"
    };
    char raw_suffix[sizeof(native) + 20U] = {0};
    memcpy(raw_suffix, native, sizeof(native));
    memcpy(raw_suffix + sizeof(native), "trailing garbage", sizeof("trailing garbage"));
    check_text(raw_suffix, sizeof(native) + sizeof("trailing garbage") - 1U, false);
    check_text(native, sizeof(native) - 1U, true);
    check_text(NULL, 0U, false);
    check_text("", 0U, false);
    for (size_t i = 0U; i < sizeof(nul_cases) / sizeof(nul_cases[0]); ++i) {
        check_text(nul_cases[i], strlen(nul_cases[i]), false);
    }
    for (size_t run = 1U; run <= 8U; ++run) {
        char json[256];
        char slashes[9] = {0};
        memset(slashes, '\\', run);
        snprintf(json, sizeof(json),
            "{\"schema\":1,\"device_id\":\"device-a\",\"command\":\"get_status\",\"action_id\":\"test-1\",\"payload\":{},\"source\":\"%su0000\"}", slashes);
        check_text(json, strlen(json), (run % 2U) == 0U);
    }
    /* Escaped quotes must not terminate the string while scanning escapes. */
    static const char escaped_quote_nul[] = "{\"schema\":1,\"device_id\":\"device-a\",\"command\":\"get_status\",\"action_id\":\"test-1\",\"payload\":{\"text\":\"a\\\"\\u0000\"}}";
    check_text(escaped_quote_nul, sizeof(escaped_quote_nul) - 1U, false);
    static const char escaped_quote_literal[] = "{\"schema\":1,\"device_id\":\"device-a\",\"command\":\"get_status\",\"action_id\":\"test-1\",\"payload\":{\"text\":\"a\\\"\\\\u0000\"}}";
    check_text(escaped_quote_literal, sizeof(escaped_quote_literal) - 1U, true);
    check_text("{} trailing", sizeof("{} trailing") - 1U, false);
    /* All short slices are bounded, including an unfinished escape. */
    static const char truncated_escape[] = { '"', '\\', 'u', '0', '0', '0', '0' };
    for (size_t length = 1U; length < sizeof(truncated_escape); ++length) {
        assert(unified_json_text_is_cstring_safe(truncated_escape, length));
    }
    assert(!unified_json_text_is_cstring_safe(truncated_escape, sizeof(truncated_escape)));
    const char *const profile_keys[] = { "ssid", "password", "priority", "enabled" };
    const char *shapes[] = {
        "{\"ssid\":\"A\",\"password\":\"\",\"priority\":1,\"enabled\":true}",
        "{\"enabled\":true,\"priority\":1,\"password\":\"\",\"ssid\":\"A\"}",
        "{\"ssid\":\"A\",\"password\":\"\",\"priority\":1,\"enabled\":true,\"ssid\":\"B\"}",
        "{\"ssid\":\"A\",\"password\":\"\",\"priority\":1}",
        "{\"ssid\":\"A\",\"password\":\"\",\"priority\":1,\"enabled\":true,\"legacy\":1}",
        "[]", "null"
    };
    for (size_t i = 0; i < sizeof(shapes) / sizeof(shapes[0]); ++i) {
        cJSON *shape = cJSON_Parse(shapes[i]);
        assert(automation_bridge_exact_keys(shape, profile_keys, 4U) == (i < 2));
        cJSON_Delete(shape);
    }
    char bounded_id[UNIFIED_CORRELATION_ID_LEN + 1];
    memset(bounded_id, 'a', sizeof(bounded_id));
    bounded_id[UNIFIED_CORRELATION_ID_LEN - 1] = '\0';
    assert(automation_bridge_action_id_is_valid(bounded_id));
    bounded_id[UNIFIED_CORRELATION_ID_LEN - 1] = 'a';
    bounded_id[UNIFIED_CORRELATION_ID_LEN] = '\0';
    assert(!automation_bridge_action_id_is_valid(bounded_id));
    assert(!automation_bridge_action_id_is_valid("recovery_1790145131661_wifi_disconnect"));
    check("", true);
    check(",\"source\":\"test\",\"timeout\":15000,\"ttl_ms\":30000", true);
    check(",\"timeout\":0,\"ttl_ms\":4294967295", true);
    check(",\"timeout\":1,\"timeout\":2", false);
    check(",\"source\":\"a\",\"source\":\"b\"", false);
    check(",\"ttl_ms\":1,\"ttl_ms\":2", false);
    check(",\"schema\":1", false);
    check(",\"timeout\":null", false);
    check(",\"timeout\":\"1000\"", false);
    check(",\"timeout\":-1", false);
    check(",\"ttl_ms\":1.5", false);
    check(",\"ttl_ms\":4294967296", false);
    check(",\"timeout\":1e999", false);
    check(",\"source\":false", false);
    check(",\"source\":\"aaaaaaaaaaaaaaaaaaaaaaa\"", true);
    check(",\"source\":\"aaaaaaaaaaaaaaaaaaaaaaaa\"", false);
    check(",\"unknown\":1", false);
    assert(cJSON_ParseWithOpts("{} trailing", NULL, true) == NULL);
    puts("production envelope validation: 21 cases PASS");
    puts("production profile object shape: 7 cases PASS");
    printf("production JSON text/envelope safety: %u cases PASS; 7 bounded escape slices PASS\n", text_cases);
    return 0;
}
