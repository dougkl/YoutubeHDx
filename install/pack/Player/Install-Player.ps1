<#
.SYNOPSIS
  Installs (or updates) the YoutubeHDx Player extension for this PC: always 4K, English captions that are
  human-made only, and your caption style. No downloader, no login, nothing else runs on this PC.
#>
param(
    [string] $InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\YoutubeHDx-Player')
)
$ErrorActionPreference = 'Stop'
$pack = $PSScriptRoot

function Ok([string] $m)   { Write-Host "   OK  $m" -ForegroundColor Green }
function Warn([string] $m) { Write-Host "   !!  $m" -ForegroundColor Yellow }
function Find-Chrome {
    foreach ($hive in 'HKCU:', 'HKLM:') {
        $p = Get-ItemProperty "$hive\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" -ErrorAction SilentlyContinue
        if ($p -and (Test-Path $p.'(default)')) { return $p.'(default)' }
    }
    return $null
}

if (-not (Test-Path (Join-Path $pack 'extension\manifest.json'))) { throw 'Pack is incomplete: extension\ is missing next to this script.' }

$chrome = Find-Chrome
if (-not $chrome -and (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host '   ..  Installing Google Chrome'
    & winget install --id Google.Chrome --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
    $chrome = Find-Chrome
}

$extDir = Join-Path $InstallDir 'extension'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
if (Test-Path $extDir) { Remove-Item $extDir -Recurse -Force }
Copy-Item (Join-Path $pack 'extension') $extDir -Recurse -Force
Get-ChildItem $InstallDir -Recurse -File | Unblock-File
Ok "Player extension copied to $extDir"

Write-Host ''
Write-Host 'Last step, in Chrome on this PC (one time):' -ForegroundColor White
Write-Host '  1. On the extensions page that opens: turn on "Developer mode", click "Load unpacked", and choose:'
Write-Host "       $extDir" -ForegroundColor White
Write-Host '  2. Click the YoutubeHDx Player icon to set quality, caption language and caption style.'
Write-Host ''
Write-Host 'After an update, click the reload icon on the extension card (or restart Chrome).'
Set-Clipboard -Value $extDir -ErrorAction SilentlyContinue
Write-Host '(The extension folder path is on your clipboard.)'
if ($chrome) { Start-Process $chrome 'chrome://extensions' } else { Warn 'Chrome not found; install it, then load the extension.' }
