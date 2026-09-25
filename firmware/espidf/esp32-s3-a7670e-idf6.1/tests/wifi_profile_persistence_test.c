#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define WIFI_MGR_PROFILE_MAX 4U
typedef struct { bool enabled; uint16_t priority; char ssid[33]; char password[65]; } wifi_mgr_profile_t;
typedef struct { uint32_t revision; uint8_t count; wifi_mgr_profile_t profiles[4]; } wifi_mgr_profile_set_t;
typedef struct { char wifi_ssid[33]; char wifi_password[65]; } config_mgr_data_t;
typedef int esp_err_t;
typedef int nvs_handle_t;
typedef int portMUX_TYPE;
typedef int *SemaphoreHandle_t;
#define ESP_OK 0
#define ESP_ERR_INVALID_ARG 1
#define ESP_ERR_INVALID_STATE 2
#define ESP_ERR_TIMEOUT 3
#define ESP_ERR_NO_MEM 4
#define ESP_ERR_NVS_NOT_FOUND 5
#define NVS_READWRITE 1
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(x) ((void)(x))
#define portEXIT_CRITICAL(x) ((void)(x))
#define pdMS_TO_TICKS(x) (x)
#define pdTRUE 1
static int held, mutex, open_error, set_error, commit_error, writes, commits, notifications;
static bool corrupt_readback;
static unsigned char disk[1024], pending[1024];
static size_t disk_size, pending_size;
static SemaphoreHandle_t xSemaphoreCreateMutex(void) { return &mutex; }
static void vSemaphoreDelete(SemaphoreHandle_t p) { (void)p; }
static int xSemaphoreTake(SemaphoreHandle_t p, int timeout) { (void)p; (void)timeout; assert(!held); held = 1; return 1; }
static void xSemaphoreGive(SemaphoreHandle_t p) { (void)p; assert(held); held = 0; }
static void wifi_mgr_notify_task(void) { assert(!held); notifications++; }
static void config_mgr_snapshot(config_mgr_data_t *c) { memset(c, 0, sizeof(*c)); strcpy(c->wifi_ssid, "Saved"); strcpy(c->wifi_password, "testpass"); }
static int nvs_open(const char *ns, int mode, nvs_handle_t *h) { (void)ns; (void)mode; *h = 1; return open_error; }
static void nvs_close(nvs_handle_t h) { (void)h; pending_size = 0; }
static int nvs_get_blob(nvs_handle_t h, const char *key, void *out, size_t *size) {
    (void)h; (void)key; if (!disk_size) return ESP_ERR_NVS_NOT_FOUND;
    assert(*size >= disk_size); memcpy(out, disk, disk_size);
    if (corrupt_readback) ((unsigned char *)out)[0] ^= 1;
    *size = disk_size; return ESP_OK;
}
static int nvs_set_blob(nvs_handle_t h, const char *key, const void *in, size_t size) {
    (void)h; (void)key; ++writes; if (set_error) return set_error;
    assert(size <= sizeof(pending)); memcpy(pending, in, size); pending_size = size; return ESP_OK;
}
static int nvs_commit(nvs_handle_t h) {
    (void)h; ++commits; if (commit_error) return commit_error;
    memcpy(disk, pending, pending_size); disk_size = pending_size; return ESP_OK;
}
#include "wifi_selection_production.h"
int main(void) {
    wifi_mgr_profile_set_t p = {0}, out = {0};
    bool available = true;
    uint32_t revision = 99;
    uint8_t count = 99;
    assert(wifi_mgr_profiles_auto_state(&available, &revision) == ESP_ERR_INVALID_STATE && !available && revision == 0U);
    assert(wifi_mgr_profiles_metadata(&revision, &count) == ESP_ERR_INVALID_STATE && revision == 0 && count == 0);
    assert(wifi_mgr_profiles_get(&out) == ESP_ERR_INVALID_STATE && writes == 0);
    set_error = 8;
    assert(wifi_mgr_profiles_init() == 8 && !s_loaded && !held);
    set_error = 0; commit_error = 9;
    assert(wifi_mgr_profiles_init() == 9 && !s_loaded && !held);
    commit_error = 0;
    assert(wifi_mgr_profiles_init() == ESP_OK);
    assert(wifi_mgr_profiles_get(&p) == ESP_OK && p.count == 1 && p.revision == 1);
    assert(wifi_mgr_profiles_auto_state(&available, &revision) == ESP_OK && available && revision == 1U);
    int previous_writes = writes;
    assert(wifi_mgr_profiles_apply(&p) == ESP_OK && writes == previous_writes && notifications == 0);
    strcpy(p.profiles[0].ssid, "Changed");
    assert(wifi_mgr_profiles_apply(&p) == ESP_ERR_INVALID_STATE && !held);
    p.revision = 2; open_error = 7;
    assert(wifi_mgr_profiles_apply(&p) == 7 && !held);
    open_error = 0; commit_error = 9;
    assert(wifi_mgr_profiles_apply(&p) == 9 && !held);
    assert(wifi_mgr_profiles_get(&out) == ESP_OK && out.revision == 1);
    commit_error = 0;
    corrupt_readback = true;
    assert(wifi_mgr_profiles_apply(&p) == ESP_ERR_INVALID_STATE && !held);
    assert(wifi_mgr_profiles_get(&out) == ESP_OK && out.revision == 1);
    corrupt_readback = false;
    assert(wifi_mgr_profiles_apply(&p) == ESP_OK);
    assert(notifications == 1);
    assert(wifi_mgr_profiles_metadata(&revision, &count) == ESP_OK && revision == 2 && count == 1);
    s_loaded = false;
    assert(wifi_mgr_profiles_get(&out) == ESP_ERR_INVALID_STATE);
    assert(wifi_mgr_profiles_init() == ESP_OK);
    assert(wifi_mgr_profiles_get(&out) == ESP_OK && out.revision == 2 && strcmp(out.profiles[0].ssid, "Changed") == 0);
    p.revision = 1;
    assert(wifi_mgr_profiles_apply(&p) == ESP_ERR_INVALID_STATE);
    p.revision = 3; p.count = 2; p.profiles[1] = p.profiles[0]; p.profiles[1].enabled = false;
    assert(wifi_mgr_profiles_apply(&p) == ESP_ERR_INVALID_ARG);
    p.count = 1; p.profiles[0].priority = 0;
    assert(wifi_mgr_profiles_apply(&p) == ESP_ERR_INVALID_ARG);
    p.profiles[0].priority = 1; memset(p.profiles[0].password, 'a', 64); p.profiles[0].password[64] = 0;
    assert(validate_set(&p) == ESP_OK);
    p.profiles[0].password[0] = 'z'; assert(validate_set(&p) == ESP_ERR_INVALID_ARG);
    p.revision = 4; p.profiles[0].password[0] = 'a'; p.profiles[0].enabled = false;
    assert(wifi_mgr_profiles_apply(&p) == ESP_OK);
    assert(notifications == 2);
    assert(wifi_mgr_profiles_auto_state(&available, &revision) == ESP_OK && !available && revision == 4U);
    p.revision = 5; p.count = 0;
    assert(wifi_mgr_profiles_apply(&p) == ESP_OK);
    assert(notifications == 3);
    assert(wifi_mgr_profiles_auto_state(&available, &revision) == ESP_OK && !available && revision == 5U);
    disk[0] ^= 1; s_loaded = false;
    assert(wifi_mgr_profiles_init() == ESP_ERR_INVALID_STATE && !s_loaded && !held);
    puts("Profile persistence fault/replay/reboot/validation tests passed");
    return 0;
}
