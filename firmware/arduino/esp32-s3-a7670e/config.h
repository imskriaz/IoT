#pragma once

// ── Hardware Pins (Waveshare ESP32-S3-A7670E-4G V2.0 — verified on hardware) ──
// V2 routes A7670E UART through TXB0104PWR to GPIO17(RX)/GPIO18(TX).
// V1 used GPIO40/45 — if you have V1, update these.
#define MODEM_RX_PIN     17      // ESP32 ← A7670E TXD  (via TXB0104PWR)
#define MODEM_TX_PIN     18      // ESP32 → A7670E RXD  (via TXB0104PWR)
#define MODEM_EN_PIN     21      // TXB0104PWR OE — HIGH enables level shifter
#define MODEM_BAUD       115200

// Board metadata published to the dashboard About page.
#ifndef BOARD_SLUG
#  define BOARD_SLUG     "waveshare-esp32-s3-a7670e-4g-v2"
#endif
#ifndef BOARD_NAME
#  define BOARD_NAME     "Waveshare ESP32-S3-A7670E-4G"
#endif
#ifndef BOARD_VENDOR
#  define BOARD_VENDOR   "Waveshare"
#endif
#ifndef BOARD_REVISION
#  define BOARD_REVISION "V2.0"
#endif
#ifndef BOARD_FAMILY
#  define BOARD_FAMILY   "ESP32-S3 + A7670E"
#endif
#ifndef BOARD_CHIP
#  define BOARD_CHIP     "ESP32-S3R8"
#endif
#ifndef BOARD_CPU
#  define BOARD_CPU      "Xtensa LX7 dual-core up to 240 MHz"
#endif
#ifndef BOARD_FLASH
#  define BOARD_FLASH    "16 MB"
#endif
#ifndef BOARD_PSRAM
#  define BOARD_PSRAM    "8 MB"
#endif
#ifndef GIT_HASH
#  define GIT_HASH       "dev"
#endif

// V2 I2C for MAX17048G fuel gauge
#define I2C_SDA_PIN      15      // MAX17048G SDA (V2: GPIO15)
#define I2C_SCL_PIN      16      // MAX17048G SCL (V2: GPIO16)

#define RGB_PIN          38      // WS2812B NeoPixel (1 pixel)
#define RGB_COUNT        1

// Camera connector (verified on the same unit during dedicated A/B testing).
// Note: SCCB uses GPIO15/16, which are also shared with the battery gauge I2C bus.
// The current proven camera path works alongside the rest of the board in testing,
// but future external devices should not assume these pins are free.
#define CAMERA_PWDN_PIN   -1
#define CAMERA_RESET_PIN  -1
#define CAMERA_XCLK_PIN   39
#define CAMERA_SIOD_PIN   15
#define CAMERA_SIOC_PIN   16
#define CAMERA_Y9_PIN     14
#define CAMERA_Y8_PIN     13
#define CAMERA_Y7_PIN     12
#define CAMERA_Y6_PIN     11
#define CAMERA_Y5_PIN     10
#define CAMERA_Y4_PIN      9
#define CAMERA_Y3_PIN      8
#define CAMERA_Y2_PIN      7
#define CAMERA_VSYNC_PIN  42
#define CAMERA_HREF_PIN   41
#define CAMERA_PCLK_PIN   46
#define CAMERA_HTTP_PORT  81

// ── Timing ────────────────────────────────────────────────────────────────────
#define STATUS_INTERVAL_MS      60000   // publish status heartbeat every 1 min
#define GPS_INTERVAL_MS         60000   // publish GPS updates every 1 min by default
#define SIGNAL_FALLBACK_MS      60000   // AT+CSQ fallback poll every 1 min
#define MQTT_KEEPALIVE_SEC      60      // MQTT keepalive
#define AT_TIMEOUT_MS           5000    // default AT command timeout
#define AT_CONNECT_TIMEOUT_MS   15000   // for NETOPEN / CMQTTCONNECT
#define RECONNECT_BASE_MS       2000    // exponential backoff base
#define RECONNECT_MAX_MS        60000   // backoff cap

// ── SD Card SPI Pins (HSPI peripheral, expansion header) ─────────────────────
// Override in credentials.h or here if your wiring differs.
// GPIO10–13 are free on ESP32-S3 (not used by internal flash which uses GPIO0–9).
#ifndef SDMMC_CLK_PIN
#  define SDMMC_CLK_PIN 5
#endif
#ifndef SDMMC_CMD_PIN
#  define SDMMC_CMD_PIN 4
#endif
#ifndef SDMMC_D0_PIN
#  define SDMMC_D0_PIN  6
#endif
#ifndef SDMMC_CD_PIN
#  define SDMMC_CD_PIN  46
#endif

// ── Buffer Sizes ──────────────────────────────────────────────────────────────
#define AT_BUF_SIZE      512    // serial read ring buffer
#define JSON_BUF_SIZE    2048   // outgoing JSON payload buffer
#define TOPIC_BUF_SIZE   128    // MQTT topic string buffer
#define CMD_BUF_SIZE     256    // incoming command payload buffer
