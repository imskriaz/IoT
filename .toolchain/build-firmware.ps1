param(
    [string]$Project = 'esp32-s3-a7670e',
    [string]$BuildDir = 'd:\Projects\IoT\build'
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'enter-iot-env.ps1')

$repoRoot = Split-Path -Parent $PSScriptRoot
$projectDir = Join-Path $repoRoot "firmware\$Project\espidf"

if (-not (Test-Path $projectDir)) {
    throw "Firmware project not found: $projectDir"
}

function Reset-MismatchedBuildDir {
    param(
        [string]$BuildDirectory,
        [string]$ExpectedProjectDir
    )

    $cachePath = Join-Path $BuildDirectory 'CMakeCache.txt'
    if (-not (Test-Path $cachePath)) {
        return
    }

    $expected = [System.IO.Path]::GetFullPath($ExpectedProjectDir)
    $configured = Get-Content $cachePath |
        Where-Object { $_ -like 'CMAKE_HOME_DIRECTORY:INTERNAL=*' } |
        Select-Object -First 1

    if (-not $configured) {
        return
    }

    $configuredPath = $configured.Substring('CMAKE_HOME_DIRECTORY:INTERNAL='.Length)
    if (-not $configuredPath) {
        return
    }

    $configuredFullPath = [System.IO.Path]::GetFullPath($configuredPath)
    if ($configuredFullPath -ieq $expected) {
        return
    }

    Write-Host "Resetting stale build directory: $BuildDirectory"
    Write-Host "  cached project:   $configuredFullPath"
    Write-Host "  expected project: $expected"
    Remove-Item -LiteralPath $BuildDirectory -Recurse -Force
}

Reset-MismatchedBuildDir -BuildDirectory $BuildDir -ExpectedProjectDir $projectDir

Set-Location $projectDir
& idf.py -B $BuildDir build
