$ErrorActionPreference = 'Stop'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC C compiler is required for result journal host tests.' }
$msvcRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdk = Get-ChildItem (Join-Path $kitsRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (!$sdk) { throw 'Windows SDK is required for result journal host tests.' }

$testRoot = $PSScriptRoot
$firmwareRoot = Split-Path $testRoot
$sourceRoot = Join-Path $firmwareRoot 'components\storage_mgr\src'
$stubRoot = Join-Path $testRoot 'result_journal_host_stubs'
$apiSource = Get-Content -Raw (Join-Path $firmwareRoot 'components\api_bridge\src\api_bridge.c')
$mqttSource = Get-Content -Raw (Join-Path $firmwareRoot 'components\mqtt_mgr\src\mqtt_mgr.c')
if ($apiSource -notmatch '(?s)storage_mgr_result_reserve\(&normalized_action\).*?api_bridge_dispatch_action\(&normalized_action') {
    throw 'API bridge no longer reserves durable result capacity before command dispatch.'
}
if ($apiSource -notmatch '(?s)ESP_ERR_NOT_ALLOWED.*?storage_mgr_result_get\(&normalized_action') {
    throw 'Terminal duplicate no longer replays its original durable outcome.'
}
$pubAckBlock = [regex]::Match($mqttSource, '(?s)case MQTT_EVENT_PUBLISHED:(?<body>.*?)case MQTT_EVENT_DATA:')
if (!$pubAckBlock.Success -or $pubAckBlock.Groups['body'].Value.Contains('storage_mgr_result_ack')) {
    throw 'MQTT PUBACK must remain separate from dashboard database acknowledgement.'
}
if ($mqttSource -notmatch 'command/action-result-ack' -or $mqttSource -notmatch 'schema_version') {
    throw 'Versioned dashboard result acknowledgement contract is missing.'
}
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ('iot-result-journal-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildRoot | Out-Null
$previousInclude = $env:INCLUDE
$previousLib = $env:LIB
Push-Location $buildRoot
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
    & $compiler /nologo /W4 /WX /TC /D_CRT_SECURE_NO_WARNINGS /DSTORAGE_RESULT_JOURNAL_HOST_TEST /DCONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN=8192 "/I$stubRoot" "/I$sourceRoot" `
        (Join-Path $sourceRoot 'storage_result_journal.c') (Join-Path $testRoot 'result_journal_test.c') `
        "/Fe:result_journal_test.exe" "/Fo:$buildRoot\"
    if ($LASTEXITCODE -ne 0) { throw "Result journal host compile failed: $LASTEXITCODE" }
    & (Join-Path $buildRoot 'result_journal_test.exe')
    if ($LASTEXITCODE -ne 0) { throw "Result journal host test failed: $LASTEXITCODE" }
} finally {
    Pop-Location
    $env:INCLUDE = $previousInclude
    $env:LIB = $previousLib
    $resolvedBuild = [IO.Path]::GetFullPath($buildRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolvedBuild.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedBuild) -notmatch '^iot-result-journal-[0-9a-f]{32}$') {
        throw 'Refusing cleanup outside this test temporary directory.'
    }
    Remove-Item -LiteralPath $resolvedBuild -Recurse -Force -ErrorAction SilentlyContinue
}
