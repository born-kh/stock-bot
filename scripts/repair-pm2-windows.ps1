$ErrorActionPreference = "Continue"

$projectDir = (Resolve-Path "$PSScriptRoot/..").Path
$pm2Home = Join-Path $env:USERPROFILE ".pm2"

Write-Host "Repairing PM2 on Windows..."
Write-Host "Project: $projectDir"
Write-Host "PM2_HOME: $pm2Home"

Push-Location $projectDir

Write-Host "`n1) Trying graceful PM2 stop..."
npx pm2 kill 2>$null | Out-Null

Write-Host "2) Killing leftover Node/PM2 processes..."
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "3) Removing stale PM2 socket/pid files..."
$staleFiles = @("rpc.sock", "pub.sock", "pm2.pid", "touch", "interactor.sock")
foreach ($name in $staleFiles) {
  $p = Join-Path $pm2Home $name
  if (Test-Path $p) {
    Remove-Item -Force $p -ErrorAction SilentlyContinue
  }
}

Write-Host "4) Starting bot with one command..."
npm run server

Pop-Location

Write-Host "`nDone."
