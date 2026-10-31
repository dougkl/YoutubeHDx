# Removes the YoutubeHDx Player extension files. Remove its card in chrome://extensions as well.
param([string] $InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\YoutubeHDx-Player'))
Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'YoutubeHDx Player files removed. Remove the "YoutubeHDx Player" card in chrome://extensions too.'
