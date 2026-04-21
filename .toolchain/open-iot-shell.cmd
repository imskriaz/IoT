@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
start "IoT Shell" powershell.exe -NoExit -ExecutionPolicy Bypass -Command ". '%SCRIPT_DIR%enter-iot-env.ps1'; Set-Location '%SCRIPT_DIR%..'"
