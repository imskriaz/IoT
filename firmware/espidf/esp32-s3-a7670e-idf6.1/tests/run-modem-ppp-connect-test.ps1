$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC/Tools/MSVC/**/bin/Hostx64/x64/cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC required' }
$msvc = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdk = Get-ChildItem "$kits/Include" -Directory | Sort-Object Name -Descending | Select-Object -First 1
$build = Join-Path ([IO.Path]::GetTempPath()) ('iot-ppp-connect-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $build | Out-Null
$savedInclude = $env:INCLUDE
$savedLib = $env:LIB
try {
    $env:INCLUDE = "$msvc/include;$($sdk.FullName)/ucrt;$($sdk.FullName)/shared;$($sdk.FullName)/um"
    $env:LIB = "$msvc/lib/x64;$kits/Lib/$($sdk.Name)/ucrt/x64;$kits/Lib/$($sdk.Name)/um/x64"
    & $compiler /nologo /W4 /WX /TC /std:c11 "/I$projectRoot/components/modem_a7670/src" "$PSScriptRoot/modem_ppp_connect_test.c" "/Fe:$build/test.exe" "/Fo:$build/test.obj"
    if ($LASTEXITCODE) { throw 'PPP CONNECT parser compile failed' }
    & "$build/test.exe"
    if ($LASTEXITCODE) { throw 'PPP CONNECT parser assertions failed' }
} finally {
    $env:INCLUDE = $savedInclude
    $env:LIB = $savedLib
    $resolved = [IO.Path]::GetFullPath($build)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'iot-ppp-connect-test-*') { throw 'Unsafe cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
