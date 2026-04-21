$ErrorActionPreference = 'Stop'

$ports = Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue |
    Where-Object { $_.FriendlyName -match '\(COM\d+\)' } |
    ForEach-Object {
        $match = [regex]::Match($_.FriendlyName, '\((COM\d+)\)')
        [PSCustomObject]@{
            Port       = if ($match.Success) { $match.Groups[1].Value } else { '' }
            Friendly   = $_.FriendlyName
            Status     = $_.Status
            InstanceId = $_.InstanceId
        }
    } |
    Where-Object { $_.Port } |
    Sort-Object Port

if (-not $ports) {
    Write-Host 'No serial ports detected.'
    exit 0
}

$ports | Format-Table -AutoSize
