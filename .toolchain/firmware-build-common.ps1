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

function Remove-LegacyFirmwareBuildDirs {
    param(
        [string]$RepoRoot,
        [string]$CanonicalBuildDirectory
    )

    $legacyBuildDirs = @(
        @{
            Path = (Join-Path $RepoRoot 'build')
            Parent = $RepoRoot
            Reason = 'repo-root'
        },
        @{
            Path = (Join-Path $CanonicalBuildDirectory 'build')
            Parent = $CanonicalBuildDirectory
            Reason = 'nested'
        }
    )

    foreach ($entry in $legacyBuildDirs) {
        $candidate = [System.IO.Path]::GetFullPath($entry.Path)
        $canonical = [System.IO.Path]::GetFullPath($CanonicalBuildDirectory)
        if ($candidate -ieq $canonical) {
            continue
        }

        Remove-FirmwareBuildDirectory `
            -BuildDirectory $candidate `
            -AllowedParentDirectory $entry.Parent `
            -Reason $entry.Reason
    }
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
