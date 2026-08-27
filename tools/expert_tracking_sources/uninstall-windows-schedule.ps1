$ErrorActionPreference = "Stop"
foreach ($taskName in @("高手跟踪-收盘更新", "高手跟踪-失败补救")) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "已移除：$taskName"
  }
}
