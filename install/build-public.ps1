<#
.SYNOPSIS
  Makes the public downloads (YoutubeHDx-Player.zip, YoutubeHDx-Downloader.zip) from a built pack,
  with personal settings removed: placeholder NAS path, no watched playlists, no TIDAL Client ID.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install\build-public.ps1 -Pack "W:\Music (videos)\Software\YoutubeHDx\YoutubeHDx-Pack-1.10.27"
#>
param(
    [Parameter(Mandatory)] [string] $Pack,
    [string] $OutDir
)
$ErrorActionPreference = 'Stop'
$version = (Split-Path $Pack -Leaf) -replace '^YoutubeHDx-Pack-', ''
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot "..\dist\public-$version" }
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$utf8 = New-Object Text.UTF8Encoding $false
function Write-Text([string] $path, [string] $text) { [IO.File]::WriteAllText($path, ($text -replace "`r?`n", "`r`n"), $utf8) }

# ---- Player: no TIDAL Client ID (users paste their own on the options page) ----
$pl = Join-Path $OutDir 'YoutubeHDx-Player'
Copy-Item (Join-Path $Pack 'Player') $pl -Recurse
Remove-Item (Join-Path $pl 'extension\tidal-config.json') -Force -ErrorAction SilentlyContinue
Write-Text (Join-Path $pl 'README.txt') @"
YoutubeHDx Player $version
=========================
For the PC you watch YouTube on. Always 4K, English captions that are human-made only,
in your own caption style. Optional: play the matching TIDAL track in sync with music videos.

INSTALL
  1. Double-click Install-Player.cmd (installs Chrome with winget if it's missing; no admin needed).
  2. In Chrome open chrome://extensions, turn Developer mode ON, click Load unpacked and pick
     %LocalAppData%\Programs\YoutubeHDx-Player\extension
  3. Click the YoutubeHDx Player icon to set quality, caption language and caption style.

TIDAL (optional)
  Needs a TIDAL subscription and your own free developer app from https://developer.tidal.com.
  Paste its Client ID on the Player's options page, then sign in to TIDAL from there.

UPDATE: run Install-Player.cmd from a newer download, then click reload on the extension card.
REMOVE: Uninstall-Player.cmd
Source and license (MIT): https://github.com/dougkl/YoutubeHDx
"@

# ---- Downloader: placeholder NAS path, no playlists, no TIDAL Client ID ----
$dl = Join-Path $OutDir 'YoutubeHDx-Downloader'
Copy-Item (Join-Path $Pack 'Downloader') $dl -Recurse
$cfgPath = Join-Path $dl 'downloader-config.json'
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$cfg.nasPath = '\\nas\media\YouTube'
$cfg.watchedPlaylists = @()
foreach ($k in 'tidalClientId', 'tidalCountry', 'tidalPlaylist', 'duplicateFolders', 'duplicateSkipFolders') {
    if ($cfg.PSObject.Properties[$k]) { $cfg.PSObject.Properties.Remove($k) }
}
[IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 6), $utf8)
Write-Text (Join-Path $dl 'README.txt') @"
YoutubeHDx Downloader $version
=============================
For an always-on Windows PC (the "download server"). Archives YouTube videos and whole playlists
in up to 4K with human-made English captions, as MKV, to a NAS or any folder.

BEFORE YOU INSTALL
  Open downloader-config.json and set "nasPath" to where videos should go
  (for example \\mynas\media\YouTube or D:\YouTube). You can change it later from the tray icon.

INSTALL
  1. Double-click Install-Downloader.cmd. It installs what's missing (yt-dlp, ffmpeg, Deno,
     .NET 8 Desktop Runtime, Chrome), installs the app for this Windows user, starts it at logon,
     and keeps yt-dlp up to date daily. No admin needed.
  2. In Chrome on this PC, sign in to YouTube (Premium gives the best quality).
  3. chrome://extensions -> Developer mode ON -> Load unpacked ->
     %LocalAppData%\Programs\YoutubeHDx\extension   (the path is on your clipboard)
  4. Click the extension icon: green "Signed in" means downloads use your account.

USE
  On any YouTube video or playlist, click the extension: Download, Download whole playlist,
  or Auto-sync this playlist (new videos are fetched automatically).
  Tray icon: pause/resume downloads, edit settings, open the log, scan subtitles.

UPDATE: run Install-Downloader.cmd from a newer download. Settings and history are kept.
REMOVE: Uninstall-Downloader.cmd
Only download videos you have the right to keep. Source and license (MIT): https://github.com/dougkl/YoutubeHDx
"@

# ---- Safety check: nothing personal may leave this PC ----
$personal = 'TRUENAS|PLKauv8SCR9w|9KVmoyxNHumWQEWj|Douglas|douglas\.|hypermachina|supermachina|AutoDownload'
$leaks = Get-ChildItem $OutDir -Recurse -File | Where-Object { $_.Extension -notin '.png' } |
    Where-Object { [IO.File]::ReadAllText($_.FullName) -match $personal }
if ($leaks) { $leaks | ForEach-Object { Write-Warning "Personal data in $($_.FullName)" }; throw 'Not publishing: personal data found.' }

Compress-Archive -Path $pl -DestinationPath (Join-Path $OutDir 'YoutubeHDx-Player.zip') -Force
Compress-Archive -Path $dl -DestinationPath (Join-Path $OutDir 'YoutubeHDx-Downloader.zip') -Force
Write-Host "Clean. Public downloads for $version in $OutDir" -ForegroundColor Green
Get-ChildItem $OutDir -Filter *.zip | ForEach-Object { '{0}  {1:N0} KB' -f $_.Name, ($_.Length / 1KB) }
