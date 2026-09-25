param([switch]$Persistence)
$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC/Tools/MSVC/**/bin/Hostx64/x64/cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC required' }
$msvc = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdk = Get-ChildItem (Join-Path $kits 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$source = Get-Content -Raw (Join-Path (Split-Path $PSScriptRoot) 'components/wifi_mgr/src/wifi_mgr_scan.c')
$start = $source.IndexOf('static uint16_t wifi_mgr_find_target_record(')
$end = $source.IndexOf('static esp_err_t wifi_mgr_run_preconnect_scan(', $start)
if ($start -lt 0 -or $end -lt $start) { throw 'Production selector seam missing' }
if ($Persistence) {
    $source = Get-Content -Raw (Join-Path (Split-Path $PSScriptRoot) 'components/wifi_mgr/src/wifi_mgr_profiles.c')
    $start = $source.IndexOf('#define WIFI_PROFILE_NAMESPACE')
    $end = $source.Length
    if ($start -lt 0) { throw 'Production persistence seam missing' }
}
$build = Join-Path ([IO.Path]::GetTempPath()) ('iot-wifi-select-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $build | Out-Null
# Generated test include, extracted verbatim from production.
$source.Substring($start, $end - $start) | Set-Content (Join-Path $build 'wifi_selection_production.h')
$savedInclude = $env:INCLUDE
$savedLib = $env:LIB
Push-Location $build
try {
    $env:INCLUDE = @((Join-Path $msvc 'include'), (Join-Path $sdk.FullName 'ucrt'), (Join-Path $sdk.FullName 'shared'), (Join-Path $sdk.FullName 'um')) -join ';'
    $env:LIB = @((Join-Path $msvc 'lib/x64'), (Join-Path $kits ('Lib/' + $sdk.Name + '/ucrt/x64')), (Join-Path $kits ('Lib/' + $sdk.Name + '/um/x64'))) -join ';'
    $testFile = if ($Persistence) { 'wifi_profile_persistence_test.c' } else { 'wifi_profile_selection_test.c' }
    & $compiler /nologo /W4 /TC /D_CRT_SECURE_NO_WARNINGS "/I$build" (Join-Path $PSScriptRoot $testFile) /Fe:selection_test.exe
    if ($LASTEXITCODE -ne 0) { throw 'Compile failed' }
    & ./selection_test.exe
    if ($LASTEXITCODE -ne 0) { throw 'Regression failed' }
} finally {
    Pop-Location
    $env:INCLUDE = $savedInclude
    $env:LIB = $savedLib
}
