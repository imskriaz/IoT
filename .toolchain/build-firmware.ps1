param(
    [string]$Project = 'esp32-s3-a7670e',
    [string]$BuildDir = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'enter-iot-env.ps1')
. (Join-Path $PSScriptRoot 'firmware-build-common.ps1')

$context = Initialize-FirmwareBuildContext -Project $Project -BuildDirectory $BuildDir
$projectDir = $context.ProjectDirectory
$BuildDir = $context.BuildDirectory

Set-Location $projectDir
& idf.py -B $BuildDir build
