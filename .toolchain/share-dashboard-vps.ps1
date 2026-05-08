param(
    [Parameter(Mandatory = $true)]
    [string]$VpsHost,

    [Parameter(Mandatory = $true)]
    [string]$VpsUser,

    # One or more remote:local mappings. Examples:
    #   3000:3001                 VPS 127.0.0.1:3000 -> local 127.0.0.1:3001
    #   3010:5173:127.0.0.1       VPS 127.0.0.1:3010 -> local 127.0.0.1:5173
    [string[]]$Forward = @("3000:3001"),

    # Backward-compatible single-port defaults.
    [int]$LocalPort = 3001,
    [int]$RemotePort = 3000,

    [string]$SshKey = "",
    [string]$PublicUrl = "",
    [string]$RemoteBind = "127.0.0.1",
    [string]$LocalBind = "127.0.0.1",
    [switch]$NoHealthCheck,
    [switch]$Reconnect,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Require-Command($Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required but was not found in PATH."
    }
}

function Parse-ForwardSpec($Spec) {
    $parts = ([string]$Spec).Split(":")
    if ($parts.Count -lt 2 -or $parts.Count -gt 3) {
        throw "Invalid forward '$Spec'. Use remotePort:localPort or remotePort:localPort:localHost."
    }

    $remote = 0
    $local = 0
    if (-not [int]::TryParse($parts[0], [ref]$remote) -or $remote -lt 1 -or $remote -gt 65535) {
        throw "Invalid remote port in '$Spec'."
    }
    if (-not [int]::TryParse($parts[1], [ref]$local) -or $local -lt 1 -or $local -gt 65535) {
        throw "Invalid local port in '$Spec'."
    }

    $targetHost = if ($parts.Count -eq 3 -and $parts[2]) { $parts[2] } else { $LocalBind }
    [pscustomobject]@{
        RemotePort = $remote
        LocalPort = $local
        LocalHost = $targetHost
    }
}

function Test-LocalPort($HostName, $Port) {
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $task = $client.ConnectAsync($HostName, $Port)
        if (-not $task.Wait(2000)) {
            $client.Dispose()
            return $false
        }
        $client.Dispose()
        return $true
    } catch {
        return $false
    }
}

Require-Command ssh

if (($Forward.Count -eq 1 -and $Forward[0] -eq "3000:3001") -and ($LocalPort -ne 3001 -or $RemotePort -ne 3000)) {
    $Forward = @("$RemotePort`:$LocalPort")
}

$forwardRules = @($Forward | ForEach-Object { Parse-ForwardSpec $_ })
if (-not $forwardRules.Count) {
    throw "At least one forward is required."
}

if (-not $NoHealthCheck) {
    foreach ($rule in $forwardRules) {
        if ($DryRun) {
            continue
        }
        if (-not (Test-LocalPort $rule.LocalHost $rule.LocalPort)) {
            throw "Local target $($rule.LocalHost):$($rule.LocalPort) is not reachable. Start that service first, or use -NoHealthCheck."
        }
    }
}

if ($PublicUrl) {
    Write-Host ""
    Write-Host "Keep these in dashboard/.env before generating Android QR codes:"
    Write-Host "ANDROID_BRIDGE_PUBLIC_URL=$PublicUrl"
    Write-Host "SOCKET_IO_CORS_ORIGIN=$PublicUrl"
    Write-Host ""
}

$baseArgs = @(
    "-N",
    "-T",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-o", "TCPKeepAlive=yes",
    "-o", "Compression=no",
    "-o", "AddressFamily=inet",
    "-o", "ConnectTimeout=10",
    "-o", "IPQoS=lowdelay"
)

if ($SshKey) {
    $baseArgs = @("-i", $SshKey) + $baseArgs
}

foreach ($rule in $forwardRules) {
    $baseArgs += @(
        "-R",
        "$RemoteBind`:$($rule.RemotePort)`:$($rule.LocalHost)`:$($rule.LocalPort)"
    )
}

$baseArgs += "$VpsUser@$VpsHost"

Write-Host "Opening fast reverse tunnel:"
foreach ($rule in $forwardRules) {
    Write-Host "  VPS $RemoteBind`:$($rule.RemotePort) -> local $($rule.LocalHost):$($rule.LocalPort)"
}
Write-Host "Use one tunnel for dashboard, chat, live updates, Socket.IO, SSE, or any local HTTP/TCP service."
Write-Host "Keep this window open."
Write-Host ""

if ($DryRun) {
    Write-Host "Dry run SSH command:"
    Write-Host ("ssh " + ($baseArgs -join " "))
    exit 0
}

do {
    & ssh @baseArgs
    $exitCode = $LASTEXITCODE
    if (-not $Reconnect) {
        exit $exitCode
    }
    Write-Host "Tunnel exited with code $exitCode. Reconnecting in 3 seconds..."
    Start-Sleep -Seconds 3
} while ($true)
