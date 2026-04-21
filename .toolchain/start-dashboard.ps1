$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'enter-iot-env.ps1')

$repoRoot = Split-Path -Parent $PSScriptRoot
$dashboardDir = Join-Path $repoRoot 'dashboard'

Set-Location $dashboardDir
& node server.js
