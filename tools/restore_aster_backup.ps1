param(
  [Parameter(Mandatory = $true)][string]$BackupPath,
  [switch]$ConfirmRestore
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$BackupRoot = (Resolve-Path -LiteralPath (Join-Path $ProjectRoot "data\backups")).Path
$ResolvedBackup = (Resolve-Path -LiteralPath $BackupPath).Path
if (-not $ResolvedBackup.StartsWith($BackupRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Backup must be inside $BackupRoot" }
if (-not $ConfirmRestore) { throw "Restore is destructive and requires -ConfirmRestore" }

$NodePath = Join-Path $env:ProgramFiles "nodejs\node.exe"
$verification = & $NodePath (Join-Path $PSScriptRoot "verify_sqlite_backup.mjs") $ResolvedBackup | ConvertFrom-Json
if ($verification.ok -ne $true) { throw "Backup verification failed" }

$TaskName = "AsterUnifiedWorkbenchWatchdog"
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
foreach ($name in @("engine", "web")) {
  $statePath = Join-Path $ProjectRoot "data\runtime\$name.json"
  if (-not (Test-Path -LiteralPath $statePath)) { continue }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if ($state.projectRoot -eq $ProjectRoot) { Stop-Process -Id ([int]$state.pid) -Force -ErrorAction SilentlyContinue }
}

$DatabasePath = Join-Path $ProjectRoot "data\aster.db"
$SafetyCopy = Join-Path $BackupRoot ("aster-pre-restore-{0}.db" -f (Get-Date -Format "yyyy-MM-dd-HHmmss"))
Copy-Item -LiteralPath $DatabasePath -Destination $SafetyCopy
Copy-Item -LiteralPath $ResolvedBackup -Destination $DatabasePath -Force
Start-ScheduledTask -TaskName $TaskName
[pscustomobject]@{ Restored = $ResolvedBackup; SafetyCopy = $SafetyCopy; Checksum = $verification.checksum; Integrity = $verification.integrity }
