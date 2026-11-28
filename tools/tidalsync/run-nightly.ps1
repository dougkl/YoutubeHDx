# Nightly TIDAL sync: measures library videos not done yet (one at a time, gently, so TIDAL doesn't refuse),
# then publishes sync/tidal-sync.json to GitHub (main) when it changed. Log: %TEMP%\tidalsync\nightly.log
$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$log = Join-Path $env:TEMP 'tidalsync\nightly.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
$env:PYTHONIOENCODING = 'utf-8'
"=== $(Get-Date -Format s) start" | Add-Content $log
Push-Location (Join-Path $repo 'tools\tidalsync')
python job.py 0 1 *>> $log
python job.py merge *>> $log
Pop-Location
Push-Location $repo
git add sync/tidal-sync.json
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    git commit -q -m "Sync file: nightly TIDAL measurements`n`nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" *>> $log
    git pull -q --rebase origin main *>> $log
    git push -q origin main *>> $log
    "pushed" | Add-Content $log
}
Pop-Location
"=== $(Get-Date -Format s) done" | Add-Content $log
