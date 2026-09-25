#include "storage_sd.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include "board_bsp.h"
#include "driver/sdmmc_host.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "sdmmc_cmd.h"

#define SD_MOUNT_POINT "/sd"
static const char *TAG = "physical_sd";
static sdmmc_card_t *s_card;
static storage_sd_status_t s_status = {.error = "not_probed"};
static SemaphoreHandle_t s_io_lock;

esp_err_t storage_sd_init(void) {
    if (s_io_lock) {
        return ESP_OK;
    }
    s_io_lock = xSemaphoreCreateMutex();
    return s_io_lock ? ESP_OK : ESP_ERR_NO_MEM;
}

esp_err_t storage_sd_acquire(uint32_t timeout_ms) {
    if (!s_io_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_io_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    if (!s_card || !s_status.mounted) {
        xSemaphoreGive(s_io_lock);
        return ESP_ERR_NOT_FOUND;
    }
    return ESP_OK;
}

void storage_sd_release(void) {
    if (s_io_lock) {
        xSemaphoreGive(s_io_lock);
    }
}

static void set_error(const char *error) {
    snprintf(s_status.error, sizeof(s_status.error), "%s", error);
}

static uint32_t read_le32(const uint8_t *bytes) {
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) |
           ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

/* Read only the boot sector(s), never filenames or contents. IDF 5.3's
 * bundled FatFs has FF_FS_EXFAT=0; report that format without erasing it. */
static bool card_uses_exfat(sdmmc_card_t *card) {
    uint8_t *sector = heap_caps_malloc(512, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    bool exfat = false;
    if (!sector) {
        return false;
    }
    if (sdmmc_read_sectors(card, sector, 0, 1) == ESP_OK) {
        bool signature = sector[510] == 0x55 && sector[511] == 0xaa;
        exfat = signature && memcmp(sector + 3, "EXFAT   ", 8) == 0;
        bool fat_boot = memcmp(sector + 54, "FAT", 3) == 0 ||
                        memcmp(sector + 82, "FAT32", 5) == 0;
        if (!exfat && !fat_boot && signature) {
            /* MBR partition entries; do not follow unbounded/corrupt offsets. */
            uint32_t partitions[4] = {0};
            for (unsigned i = 0; i < 4; ++i) {
                const uint8_t *entry = sector + 446 + i * 16;
                uint32_t start = read_le32(entry + 8);
                uint32_t count = read_le32(entry + 12);
                if (entry[4] == 0x07 && start > 0 && start < card->csd.capacity &&
                    count > 0 && count <= card->csd.capacity - start) {
                    partitions[i] = start;
                }
            }
            for (unsigned i = 0; i < 4 && !exfat; ++i) {
                if (partitions[i] > 0 && partitions[i] < card->csd.capacity &&
                    sdmmc_read_sectors(card, sector, partitions[i], 1) == ESP_OK) {
                    exfat = sector[510] == 0x55 && sector[511] == 0xaa &&
                            memcmp(sector + 3, "EXFAT   ", 8) == 0;
                }
            }
        }
    }
    heap_caps_free(sector);
    return exfat;
}

static void refresh_usage(void) {
    uint64_t total = 0, free_bytes = 0;
    esp_err_t err = esp_vfs_fat_info(SD_MOUNT_POINT, &total, &free_bytes);
    if (err == ESP_OK && free_bytes <= total) {
        s_status.total_bytes = total;
        s_status.free_bytes = free_bytes;
        s_status.used_bytes = total - free_bytes;
        set_error("");
    } else {
        s_status.total_bytes = s_status.free_bytes = s_status.used_bytes = 0;
        set_error("usage_failed");
    }
}

void storage_sd_poll(bool enabled, storage_sd_status_t *out_status) {
    if (!out_status) {
        return;
    }
    if (!s_io_lock || xSemaphoreTake(s_io_lock, portMAX_DELAY) != pdTRUE) {
        memset(out_status, 0, sizeof(*out_status));
        snprintf(out_status->error, sizeof(out_status->error), "%s", "lease_failed");
        return;
    }
    if (!enabled) {
        if (s_card) {
            esp_vfs_fat_sdcard_unmount(SD_MOUNT_POINT, s_card);
            s_card = NULL;
        }
        memset(&s_status, 0, sizeof(s_status));
        set_error("disabled");
        *out_status = s_status;
        xSemaphoreGive(s_io_lock);
        return;
    }
    if (s_card) {
        if (sdmmc_get_status(s_card) == ESP_OK) {
            refresh_usage();
        } else {
            esp_vfs_fat_sdcard_unmount(SD_MOUNT_POINT, s_card);
            s_card = NULL;
            memset(&s_status, 0, sizeof(s_status));
            set_error("removed");
            ESP_LOGW(TAG, "SD no longer responding; internal flash unchanged");
        }
        *out_status = s_status;
        xSemaphoreGive(s_io_lock);
        return;
    }

    board_bsp_sdcard_config_t board = {0};
    board_bsp_get_sdcard_config(&board);
    sdmmc_host_t host = SDMMC_HOST_DEFAULT();
    sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
    host.flags = SDMMC_HOST_FLAG_1BIT;
    host.max_freq_khz = SDMMC_FREQ_DEFAULT;
    slot.width = 1;
    slot.clk = board.pin_clk;
    slot.cmd = board.pin_cmd;
    slot.d0 = board.pin_d0;
    /* GPIO46 is also a camera pin on V2: never trust or drive card detect. */
    slot.cd = SDMMC_SLOT_NO_CD;
    slot.wp = SDMMC_SLOT_NO_WP;
    slot.flags |= SDMMC_SLOT_FLAG_INTERNAL_PULLUP;
    memset(&s_status, 0, sizeof(s_status));

    sdmmc_card_t *probe = heap_caps_calloc(1, sizeof(*probe), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!probe) {
        set_error("init_failed");
        *out_status = s_status;
        return;
    }
    esp_err_t err = sdmmc_host_init();
    bool host_ready = err == ESP_OK;
    if (err == ESP_OK) {
        err = sdmmc_host_init_slot(host.slot, &slot);
    }
    if (err == ESP_OK) {
        err = sdmmc_card_init(&host, probe);
    }
    bool exfat = false;
    if (err == ESP_OK) {
        s_status.detected = true;
        s_status.capacity_bytes = (uint64_t)probe->csd.capacity * probe->csd.sector_size;
        exfat = card_uses_exfat(probe);
    }
    if (host_ready) {
        sdmmc_host_deinit();
    }
    heap_caps_free(probe);
    if (err != ESP_OK) {
        set_error(err == ESP_ERR_TIMEOUT ? "not_detected" : "init_failed");
        ESP_LOGW(TAG, "SD probe failed: %s; no format attempted", esp_err_to_name(err));
    } else if (exfat) {
        set_error("unsupported_exfat");
        ESP_LOGW(TAG, "SD detected capacity_mib=%" PRIu32 " filesystem=exFAT (unsupported by bundled FatFs); unchanged",
                 (uint32_t)(s_status.capacity_bytes / (1024U * 1024U)));
    } else {
        const esp_vfs_fat_mount_config_t mount = {
            .format_if_mount_failed = false,
            .max_files = 4,
            .allocation_unit_size = 16 * 1024,
            .disk_status_check_enable = true,
        };
        err = esp_vfs_fat_sdmmc_mount(SD_MOUNT_POINT, &host, &slot, &mount, &s_card);
        if (err == ESP_OK) {
            s_status.mounted = true;
            refresh_usage();
            ESP_LOGI(TAG, "SD mounted capacity_mib=%" PRIu32 " total_mib=%" PRIu32 " free_mib=%" PRIu32,
                     (uint32_t)(s_status.capacity_bytes / (1024U * 1024U)),
                     (uint32_t)(s_status.total_bytes / (1024U * 1024U)),
                     (uint32_t)(s_status.free_bytes / (1024U * 1024U)));
        } else {
            s_card = NULL;
            set_error("mount_failed");
            ESP_LOGW(TAG, "SD detected but mount failed: %s; card unchanged", esp_err_to_name(err));
        }
    }
    *out_status = s_status;
    xSemaphoreGive(s_io_lock);
}
