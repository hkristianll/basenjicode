# Launch NordCode with the Chrome DevTools Protocol port open so scripts/peek.mjs can attach and
# screenshot the LIVE app — whatever session/state you're actually looking at. Read-only debugging,
# bound to 127.0.0.1 (loopback) only by Chromium.
#
#   ./scripts/launch-debug.ps1            # installed build (%LOCALAPPDATA%\Programs\NordCode)
#   ./scripts/launch-debug.ps1 -Dev       # dev build via electron-vite (npm run dev)
#   ./scripts/launch-debug.ps1 -Port 9333
#
# Then, when you hit a visual issue:  npm run peek   (writes _shots/peek.png)

param(
  [int]$Port = 9222,
  [switch]$Dev
)
$ErrorActionPreference = 'Stop'

if ($Dev) {
  Write-Host "Starting NordCode (dev) with remote debugging on 127.0.0.1:$Port ..."
  $env:NORDCODE_REMOTE_DEBUG = "$Port"
  npm run dev
  return
}

$exe = Join-Path $env:LOCALAPPDATA 'Programs\NordCode\NordCode.exe'
if (-not (Test-Path $exe)) {
  throw "Installed NordCode not found at $exe. Install the build first, or use -Dev."
}

# A running instance holds the single-instance lock (index.ts:135): a 2nd launch — even with the flag —
# just focuses the existing window (which has no debug port) and exits. So close any running NordCode
# first. Sessions/settings persist to disk, so this is safe.
$running = Get-Process NordCode -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "Closing $($running.Count) running NordCode instance(s) so the debug port can bind ..."
  $running | Stop-Process -Force
  Start-Sleep -Milliseconds 700
}

Write-Host "Launching $exe  --remote-debugging-port=$Port  (loopback only) ..."
Start-Process $exe -ArgumentList "--remote-debugging-port=$Port"
Start-Sleep -Milliseconds 1200
Write-Host "CDP endpoint ready: http://127.0.0.1:$Port/json"
Write-Host "When you hit an issue, run:  npm run peek" -ForegroundColor Green
