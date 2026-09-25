[CmdletBinding()]
param(
    [int]$Port = 1883,
    [string]$Config = '',
    [string]$BindAddress = '127.0.0.1',
    [switch]$AllowAnonymous
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$mosquitto = Get-Command mosquitto -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $mosquitto) {
    throw 'Mosquitto is not installed or is not on PATH. Run .\.toolchain\install-stack.ps1.'
}

$runtimeDir = Join-Path $repoRoot '.toolchain\mosquitto-runtime'
New-Item -ItemType Directory -Force -Path (Join-Path $runtimeDir 'data') | Out-Null
$configPath = if ($Config) { (Resolve-Path -LiteralPath $Config).Path } else { Join-Path $runtimeDir 'mosquitto.conf' }
if (-not (Test-Path -LiteralPath $configPath)) {
    $runtimePosix = $runtimeDir.Replace([char]92,[char]47)
    if (-not $AllowAnonymous -and $BindAddress -ne '127.0.0.1') {
        throw 'Non-loopback MQTT requires an explicit authenticated config.'
    }
    @(
        "listener $Port $BindAddress"
        $(if ($AllowAnonymous -or $BindAddress -eq '127.0.0.1') { 'allow_anonymous true' } else { 'allow_anonymous false' })
        'persistence true'
        "persistence_location $($runtimeDir -replace '\\','/')/data/"
        'log_dest stdout'
        'connection_messages true'
        'max_connections 100'
    ) | Set-Content -LiteralPath $configPath -Encoding utf8
}

Write-Host "Starting Mosquitto on $BindAddress`:$Port"
if ($BindAddress -eq '127.0.0.1') { Write-Host 'Development mode: anonymous access is loopback-bound.' }
& $mosquitto.Source -c $configPath
