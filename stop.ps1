$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$RuntimeDir = Join-Path $ProjectRoot "data\runtime"

foreach ($name in @("watchdog", "engine", "web")) {
  $statePath = Join-Path $RuntimeDir "$name.json"
  if (-not (Test-Path -LiteralPath $statePath)) { continue }
  try {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.projectRoot -ne $ProjectRoot) { continue }
    $process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
    if ($process) {
      $recorded = [datetime]::Parse($state.startedAt)
      if ([math]::Abs(($process.StartTime - $recorded).TotalSeconds) -lt 3) {
        Stop-Process -Id $process.Id -Force
      }
    }
  } catch {}
}
Write-Host "Aster Research Workbench stopped. Database and backups were preserved."
