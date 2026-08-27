$ErrorActionPreference = "Stop"
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location -LiteralPath $workspaceRoot

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw "未找到 Node.js。请先安装 Node.js 20 或更高版本，并重新运行安装脚本。"
}

& $nodeCommand.Source "tools\expert_tracking_sources\run_stable_update.mjs" @args
exit $LASTEXITCODE
