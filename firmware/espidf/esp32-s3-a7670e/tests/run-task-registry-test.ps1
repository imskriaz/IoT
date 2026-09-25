$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC C compiler is required for the task registry test.' }
$msvcRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler)))
$kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$sdk = Get-ChildItem (Join-Path $kitsRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (!$sdk) { throw 'Windows SDK is required for the task registry test.' }
$testBuild = Join-Path ([IO.Path]::GetTempPath()) ('iot-task-registry-' + [Guid]::NewGuid().ToString('N'))
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
    $testExe = Join-Path $testBuild 'task_registry_test.exe'
    $firmwareRoot = Split-Path $PSScriptRoot
    $stubRoot = Join-Path $PSScriptRoot 'task_registry_host_stubs'
    $diagnosticsRoot = Join-Path $firmwareRoot 'components\diagnostics'
    $runtimeRoot = Join-Path $firmwareRoot 'components\shared_models\include'
    & $compiler /nologo /W4 /WX /TC /D_CRT_SECURE_NO_WARNINGS /DCONFIG_UNIFIED_TASK_REGISTRY_CAPACITY=24 "/I$stubRoot" "/I$diagnosticsRoot\include" "/I$runtimeRoot" `
        (Join-Path $diagnosticsRoot 'src\task_registry.c') (Join-Path $PSScriptRoot 'task_registry_test.c') "/Fe:$testExe" "/Fo:$testBuild\"
    if ($LASTEXITCODE -ne 0) { throw "Host compile failed: $LASTEXITCODE" }
    foreach ($scenario in @('liveness', 'zero', 'low', 'healthy-boundary')) {
        & $testExe $scenario
        if ($LASTEXITCODE -ne 0) { throw "Host test failed ($scenario): $LASTEXITCODE" }
    }
} finally {
    $env:INCLUDE = $previousInclude
    $env:LIB = $previousLib
    $resolvedBuild = [IO.Path]::GetFullPath($testBuild)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolvedBuild.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
        !(Split-Path $resolvedBuild -Leaf).StartsWith('iot-task-registry-')) {
        throw 'Refusing cleanup outside the task registry test temp directory.'
    }
    Remove-Item -LiteralPath $resolvedBuild -Recurse -Force -ErrorAction SilentlyContinue
}

