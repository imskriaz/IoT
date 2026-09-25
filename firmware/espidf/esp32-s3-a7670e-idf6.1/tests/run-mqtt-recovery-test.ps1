$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC C compiler is required for the host recovery test.' }
$msvcRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdk = Get-ChildItem (Join-Path $kitsRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (!$sdk) { throw 'Windows SDK is required for the host recovery test.' }
$testBuild = Join-Path ([IO.Path]::GetTempPath()) ('iot-mqtt-recovery-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testBuild | Out-Null
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
    $testExe = Join-Path $testBuild 'mqtt_recovery_test.exe'
    & $compiler /nologo /W4 /WX /TC (Join-Path $PSScriptRoot 'mqtt_recovery_test.c') "/Fe:$testExe" "/Fo:$testBuild\mqtt_recovery_test.obj"
    if ($LASTEXITCODE -ne 0) { throw "Host compile failed: $LASTEXITCODE" }
    & $testExe
    if ($LASTEXITCODE -ne 0) { throw "Host test failed: $LASTEXITCODE" }
} finally {
    $env:INCLUDE = $previousInclude
    $env:LIB = $previousLib
    Remove-Item -LiteralPath $testBuild -Recurse -Force -ErrorAction SilentlyContinue
}
