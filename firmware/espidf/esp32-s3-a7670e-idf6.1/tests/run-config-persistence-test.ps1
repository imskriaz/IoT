$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC C compiler is required for the config persistence host test.' }
$kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdk = Get-ChildItem (Join-Path $kitsRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (!$sdk) { throw 'Windows SDK is required for the config persistence host test.' }
$msvcRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$outDir = Join-Path $env:TEMP 'esp32-config-persistence-test'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$exe = Join-Path $outDir 'config_persistence_test.exe'
$stub = Join-Path $root 'tests/config_persistence_host_stubs'
$private = Join-Path $root 'components/config_mgr/private_include'
$include = Join-Path $root 'components/config_mgr/include'
$source = Join-Path $root 'components/config_mgr/src/config_mgr_persistence.c'
$test = Join-Path $root 'tests/config_persistence_test.c'
$oldInclude = $env:INCLUDE
$oldLib = $env:LIB
$env:INCLUDE = @((Join-Path $msvcRoot 'include'), (Join-Path $sdk.FullName 'ucrt'), (Join-Path $sdk.FullName 'shared'), (Join-Path $sdk.FullName 'um')) -join ';'
$env:LIB = @((Join-Path $msvcRoot 'lib\x64'), (Join-Path $kitsRoot ('Lib\' + $sdk.Name + '\ucrt\x64')), (Join-Path $kitsRoot ('Lib\' + $sdk.Name + '\um\x64'))) -join ';'
& $compiler /nologo /W4 /WX /std:c11 /TC /D_CRT_SECURE_NO_WARNINGS "/I$stub" "/I$include" "/I$private" $source $test "/Fe:$exe"
if ($LASTEXITCODE -ne 0) { throw "Config persistence host test compile failed: $LASTEXITCODE" }
& $exe
if ($LASTEXITCODE -ne 0) { throw "Config persistence host test failed: $LASTEXITCODE" }
$env:INCLUDE = $oldInclude
$env:LIB = $oldLib
Write-Host 'config persistence host test: PASS'
