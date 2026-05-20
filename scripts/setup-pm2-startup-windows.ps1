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

# Delete old task only if it exists (avoid failing on first run).
cmd.exe /c "schtasks /Query /TN `"$taskName`" >nul 2>&1"
if ($LASTEXITCODE -eq 0) {
  cmd.exe /c "schtasks /Delete /TN `"$taskName`" /F >nul 2>&1"
}

cmd.exe /c "schtasks /Create /F /SC ONSTART /RU SYSTEM /RL HIGHEST /TN `"$taskName`" /TR `"$nodeCmd`""
if ($LASTEXITCODE -ne 0) {
  throw "Failed to create scheduled task '$taskName'. Run PowerShell as Administrator and try again."
}

Write-Host ""
Write-Host "Done. Startup task configured."
Write-Host "Task name: $taskName"
Write-Host "Command: $nodeCmd"
Write-Host ""
Write-Host "Check status with:"
Write-Host "  schtasks /Query /TN $taskName /V /FO LIST"
