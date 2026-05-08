$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$envPath = Join-Path $repoRoot 'dashboard\.env'
$logDir = Join-Path $repoRoot 'temp\dashboard'
$stdout = Join-Path $logDir 'dashboard.out.log'
$stderr = Join-Path $logDir 'dashboard.err.log'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$port = 3001
if (Test-Path $envPath) {
    $configuredPort = Select-String -Path $envPath -Pattern '^PORT=(\d+)' | Select-Object -First 1
    if ($configuredPort -and $configuredPort.Matches[0].Groups[1].Value) {
        $port = [int]$configuredPort.Matches[0].Groups[1].Value
    }
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    Write-Host "Dashboard already listening on port $port (PID $($listener.OwningProcess))."
    exit 0
}

Start-Process -FilePath 'npm.cmd' `
    -ArgumentList @('start') `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden

Write-Host "Dashboard start requested on port $port."
