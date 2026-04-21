param(
    [string]$Project = 'esp32-s3-a7670e',
    [string]$BuildDir = 'd:\Projects\IoT\build'
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'enter-iot-env.ps1')

$repoRoot = Split-Path -Parent $PSScriptRoot
$projectDir = Join-Path $repoRoot "firmware\espidf\$Project"

if (-not (Test-Path $projectDir)) {
    throw "Firmware project not found: $projectDir"
}

Set-Location $projectDir
& idf.py -B $BuildDir build
