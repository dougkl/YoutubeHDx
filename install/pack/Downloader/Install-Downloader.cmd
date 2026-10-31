@echo off
rem Double-click to run Install-Downloader.ps1 (works even when PowerShell scripts are restricted).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Downloader.ps1" %*
echo.
pause
