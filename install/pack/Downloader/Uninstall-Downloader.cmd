@echo off
rem Double-click to run Uninstall-Downloader.ps1 (works even when PowerShell scripts are restricted).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall-Downloader.ps1" %*
echo.
pause
