$ErrorActionPreference = 'Stop'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC C compiler is required for the modem IP parser host test.' }
$msvcRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdk = Get-ChildItem (Join-Path $kitsRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (!$sdk) { throw 'Windows SDK is required for the modem IP parser host test.' }

$firmwareRoot = Split-Path $PSScriptRoot
$modemSource = Get-Content -Raw (Join-Path $firmwareRoot 'components\modem_a7670\src\modem_a7670.c')
$match = [regex]::Match($modemSource, '(?s)/\* MODEM_IP_PARSER_TEST_BEGIN \*/(?<source>.*?)/\* MODEM_IP_PARSER_TEST_END \*/')
if (!$match.Success) { throw 'Modem IP parser test seam is missing.' }

$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ('iot-modem-ip-parser-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildRoot | Out-Null
$generated = Join-Path $buildRoot 'modem_ip_parser_generated.c'
$testSource = (Join-Path $PSScriptRoot 'modem_ip_parser_test.c').Replace('\', '/')
@"
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#define UNIFIED_IPV4_ADDR_LEN 16U
$($match.Groups['source'].Value)
#include "$testSource"
"@ | Set-Content $generated

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
    $testExe = Join-Path $buildRoot 'modem_ip_parser_test.exe'
    & $compiler /nologo /W4 /WX /TC /D_CRT_SECURE_NO_WARNINGS $generated "/Fe:$testExe" "/Fo:$buildRoot\modem_ip_parser_test.obj"
    if ($LASTEXITCODE -ne 0) { throw "Modem IP parser host compile failed: $LASTEXITCODE" }
    & $testExe
    if ($LASTEXITCODE -ne 0) { throw "Modem IP parser host test failed: $LASTEXITCODE" }
} finally {
    $env:INCLUDE = $previousInclude
    $env:LIB = $previousLib
    Remove-Item -LiteralPath $buildRoot -Recurse -Force -ErrorAction SilentlyContinue
}
