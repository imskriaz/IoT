'use strict';

// Compile the actual firmware implementation with host-only IDF shims. These
// tests never open a device, mount a real filesystem, or read a user's SD card.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const components = path.resolve(__dirname, '../../firmware/espidf/esp32-s3-a7670e-idf6.1/components');
const sourcePath = path.join(components, 'storage_mgr/src/storage_sd.c');
const statusPath = path.join(components, 'device_status/src/device_status.c');
let temporary;
let executable;

function extractFunction(source, signature) {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`Firmware function missing: ${signature}`);
    let depth = 0;
    const body = source.indexOf('{', start);
    for (let i = body; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`Unterminated firmware function: ${signature}`);
}

beforeAll(() => {
    const source = fs.readFileSync(sourcePath, 'utf8').replace(/^#include[^\n]*\n/gm, '');
    const header = fs.readFileSync(path.join(components, 'storage_mgr/include/storage_sd.h'), 'utf8')
        .replace(/^#(?:include|pragma)[^\n]*\n/gm, '');
    const formatter = extractFunction(fs.readFileSync(statusPath, 'utf8'), 'static void device_status_u64_to_dec(');
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'iot-physical-sd-test-'));
    executable = path.join(temporary, process.platform === 'win32' ? 'physical-sd.exe' : 'physical-sd');
    const harness = `
#include <stdbool.h>
#include <stdint.h>
#include <inttypes.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#define ESP_OK 0
#define ESP_ERR_TIMEOUT 1
#define ESP_ERR_NO_MEM 2
#define ESP_ERR_INVALID_STATE 3
#define ESP_ERR_NOT_FOUND 4
#define pdTRUE 1
#define portMAX_DELAY UINT32_MAX
#define pdMS_TO_TICKS(value) (value)
#define MALLOC_CAP_INTERNAL 1
#define MALLOC_CAP_DMA 2
#define MALLOC_CAP_8BIT 4
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGI(...) ((void)0)
#define SDMMC_HOST_FLAG_1BIT 1
#define SDMMC_FREQ_DEFAULT 20000
#define SDMMC_SLOT_NO_CD -1
#define SDMMC_SLOT_NO_WP -1
#define SDMMC_SLOT_FLAG_INTERNAL_PULLUP 1
typedef int esp_err_t;
typedef int SemaphoreHandle_t;
typedef struct { struct { uint32_t capacity; uint32_t sector_size; } csd; } sdmmc_card_t;
typedef struct { int flags, max_freq_khz, slot; } sdmmc_host_t;
typedef struct { int width, clk, cmd, d0, cd, wp, flags; } sdmmc_slot_config_t;
typedef struct { int pin_clk, pin_cmd, pin_d0; } board_bsp_sdcard_config_t;
typedef struct { bool format_if_mount_failed; int max_files, allocation_unit_size; bool disk_status_check_enable; } esp_vfs_fat_mount_config_t;
#define SDMMC_HOST_DEFAULT() ((sdmmc_host_t){0})
#define SDMMC_SLOT_CONFIG_DEFAULT() ((sdmmc_slot_config_t){0})
static uint8_t fixture[5][512];
static uint32_t fixture_lba[5] = {0, 2048, 4096, 8192, 16384};
static uint32_t reads[8];
static int read_count, fail_lba = -1, allocation_count, outstanding, fail_allocation;
static int mount_count, unmount_count, host_init_count, host_deinit_count;
static int mount_result, status_result, init_result, usage_result;
static uint64_t fixture_total = UINT64_C(68719476736), fixture_free = UINT64_C(51539607552);
static sdmmc_card_t mounted_card = {{134217728U, 512U}};
static int mutex_available = 1;
static SemaphoreHandle_t xSemaphoreCreateMutex(void) { return 1; }
static int xSemaphoreTake(SemaphoreHandle_t mutex, uint32_t ticks) {
    (void)mutex; (void)ticks;
    if (!mutex_available) return 0;
    mutex_available = 0;
    return pdTRUE;
}
static void xSemaphoreGive(SemaphoreHandle_t mutex) { (void)mutex; mutex_available = 1; }
static void *heap_caps_malloc(size_t n, int caps) {
    (void)caps;
    if (++allocation_count == fail_allocation) return NULL;
    void *p = malloc(n); if (p) outstanding++; return p;
}
static void *heap_caps_calloc(size_t n, size_t size, int caps) {
    void *p = heap_caps_malloc(n * size, caps); if (p) memset(p, 0, n * size); return p;
}
static void heap_caps_free(void *p) { if (p) { outstanding--; free(p); } }
static int sdmmc_read_sectors(sdmmc_card_t *card, void *buffer, size_t lba, size_t count) {
    assert(count == 1 && lba < card->csd.capacity && read_count < 8);
    reads[read_count++] = (uint32_t)lba;
    if (lba == (size_t)fail_lba) return -1;
    for (int i = 0; i < 5; ++i) if (lba == fixture_lba[i]) { memcpy(buffer, fixture[i], 512); return ESP_OK; }
    return -1;
}
static int esp_vfs_fat_info(const char *p, uint64_t *total, uint64_t *free_bytes) {
    assert(!strcmp(p, "/sd")); *total = fixture_total; *free_bytes = fixture_free; return usage_result;
}
static int esp_vfs_fat_sdcard_unmount(const char *p, sdmmc_card_t *card) {
    assert(!strcmp(p, "/sd") && card == &mounted_card); unmount_count++; return ESP_OK;
}
static int sdmmc_get_status(sdmmc_card_t *card) { assert(card == &mounted_card); return status_result; }
static void board_bsp_get_sdcard_config(board_bsp_sdcard_config_t *board) { *board = (board_bsp_sdcard_config_t){5, 4, 6}; }
static int sdmmc_host_init(void) { host_init_count++; return init_result; }
static int sdmmc_host_init_slot(int host, const sdmmc_slot_config_t *slot) {
    (void)host; assert(slot->width == 1 && slot->cd == -1 && slot->wp == -1); return ESP_OK;
}
static int sdmmc_card_init(const sdmmc_host_t *host, sdmmc_card_t *card) {
    assert(host->flags == SDMMC_HOST_FLAG_1BIT); *card = mounted_card; return ESP_OK;
}
static int sdmmc_host_deinit(void) { host_deinit_count++; return ESP_OK; }
static const char *esp_err_to_name(int error) { (void)error; return "fixture-error"; }
static int esp_vfs_fat_sdmmc_mount(const char *p, const sdmmc_host_t *h,
    const sdmmc_slot_config_t *s, const esp_vfs_fat_mount_config_t *config, sdmmc_card_t **card) {
    (void)h; (void)s; assert(!strcmp(p, "/sd") && !config->format_if_mount_failed);
    mount_count++; if (!mount_result) *card = &mounted_card; return mount_result;
}
${header}
${source}
${formatter}
static void boot(int index, bool exfat) {
    fixture[index][510] = 0x55; fixture[index][511] = 0xaa;
    memcpy(fixture[index] + 3, exfat ? "EXFAT   " : "MSDOS5.0", 8);
    if (!exfat) memcpy(fixture[index] + 82, "FAT32   ", 8);
}
static void partition(int index, uint32_t lba) {
    memset(fixture[0] + 3, 0, 8);
    memset(fixture[0] + 82, 0, 8);
    uint8_t *p = fixture[0] + 446 + index * 16;
    p[4] = 7;
    for (int i = 0; i < 4; ++i) p[8 + i] = (uint8_t)(lba >> (8 * i));
    p[12] = 1;
}
int main(int argc, char **argv) {
    assert(argc >= 2);
    assert(storage_sd_init() == ESP_OK);
    const char *scenario = argv[1];
    if (!strcmp(scenario, "format")) {
        assert(argc == 4); char out[21];
        device_status_u64_to_dec(strtoull(argv[2], NULL, 10), out, sizeof(out));
        assert(!strcmp(out, argv[3])); return 0;
    }
    if (!strcmp(scenario, "little-endian")) {
        const uint8_t bytes[] = {0x98, 0xba, 0xdc, 0xfe};
        assert(read_le32(bytes) == UINT32_C(0xfedcba98)); return 0;
    }
    bool expected = false;
    int expected_reads = 1;
    boot(0, false);
    if (!strcmp(scenario, "superfloppy")) { boot(0, true); expected = true; }
    if (!strcmp(scenario, "mbr-first")) { partition(0, 2048); boot(1, true); expected = true; expected_reads = 2; }
    if (!strcmp(scenario, "mbr-fourth")) {
        for (int i = 0; i < 4; ++i) { partition(i, fixture_lba[i + 1]); boot(i + 1, i == 3); }
        expected = true; expected_reads = 5;
    }
    if (!strcmp(scenario, "fat32-partition")) { partition(0, 2048); boot(1, false); expected_reads = 2; }
    if (!strcmp(scenario, "misplaced-signature")) memcpy(fixture[0] + 82, "EXFAT   ", 8);
    if (!strcmp(scenario, "near-signature")) memcpy(fixture[0] + 3, "EXFAT  X", 8);
    if (!strcmp(scenario, "invalid-boot-signature")) { boot(0, true); fixture[0][511] = 0; }
    if (!strcmp(scenario, "invalid-mbr-signature")) { partition(0, 2048); boot(1, true); fixture[0][511] = 0; }
    if (!strcmp(scenario, "invalid-partition-signature")) {
        partition(0, 2048); boot(1, true); fixture[1][510] = 0; expected_reads = 2;
    }
    if (!strcmp(scenario, "fat32-vbr-not-mbr")) { partition(0, 2048); boot(0, false); boot(1, true); }
    if (!strcmp(scenario, "fat16-vbr-not-mbr")) {
        partition(0, 2048); memcpy(fixture[0] + 54, "FAT16   ", 8); boot(1, true);
    }
    if (!strcmp(scenario, "wrong-partition-type")) { partition(0, 2048); fixture[0][450] = 0x0c; boot(1, true); }
    if (!strcmp(scenario, "empty-partition")) { partition(0, 2048); fixture[0][458] = 0; boot(1, true); }
    if (!strcmp(scenario, "partition-overruns-card")) {
        partition(0, 2048); memset(fixture[0] + 458, 0xff, 4); boot(1, true);
    }
    if (!strcmp(scenario, "out-of-range")) {
        partition(0, 0); partition(1, mounted_card.csd.capacity); partition(2, UINT32_MAX);
    }
    if (!strcmp(scenario, "read-failure")) fail_lba = 0;
    if (!strcmp(scenario, "partition-read-failure")) { partition(0, 2048); fail_lba = 2048; expected_reads = 2; }
    if (!strcmp(scenario, "recover-next-partition")) {
        partition(0, 2048); partition(1, 4096); fail_lba = 2048; boot(2, true); expected = true; expected_reads = 3;
    }
    if (!strcmp(scenario, "allocation-failure")) { fail_allocation = 1; expected_reads = 0; }
    if (!strncmp(scenario, "poll-", 5)) {
        storage_sd_status_t result;
        if (!strcmp(scenario, "poll-exfat")) boot(0, true);
        if (!strcmp(scenario, "poll-mount-failure")) mount_result = -1;
        if (!strcmp(scenario, "poll-allocation-failure")) fail_allocation = 1;
        if (!strcmp(scenario, "poll-init-timeout")) init_result = ESP_ERR_TIMEOUT;
        storage_sd_poll(true, &result);
        assert(outstanding == 0);
        if (!strcmp(scenario, "poll-allocation-failure")) {
            assert(!result.detected && !result.mounted && !strcmp(result.error, "init_failed"));
            assert(host_init_count == 0 && mount_count == 0); return 0;
        }
        if (!strcmp(scenario, "poll-init-timeout")) {
            assert(!result.detected && !result.mounted && !strcmp(result.error, "not_detected"));
            assert(host_deinit_count == 0 && mount_count == 0); return 0;
        }
        assert(result.detected && result.capacity_bytes == UINT64_C(68719476736));
        assert(host_init_count == 1 && host_deinit_count == 1);
        if (!strcmp(scenario, "poll-exfat")) {
            assert(!result.mounted && !strcmp(result.error, "unsupported_exfat") && mount_count == 0); return 0;
        }
        if (!strcmp(scenario, "poll-mount-failure")) {
            assert(!result.mounted && !strcmp(result.error, "mount_failed") && result.total_bytes == 0); return 0;
        }
        assert(result.mounted && result.total_bytes == fixture_total && result.free_bytes == fixture_free);
        assert(result.used_bytes == UINT64_C(17179869184));
        assert(storage_sd_acquire(10U) == ESP_OK);
        storage_sd_release();
        if (!strcmp(scenario, "poll-usage-failure")) {
            usage_result = -1; storage_sd_poll(true, &result);
            assert(!strcmp(result.error, "usage_failed") && !result.total_bytes && !result.used_bytes && !result.free_bytes);
        } else if (!strcmp(scenario, "poll-invalid-free")) {
            fixture_free = fixture_total + 1; storage_sd_poll(true, &result);
            assert(!strcmp(result.error, "usage_failed") && !result.total_bytes && !result.used_bytes && !result.free_bytes);
        } else if (!strcmp(scenario, "poll-removal")) {
            status_result = -1; storage_sd_poll(true, &result);
            assert(!result.detected && !result.mounted && !result.capacity_bytes && !strcmp(result.error, "removed"));
            assert(unmount_count == 1);
        } else if (!strcmp(scenario, "poll-disable")) {
            storage_sd_poll(false, &result);
            assert(!result.detected && !result.mounted && !result.capacity_bytes && !strcmp(result.error, "disabled"));
            assert(unmount_count == 1);
        } else {
            storage_sd_poll(true, &result); assert(mount_count == 1 && host_init_count == 1);
        }
        return 0;
    }
    assert(card_uses_exfat(&mounted_card) == expected);
    assert(read_count == expected_reads && outstanding == 0 && mount_count == 0);
    return 0;
}
`;
    const harnessPath = path.join(temporary, 'physical-sd.c');
    fs.writeFileSync(harnessPath, harness);
    if (process.platform === 'win32') {
        const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
        const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
        if (!installation) throw new Error('MSVC is required for executable firmware SD regressions');
        const setup = path.join(installation, 'VC/Auxiliary/Build/vcvars64.bat');
        execFileSync('cmd.exe', ['/d', '/s', '/c', `""${setup}" >nul && cl /nologo /std:c11 /D_CRT_SECURE_NO_WARNINGS physical-sd.c /Fe:physical-sd.exe"`], { cwd: temporary, stdio: 'pipe', windowsVerbatimArguments: true });
    } else {
        execFileSync(process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', harnessPath, '-o', executable], { stdio: 'pipe' });
    }
}, 60000);

afterAll(() => {
    if (!temporary) return;
    const resolved = path.resolve(temporary);
    const root = path.resolve(os.tmpdir());
    if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('iot-physical-sd-test-')) {
        throw new Error('Refusing cleanup outside this test-created temporary directory');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
});

test.each([
    'little-endian', 'superfloppy', 'mbr-first', 'mbr-fourth', 'fat32', 'fat32-partition',
    'misplaced-signature', 'near-signature', 'invalid-boot-signature', 'invalid-mbr-signature',
    'invalid-partition-signature', 'fat32-vbr-not-mbr', 'fat16-vbr-not-mbr',
    'wrong-partition-type', 'empty-partition', 'partition-overruns-card',
    'out-of-range', 'read-failure', 'partition-read-failure', 'recover-next-partition', 'allocation-failure',
    'poll-64gb', 'poll-exfat', 'poll-mount-failure', 'poll-allocation-failure', 'poll-init-timeout',
    'poll-usage-failure', 'poll-invalid-free', 'poll-removal', 'poll-disable'
])('executes physical SD behavior: %s', scenario => {
    expect(() => execFileSync(executable, [scenario], { stdio: 'pipe' })).not.toThrow();
});

test.each(['0', '4294967295', '4294967296', '64000000000', '68719476736', '18446744073709551615'])('serializes 64-bit bytes without nano printf: %s', value => {
    expect(() => execFileSync(executable, ['format', value, value], { stdio: 'pipe' })).not.toThrow();
});

test('physical SD probe never formats or writes files', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).toMatch(/format_if_mount_failed\s*=\s*false/);
    expect(source).not.toMatch(/format_if_mount_failed\s*=\s*true|\b(?:fopen|fwrite|fprintf|sdmmc_write_sectors|f_mkfs|esp_vfs_fat_sdcard_format)\s*\(/);
});

test('physical SD mount is separate from the internal-flash durable spool', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const manager = fs.readFileSync(path.join(components, 'storage_mgr/src/storage_mgr.c'), 'utf8');
    const flashMount = extractFunction(manager, 'static esp_err_t storage_mgr_try_mount_sd(void) {');
    expect(source).toMatch(/#define SD_MOUNT_POINT "\/sd"/);
    expect(source).not.toContain('esp_vfs_fat_spiflash_mount');
    expect(flashMount).toContain('"/storage"');
    expect(flashMount).toContain('esp_vfs_fat_spiflash_mount_rw_wl');
    expect(flashMount).not.toContain('"/sd"');
});

test('all SD capacity and usage fields use nano-safe decimal serialization', () => {
    const source = fs.readFileSync(statusPath, 'utf8');
    for (const field of ['capacity', 'total', 'used', 'free']) {
        expect(source).toContain(`device_status_u64_to_dec(snapshot->sd_${field}_bytes, scratch->sd_${field}, sizeof(scratch->sd_${field}))`);
        expect(source).toContain(`sd_${field}_bytes\\\":%s`);
    }
    expect(extractFunction(source, 'static void device_status_u64_to_dec(')).not.toMatch(/printf|PRIu64|%llu/);
});
