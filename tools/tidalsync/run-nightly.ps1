# Nightly TIDAL sync: measures library videos not done yet (one at a time, gently, so TIDAL doesn't refuse),
# then publishes sync/tidal-sync.json to GitHub (main) when it changed. Log: %TEMP%\tidalsync\nightly.log
$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$log = Join-Path $env:TEMP 'tidalsync\nightly.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
$env:PYTHONIOENCODING = 'utf-8'
# The Python that has tidalapi, numpy and scipy (a scheduled task may find another one first).
$py = if (Test-Path "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe") { "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" } else { 'python' }
function Log { process { $_ | Out-File -FilePath $log -Append -Encoding utf8 } }
"=== $(Get-Date -Format s) start" | Log
Push-Location (Join-Path $repo 'tools\tidalsync')
& $py job.py 0 1 2>&1 | Log
& $py job.py merge 2>&1 | Log
Pop-Location
Push-Location $repo
git add sync/tidal-sync.json
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    git commit -q -m "Sync file: nightly TIDAL measurements`n`nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" 2>&1 | Log
    git pull -q --rebase origin main 2>&1 | Log
    git push -q origin main 2>&1 | Log
    "pushed" | Log
}
Pop-Location
"=== $(Get-Date -Format s) done" | Log
