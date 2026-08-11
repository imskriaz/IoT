$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'firmware-build-common.ps1')

$ports = Get-IotCandidateSerialPorts

if (-not $ports) {
    Write-Host 'No serial ports detected.'
    exit 0
}

$ports | Select-Object Port, Friendly, Status, InstanceId | Format-Table -AutoSize
