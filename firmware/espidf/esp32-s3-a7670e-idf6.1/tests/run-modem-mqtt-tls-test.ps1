$ErrorActionPreference = 'Stop'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC C compiler is required for the modem MQTT TLS host test.' }
$msvcRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdk = Get-ChildItem (Join-Path $kitsRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (!$sdk) { throw 'Windows SDK is required for the modem MQTT TLS host test.' }

$firmwareRoot = Split-Path $PSScriptRoot
$source = Get-Content -Raw (Join-Path $firmwareRoot 'components\modem_a7670\src\modem_a7670.c')
$subscribeBody = [regex]::Match($source, '(?ms)^static esp_err_t modem_a7670_mqtt_subscribe_locked\([^;{]*\)\s*\{.*?^\}')
$connectBody = [regex]::Match($source, '(?ms)^esp_err_t modem_a7670_mqtt_connect\([^;{]*\)\s*\{.*?^\}')
$publishBody = [regex]::Match($source, '(?ms)^static esp_err_t modem_a7670_mqtt_publish_locked\([^;{]*\)\s*\{.*?^\}')
if (!$subscribeBody.Success -or
    ([regex]::Matches($subscribeBody.Value, 'modem_a7670_wait_mqtt_result_locked\(response, response_len, timeout_ms, "\+CMQTTSUB:", &suback_code\)')).Count -ne 2 -or
    ([regex]::Matches($subscribeBody.Value, 'suback_code != 0')).Count -ne 2 -or
    !$connectBody.Success -or
    ([regex]::Matches($connectBody.Value, 'modem_a7670_wait_mqtt_result_locked\(response, response_len, timeout_ms, "\+CMQTTSTART:", &start_code\)')).Count -ne 1 -or
    !$connectBody.Value.Contains('start_code == 0') -or
    !$connectBody.Value.Contains('start_code != 0') -or
    $connectBody.Value.Contains('modem_a7670_response_has_mqtt_start_ready') -or
    ([regex]::Matches($connectBody.Value, 'modem_a7670_wait_mqtt_result_locked\(response, response_len, timeout_ms, "\+CMQTTCONNECT:", &connect_code\)')).Count -ne 1 -or
    !$connectBody.Value.Contains('connect_code != 0') -or
    !$connectBody.Value.Contains('connect_code == 3') -or
    !$publishBody.Success -or
    ([regex]::Matches($publishBody.Value, 'modem_a7670_wait_mqtt_result_locked\(response, response_len, timeout_ms, "\+CMQTTPUB:", &publish_code\)')).Count -ne 1 -or
    !$publishBody.Value.Contains('publish_code != 0') -or
    $connectBody.Value.Contains('modem_a7670_response_has_phrase(response, "+CMQTTCONNECT: 0,0")')) {
    throw 'Production connect, subscribe and publish must wait for complete terminal MQTT results.'
}
$header = Get-Content -Raw (Join-Path $firmwareRoot 'components\modem_a7670\include\modem_a7670.h')
$helpers = [regex]::Match($source, '(?s)static bool modem_a7670_clock_is_certificate_usable\(.*?(?=static esp_err_t modem_a7670_append_response_chunk\()')
$appendChunk = [regex]::Match($source, '(?ms)^static esp_err_t modem_a7670_append_response_chunk\([^;{]*\)\s*\{.*?^\}')
$mqttResultWait = [regex]::Match($source, '(?ms)^static esp_err_t modem_a7670_wait_mqtt_result_locked\([^;{]*\)\s*\{.*?^\}')
$member = [regex]::Match($source, 'char tls_certificate_response\[\d+\];')
$certificate = [regex]::Match($header, '(?m)^#define MODEM_A7670_MQTT_TLS_CA_CERT_NAME[^\r\n]+')
if (!$helpers.Success -or !$appendChunk.Success -or !$mqttResultWait.Success -or !$member.Success -or !$certificate.Success) {
    throw 'Production TLS/subscription helpers, scratch member or CA filename could not be extracted.'
}

$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ('iot-modem-mqtt-tls-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildRoot | Out-Null
$previousInclude = $env:INCLUDE
$previousLib = $env:LIB
try {
    $helpers.Value | Set-Content (Join-Path $buildRoot 'modem_tls_functions.inc')
    @($appendChunk.Value, $mqttResultWait.Value) | Set-Content (Join-Path $buildRoot 'modem_mqtt_result_wait_production.inc')
    @($certificate.Value, ('#define TLS_CERTIFICATE_MEMBER ' + $member.Value)) |
        Set-Content (Join-Path $buildRoot 'modem_tls_config.inc')
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
    $testExe = Join-Path $buildRoot 'modem_mqtt_tls_test.exe'
    & $compiler /nologo /W4 /WX /TC /std:c11 /D_CRT_SECURE_NO_WARNINGS "/I$buildRoot" `
        (Join-Path $PSScriptRoot 'modem_mqtt_tls_test.c') "/Fe:$testExe" "/Fo:$buildRoot\modem_mqtt_tls_test.obj"
    if ($LASTEXITCODE -ne 0) { throw "Modem MQTT TLS host compile failed: $LASTEXITCODE" }
    & $testExe
    if ($LASTEXITCODE -ne 0) { throw "Modem MQTT TLS host test failed: $LASTEXITCODE" }
} finally {
    $env:INCLUDE = $previousInclude
    $env:LIB = $previousLib
    $resolvedBuildRoot = [IO.Path]::GetFullPath($buildRoot)
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolvedBuildRoot.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path $resolvedBuildRoot -Leaf) -notlike 'iot-modem-mqtt-tls-*') {
        throw 'Refusing cleanup outside the generated test directory.'
    }
    Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force -ErrorAction SilentlyContinue
}
