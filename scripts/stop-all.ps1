# AI 额度看板 · Windows 一键停止（桌面卡片 + 托盘 + 看板服务）
# 与 macOS stop-all.sh 对齐。用法: .\stop-all.cmd
$ErrorActionPreference = 'Continue'

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
Stop-ByCommandLine "Name='powershell.exe' OR Name='pwsh.exe'" '*widget.ps1*'

Write-Host '停止托盘插件...'
Stop-ByCommandLine "Name='powershell.exe' OR Name='pwsh.exe'" '*tray.ps1*'

Write-Host '停止看板服务...'
Stop-ByCommandLine "Name='node.exe'" '*server*index.js*'

Write-Host '全部停止。网页端将无法访问，MCP/CLI 查询不受影响（按需自启）。'
