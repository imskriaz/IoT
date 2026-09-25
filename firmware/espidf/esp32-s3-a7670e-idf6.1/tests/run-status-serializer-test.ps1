$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$source = Get-Content -Raw "$root/components/device_status/src/device_status.c"
$header = Get-Content -Raw "$root/components/device_status/include/device_status.h"
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC/Tools/MSVC/**/bin/Hostx64/x64/cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC required' }
$msvc = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdk = Get-ChildItem "$kits/Include" -Directory | Sort-Object Name -Descending | Select-Object -First 1
$build = Join-Path ([IO.Path]::GetTempPath()) ('iot-status-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $build | Out-Null
$savedInclude = $env:INCLUDE
$savedLib = $env:LIB
try {
    $patterns = @(
        '(?s)typedef struct \{.*?(?=static const char \*device_status_reset_reason_name)',
        '(?s)static void device_status_escape_json\(.*?(?=esp_err_t device_status_init)',
        '(?s)esp_err_t device_status_build_json_from_snapshot\(.*?(?=esp_err_t device_status_build_json\()'
    )
    $parts = foreach ($pattern in $patterns) {
        $match = [regex]::Match($source, $pattern)
        if (!$match.Success) { throw "Production function extraction failed: $pattern" }
        $match.Value
    }
    $parts | Set-Content "$build/status_functions.inc"
    $telemetry = Get-Content -Raw "$root/components/telemetry_service/src/telemetry_service.c"
    $defines = [regex]::Matches($telemetry, '(?m)^#define TELEMETRY_\w+\s+\d+U?\s*$') | ForEach-Object { $_.Value }
    $start = $telemetry.IndexOf('static uint32_t telemetry_bucket_u32(')
    $end = $telemetry.IndexOf('static uint32_t telemetry_stable_publish_interval_ms(', $start)
    if ($start -lt 0 -or $end -le $start) { throw 'Telemetry fingerprint extraction seam missing' }
    ($defines -join "`n") + "`n" + $telemetry.Substring($start, $end - $start) | Set-Content "$build/telemetry_fingerprint.inc"
    $fields = foreach ($field in [regex]::Matches($header, '(?m)^    (char|u?int\d+_t|bool) (\w+)(\[[^;]+\])?;')) {
        $type = $field.Groups[1].Value; $name = $field.Groups[2].Value
        if ($type -eq 'char') { "memset(snapshot.$name, 34, sizeof(snapshot.$name) - 1U);" }
        elseif ($type -eq 'bool') { "snapshot.$name = true;" }
        elseif ($type.StartsWith('uint')) { "snapshot.$name = " + $type.Replace('_t', '').ToUpper() + '_MAX;' }
        else { "snapshot.$name = " + $type.Replace('_t', '').ToUpper() + '_MAX;' }
    }
    $fields | Set-Content "$build/status_max_fields.inc"
    $env:INCLUDE = "$msvc/include;$($sdk.FullName)/ucrt;$($sdk.FullName)/shared;$($sdk.FullName)/um"
    $env:LIB = "$msvc/lib/x64;$kits/Lib/$($sdk.Name)/ucrt/x64;$kits/Lib/$($sdk.Name)/um/x64"
    & $compiler /nologo /W4 /WX /TC /std:c11 /D_CRT_SECURE_NO_WARNINGS "/I$build" "/I$PSScriptRoot/result_journal_host_stubs" "/I$root/components/device_status/include" "/I$root/components/shared_models/include" "$PSScriptRoot/status_serializer_test.c" "/Fe:$build/test.exe" "/Fo:$build/test.obj"
    if ($LASTEXITCODE) { throw 'Status test compile failed' }
    $json = & "$build/test.exe"
    if ($LASTEXITCODE) { throw 'Status serializer assertions failed' }
    $parsed = $json | ConvertFrom-Json
    if ($parsed.active_path -ne 'offline') { throw 'Invalid serialized status' }
    Write-Output "STATUS_SERIALIZER_PASS max-field JSON bytes=$([Text.Encoding]::UTF8.GetByteCount($json))"
} finally {
    $env:INCLUDE = $savedInclude; $env:LIB = $savedLib
    $resolved = [IO.Path]::GetFullPath($build)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'iot-status-test-*') { throw 'Unsafe cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
