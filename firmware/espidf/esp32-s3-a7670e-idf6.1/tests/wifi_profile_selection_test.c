#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
typedef struct { unsigned char ssid[33]; int8_t rssi; } wifi_ap_record_t;
typedef struct { bool enabled; uint16_t priority; char ssid[33]; char password[65]; } wifi_mgr_profile_t;
typedef struct { uint32_t revision; uint8_t count; wifi_mgr_profile_t profiles[4]; } wifi_mgr_profile_set_t;
#include "wifi_selection_production.h"
int main(void) {
    wifi_ap_record_t aps[] = {{"Unsaved", -20}, {"Second", -30}, {"First", -90}};
    wifi_mgr_profile_set_t profiles = { .revision = 1, .count = 2,
        .profiles = {{true, 1, "First", ""}, {true, 2, "Second", ""}} };
    assert(wifi_mgr_find_target_record(aps, 1, "Missing", &profiles) == UINT16_MAX);
    assert(wifi_mgr_find_target_record(aps, 3, "Missing", &profiles) == 2);
    profiles.profiles[0].enabled = false;
    assert(wifi_mgr_find_target_record(aps, 3, "First", &profiles) == 1);
    profiles.profiles[1].enabled = false;
    assert(wifi_mgr_find_target_record(aps, 3, "First", &profiles) == UINT16_MAX);
    profiles.profiles[0].enabled = profiles.profiles[1].enabled = true;
    profiles.profiles[1].priority = 1;
    assert(wifi_mgr_find_target_record(aps, 3, "", &profiles) == 1);
    aps[2].rssi = -30;
    assert(wifi_mgr_find_target_record(aps, 3, "", &profiles) == 2);
    assert(wifi_mgr_find_target_record(aps, 0, "", &profiles) == UINT16_MAX);
    assert(wifi_mgr_find_target_record(NULL, 3, "", &profiles) == UINT16_MAX);
    assert(wifi_mgr_find_target_record(aps, 3, "First", NULL) == 2);
    assert(wifi_mgr_find_target_record(aps, 3, "Missing", NULL) == UINT16_MAX);
    profiles.count = 0;
    assert(wifi_mgr_find_target_record(aps, 3, "First", &profiles) == UINT16_MAX);
    puts("Wi-Fi profile selection: 11 cases passed");
    return 0;
}
