$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC is required.' }
$msvcRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdk = Get-ChildItem (Join-Path $kitsRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$firmwareRoot = Split-Path $PSScriptRoot
$source = Get-Content -Raw (Join-Path $firmwareRoot 'components/api_bridge/src/api_bridge.c')
$start = $source.IndexOf('static esp_err_t api_bridge_begin_wifi_transition(')
$end = $source.IndexOf('void api_bridge_poll_async_transitions(', $start)
$typesStart = $source.IndexOf('typedef enum {', $source.IndexOf('/* FW-02:'))
$typesEnd = $source.IndexOf('static SemaphoreHandle_t s_lock;', $typesStart)
if ($start -lt 0 -or $end -lt $start -or $typesStart -lt 0) { throw 'Production transition seam missing' }
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ('iot-envelope-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildRoot | Out-Null
($source.Substring($typesStart, $typesEnd - $typesStart) + "`nstatic api_bridge_async_transition_table_t s_async_transitions;`n" + $source.Substring($start, $end - $start)) | Set-Content (Join-Path $buildRoot 'wifi_transition_production.h')
$models = Join-Path $firmwareRoot 'components/shared_models/include'
'#pragma once
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERR_INVALID_STATE 259
#define ESP_ERR_TIMEOUT 263
#define ESP_ERR_NO_MEM 257' | Set-Content (Join-Path $buildRoot 'esp_err.h')
$previousInclude = $env:INCLUDE
$previousLib = $env:LIB
Push-Location $buildRoot
try {
    $env:INCLUDE = @((Join-Path $msvcRoot 'include'), (Join-Path $sdk.FullName 'ucrt'), (Join-Path $sdk.FullName 'shared'), (Join-Path $sdk.FullName 'um')) -join ';'
    $env:LIB = @((Join-Path $msvcRoot 'lib/x64'), (Join-Path $kitsRoot ('Lib/' + $sdk.Name + '/ucrt/x64')), (Join-Path $kitsRoot ('Lib/' + $sdk.Name + '/um/x64'))) -join ';'
    & $compiler /nologo /W3 /TC /D_CRT_SECURE_NO_WARNINGS "/I$buildRoot" "/I$models" (Join-Path $PSScriptRoot 'wifi_transition_test.c') /Fe:envelope_test.exe
    if ($LASTEXITCODE -ne 0) { throw 'Envelope compile failed' }
    & .\envelope_test.exe
    if ($LASTEXITCODE -ne 0) { throw 'Envelope regression failed' }
} finally {
    Pop-Location
    $env:INCLUDE = $previousInclude
    $env:LIB = $previousLib
    $resolved = [IO.Path]::GetFullPath($buildRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^iot-envelope-[0-9a-f]{32}$') { throw 'Unsafe cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
