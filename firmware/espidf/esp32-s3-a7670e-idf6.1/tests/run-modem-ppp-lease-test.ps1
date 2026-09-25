$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
$source = Get-Content -Raw "$projectRoot/components/modem_a7670/src/modem_a7670_ppp.c"
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC/Tools/MSVC/**/bin/Hostx64/x64/cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC required' }
$msvc = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdk = Get-ChildItem "$kits/Include" -Directory | Sort-Object Name -Descending | Select-Object -First 1
$build = Join-Path ([IO.Path]::GetTempPath()) ('iot-ppp-lease-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $build | Out-Null
$savedInclude = $env:INCLUDE
$savedLib = $env:LIB
try {
    $parts = foreach ($name in @(
        'modem_a7670_ppp_owned_snapshot',
        'modem_a7670_ppp_uart_owned',
        'modem_a7670_ppp_at_allowed',
        'modem_a7670_ppp_reserve',
        'modem_a7670_ppp_release',
        'modem_a7670_ppp_stop'
    )) {
        $pattern = '(?ms)^(?:static )?(?:bool|void|esp_err_t) ' + [regex]::Escape($name) + '\([^;{]*\)\s*\{.*?^\}'
        $match = [regex]::Match($source, $pattern)
        if (!$match.Success) { throw "Production PPP lease extraction failed: $name" }
        $match.Value
    }
    $parts | Set-Content "$build/ppp_lease_functions.inc"
    $env:INCLUDE = "$msvc/include;$($sdk.FullName)/ucrt;$($sdk.FullName)/shared;$($sdk.FullName)/um"
    $env:LIB = "$msvc/lib/x64;$kits/Lib/$($sdk.Name)/ucrt/x64;$kits/Lib/$($sdk.Name)/um/x64"
    & $compiler /nologo /W4 /WX /TC /std:c11 "/I$build" "$PSScriptRoot/modem_ppp_lease_test.c" "/Fe:$build/test.exe" "/Fo:$build/test.obj"
    if ($LASTEXITCODE) { throw 'PPP lease test compile failed' }
    & "$build/test.exe"
    if ($LASTEXITCODE) { throw 'PPP lease assertions failed' }
} finally {
    $env:INCLUDE = $savedInclude
    $env:LIB = $savedLib
    $resolved = [IO.Path]::GetFullPath($build)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'iot-ppp-lease-test-*') { throw 'Unsafe cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
