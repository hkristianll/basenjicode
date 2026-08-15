# Start the NordCode voice sidecar (local speech-to-text + text-to-speech).
# Leave this window open while you use voice mode in NordCode.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Write-Host 'Starting NordCode voice sidecar on http://127.0.0.1:8123 …' -ForegroundColor Cyan
python server.py
