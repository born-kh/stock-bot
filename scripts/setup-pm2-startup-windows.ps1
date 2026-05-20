$ErrorActionPreference = "Stop"

# Run from repo root where package.json exists.
$projectDir = (Resolve-Path "$PSScriptRoot/..").Path
$taskName = "stock-bot-pm2-resurrect"

Write-Host "Saving current PM2 process list..."
Push-Location $projectDir
npx pm2 save
Pop-Location

$nodeCmd = "cmd.exe /c cd /d `"$projectDir`" && npx pm2 resurrect"

Write-Host "Creating or updating task: $taskName"
schtasks /Delete /TN $taskName /F 2>$null | Out-Null
schtasks /Create /F /SC ONSTART /RU SYSTEM /RL HIGHEST /TN $taskName /TR $nodeCmd | Out-Null

Write-Host ""
Write-Host "Done. Startup task configured."
Write-Host "Task name: $taskName"
Write-Host "Command: $nodeCmd"
Write-Host ""
Write-Host "Check status with:"
Write-Host "  schtasks /Query /TN $taskName /V /FO LIST"
