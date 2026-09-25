$ErrorActionPreference = 'Stop'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC C compiler is required for the modem MQTT RX host test.' }
$msvcRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdk = Get-ChildItem (Join-Path $kitsRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (!$sdk) { throw 'Windows SDK is required for the modem MQTT RX host test.' }

$source = Get-Content -Raw (Join-Path (Split-Path $PSScriptRoot) 'components\modem_a7670\src\modem_a7670.c')
$functions = [regex]::Match($source, '(?s)static size_t modem_a7670_parse_cmqttrx_length\([^;{]*\{.*?(?=static bool modem_a7670_append_fragment\()')
if (!$functions.Success) { throw 'Production CMQTTRX length helpers could not be extracted.' }
$parserParts = foreach ($pattern in @(
    '(?s)static void modem_a7670_reset_mqtt_rx_locked\(void\) \{.*?(?=static void modem_a7670_reset_pending_ussd_response_locked\()',
    '(?s)static bool modem_a7670_mqtt_topic_is_command\([^;{]*\{.*?(?=static void modem_a7670_queue_mqtt_message_locked\()',
    '(?s)static void modem_a7670_queue_completed_mqtt_rx_locked\(void\) \{.*?(?=static void modem_a7670_queue_sms_index_locked\()'
)) {
    $part = [regex]::Match($source, $pattern)
    if (!$part.Success) { throw "Production MQTT parser extraction failed: $pattern" }
    $part.Value
}
$mqttBranch = [regex]::Match($source, '(?s)    if \(strncmp\(line, "\+CMQTTCONNLOST".*?(?=    if \(strncmp\(line, "\+CMQTTRECV:")')
$responseParser = [regex]::Match($source, '(?s)void modem_a7670_parse_response_locked\([^;{]*\{.*?(?=esp_err_t modem_a7670_read_until_quiet_locked\()')
if (!$mqttBranch.Success -or !$responseParser.Success) { throw 'Production MQTT branch/byte parser extraction failed.' }

# Source-level guard: a bounded diagnostic response must never decide how many
# UART bytes are parsed. Each reader parses a consumed chunk before attempting
# to append it, and quiet-drain keeps parsing after a clipped append.
foreach ($name in @(
    'modem_a7670_read_until_quiet_bounded_locked',
    'modem_a7670_read_response_locked',
    'modem_a7670_read_response_until_phrase_locked')) {
    $body = [regex]::Match($source, "(?s)(?:static )?esp_err_t $name\([^;{]*\{.*?(?=\n(?:static )?esp_err_t |\nstatic bool |\nvoid )")
    if (!$body.Success) { throw "Production reader $name could not be located." }
    $parse = $body.Value.IndexOf('modem_a7670_parse_response_locked(read_buffer, (size_t)bytes)')
    $append = $body.Value.IndexOf('modem_a7670_append_response_chunk(response, response_len, &used, read_buffer)')
    if ($parse -lt 0 -or $append -lt 0 -or $parse -ge $append) {
        throw "Reader $name does not parse every UART chunk before bounded diagnostic append."
    }
}

$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ('iot-modem-mqtt-rx-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildRoot | Out-Null
$previousInclude = $env:INCLUDE
$previousLib = $env:LIB
try {
    $functions.Value | Set-Content (Join-Path $buildRoot 'modem_rx_functions.inc')
    @($parserParts; 'static void modem_a7670_parse_line_locked(const char *line) {'; $mqttBranch.Value; '}'; $responseParser.Value) |
        Set-Content (Join-Path $buildRoot 'modem_rx_parser.inc')
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
    $testExe = Join-Path $buildRoot 'modem_mqtt_rx_test.exe'
    & $compiler /nologo /W4 /WX /TC /std:c11 /D_CRT_SECURE_NO_WARNINGS "/I$buildRoot" `
        (Join-Path $PSScriptRoot 'modem_mqtt_rx_test.c') "/Fe:$testExe" "/Fo:$buildRoot\modem_mqtt_rx_test.obj"
    if ($LASTEXITCODE -ne 0) { throw "Modem MQTT RX host compile failed: $LASTEXITCODE" }
    & $testExe
    if ($LASTEXITCODE -ne 0) { throw "Modem MQTT RX host test failed: $LASTEXITCODE" }
} finally {
    $env:INCLUDE = $previousInclude
    $env:LIB = $previousLib
    $resolvedBuildRoot = [IO.Path]::GetFullPath($buildRoot)
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolvedBuildRoot.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path $resolvedBuildRoot -Leaf) -notlike 'iot-modem-mqtt-rx-*') {
        throw 'Refusing cleanup outside the generated test directory.'
    }
    Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force -ErrorAction SilentlyContinue
}
