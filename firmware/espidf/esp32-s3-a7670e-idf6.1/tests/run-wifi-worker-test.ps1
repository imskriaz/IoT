$ErrorActionPreference = 'Stop'
$firmwareRoot = Split-Path $PSScriptRoot
$source = Get-Content -Raw "$firmwareRoot/components/wifi_mgr/src/wifi_mgr.c"
$scanSource = Get-Content -Raw "$firmwareRoot/components/wifi_mgr/src/wifi_mgr_scan.c"
$runtimeRequest = [regex]::Match($source, '(?ms)^esp_err_t wifi_mgr_request_runtime_connect\([^;{]*\)\s*\{.*?^\}')
if (!$runtimeRequest.Success -or
    !$runtimeRequest.Value.Contains('wifi_mgr_clear_runtime_override_locked();') -or
    !$runtimeRequest.Value.Contains('s_runtime_override_started_ms = unified_tick_now_ms();') -or
    !$runtimeRequest.Value.Contains('if (!scan_in_progress) {') -or
    !$scanSource.Contains('scratch->override_revision = wifi_mgr_runtime_override_revision_locked();') -or
    !$scanSource.Contains('if (scratch->override_revision != wifi_mgr_runtime_override_revision_locked()) {') -or
    !$scanSource.Contains('current_profiles_revision != scratch->profiles.revision') -or
    !$scanSource.Contains('notify_after_scan = s_connect_requested && s_status.started && !s_status.connected;')) {
    throw 'Runtime override must have a deadline and roll back rejected Wi-Fi driver config.'
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC/Tools/MSVC/**/bin/Hostx64/x64/cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC required' }
$msvc = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdk = Get-ChildItem "$kits/Include" -Directory | Sort-Object Name -Descending | Select-Object -First 1
$build = Join-Path ([IO.Path]::GetTempPath()) ('iot-wifi-worker-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $build | Out-Null
$savedInclude = $env:INCLUDE
$savedLib = $env:LIB
try {
    $constants = [regex]::Matches($source, '(?m)^static const uint32_t WIFI_MGR_[A-Z_]+ = [0-9]+U;')
    if ($constants.Count -ne 5) { throw 'Review changed worker timing constants' }
    $parts = foreach ($name in @('wifi_mgr_next_absent_retry_delay_ms', 'wifi_mgr_reset_absent_retry_backoff', 'wifi_mgr_clear_runtime_override_locked', 'wifi_mgr_request_connect_locked', 'wifi_mgr_task')) {
        $match = [regex]::Match($source, '(?ms)^static (?:void|uint32_t) ' + [regex]::Escape($name) + '\([^;{]*\)\s*\{.*?^\}')
        if (!$match.Success) { throw "Production worker seam missing: $name" }
        $match.Value
    }
    (@($constants | ForEach-Object { $_.Value }) + $parts) | Set-Content "$build/wifi_worker_production.inc"
    $env:INCLUDE = "$msvc/include;$($sdk.FullName)/ucrt;$($sdk.FullName)/shared;$($sdk.FullName)/um"
    $env:LIB = "$msvc/lib/x64;$kits/Lib/$($sdk.Name)/ucrt/x64;$kits/Lib/$($sdk.Name)/um/x64"
    & $compiler /nologo /W4 /WX /TC /D_CRT_SECURE_NO_WARNINGS "/I$build" "$PSScriptRoot/wifi_worker_test.c" "/Fe:$build/test.exe" "/Fo:$build/test.obj"
    if ($LASTEXITCODE) { throw 'Wi-Fi worker compile failed' }
    & "$build/test.exe"
    if ($LASTEXITCODE) { throw 'Wi-Fi worker regression failed' }
} finally {
    $env:INCLUDE = $savedInclude
    $env:LIB = $savedLib
    $resolved = [IO.Path]::GetFullPath($build)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path $resolved -Leaf) -notmatch '^iot-wifi-worker-[0-9a-f]{32}$') { throw 'Unsafe cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
