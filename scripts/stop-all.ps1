# AI 额度看板 · Windows 一键停止（桌面卡片 + 托盘 + 看板服务）
# 与 macOS stop-all.sh 对齐。用法: .\stop-all.cmd
$ErrorActionPreference = 'Continue'
# 本仓库根目录（stop-all.ps1 位于 scripts/ 下）：所有匹配模式锚定到该路径，
# 避免裸通配符（如 *server*index.js*）误杀其他仓库/项目里的同名进程
$Root = Split-Path -Parent $PSScriptRoot

function Stop-ByCommandLine([string]$name, [string]$pattern) {
  $hits = Get-CimInstance Win32_Process -Filter $name -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like $pattern }
  if ($hits) {
    foreach ($p in $hits) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host "[ai-quota] 已停止: $($hits.Count) 个进程"
  } else {
    Write-Host '[ai-quota] 未在运行'
  }
}

Write-Host '停止桌面卡片...'
Stop-ByCommandLine "Name='powershell.exe' OR Name='pwsh.exe'" "*$Root*widget.ps1*"

Write-Host '停止托盘插件...'
Stop-ByCommandLine "Name='powershell.exe' OR Name='pwsh.exe'" "*$Root*tray.ps1*"

Write-Host '停止看板服务...'
Stop-ByCommandLine "Name='node.exe'" "*$Root*server*index.js*"

Write-Host '全部停止。网页端将无法访问，MCP/CLI 查询不受影响（按需自启）。'
