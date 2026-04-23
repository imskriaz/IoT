param(
    [string]$Project = 'esp32-s3-a7670e',
    [string]$BuildDir = '',
    [string]$Port,
    [int]$Baud = 460800
)

$ErrorActionPreference = 'Stop'

function Get-IotCandidateSerialPorts {
    $ports = Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue |
        Where-Object { $_.FriendlyName -match '\(COM\d+\)' } |
        ForEach-Object {
            $match = [regex]::Match($_.FriendlyName, '\((COM\d+)\)')
            $portName = if ($match.Success) { $match.Groups[1].Value } else { $null }
            $friendly = $_.FriendlyName
            $instanceId = $_.InstanceId

            $score = 0
            if ($friendly -match 'CH343|CH340') { $score += 100 }
            if ($friendly -match 'CP210|Silicon Labs|FTDI') { $score += 90 }
            if ($friendly -match 'USB Serial Device') { $score += 70 }
            if ($friendly -match 'UART|JTAG') { $score += 20 }
            if ($friendly -match 'Bluetooth') { $score -= 100 }
            if ($instanceId -match '^USB\\') { $score += 20 }
            if ($_.Status -eq 'OK') { $score += 20 }
            if ($_.Status -eq 'Unknown') { $score += 5 }

            [PSCustomObject]@{
                Port       = $portName
                Friendly   = $friendly
                Status     = $_.Status
                InstanceId = $instanceId
                Score      = $score
            }
        } |
        Where-Object { $_.Port } |
        Sort-Object -Property @{ Expression = 'Score'; Descending = $true }, @{ Expression = 'Port'; Descending = $false }

    return @($ports)
}

. (Join-Path $PSScriptRoot 'enter-iot-env.ps1')

$repoRoot = Split-Path -Parent $PSScriptRoot
$projectDir = Join-Path $repoRoot "firmware\espidf\$Project"

if (-not $BuildDir) {
    $BuildDir = Join-Path $projectDir 'build'
}

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
