@echo off
rem Installs or updates the YoutubeHDx Downloader (download server) from the newest YoutubeHDx-Pack-x.y.z folder next to this file.
rem Works from the NAS share directly, even where PowerShell scripts are restricted.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "try {" ^
  "  $root = '%~dp0'.TrimEnd('\');" ^
  "  $packs = @(Get-ChildItem -LiteralPath $root -Directory | Where-Object { $_.Name -match '^YoutubeHDx-Pack-(\d+(\.\d+){1,3})$' } |" ^
  "    Sort-Object { [version]$_.Name.Substring(16) } -Descending);" ^
  "  if ($packs.Count -eq 0) { throw 'No YoutubeHDx-Pack-x.y.z folder found next to this file.' }" ^
  "  Write-Host ('Installing ' + $packs[0].Name + ' - Downloader for the download server') -ForegroundColor Cyan;" ^
  "  & (Join-Path $packs[0].FullName 'Downloader\Install-Downloader.ps1')" ^
  "} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }"
echo.
pause
