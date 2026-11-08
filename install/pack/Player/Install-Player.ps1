<#
.SYNOPSIS
  Installs (or updates) the YoutubeHDx Player extension for this PC: always 4K, English captions that are
  human-made only, and your caption style. No downloader, no login, nothing else runs on this PC.
#>
param(
    [string] $InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\YoutubeHDx-Player'),
    # Chrome's per-user policy list of sites allowed to play sound without a click first.
    [string] $AutoplayPolicyKey = 'HKCU:\Software\Policies\Google\Chrome\AutoplayAllowlist'
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

# TIDAL audio plays in your TIDAL web-player tab, which Chrome keeps silent until you click in it. Adding tidal.com
# to Chrome's autoplay allow-list (for this Windows user only) lets the Player start it by itself.
$tidalPattern = '[*.]tidal.com'
try {
    if (-not (Test-Path $AutoplayPolicyKey)) { New-Item -Path $AutoplayPolicyKey -Force | Out-Null }
    $entries = (Get-Item $AutoplayPolicyKey).Property | Where-Object { $_ -match '^\d+$' }
    $values = @($entries | ForEach-Object { (Get-ItemProperty $AutoplayPolicyKey).$_ })
    if ($values -contains $tidalPattern) {
        Ok 'TIDAL may already play sound without a click (Chrome autoplay allow-list)'
    } else {
        $next = 1 + (@($entries | ForEach-Object { [int]$_ }) + 0 | Measure-Object -Maximum).Maximum
        New-ItemProperty -Path $AutoplayPolicyKey -Name "$next" -Value $tidalPattern -PropertyType String -Force | Out-Null
        Ok 'TIDAL may now play sound without a click (Chrome autoplay allow-list) - restart Chrome once'
    }
} catch {
    Warn "Could not add tidal.com to Chrome's autoplay list ($($_.Exception.Message)); the first TIDAL song will ask for one click."
}

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
