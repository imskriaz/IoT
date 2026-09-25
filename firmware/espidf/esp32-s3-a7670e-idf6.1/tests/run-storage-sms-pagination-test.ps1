$ErrorActionPreference = 'Stop'

function Get-TestCompiler {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $compiler = & $vswhere -latest -products '*' -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
    if (!$compiler) { throw 'MSVC C compiler is required for the storage SMS tests.' }
    return $compiler
}

function Invoke-HostCTest {
    param(
        [Parameter(Mandatory)] [string] $Compiler,
        [Parameter(Mandatory)] [string] $Source,
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $BuildDirectory
    )
    $exe = Join-Path $BuildDirectory ($Name + '.exe')
    & $Compiler /nologo /W4 /WX /TC $Source "/Fe:$exe" "/Fo:$BuildDirectory\$Name.obj"
    if ($LASTEXITCODE -ne 0) { throw "$Name host compile failed: $LASTEXITCODE" }
    & $exe
    if ($LASTEXITCODE -ne 0) { throw "$Name host test failed: $LASTEXITCODE" }
}

$storagePath = Join-Path $PSScriptRoot '..\components\storage_mgr\src\storage_mgr.c'
$source = Get-Content -Raw $storagePath
$migration = [regex]::Match($source, '(?s)/\* STORAGE_SMS_MIGRATION_TEST_BEGIN \*/(?<source>.*?)/\* STORAGE_SMS_MIGRATION_TEST_END \*/')
$pagination = [regex]::Match($source, '(?s)/\* STORAGE_SMS_PAGINATION_TEST_BEGIN \*/(?<source>.*?)/\* STORAGE_SMS_PAGINATION_TEST_END \*/')
if (!$migration.Success) { throw 'Storage SMS migration test seam is missing.' }
if (!$pagination.Success) { throw 'Storage SMS pagination test seam is missing.' }

$migrationPreamble = @'
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERR_INVALID_ARG -1
#define CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY 4U
#define STORAGE_BLOB_VERSION 7U
#define STORAGE_BLOB_LEGACY_VERSION 5U
#define STORAGE_BLOB_TRANSITION_VERSION 6U
#define STORAGE_SMS_MIGRATED_ID_FIRST 0x80000001U
#define STORAGE_SMS_ID_FIRST 0xC0000001U

typedef struct {
    char text[64];
    uint32_t timestamp_ms;
    int16_t storage_index;
} unified_sms_payload_t;
typedef struct { char value[32]; } unified_call_payload_t;
typedef enum {
    STORAGE_MGR_RECORD_SMS = 1,
    STORAGE_MGR_RECORD_CALL = 2,
} storage_mgr_record_type_t;
typedef union {
    unified_sms_payload_t sms;
    unified_call_payload_t call;
} storage_mgr_record_payload_t;
typedef struct {
    storage_mgr_record_type_t type;
    uint32_t timestamp_ms;
    storage_mgr_record_payload_t payload;
} storage_mgr_record_t;
typedef struct {
    uint32_t version;
    uint32_t count;
    uint32_t head;
    storage_mgr_record_t records[CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY];
} storage_blob_t;
'@

$paginationPreamble = @'
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERR_INVALID_ARG -1
#define ESP_ERR_TIMEOUT -2
#define ESP_ERR_INVALID_SIZE -3
#define pdTRUE 1
#define pdMS_TO_TICKS(value) (value)
#define CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY 12U
#define CONFIG_UNIFIED_STORAGE_SMS_HISTORY_MAX_ENTRIES 8U
#define STORAGE_BLOB_VERSION 7U

typedef struct {
    char from[24];
    char text[96];
    char detail[24];
    uint8_t sim_slot;
    int16_t storage_index;
    uint32_t timestamp_ms;
    bool outgoing;
} unified_sms_payload_t;
typedef struct { char value[16]; } unified_call_payload_t;
typedef enum {
    STORAGE_MGR_RECORD_SMS = 1,
    STORAGE_MGR_RECORD_CALL = 2,
} storage_mgr_record_type_t;
typedef union {
    unified_sms_payload_t sms;
    unified_call_payload_t call;
} storage_mgr_record_payload_t;
typedef struct {
    storage_mgr_record_type_t type;
    uint32_t timestamp_ms;
    storage_mgr_record_payload_t payload;
} storage_mgr_record_t;
typedef struct {
    uint32_t version;
    uint32_t count;
    uint32_t head;
    storage_mgr_record_t records[CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY];
} storage_blob_t;

static int s_lock = 1;
static storage_blob_t *s_blob;
static int xSemaphoreTake(int lock, int ticks) { (void)lock; (void)ticks; return pdTRUE; }
static void xSemaphoreGive(int lock) { (void)lock; }
static void storage_mgr_escape_json(const char *input, char *output, size_t output_len) {
    (void)snprintf(output, output_len, "%s", input ? input : "");
}
'@

$compiler = Get-TestCompiler
$msvcRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdk = Get-ChildItem (Join-Path $kitsRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (!$sdk) { throw 'Windows SDK is required for the storage SMS tests.' }
$buildDir = Join-Path ([IO.Path]::GetTempPath()) ('iot-storage-sms-pages-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildDir | Out-Null
$migrationSource = Join-Path $buildDir 'storage_sms_migration_generated.c'
$paginationSource = Join-Path $buildDir 'storage_sms_pagination_generated.c'
[IO.File]::WriteAllText($migrationSource, $migrationPreamble + $migration.Groups['source'].Value + [Environment]::NewLine + (Get-Content -Raw (Join-Path $PSScriptRoot 'storage_sms_migration_test.c')), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($paginationSource, $paginationPreamble + $pagination.Groups['source'].Value + [Environment]::NewLine + (Get-Content -Raw (Join-Path $PSScriptRoot 'storage_sms_pagination_test.c')), [Text.UTF8Encoding]::new($false))

$previousInclude = $env:INCLUDE
$previousLib = $env:LIB
try {
    $env:INCLUDE = @((Join-Path $msvcRoot 'include'), (Join-Path $sdk.FullName 'ucrt'), (Join-Path $sdk.FullName 'shared'), (Join-Path $sdk.FullName 'um')) -join ';'
    $env:LIB = @((Join-Path $msvcRoot 'lib\x64'), (Join-Path $kitsRoot ('Lib\' + $sdk.Name + '\ucrt\x64')), (Join-Path $kitsRoot ('Lib\' + $sdk.Name + '\um\x64'))) -join ';'
    Invoke-HostCTest -Compiler $compiler -Source $migrationSource -Name 'storage_sms_migration_test' -BuildDirectory $buildDir
    Invoke-HostCTest -Compiler $compiler -Source $paginationSource -Name 'storage_sms_pagination_test' -BuildDirectory $buildDir
} finally {
    $env:INCLUDE = $previousInclude
    $env:LIB = $previousLib
    Remove-Item -LiteralPath $buildDir -Recurse -Force -ErrorAction SilentlyContinue
}
