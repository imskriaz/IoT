param(
    [ValidateSet('debug', 'release')]
    [string] $Variant = 'release',

    [string] $Serial = '',

    [int] $WaitSeconds = 20,

    [switch] $NoBuild,

    [switch] $Clean,

    [switch] $GrantPermissions
)

$ErrorActionPreference = 'Stop'

function Find-CommandPath {
    param([string[]] $Names)

    foreach ($name in $Names) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd) {
            return $cmd.Source
        }
    }

    return $null
}

function Read-AdbDevices {
    param([string] $Adb)

    $raw = & $Adb devices -l
    $devices = @()

    foreach ($line in $raw) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed -match '^List of devices') {
            continue
        }

        if ($trimmed -match '^(\S+)\s+(\S+)(?:\s+(.*))?$') {
            $devices += [pscustomobject]@{
                Serial = $matches[1]
                State = $matches[2]
                Detail = if ($matches.Count -gt 3) { $matches[3] } else { '' }
            }
        }
    }

    return $devices
}

function Fail-WithDeviceHelp {
    param(
        [object[]] $Devices,
        [string] $Adb
    )

    $deviceList = (& $Adb devices -l) -join [Environment]::NewLine
    $message = @(
        'ADB device check failed.',
        '',
        $deviceList,
        ''
    )

    if ($Devices.Count -eq 0) {
        $message += 'No Android device is visible to adb.'
        $message += 'Check: USB debugging enabled, file-transfer/MTP USB mode selected, phone RSA prompt accepted, and cable supports data.'
        $message += 'If the phone was just plugged in, run: adb kill-server; adb start-server; adb devices -l'
    } elseif ($Devices | Where-Object { $_.State -eq 'unauthorized' }) {
        $message += 'Device is unauthorized. Unlock the phone and accept the USB debugging RSA prompt, then rerun this script.'
    } elseif ($Devices | Where-Object { $_.State -eq 'offline' }) {
        $message += 'Device is offline. Replug USB or run: adb kill-server; adb start-server'
    } else {
        $message += 'No installable device is in state "device".'
    }

    throw ($message -join [Environment]::NewLine)
}

$repoAndroidDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoAndroidDir

$adb = Find-CommandPath @('adb.exe', 'adb')
if (-not $adb) {
    throw 'adb was not found on PATH. Add Android SDK platform-tools to PATH.'
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$allDevices = @()
$readyDevices = @()

do {
    $allDevices = @(Read-AdbDevices -Adb $adb)
    $readyDevices = @($allDevices | Where-Object { $_.State -eq 'device' })
    if ($readyDevices.Count -gt 0) {
        break
    }
    Start-Sleep -Milliseconds 750
} while ((Get-Date) -lt $deadline)

if ($Serial) {
    $selected = $readyDevices | Where-Object { $_.Serial -eq $Serial } | Select-Object -First 1
    if (-not $selected) {
        Fail-WithDeviceHelp -Devices $allDevices -Adb $adb
    }
} else {
    if ($readyDevices.Count -eq 0) {
        Fail-WithDeviceHelp -Devices $allDevices -Adb $adb
    }
    if ($readyDevices.Count -gt 1) {
        $deviceLines = $readyDevices | ForEach-Object { "  $($_.Serial) $($_.Detail)" }
        throw (("Multiple devices are connected. Rerun with -Serial <device-serial>." + [Environment]::NewLine) + ($deviceLines -join [Environment]::NewLine))
    }
    $selected = $readyDevices[0]
}

$serialArg = @('-s', $selected.Serial)
$abi = ((& $adb @serialArg shell getprop ro.product.cpu.abi) -join '').Trim()
if (-not $abi) {
    $abiList = ((& $adb @serialArg shell getprop ro.product.cpu.abilist) -join '').Trim()
    $abi = ($abiList -split ',')[0]
}
if (-not $abi) {
    throw "Could not detect CPU ABI for device $($selected.Serial)."
}

if (-not $NoBuild) {
    $variantTask = $Variant.Substring(0, 1).ToUpperInvariant() + $Variant.Substring(1)
    & .\gradlew.bat ":app:assemble$variantTask"
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

$apkDir = Join-Path $repoAndroidDir "app\build\outputs\apk\$Variant"
$matchingApk = Get-ChildItem $apkDir -Filter "*-$abi-$Variant.apk" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $matchingApk) {
    $matchingApk = Get-ChildItem $apkDir -Filter "*-$Variant.apk" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch 'unsigned' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

if (-not $matchingApk) {
    throw "No signed $Variant APK found in $apkDir for ABI $abi."
}

Write-Output ("Installing {0:N2} MB APK for {1} ({2})" -f ($matchingApk.Length / 1MB), $selected.Serial, $abi)
Write-Output $matchingApk.FullName

if ($Clean) {
    & $adb @serialArg uninstall com.devicebridge.android | Write-Output
}

$installArgs = @('install', '-r', '-d')
if ($GrantPermissions) {
    $installArgs += '-g'
}
$installArgs += $matchingApk.FullName

& $adb @serialArg @installArgs
if ($LASTEXITCODE -ne 0) {
    Write-Output ''
    Write-Output 'Install failed. If this is a signature mismatch from an older APK, rerun with -Clean to uninstall first.'
    exit $LASTEXITCODE
}

Write-Output 'Install complete.'
