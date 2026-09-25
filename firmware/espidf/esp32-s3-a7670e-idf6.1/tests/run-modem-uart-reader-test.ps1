$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$source = Get-Content -Raw "$root/components/modem_a7670/src/modem_a7670.c"
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC/Tools/MSVC/**/bin/Hostx64/x64/cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC required' }
$msvc = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdk = Get-ChildItem "$kits/Include" -Directory | Sort-Object Name -Descending | Select-Object -First 1
$build = Join-Path ([IO.Path]::GetTempPath()) ('iot-uart-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $build | Out-Null
$savedInclude = $env:INCLUDE; $savedLib = $env:LIB
try {
    $parts = foreach ($pattern in @(
        '(?s)static esp_err_t modem_a7670_append_response_chunk\(.*?(?=static bool modem_a7670_response_has_mqtt_stop_done)',
        '(?s)esp_err_t modem_a7670_read_until_quiet_locked\([^;{]*\{.*?(?=static esp_err_t modem_a7670_open_network_stack_locked\()'
    )) {
        $match = [regex]::Match($source, $pattern)
        if (!$match.Success) { throw 'Production reader extraction failed' }
        $match.Value
    }
    $parts | Set-Content "$build/uart_functions.inc"
    $env:INCLUDE = "$msvc/include;$($sdk.FullName)/ucrt;$($sdk.FullName)/shared;$($sdk.FullName)/um"
    $env:LIB = "$msvc/lib/x64;$kits/Lib/$($sdk.Name)/ucrt/x64;$kits/Lib/$($sdk.Name)/um/x64"
    & $compiler /nologo /W4 /WX /TC /std:c11 /D_CRT_SECURE_NO_WARNINGS "/I$build" "/I$PSScriptRoot/result_journal_host_stubs" "$PSScriptRoot/modem_uart_reader_test.c" "/Fe:$build/test.exe" "/Fo:$build/test.obj"
    if ($LASTEXITCODE) { throw 'UART reader compile failed' }
    & "$build/test.exe"
    if ($LASTEXITCODE) { throw 'UART reader assertions failed' }
} finally {
    $env:INCLUDE = $savedInclude; $env:LIB = $savedLib
    $resolved = [IO.Path]::GetFullPath($build)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'iot-uart-test-*') { throw 'Unsafe cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
