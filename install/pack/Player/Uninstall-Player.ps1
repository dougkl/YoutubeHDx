# Removes the YoutubeHDx Player extension files. Remove its card in chrome://extensions as well.
param(
    [string] $InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\YoutubeHDx-Player'),
    [string] $AutoplayPolicyKey = 'HKCU:\Software\Policies\Google\Chrome\AutoplayAllowlist'
)
Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
# Undo the installer's tidal.com entry in Chrome's autoplay allow-list (other entries stay).
if (Test-Path $AutoplayPolicyKey) {
    foreach ($name in (Get-Item $AutoplayPolicyKey).Property) {
        if ((Get-ItemProperty $AutoplayPolicyKey).$name -eq '[*.]tidal.com') { Remove-ItemProperty $AutoplayPolicyKey -Name $name }
    }
    if (-not (Get-Item $AutoplayPolicyKey).Property) { Remove-Item $AutoplayPolicyKey -ErrorAction SilentlyContinue }
}
Write-Host 'YoutubeHDx Player files removed. Remove the "YoutubeHDx Player" card in chrome://extensions too.'
