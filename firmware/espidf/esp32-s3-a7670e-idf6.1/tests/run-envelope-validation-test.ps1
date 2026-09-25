$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC is required.' }
$msvcRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdk = Get-ChildItem (Join-Path $kitsRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$firmwareRoot = Split-Path $PSScriptRoot
$source = Get-Content -Raw (Join-Path $firmwareRoot 'components/automation_bridge/src/automation_bridge.c')
$start = $source.IndexOf('static esp_err_t automation_bridge_validate_envelope(')
$end = $source.IndexOf('/* One bounded parse before admission', $start)
if ($start -lt 0 -or $end -lt $start) { throw 'Production validator seam missing' }
$cjson = Join-Path $firmwareRoot 'managed_components/espressif__cjson/cJSON'
$sharedModels = Join-Path $firmwareRoot 'components/shared_models/include'
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ('iot-envelope-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildRoot | Out-Null
# Generated test artifact only; source under test is not rewritten.
$exactStart = $source.IndexOf('static bool automation_bridge_exact_keys(')
$exactEnd = $source.IndexOf('static esp_err_t automation_bridge_parse_item(', $exactStart)
if ($exactStart -lt 0 -or $exactEnd -lt $exactStart) { throw 'Exact-key seam missing' }
($source.Substring($start, $end - $start) + "`n" + $source.Substring($exactStart, $exactEnd - $exactStart)) | Set-Content (Join-Path $buildRoot 'envelope_production.h')
$mqttSource = Get-Content -Raw (Join-Path $firmwareRoot 'components/mqtt_mgr/src/mqtt_mgr.c')
$ackStart = $mqttSource.IndexOf('static esp_err_t mqtt_mgr_process_result_ack(const char *topic, const char *payload) {')
$ackEnd = $mqttSource.IndexOf('/* Re-send the oldest committed result', $ackStart)
if ($ackStart -lt 0 -or $ackEnd -lt $ackStart) { throw 'Result ACK seam missing' }
$mqttSource.Substring($ackStart, $ackEnd - $ackStart) | Set-Content (Join-Path $buildRoot 'result_ack_production.h')
$headers = (Get-Content -Raw (Join-Path $firmwareRoot 'components/shared_models/include/common_models.h')) + (Get-Content -Raw (Join-Path $firmwareRoot 'components/config_mgr/include/config_mgr.h'))
$limits = foreach ($name in @('CONFIG_MGR_DEVICE_ID_LEN','UNIFIED_TEXT_MEDIUM_LEN','UNIFIED_TEXT_SHORT_LEN','UNIFIED_CORRELATION_ID_LEN')) {
    $match = [regex]::Match($headers, ('(?m)^#define\s+' + $name + '\s+\d+'))
    if (!$match.Success) { throw "Production limit missing: $name" }
    $match.Value
}
$limits | Set-Content (Join-Path $buildRoot 'envelope_limits.h')
$previousInclude = $env:INCLUDE
$previousLib = $env:LIB
Push-Location $buildRoot
try {
    $env:INCLUDE = @((Join-Path $msvcRoot 'include'), (Join-Path $sdk.FullName 'ucrt'), (Join-Path $sdk.FullName 'shared'), (Join-Path $sdk.FullName 'um')) -join ';'
    $env:LIB = @((Join-Path $msvcRoot 'lib/x64'), (Join-Path $kitsRoot ('Lib/' + $sdk.Name + '/ucrt/x64')), (Join-Path $kitsRoot ('Lib/' + $sdk.Name + '/um/x64'))) -join ';'
    & $compiler /nologo /W3 /TC /D_CRT_SECURE_NO_WARNINGS "/I$buildRoot" "/I$cjson" "/I$sharedModels" (Join-Path $PSScriptRoot 'envelope_validation_test.c') (Join-Path $cjson 'cJSON.c') /Fe:envelope_test.exe
    if ($LASTEXITCODE -ne 0) { throw 'Envelope compile failed' }
    & .\envelope_test.exe
    if ($LASTEXITCODE -ne 0) { throw 'Envelope regression failed' }
    & $compiler /nologo /W4 /WX /TC /D_CRT_SECURE_NO_WARNINGS "/I$buildRoot" "/I$cjson" "/I$sharedModels" (Join-Path $PSScriptRoot 'result_ack_validation_test.c') (Join-Path $cjson 'cJSON.c') /Fe:result_ack_test.exe
    if ($LASTEXITCODE -ne 0) { throw 'Result ACK compile failed' }
    & .\result_ack_test.exe
    if ($LASTEXITCODE -ne 0) { throw 'Result ACK regression failed' }
} finally {
    Pop-Location
    $env:INCLUDE = $previousInclude
    $env:LIB = $previousLib
    $resolved = [IO.Path]::GetFullPath($buildRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^iot-envelope-[0-9a-f]{32}$') { throw 'Unsafe cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
