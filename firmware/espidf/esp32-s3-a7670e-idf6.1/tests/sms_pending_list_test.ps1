$ErrorActionPreference = 'Stop'

$telephonyPath = Join-Path $PSScriptRoot '..\components\modem_a7670\src\modem_a7670_telephony.c'
$telephonySource = Get-Content -Raw $telephonyPath
$match = [regex]::Match(
    $telephonySource,
    '(?s)/\* SMS_PENDING_TEST_BEGIN \*/(?<source>.*?)/\* SMS_PENDING_TEST_END \*/'
)
if (!$match.Success) {
    throw 'Pending-SMS parser test seam is missing from modem_a7670_telephony.c.'
}
if ($telephonySource -notmatch '(?s)for \(size_t item = 0U; item < sms_index_count; \+\+item\).*?if \(err != ESP_ERR_NOT_FOUND\)') {
    throw 'CMGL consumption no longer walks all captured indexes past delivery reports.'
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC C compiler is required for the pending-SMS host test.' }
$msvcRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdk = Get-ChildItem (Join-Path $kitsRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (!$sdk) { throw 'Windows SDK is required for the pending-SMS host test.' }

$testBuild = Join-Path ([IO.Path]::GetTempPath()) ('iot-sms-pending-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testBuild | Out-Null
$generatedSource = Join-Path $testBuild 'sms_pending_list_generated.c'
$preamble = @'
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

'@
$testBody = Get-Content -Raw (Join-Path $PSScriptRoot 'sms_pending_list_test.c')
[IO.File]::WriteAllText(
    $generatedSource,
    $preamble + $match.Groups['source'].Value + [Environment]::NewLine + $testBody,
    [Text.UTF8Encoding]::new($false)
)

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
    $testExe = Join-Path $testBuild 'sms_pending_list_test.exe'
    & $compiler /nologo /W4 /WX /TC $generatedSource "/Fe:$testExe" "/Fo:$testBuild\sms_pending_list_test.obj"
    if ($LASTEXITCODE -ne 0) { throw "Host compile failed: $LASTEXITCODE" }
    & $testExe
    if ($LASTEXITCODE -ne 0) { throw "Host test failed: $LASTEXITCODE" }
} finally {
    $env:INCLUDE = $previousInclude
    $env:LIB = $previousLib
}
