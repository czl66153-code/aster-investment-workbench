$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$RuntimeDir = Join-Path $ProjectRoot "data\runtime"
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer was not found."
}
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules\.bin\vinext.cmd"))) {
  throw "Dependencies are missing. Run npm install in this directory first."
}
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "dist"))) {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "The production build failed." }
}

$watchdogState = Join-Path $RuntimeDir "watchdog.json"
$alreadyRunning = $false
if (Test-Path -LiteralPath $watchdogState) {
  try {
    $state = Get-Content -LiteralPath $watchdogState -Raw | ConvertFrom-Json
    $process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
    if ($process -and $state.projectRoot -eq $ProjectRoot) {
      $recorded = [datetime]::Parse($state.startedAt)
      $alreadyRunning = [math]::Abs(($process.StartTime - $recorded).TotalSeconds) -lt 3
    }
  } catch { $alreadyRunning = $false }
}
if (-not $alreadyRunning) {
  Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $ProjectRoot "watchdog.ps1")) -WorkingDirectory $ProjectRoot -WindowStyle Hidden | Out-Null
}

Write-Host "Aster Research Workbench is starting:"
Write-Host "  Web     http://localhost:3100/"
Write-Host "  Engine  http://127.0.0.1:8035/health"
Write-Host "The watchdog checks both services every 30 seconds."
