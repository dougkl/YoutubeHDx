@echo off
rem Double-click to run Uninstall-Player.ps1 (works even when PowerShell scripts are restricted).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall-Player.ps1" %*
echo.
pause
