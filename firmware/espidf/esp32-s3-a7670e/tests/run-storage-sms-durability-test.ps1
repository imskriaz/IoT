$ErrorActionPreference = 'Stop'

function Get-TestCompiler {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $compiler = & $vswhere -latest -products '*' -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
    if (!$compiler) { throw 'MSVC C compiler is required for the storage/SMS durability host tests.' }
    return $compiler
}

function Invoke-HostCTest {
    param(
        [Parameter(Mandatory)] [string] $Compiler,
        [Parameter(Mandatory)] [string] $Source,
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $BuildDirectory
    )

    $testExe = Join-Path $BuildDirectory ($Name + '.exe')
    & $Compiler /nologo /W4 /WX /TC $Source "/Fe:$testExe" "/Fo:$BuildDirectory\$Name.obj"
    if ($LASTEXITCODE -ne 0) { throw "$Name host compile failed: $LASTEXITCODE" }
    & $testExe
    if ($LASTEXITCODE -ne 0) { throw "$Name host test failed: $LASTEXITCODE" }
}

$storagePath = Join-Path $PSScriptRoot '..\components\storage_mgr\src\storage_mgr.c'
$smsPath = Join-Path $PSScriptRoot '..\components\sms_service\src\sms_service.c'
$storageSource = Get-Content -Raw $storagePath
$smsSource = Get-Content -Raw $smsPath
$storageMatch = [regex]::Match(
    $storageSource,
    '(?s)/\* STORAGE_DURABILITY_TEST_BEGIN \*/(?<source>.*?)/\* STORAGE_DURABILITY_TEST_END \*/'
)
$storageDeleteMatch = [regex]::Match(
    $storageSource,
    '(?s)/\* STORAGE_DELETE_DURABILITY_TEST_BEGIN \*/(?<source>.*?)/\* STORAGE_DELETE_DURABILITY_TEST_END \*/'
)
$smsMatch = [regex]::Match(
    $smsSource,
    '(?s)/\* SMS_DURABILITY_TEST_BEGIN \*/(?<source>.*?)/\* SMS_DURABILITY_TEST_END \*/'
)
if (!$storageMatch.Success) { throw 'Storage durability test seam is missing from storage_mgr.c.' }
if (!$storageDeleteMatch.Success) { throw 'Storage delete durability test seam is missing from storage_mgr.c.' }
if (!$smsMatch.Success) { throw 'SMS durability test seam is missing from sms_service.c.' }
if ($storageSource -notmatch '(?s)static esp_err_t storage_mgr_append_record\(.*?storage_mgr_append_record_durable_locked\(record\)') {
    throw 'Storage append no longer uses the synchronous durable append boundary.'
}

$compiler = Get-TestCompiler
$msvcRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdk = Get-ChildItem (Join-Path $kitsRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (!$sdk) { throw 'Windows SDK is required for the storage/SMS durability host tests.' }

$testBuild = Join-Path ([IO.Path]::GetTempPath()) ('iot-storage-sms-durability-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testBuild | Out-Null
$storageGenerated = Join-Path $testBuild 'storage_append_durability_generated.c'
$storageDeleteGenerated = Join-Path $testBuild 'storage_delete_durability_generated.c'
$smsGenerated = Join-Path $testBuild 'sms_delivery_order_generated.c'

$storagePreamble = @'
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_INVALID_ARG -2
#define ESP_ERR_NO_MEM -3
#define ESP_ERR_INVALID_STATE -4
#define CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY 3U
#define STORAGE_BLOB_VERSION 7U
#define STORAGE_SMS_ID_FIRST 0xC0000001U

typedef enum {
    STORAGE_MGR_RECORD_SMS = 1,
    STORAGE_MGR_RECORD_CALL = 2,
} storage_mgr_record_type_t;
typedef struct {
    int value;
    storage_mgr_record_type_t type;
    uint32_t timestamp_ms;
} storage_mgr_record_t;
typedef struct {
    uint32_t version;
    uint32_t count;
    uint32_t head;
    storage_mgr_record_t records[CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY];
} storage_blob_t;
typedef struct {
    bool enabled;
    uint32_t record_count;
    uint32_t dropped_count;
} storage_mgr_status_t;

static storage_blob_t test_blob;
static storage_blob_t *s_blob;
static storage_mgr_status_t s_status;
static bool s_persist_dirty;
static esp_err_t persist_result;
static unsigned persist_calls;

static uint32_t unified_tick_now_ms(void) { return 123U; }
static void storage_mgr_refresh_config_locked(void) {}
static uint32_t storage_mgr_next_sms_id_locked(void) {
    uint32_t id = s_blob->head ? s_blob->head : STORAGE_SMS_ID_FIRST;
    s_blob->head = id + 1U;
    return id;
}
static esp_err_t storage_mgr_flush_persist_locked(uint32_t now_ms) {
    (void)now_ms;
    persist_calls++;
    if (persist_result == ESP_OK) s_persist_dirty = false;
    return persist_result;
}

'@

$storageDeletePreamble = @'
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_INVALID_ARG -2
#define CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY 3U

typedef struct { int value; } storage_mgr_record_t;
typedef struct {
    uint32_t version;
    uint32_t count;
    uint32_t head;
    storage_mgr_record_t records[CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY];
} storage_blob_t;
typedef struct { uint32_t record_count; } storage_mgr_status_t;

static storage_blob_t test_blob;
static storage_blob_t candidate_blob;
static storage_blob_t *s_blob;
static storage_mgr_status_t s_status;
static bool s_persist_dirty;
static esp_err_t persist_result;
static unsigned persist_calls;

static uint32_t unified_tick_now_ms(void) { return 123U; }
static esp_err_t storage_mgr_flush_persist_locked(uint32_t now_ms) {
    (void)now_ms;
    persist_calls++;
    if (persist_result == ESP_OK) s_persist_dirty = false;
    return persist_result;
}

'@

$smsPreamble = @'
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

typedef int esp_err_t;
typedef int SemaphoreHandle_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define pdTRUE 1
#define pdMS_TO_TICKS(value) (value)

typedef struct {
    char from[64];
    char text[256];
    char detail[96];
    unsigned multipart_part_count;
} unified_sms_payload_t;
typedef enum {
    SMS_EMIT_OK = 0,
    SMS_EMIT_PUBLISH_PENDING,
    SMS_EMIT_FAILED,
} sms_emit_result_t;

static SemaphoreHandle_t s_lock = 1;
static bool storage_exists;
static esp_err_t storage_result;
static esp_err_t publish_result;
static esp_err_t delete_result;
static unsigned append_calls;
static unsigned publish_calls;
static unsigned record_calls;
static unsigned clear_calls;
static unsigned delete_calls;

static void unified_copy_cstr(char *output, size_t output_len, const char *input) {
    if (!output || output_len == 0U) return;
    if (!input) input = "";
    strncpy_s(output, output_len, input, _TRUNCATE);
}
static bool storage_mgr_sms_exists(const unified_sms_payload_t *payload) {
    (void)payload;
    return storage_exists;
}
static esp_err_t storage_mgr_append_sms(const unified_sms_payload_t *payload) {
    (void)payload;
    append_calls++;
    return storage_result;
}
static esp_err_t mqtt_mgr_publish_sms_incoming(const unified_sms_payload_t *payload) {
    (void)payload;
    publish_calls++;
    return publish_result;
}
static int xSemaphoreTake(SemaphoreHandle_t lock, int ticks) {
    (void)lock;
    (void)ticks;
    return pdTRUE;
}
static void xSemaphoreGive(SemaphoreHandle_t lock) { (void)lock; }
static void sms_service_record_incoming_locked(const unified_sms_payload_t *payload, const char *detail) {
    (void)payload;
    (void)detail;
    record_calls++;
}
static void modem_a7670_clear_consumed_sms(void) { clear_calls++; }
static esp_err_t modem_a7670_delete_consumed_sms(unsigned timeout_ms) {
    (void)timeout_ms;
    delete_calls++;
    return delete_result;
}
#define SMS_SERVICE_CONSUMED_DELETE_TIMEOUT_MS 1000U

'@

[IO.File]::WriteAllText(
    $storageGenerated,
    $storagePreamble + $storageMatch.Groups['source'].Value + [Environment]::NewLine +
        (Get-Content -Raw (Join-Path $PSScriptRoot 'storage_append_durability_test.c')),
    [Text.UTF8Encoding]::new($false)
)
[IO.File]::WriteAllText(
    $storageDeleteGenerated,
    $storageDeletePreamble + $storageDeleteMatch.Groups['source'].Value + [Environment]::NewLine +
        (Get-Content -Raw (Join-Path $PSScriptRoot 'storage_delete_durability_test.c')),
    [Text.UTF8Encoding]::new($false)
)
[IO.File]::WriteAllText(
    $smsGenerated,
    $smsPreamble + $smsMatch.Groups['source'].Value + [Environment]::NewLine +
        (Get-Content -Raw (Join-Path $PSScriptRoot 'sms_delivery_order_test.c')),
    [Text.UTF8Encoding]::new($false)
)

$previousInclude = $env:INCLUDE
$previousLib = $env:LIB
try {
    $env:INCLUDE = @(
        (Join-Path $msvcRoot 'include'),
        (Join-Path $sdk.FullName 'ucrt'),
        (Join-Path $sdk.FullName 'shared'),
        (Join-Path $sdk.FullName 'um')
    ) -join ';'
    $env:LIB = @(
        (Join-Path $msvcRoot 'lib\x64'),
        (Join-Path $kitsRoot ('Lib\' + $sdk.Name + '\ucrt\x64')),
        (Join-Path $kitsRoot ('Lib\' + $sdk.Name + '\um\x64'))
    ) -join ';'
    Invoke-HostCTest -Compiler $compiler -Source $storageGenerated -Name 'storage_append_durability_test' -BuildDirectory $testBuild
    Invoke-HostCTest -Compiler $compiler -Source $storageDeleteGenerated -Name 'storage_delete_durability_test' -BuildDirectory $testBuild
    Invoke-HostCTest -Compiler $compiler -Source $smsGenerated -Name 'sms_delivery_order_test' -BuildDirectory $testBuild
} finally {
    $env:INCLUDE = $previousInclude
    $env:LIB = $previousLib
}
