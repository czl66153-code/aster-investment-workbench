$ErrorActionPreference = 'Stop'

$node = (Get-Command node -ErrorAction Stop).Source
$projectDir = $PSScriptRoot

Write-Host '正在同步最新高手档案数据...'
& $node (Join-Path $projectDir 'sync-data.mjs')

Write-Host 'Alpha Lens 已启动：http://127.0.0.1:4178'
Write-Host '按 Ctrl+C 可停止。'
& $node (Join-Path $projectDir 'server.mjs')
