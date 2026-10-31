# Runs both test suites. Needs the .NET 8 SDK and Node 20+. Exit code is non-zero if anything fails.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')

Write-Host "== C# (Core, queue, IPC, native host) ==" -ForegroundColor Cyan
dotnet run --project (Join-Path $root 'tests\YoutubeHDx.Tests') -c Release
$dotnetFailed = $LASTEXITCODE

Write-Host "`n== Extension (player, captions, background) ==" -ForegroundColor Cyan
node --test (Join-Path $root 'tests\extension\extension.test.mjs') (Join-Path $root 'tests\extension\lyrics.test.mjs') (Join-Path $root 'tests\extension\sync.test.mjs')
$nodeFailed = $LASTEXITCODE

if ($dotnetFailed -or $nodeFailed) { Write-Host "`nTests failed." -ForegroundColor Red; exit 1 }
Write-Host "`nAll tests passed." -ForegroundColor Green
