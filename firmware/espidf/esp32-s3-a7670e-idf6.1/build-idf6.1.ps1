param(
    [string]$IdfPath = 'D:\Tools\esp-idf-v6.1',
    [string]$ToolsPath = 'D:\Tools\espressif',
    [string]$PythonEnv = 'D:\Tools\espressif\python_env\idf6.1_py3.14_env',
    [string]$BuildDirectory = 'build-idf6.1',
    [switch]$Reconfigure
)

$ErrorActionPreference = 'Stop'

$env:IDF_TOOLS_PATH = $ToolsPath
$env:IDF_PYTHON_ENV_PATH = $PythonEnv
$env:PATH = "$PythonEnv\Scripts;$env:PATH"
. (Join-Path $IdfPath 'export.ps1')

$projectPath = $PSScriptRoot
Push-Location $projectPath
try {
    $idfPython = Join-Path $PythonEnv 'Scripts\python.exe'
    $idfPy = Join-Path $IdfPath 'tools\idf.py'
    if ($Reconfigure) {
        & $idfPython $idfPy -B $BuildDirectory reconfigure
    }
    & $idfPython $idfPy -B $BuildDirectory build
    if ($LASTEXITCODE -ne 0) {
        throw "ESP-IDF 6.1 build failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}
