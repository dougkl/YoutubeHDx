<#
.SYNOPSIS
  Builds the YoutubeHDx install pack (Downloader + Player) into dist\ as a folder and a .zip.

.DESCRIPTION
  The downloader settings in the pack (NAS folder, watched playlists, quality, captions...) are taken
  from -SeedFrom, by default this PC's own settings. Machine-specific paths and your login are never copied.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install\build-pack.ps1
#>
param(
    [string] $OutDir = (Join-Path $PSScriptRoot '..\dist'),
    [string] $SeedFrom = (Join-Path $env:LOCALAPPDATA 'YoutubeHDx\settings.json'),
    # Also copy the pack here (e.g. a NAS software folder). Each version gets its own folder; nothing is overwritten.
    [string] $PublishTo
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content (Join-Path $root 'extension-downloader\manifest.json') -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$pack = Join-Path $OutDir "YoutubeHDx-Pack-$version"
if (Test-Path $pack) { Remove-Item $pack -Recurse -Force }

Write-Host "Building YoutubeHDx pack $version" -ForegroundColor Cyan

# Downloader: app + native host in one folder, plus the Downloader extension.
foreach ($proj in 'YoutubeHDx.App', 'YoutubeHDx.NativeHost') {
    dotnet publish (Join-Path $root "src\$proj\$proj.csproj") -c Release -r win-x64 --self-contained false `
        -p:DebugType=none -o (Join-Path $pack 'Downloader\app') --nologo -v quiet
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed for $proj" }
}
Copy-Item (Join-Path $root 'extension-downloader') (Join-Path $pack 'Downloader\extension') -Recurse
Copy-Item (Join-Path $PSScriptRoot 'pack\Downloader\*') (Join-Path $pack 'Downloader')

# Player: just the extension.
New-Item -ItemType Directory -Force -Path (Join-Path $pack 'Player') | Out-Null
Copy-Item (Join-Path $root 'extension-player') (Join-Path $pack 'Player\extension') -Recurse
Copy-Item (Join-Path $PSScriptRoot 'pack\Player\*') (Join-Path $pack 'Player')
Copy-Item (Join-Path $PSScriptRoot 'pack\README.txt') $pack

# Seed settings for the server: portable values only (no tool paths, temp folder or login).
$portable = 'nasPath', 'maxHeight', 'subtitleLanguages', 'embedSubtitles', 'keepSubtitleFiles', 'outputTemplate',
            'extraArgs', 'maxConcurrentDownloads', 'requireLogin', 'watchedPlaylists', 'watchIntervalMinutes'
$seed = [ordered]@{}
if (Test-Path $SeedFrom) {
    $src = Get-Content $SeedFrom -Raw | ConvertFrom-Json
    foreach ($k in $portable) { if ($src.PSObject.Properties[$k]) { $seed[$k] = $src.$k } }
    Write-Host "Seeded downloader settings from $SeedFrom"
} else {
    $seed.nasPath = '\\nas\media\YouTube'
    $seed.watchedPlaylists = @()
    Write-Warning "No settings at $SeedFrom; the pack uses a placeholder NAS path. Edit Downloader\downloader-config.json."
}
[IO.File]::WriteAllText((Join-Path $pack 'Downloader\downloader-config.json'),
    ($seed | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))

$zip = "$pack.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $pack -DestinationPath $zip
Write-Host ''
Write-Host "Pack folder: $pack" -ForegroundColor Green
Write-Host "Pack zip:    $zip" -ForegroundColor Green
Write-Host "NAS: $($seed.nasPath)   Playlists: $(@($seed.watchedPlaylists).Count)"

if ($PublishTo) {
    # Versioned folders only: shares that allow create-but-not-delete (like TrueNAS with restricted ACLs) still work.
    $target = Join-Path $PublishTo (Split-Path $pack -Leaf)
    if (Test-Path -LiteralPath $target) {
        throw "$target already exists. Bump the version in extension-*\manifest.json and build again."
    }
    New-Item -ItemType Directory -Force -Path $PublishTo | Out-Null

    # Keep Plex (or Jellyfin, via .ignore) from scanning installers that sit inside a media library.
    $parent = Split-Path $PublishTo -Parent
    foreach ($dir in $PublishTo, $parent) {
        if (-not $dir) { continue }
        $pi = Join-Path $dir '.plexignore'
        if ($dir -eq $parent) {
            # In the library root: ignore just the software folder, and only if no .plexignore exists yet.
            if (-not (Test-Path -LiteralPath $pi)) {
                [IO.File]::WriteAllText($pi, (Split-Path $PublishTo -Leaf) + "/*`n", (New-Object Text.UTF8Encoding $false))
                Write-Host "Created $pi"
            } elseif (-not (Select-String -LiteralPath $pi -SimpleMatch (Split-Path $PublishTo -Leaf) -Quiet)) {
                Write-Warning "$pi exists; add this line to it yourself: $(Split-Path $PublishTo -Leaf)/*"
            }
        } elseif (-not (Test-Path -LiteralPath $pi)) {
            [IO.File]::WriteAllText($pi, "*`n", (New-Object Text.UTF8Encoding $false))
            Write-Host "Created $pi"
        }
    }
    $jf = Join-Path $PublishTo '.ignore'
    if (-not (Test-Path -LiteralPath $jf)) { [IO.File]::WriteAllText($jf, '', (New-Object Text.UTF8Encoding $false)) }

    Copy-Item -LiteralPath $pack -Destination $target -Recurse
    Copy-Item -LiteralPath $zip -Destination $PublishTo
    Write-Host "Published:   $target" -ForegroundColor Green
    Write-Host "             $(Join-Path $PublishTo (Split-Path $zip -Leaf))" -ForegroundColor Green
}
