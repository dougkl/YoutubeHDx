<#
.SYNOPSIS
  Installs (or updates) the YoutubeHDx Player extension for this PC: always 4K, English captions that are
  human-made only, and your caption style. No downloader, no login, nothing else runs on this PC.
#>
param(
    [string] $InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\YoutubeHDx-Player'),
    # Chrome's per-user policy list of sites allowed to play sound without a click first.
    [string] $AutoplayPolicyKey = 'HKCU:\Software\Policies\Google\Chrome\AutoplayAllowlist',
    # Don't ask Windows for admin rights (UAC) when the policy key can't be written as you.
    [switch] $NoElevate
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
function Get-AllowlistEntries {
    if (-not (Test-Path $AutoplayPolicyKey)) { return @{} }
    $item = Get-Item $AutoplayPolicyKey
    $map = @{}
    foreach ($name in @($item.Property | Where-Object { $_ -match '^\d+$' })) { $map[[int]$name] = [string]$item.GetValue($name) }
    return $map
}
$entries = @{}
try { $entries = Get-AllowlistEntries } catch { }
if ($entries.Values -contains $tidalPattern) {
    Ok 'TIDAL may already play sound without a click (Chrome autoplay allow-list)'
} else {
    $next = 1 + (@($entries.Keys) + 0 | Measure-Object -Maximum).Maximum
    $added = $false
    try {
        if (-not (Test-Path $AutoplayPolicyKey)) { New-Item -Path $AutoplayPolicyKey -Force | Out-Null }
        New-ItemProperty -Path $AutoplayPolicyKey -Name "$next" -Value $tidalPattern -PropertyType String -Force | Out-Null
        $added = $true
    } catch {
        # Windows keeps the Policies key for administrators: ask once (UAC) and write the same value as admin.
        if (-not $NoElevate -and $AutoplayPolicyKey -like 'HKCU:\*') {
            Write-Host '   ..  Windows needs admin rights to add tidal.com to Chrome''s autoplay list: answer Yes in the window that opens'
            $regKey = 'HKCU\' + $AutoplayPolicyKey.Substring(6)
            try {
                $p = Start-Process reg.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
                    -ArgumentList @('add', "`"$regKey`"", '/v', "$next", '/t', 'REG_SZ', '/d', "`"$tidalPattern`"", '/f')
                try { $added = (Get-AllowlistEntries).Values -contains $tidalPattern } catch { $added = $false }
                if (-not $added -and $p.ExitCode -eq 0) { Warn 'The admin account that answered is another Windows user: the setting went to that user, not you.' }
            } catch {
                Warn 'Admin rights were not given.'
            }
        }
    }
    if ($added) { Ok 'TIDAL may now play sound without a click (Chrome autoplay allow-list) - restart Chrome once' }
    else { Warn "Could not add tidal.com to Chrome's autoplay list; the Player starts TIDAL itself instead (it may show the TIDAL tab for a moment)." }
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
