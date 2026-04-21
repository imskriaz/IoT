param(
    [switch]$NoExit
)

$ErrorActionPreference = 'Stop'

$scriptRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $scriptRoot
$enterScript = Join-Path $scriptRoot 'enter-iot-env.ps1'

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host $Title
}

function Write-Check {
    param(
        [string]$Label,
        [string]$Value
    )

    $padded = ('{0}: ' -f $Label).PadRight(28, ' ')
    Write-Host ("  {0}{1}" -f $padded, $Value)
}

function Get-CommandVersion {
    param(
        [string]$Command,
        [string[]]$Arguments = @('--version')
    )

    try {
        $output = & $Command @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) {
            return '(failed)'
        }

        if ($output -is [System.Array]) {
            return ($output | Select-Object -First 1)
        }

        return [string]$output
    } catch {
        return '(missing)'
    }
}

if (-not (Test-Path $enterScript)) {
    throw "Missing toolchain bootstrap script: $enterScript"
}

. $enterScript

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeSource = ''
if ($nodeCommand) {
    $nodeSource = $nodeCommand.Source
}

$checks = @(
    @{ Label = 'Repo root'; Value = $repoRoot; Critical = $true; Exists = $true },
    @{ Label = 'IDF_PATH'; Value = $env:IDF_PATH; Critical = $true; Exists = $true },
    @{ Label = 'IDF_TOOLS_PATH'; Value = $env:IDF_TOOLS_PATH; Critical = $true; Exists = $true },
    @{ Label = 'Python env'; Value = (Join-Path $env:IDF_TOOLS_PATH 'python_env\idf5.3_py3.11_env\Scripts\python.exe'); Critical = $true; Exists = $true },
    @{ Label = 'Node path'; Value = $nodeSource; Critical = $true; Exists = $true },
    @{ Label = 'Build dir'; Value = (Join-Path $repoRoot 'build'); Critical = $false; Exists = $true },
    @{ Label = 'Dashboard .env'; Value = (Join-Path $repoRoot 'dashboard\.env'); Critical = $false; Exists = $true }
)

$failed = $false

Write-Host 'IoT local toolchain check'

Write-Section 'Paths'
foreach ($check in $checks) {
    $exists = $true
    if ($check.Exists) {
        $exists = [string]::IsNullOrWhiteSpace($check.Value) -eq $false -and (Test-Path $check.Value)
    }

    $status = if ($exists) { 'ok' } else { 'missing' }
    Write-Check $check.Label ("{0} [{1}]" -f $check.Value, $status)

    if ($check.Critical -and -not $exists) {
        $failed = $true
    }
}

Write-Section 'Commands'
$nodeVersion = Get-CommandVersion 'node'
$npmVersion = Get-CommandVersion 'npm'
$idfVersion = Get-CommandVersion 'idf.py'

Write-Check 'node --version' $nodeVersion
Write-Check 'npm --version' $npmVersion
Write-Check 'idf.py --version' $idfVersion

if ($nodeVersion -eq '(missing)' -or $nodeVersion -eq '(failed)') { $failed = $true }
if ($npmVersion -eq '(missing)' -or $npmVersion -eq '(failed)') { $failed = $true }
if ($idfVersion -eq '(missing)' -or $idfVersion -eq '(failed)') { $failed = $true }

Write-Section 'Notes'
Write-Host '  Use npm run env:check inside dashboard for dashboard-side env validation.'
Write-Host '  Keep firmware build output in the repo-root build folder.'
Write-Host '  Provision device Wi-Fi/APN/MQTT runtime settings through device config paths, not tracked repo files.'

if ($failed) {
    if ($NoExit) {
        return 1
    }
    exit 1
}

if ($NoExit) {
    return 0
}

exit 0
