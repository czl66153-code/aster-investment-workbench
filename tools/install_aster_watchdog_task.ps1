$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$WatchdogPath = Join-Path $ProjectRoot "watchdog.ps1"
$TaskName = "AsterUnifiedWorkbenchWatchdog"

if (-not (Test-Path -LiteralPath $WatchdogPath)) {
  throw "watchdog.ps1 not found: $WatchdogPath"
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$WatchdogPath`"" `
  -WorkingDirectory $ProjectRoot
$triggers = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -AtLogOn)
)
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 99 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal `
  -UserId "SYSTEM" `
  -LogonType ServiceAccount `
  -RunLevel Highest

$installMode = "system_startup_and_logon"
try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $triggers `
    -Settings $settings `
    -Principal $principal `
    -Description "ASTER独立工作台看门狗：维持3100网站、8035引擎及脚本调度，仅ASTER负责数据更新。" `
    -Force -ErrorAction Stop | Out-Null
} catch {
  $installMode = "current_user_logon_fallback_requires_admin_for_boot"
  $userTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $userPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $userTrigger `
    -Settings $settings `
    -Principal $userPrincipal `
    -Description "ASTER独立工作台看门狗（当前用户登录启动；管理员重装后可升级为开机启动）。" `
    -Force -ErrorAction Stop | Out-Null
}

Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State, @{Name="InstallMode";Expression={$installMode}}
