<#
.SYNOPSIS
  Removes the YoutubeHDx downloader from this PC. Downloaded videos on the NAS are never touched.
  Your settings, login and log are kept unless you pass -RemoveData.
#>
param(
    [string] $InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\YoutubeHDx'),
    [switch] $RemoveData
)
$ErrorActionPreference = 'SilentlyContinue'
$HostName = 'com.doug.youtubehdx'

Get-Process YoutubeHDx.App | Stop-Process -Force
Start-Sleep -Milliseconds 800
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'YoutubeHDx'
Remove-Item "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName" -Recurse
Remove-Item "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName" -Recurse
Unregister-ScheduledTask -TaskName 'YoutubeHDx - keep running' -Confirm:$false
Unregister-ScheduledTask -TaskName 'YoutubeHDx - update yt-dlp' -Confirm:$false
Get-Process YoutubeHDx.App | Stop-Process -Force
Remove-Item $InstallDir -Recurse -Force

if ($RemoveData) {
    Remove-Item (Join-Path $env:LOCALAPPDATA 'YoutubeHDx') -Recurse -Force
    Write-Host 'Removed settings, saved login and log.'
} else {
    Write-Host "Kept settings and saved login in $(Join-Path $env:LOCALAPPDATA 'YoutubeHDx') (use -RemoveData to delete them)."
}
Write-Host 'YoutubeHDx downloader removed. Remove the "YoutubeHDx Downloader" card in chrome://extensions too.'
Write-Host 'yt-dlp, ffmpeg, Deno and .NET were left installed (other apps may use them).'
