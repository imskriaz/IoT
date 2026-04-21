$ErrorActionPreference = 'Stop'

$toolchainRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $toolchainRoot
$repoTemp = Join-Path $repoRoot 'temp'
$userTemp = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Temp' } else { $null }
$pythonRuntime = Join-Path $toolchainRoot 'python-runtime'
$nodeDir = 'D:\Tools\nodejs'
$npmGlobal = 'D:\Tools\npm-global'
$npmCache = 'D:\Tools\npm-cache'
$idfPath = Join-Path $toolchainRoot 'esp-idf-v5.3.1'
$idfToolsPath = Join-Path $toolchainRoot 'espressif'
$idfPython = Join-Path $idfToolsPath 'python_env\idf5.3_py3.11_env\Scripts\python.exe'

if (-not (Test-Path $nodeDir)) {
    throw "Node.js was not found at $nodeDir"
}

if (-not (Test-Path $idfPython)) {
    throw "ESP-IDF Python environment was not found at $idfPython"
}

foreach ($path in @($repoTemp, $userTemp, $npmGlobal, $npmCache, $pythonRuntime)) {
    if (-not $path) {
        continue
    }
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

$env:IDF_PATH = $idfPath
$env:IDF_TOOLS_PATH = $idfToolsPath
$env:NPM_CONFIG_PREFIX = $npmGlobal
$env:NPM_CONFIG_CACHE = $npmCache
$env:CODEX_IOT_REPO_TEMP = $repoTemp
$env:TEMP = $repoTemp
$env:TMP = $repoTemp
$env:TMPDIR = $repoTemp

foreach ($prefix in @($nodeDir, $npmGlobal)) {
    if (($env:Path -split ';') -notcontains $prefix) {
        $env:Path = "$prefix;$env:Path"
    }
}

if ($env:PYTHONPATH) {
    $env:PYTHONPATH = "$pythonRuntime;$env:PYTHONPATH"
} else {
    $env:PYTHONPATH = $pythonRuntime
}

$exportStderr = Join-Path $repoTemp ("iot_idf_export_{0}.log" -f ([guid]::NewGuid().ToString('N')))
$previousErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $exportLines = & $idfPython "$idfPath\tools\idf_tools.py" --idf-path "$idfPath" export --format key-value 2> $exportStderr
    $exportExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference

    if ($exportExitCode -ne 0) {
        $exportError = ''
        if (Test-Path $exportStderr) {
            $exportError = (Get-Content $exportStderr | ForEach-Object { "$_" }) -join [Environment]::NewLine
        }
        throw "ESP-IDF export failed.`n$exportError"
    }
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if (Test-Path $exportStderr) {
        Remove-Item -LiteralPath $exportStderr -Force -ErrorAction SilentlyContinue
    }
}
foreach ($line in $exportLines) {
    if ($line -notmatch '=') {
        continue
    }

    $name, $value = $line -split '=', 2
    if ($name -eq 'PATH') {
        $env:Path = $value.Replace('%PATH%', $env:Path)
    } else {
        Set-Item -Path "Env:$name" -Value $value
    }
}

Write-Host "IoT environment loaded for this PowerShell session."
Write-Host "Node: $nodeDir"
Write-Host "ESP-IDF: $idfPath"
Write-Host "Run: node --version, npm test, idf.py --version"
