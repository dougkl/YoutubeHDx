<#
.SYNOPSIS
  Installs (or updates) the YoutubeHDx downloader on this PC for the current Windows user.
  Run it again any time to update; your settings, login and download history are kept.

  What it does:
    1. Installs yt-dlp, ffmpeg, Deno, the .NET 8 Desktop Runtime and Chrome with winget (skips what's there)
    2. Copies the app and the Downloader extension to %LocalAppData%\Programs\YoutubeHDx
    3. Creates settings from downloader-config.json (NAS path + playlists) on first install
    4. Registers the app with Chrome and Edge, starts it at logon, and restarts it if it ever stops
    5. Adds a daily task that keeps yt-dlp up to date (YouTube changes often)
    6. Starts the app and opens Chrome's extensions page
#>
param(
    [string] $InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\YoutubeHDx'),
    [switch] $SkipDependencies,
    [switch] $NoStart
)
$ErrorActionPreference = 'Stop'
$pack        = $PSScriptRoot
$HostName    = 'com.doug.youtubehdx'
$ExtensionId = 'jankpmgafaifknohonbbhcdhgkpdocfa'   # fixed by the key in extension\manifest.json
$DataDir     = Join-Path $env:LOCALAPPDATA 'YoutubeHDx'
$Settings    = Join-Path $DataDir 'settings.json'
$TaskName    = 'YoutubeHDx - update yt-dlp'

function Step([string] $m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok([string] $m)   { Write-Host "   OK  $m" -ForegroundColor Green }
function Warn([string] $m) { Write-Host "   !!  $m" -ForegroundColor Yellow }
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Write-Utf8([string] $path, [string] $text) {
    [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))
}
function Find-Chrome {
    foreach ($hive in 'HKCU:', 'HKLM:') {
        $p = Get-ItemProperty "$hive\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" -ErrorAction SilentlyContinue
        if ($p -and (Test-Path $p.'(default)')) { return $p.'(default)' }
    }
    return $null
}

foreach ($required in 'app\YoutubeHDx.App.exe', 'app\YoutubeHDx.NativeHost.exe', 'extension\manifest.json') {
    if (-not (Test-Path (Join-Path $pack $required))) { throw "Pack is incomplete: $required is missing next to this script." }
}

# ---------------------------------------------------------------- 1. dependencies
Refresh-Path   # see tools installed since this window opened
if (-not $SkipDependencies) {
    Step 'Checking dependencies'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'winget is not available. Install "App Installer" from the Microsoft Store, then run this again.'
    }

    $hasDesktop8 = $false
    if (Get-Command dotnet -ErrorAction SilentlyContinue) {
        $hasDesktop8 = [bool](& dotnet --list-runtimes 2>$null | Select-String '^Microsoft\.WindowsDesktop\.App 8\.')
    }

    $packages = @(
        @{ Id = 'yt-dlp.yt-dlp';                       Name = 'yt-dlp';                   Present = [bool](Get-Command yt-dlp -ErrorAction SilentlyContinue) },
        @{ Id = 'Gyan.FFmpeg';                         Name = 'ffmpeg';                   Present = [bool](Get-Command ffmpeg -ErrorAction SilentlyContinue) },
        @{ Id = 'DenoLand.Deno';                       Name = 'Deno';                     Present = [bool](Get-Command deno -ErrorAction SilentlyContinue) },
        @{ Id = 'Microsoft.DotNet.DesktopRuntime.8';   Name = '.NET 8 Desktop Runtime';   Present = $hasDesktop8 },
        @{ Id = 'Google.Chrome';                       Name = 'Google Chrome';            Present = [bool](Find-Chrome) }
    )
    foreach ($p in $packages) {
        if ($p.Present) { Ok "$($p.Name) already installed"; continue }
        Write-Host "   ..  Installing $($p.Name) (Windows may ask for permission)"
        & winget install --id $p.Id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
        if ($LASTEXITCODE -ne 0) { Warn "winget could not install $($p.Name) (exit $LASTEXITCODE). Install it manually: winget install $($p.Id)" }
        else { Ok "$($p.Name) installed" }
    }
    Refresh-Path
}

# ---------------------------------------------------------------- 2. app files
Step "Installing to $InstallDir"
$running = Get-Process YoutubeHDx.App -ErrorAction SilentlyContinue
if ($running) { $running | Stop-Process -Force; Start-Sleep -Milliseconds 800; Ok 'Stopped the running app' }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($part in 'app', 'extension') {
    $target = Join-Path $InstallDir $part
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    Copy-Item (Join-Path $pack $part) $target -Recurse -Force
}
# Files from a downloaded zip carry "downloaded from the internet" marks; clear them so nothing prompts.
Get-ChildItem $InstallDir -Recurse -File | Unblock-File
$appExe  = Join-Path $InstallDir 'app\YoutubeHDx.App.exe'
$hostExe = Join-Path $InstallDir 'app\YoutubeHDx.NativeHost.exe'
$extDir  = Join-Path $InstallDir 'extension'
Ok 'App and Downloader extension copied'

# ---------------------------------------------------------------- 3. settings
Step 'Settings'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$seed = Join-Path $pack 'downloader-config.json'
if (-not (Test-Path $Settings)) {
    if (Test-Path $seed) { Copy-Item $seed $Settings; Ok 'Created settings from downloader-config.json' }
    else { Write-Utf8 $Settings '{}'; Warn 'No downloader-config.json in the pack; created empty settings (edit nasPath)' }
} else {
    Ok 'Kept your existing settings'
}

$s = Get-Content $Settings -Raw | ConvertFrom-Json
# Settings added in newer versions (e.g. which folders the duplicate check looks through) come from the pack;
# anything you already have is left as it is.
if (Test-Path $seed) {
    $seedObj = Get-Content $seed -Raw | ConvertFrom-Json
    foreach ($p in $seedObj.PSObject.Properties) {
        if (-not $s.PSObject.Properties[$p.Name]) {
            $s | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value
            Ok "New setting from the pack: $($p.Name)"
        }
    }
}
# Point at the exact tools so the app never depends on PATH being refreshed.
foreach ($pair in @(@('ytDlpPath', 'yt-dlp'), @('ffmpegLocation', 'ffmpeg'))) {
    $key, $tool = $pair
    $current = $s.PSObject.Properties[$key]
    $isDefault = -not $current -or [string]::IsNullOrWhiteSpace($current.Value) -or $current.Value -in 'yt-dlp', 'yt-dlp.exe'
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if ($isDefault -and $cmd) {
        $s | Add-Member -NotePropertyName $key -NotePropertyValue $cmd.Source -Force
        Ok "$key -> $($cmd.Source)"
    }
}
Write-Utf8 $Settings ($s | ConvertTo-Json -Depth 6)

$nas = $s.nasPath
if ([string]::IsNullOrWhiteSpace($nas)) { Warn "nasPath is not set. Edit $Settings" }
elseif (Test-Path -LiteralPath $nas) { Ok "NAS folder reachable: $nas" }
else { Warn "Can't reach $nas from this PC as $env:USERNAME. Open it in Explorer once and save the NAS password, or fix nasPath in $Settings" }
$count = @($s.watchedPlaylists).Count
Ok "$count watched playlist(s)"

# ---------------------------------------------------------------- 4. Chrome/Edge registration + startup
Step 'Registering with Chrome and Edge'
$manifestPath = Join-Path $InstallDir "$HostName.json"
$manifest = [ordered]@{
    name            = $HostName
    description     = 'YoutubeHDx native messaging host'
    path            = $hostExe
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
Write-Utf8 $manifestPath ($manifest | ConvertTo-Json)
foreach ($k in "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName", "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName") {
    New-Item -Path $k -Force | Out-Null
    Set-Item -Path $k -Value $manifestPath
}
Ok 'Native messaging host registered'

# Keep the app running: start at logon and every 15 minutes if it isn't running.
# A second copy exits immediately (single instance), so this never duplicates the app.
Step 'Keep-alive'
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'YoutubeHDx' -ErrorAction SilentlyContinue
$KeepAliveTask = 'YoutubeHDx - keep running'
try {
    $action   = New-ScheduledTaskAction -Execute $appExe -WorkingDirectory (Split-Path $appExe)
    $atLogon  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $every15  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
    $set      = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
                    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    $who      = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $KeepAliveTask -Action $action -Trigger $atLogon, $every15 -Settings $set -Principal $who -Force | Out-Null
    Ok 'Starts at logon and restarts within 15 minutes if it ever stops'
} catch {
    Warn "Could not create the keep-alive task ($($_.Exception.Message)); falling back to start at logon only."
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'YoutubeHDx' -Value "`"$appExe`""
    $KeepAliveTask = $null
}

# ---------------------------------------------------------------- 5. keep yt-dlp current
Step 'Daily yt-dlp update'
try {
    $cmd = 'winget upgrade --id yt-dlp.yt-dlp --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity'
    $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`""
    $trigger = New-ScheduledTaskTrigger -Daily -At '4:17'
    $set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
    $who     = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $set -Principal $who -Force | Out-Null
    Ok "Task '$TaskName' runs daily (or at next logon if the PC was off)"
} catch {
    Warn "Could not create the update task ($($_.Exception.Message)). Run 'winget upgrade yt-dlp.yt-dlp' now and then."
}

# ---------------------------------------------------------------- 6. start + next steps
if (-not $NoStart) {
    Step 'Starting YoutubeHDx'
    # Through Task Scheduler (or Explorer) so the app runs in your desktop session, independent of this window.
    if ($KeepAliveTask) { Start-ScheduledTask -TaskName $KeepAliveTask } else { Start-Process explorer.exe -ArgumentList "`"$appExe`"" }
    Start-Sleep -Seconds 3
    if (Get-Process YoutubeHDx.App -ErrorAction SilentlyContinue) { Ok 'Running in the system tray' }
    else { Warn "The app didn't start; check $(Join-Path $DataDir 'youtubehdx.log')" }
}

$chrome = Find-Chrome
Write-Host ''
Write-Host 'Last step, in Chrome on this PC (one time):' -ForegroundColor White
Write-Host '  1. Sign in to YouTube with your Premium account.'
Write-Host '  2. On the extensions page that opens: turn on "Developer mode", click "Load unpacked", and choose:'
Write-Host "       $extDir" -ForegroundColor White
Write-Host "  3. Check the ID shown is $ExtensionId"
Write-Host '  4. Click the extension icon: a green "Signed in" line means downloads will use your account.'
Write-Host ''
Write-Host 'After an update, click the reload icon on the extension card (or restart Chrome).'
Set-Clipboard -Value $extDir -ErrorAction SilentlyContinue
Write-Host '(The extension folder path is on your clipboard.)'
if ($chrome) { Start-Process $chrome 'chrome://extensions' } else { Warn 'Chrome not found; install it, then load the extension.' }
