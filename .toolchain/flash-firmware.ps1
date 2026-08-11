param(
    [string]$Project = 'esp32-s3-a7670e',
    [string]$BuildDir = '',
    [string]$Port,
    [int]$Baud = 460800
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'enter-iot-env.ps1')
. (Join-Path $PSScriptRoot 'firmware-build-common.ps1')

$context = Initialize-FirmwareBuildContext -Project $Project -BuildDirectory $BuildDir
$projectDir = $context.ProjectDirectory
$BuildDir = $context.BuildDirectory

if (-not $Port) {
    $candidates = Get-IotCandidateSerialPorts
    if (-not $candidates.Count) {
        throw 'No serial ports detected. Connect the device or pass -Port explicitly.'
    }

    $Port = $candidates[0].Port
    Write-Host "Auto-selected port: $Port ($($candidates[0].Friendly))"
    if ($candidates.Count -gt 1) {
        Write-Host 'Other detected ports:'
        $candidates | Select-Object -Skip 1 | ForEach-Object {
            Write-Host "  $($_.Port)  $($_.Friendly)"
        }
    }
}

Set-Location $projectDir
& idf.py -B $BuildDir -p $Port -b $Baud flash
