@echo off
rem Double-click to run Install-Player.ps1 (works even when PowerShell scripts are restricted).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Player.ps1" %*
echo.
pause
