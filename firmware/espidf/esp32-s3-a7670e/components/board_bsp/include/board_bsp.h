#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define BOARD_NAME              "Waveshare ESP32-S3-A7670E-4G"
#define BOARD_MODEL             "ESP32-S3-A7670E"
#define BOARD_DEVICE_TYPE       "esp32"

#define PIN_MODEM_RX            17
#define PIN_MODEM_TX            18
#define PIN_MODEM_ENABLE        21
#define PIN_SDMMC_CLK           5
#define PIN_SDMMC_CMD           4
#define PIN_SDMMC_D0            6
#define PIN_SDMMC_CARD_DET      46

typedef struct {
    char hardware_uid[24];
    char device_id[32];
    uint32_t flash_size_bytes;
    uint32_t psram_size_bytes;
    bool psram_available;
} board_bsp_identity_t;

typedef struct {
    bool enabled;
    bool one_line_mode;
    bool require_card_detect;
    bool card_detect_active_low;
    int pin_clk;
    int pin_cmd;
    int pin_d0;
    int pin_card_detect;
    char mount_point[16];
} board_bsp_sdcard_config_t;

esp_err_t board_bsp_init(void);
void board_bsp_get_identity(board_bsp_identity_t *out_identity);
void board_bsp_get_sdcard_config(board_bsp_sdcard_config_t *out_config);
