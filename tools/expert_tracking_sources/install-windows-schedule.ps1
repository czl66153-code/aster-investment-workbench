param(
  [string]$PrimaryTime = "18:40",
  [string]$RecoveryTime = "20:30"
)

$ErrorActionPreference = "Stop"
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$primaryScript = Join-Path $PSScriptRoot "run-stable-update.ps1"
$recoveryScript = Join-Path $PSScriptRoot "run-recovery-update.ps1"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$powerShellCommand = Get-Command powershell.exe -ErrorAction SilentlyContinue

if (-not $nodeCommand) { throw "未找到 Node.js。请安装 Node.js 20 或更高版本。" }
if (-not $powerShellCommand) { throw "未找到 Windows PowerShell。" }
if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) { throw "当前系统不支持 Windows 任务计划程序 PowerShell 模块。" }

Write-Host "先做离线演练：校验历史数据、聚合、原子同步和健康文件。"
& $nodeCommand.Source (Join-Path $PSScriptRoot "run_stable_update.mjs") --skip-network
if ($LASTEXITCODE -ne 0) { throw "离线演练失败，未创建定时任务。请先查看 outputs\expert_tracking\logs。" }

$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 15) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 3)
$days = @("Monday", "Tuesday", "Wednesday", "Thursday", "Friday")

function Install-TrackerTask([string]$Name, [string]$Script, [string]$At) {
  $action = New-ScheduledTaskAction `
    -Execute $powerShellCommand.Source `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Script`"" `
    -WorkingDirectory $workspaceRoot
  $trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek $days -At $At
  $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "高手跟踪公开数据稳定更新；失败自动重试，保留最近有效数据。"
  Register-ScheduledTask -TaskName $Name -InputObject $task -Force | Out-Null
  Write-Host "已安装：$Name（工作日 $At）"
}

Install-TrackerTask "高手跟踪-收盘更新" $primaryScript $PrimaryTime
Install-TrackerTask "高手跟踪-失败补救" $recoveryScript $RecoveryTime

Write-Host "安装完成。任务使用当前账户 $account；电脑错过执行时间时会在下次可用时补跑。"
Write-Host "健康状态：$(Join-Path $workspaceRoot 'outputs\expert_tracking\update_status.json')"
