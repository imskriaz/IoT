#include "board_bsp.h"

#include <stdio.h>
#include <string.h>

#include "esp_flash.h"
#include "esp_mac.h"
#if CONFIG_SPIRAM
#include "esp_psram.h"
#endif

static board_bsp_identity_t s_identity;
static board_bsp_sdcard_config_t s_sdcard_config;
static bool s_ready;

esp_err_t board_bsp_init(void) {
    uint32_t flash_size = 0;
    uint8_t mac[6] = {0};

    if (s_ready) {
        return ESP_OK;
    }

    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));

    snprintf(
        s_identity.hardware_uid,
        sizeof(s_identity.hardware_uid),
        "%02X%02X%02X%02X%02X%02X",
        mac[0],
        mac[1],
        mac[2],
        mac[3],
        mac[4],
        mac[5]
    );
    snprintf(
        s_identity.device_id,
        sizeof(s_identity.device_id),
        "ws-a7670e-%02x%02x%02x",
        mac[3],
        mac[4],
        mac[5]
    );

    ESP_ERROR_CHECK(esp_flash_get_size(NULL, &flash_size));
    s_identity.flash_size_bytes = flash_size;
#if CONFIG_SPIRAM
    s_identity.psram_size_bytes = esp_psram_get_size();
#else
    s_identity.psram_size_bytes = 0;
#endif
    s_identity.psram_available = s_identity.psram_size_bytes > 0;

    memset(&s_sdcard_config, 0, sizeof(s_sdcard_config));
    s_sdcard_config.enabled = true;
    s_sdcard_config.one_line_mode = true;
    s_sdcard_config.require_card_detect = false;
    s_sdcard_config.card_detect_active_low = true;
    s_sdcard_config.pin_clk = PIN_SDMMC_CLK;
    s_sdcard_config.pin_cmd = PIN_SDMMC_CMD;
    s_sdcard_config.pin_d0 = PIN_SDMMC_D0;
    s_sdcard_config.pin_card_detect = PIN_SDMMC_CARD_DET;
    snprintf(s_sdcard_config.mount_point, sizeof(s_sdcard_config.mount_point), "%s", "/sd");

    s_ready = true;
    return ESP_OK;
}

void board_bsp_get_identity(board_bsp_identity_t *out_identity) {
    if (!out_identity) {
        return;
    }
    if (!s_ready) {
        memset(out_identity, 0, sizeof(*out_identity));
        return;
    }
    *out_identity = s_identity;
}

void board_bsp_get_sdcard_config(board_bsp_sdcard_config_t *out_config) {
    if (!out_config) {
        return;
    }

    *out_config = s_sdcard_config;
}
