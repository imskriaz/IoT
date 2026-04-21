param(
    [switch]$SyncEnv,
    [switch]$Strict,
    [switch]$SeedSafeSecrets
)

$ErrorActionPreference = 'Stop'

$scriptRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $scriptRoot
$toolchainCheck = Join-Path $scriptRoot 'check-iot-env.ps1'
$dashboardDir = Join-Path $repoRoot 'dashboard'

if (-not (Test-Path $toolchainCheck)) {
    throw "Missing toolchain checker: $toolchainCheck"
}

Write-Host 'IoT workspace doctor'
Write-Host ''
Write-Host 'Step 1/2: Toolchain'
$toolchainResult = & $toolchainCheck -NoExit
if ($toolchainResult -ne 0) {
    exit $toolchainResult
}

Write-Host ''
Write-Host 'Step 2/2: Dashboard env'
Push-Location $dashboardDir
try {
    if ($SyncEnv) {
        if ($Strict -and $SeedSafeSecrets) {
            npm run env:doctor -- --write-safe-secrets --strict
        } elseif ($Strict) {
            npm run env:doctor -- --strict
        } elseif ($SeedSafeSecrets) {
            npm run env:doctor -- --write-safe-secrets
        } else {
            npm run env:doctor
        }
    } else {
        if ($Strict) {
            npm run env:check -- --strict
        } else {
            npm run env:check
        }
    }
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Doctor result: completed'
exit 0
