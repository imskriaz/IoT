$ErrorActionPreference = 'Stop'

function Get-FirmwareBuildDirectory {
    param(
        [string]$ProjectDirectory
    )

    return (Join-Path $ProjectDirectory 'build')
}

function Test-PathInsideDirectory {
    param(
        [string]$ChildPath,
        [string]$ParentPath
    )

    $child = [System.IO.Path]::GetFullPath($ChildPath)
    $parent = [System.IO.Path]::GetFullPath($ParentPath).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $parentWithSeparator = $parent + [System.IO.Path]::DirectorySeparatorChar

    return $child.StartsWith($parentWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-FirmwareBuildDirectory {
    param(
        [string]$BuildDirectory
    )

    if (-not (Test-Path $BuildDirectory)) {
        return $false
    }

    $markers = @(
        'CMakeCache.txt',
        'build.ninja',
        'compile_commands.json',
        'esp-idf',
        'bootloader',
        'partition_table'
    )

    foreach ($marker in $markers) {
        if (Test-Path (Join-Path $BuildDirectory $marker)) {
            return $true
        }
    }

    return $false
}

function Remove-FirmwareBuildDirectory {
    param(
        [string]$BuildDirectory,
        [string]$AllowedParentDirectory,
        [string]$Reason
    )

    if (-not (Test-Path $BuildDirectory)) {
        return
    }

    $resolvedBuildDirectory = [System.IO.Path]::GetFullPath($BuildDirectory)
    $resolvedAllowedParent = [System.IO.Path]::GetFullPath($AllowedParentDirectory)

    if (-not (Test-PathInsideDirectory -ChildPath $resolvedBuildDirectory -ParentPath $resolvedAllowedParent)) {
        throw "Refusing to remove build directory outside allowed parent: $resolvedBuildDirectory"
    }

    if (-not (Test-FirmwareBuildDirectory -BuildDirectory $resolvedBuildDirectory)) {
        Write-Host "Skipping non-firmware build directory: $resolvedBuildDirectory"
        return
    }

    Write-Host "Removing $Reason firmware build directory: $resolvedBuildDirectory"
    Remove-Item -LiteralPath $resolvedBuildDirectory -Recurse -Force
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
    Remove-FirmwareBuildDirectory `
        -BuildDirectory $BuildDirectory `
        -AllowedParentDirectory $ExpectedProjectDir `
        -Reason 'stale'
}

function Initialize-FirmwareBuildContext {
    param(
        [string]$Project,
        [string]$BuildDirectory
    )

    $repoRoot = Split-Path -Parent $PSScriptRoot
    $projectDirectory = Join-Path $repoRoot "firmware\espidf\$Project"

    if (-not $BuildDirectory) {
        $BuildDirectory = Get-FirmwareBuildDirectory -ProjectDirectory $projectDirectory
    }

    if (-not (Test-Path $projectDirectory)) {
        throw "Firmware project not found: $projectDirectory"
    }

    Reset-MismatchedBuildDir -BuildDirectory $BuildDirectory -ExpectedProjectDir $projectDirectory

    return [PSCustomObject]@{
        ProjectDirectory = $projectDirectory
        BuildDirectory   = $BuildDirectory
    }
}

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
