# AI 额度看板 · Windows 一键启动（服务 + 托盘 + 桌面卡片）
# 与 macOS start-all.sh 对齐：可重复执行，已在运行的组件自动跳过。
# 用法: .\start-all.cmd（双击即可，本脚本是其 PowerShell 实现）
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
Write-Host '[ai-quota] AI 额度看板 · 一键启动' -ForegroundColor Cyan

# ---------- 1) Node 检测（要求 >= 22，内置 node:sqlite） ----------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Host '[ai-quota] 未找到 node，请先安装 Node.js 22+（https://nodejs.org）' -ForegroundColor Red
  exit 1
}
$nodeExe = $nodeCmd.Source
$nodeVer = (& $nodeExe --version) 2>$null
$major = 0
if ($nodeVer -match '^v?(\d+)') { $major = [int]$Matches[1] }
if ($major -lt 22) {
  Write-Host "[ai-quota] node 版本过低（$nodeVer），需要 22+（node:sqlite）" -ForegroundColor Red
  exit 1
}

# ---------- 2) 同步 ChatGPT token 快照（可选，codex 会定期刷新 auth.json） ----------
$authJson = Join-Path $env:USERPROFILE '.codex\auth.json'
if (Test-Path $authJson) {
  $py = Get-Command python -ErrorAction SilentlyContinue
  if ($py) {
    try { & $py.Source (Join-Path $Root 'scripts\sync-chatgpt-token.py') 2>$null } catch { }
  }
}

# ---------- 3) 看板服务 ----------
function Test-Dashboard([int]$p) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/" -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}
$running = Test-Dashboard 7788
if (-not $running) {
  Write-Host '[ai-quota] 启动看板服务...'
  $outLog = Join-Path $env:TEMP 'ai-quota-server.out.log'
  $errLog = Join-Path $env:TEMP 'ai-quota-server.err.log'
  Start-Process -FilePath $nodeExe `
    -ArgumentList ('"{0}"' -f (Join-Path $Root 'server\index.js')) `
    -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  # 等待就绪（冷启动首次全量扫描约需 30s）
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Dashboard 7788) { $ready = $true; break }
  }
  if ($ready) { Write-Host '[ai-quota] 服务已就绪（冷启动约需 30s，期间页面可能空白）' -ForegroundColor Green }
  else { Write-Host "[ai-quota] 服务尚未响应，稍后会自动就绪；日志: $outLog / $errLog" -ForegroundColor Yellow }
} else {
  Write-Host '[ai-quota] 看板服务已在运行'
}

# 服务监听端口（7788 被占时会自动后移，最多 20 个）
$port = 7788
for ($p = 7788; $p -lt 7788 + 20; $p++) { if (Test-Dashboard $p) { $port = $p; break } }

# ---------- 4) 托盘 + 桌面卡片（检测已运行则跳过） ----------
function Test-ScriptRunning([string]$name) {
  $hits = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$name.ps1*" }
  return ($null -ne $hits)
}
function Start-GuiScript([string]$label, [string]$file) {
  if (Test-ScriptRunning $file) { Write-Host "[ai-quota] $label已在运行"; return }
  Write-Host "[ai-quota] 启动${label}..."
  $full = Join-Path $Root $file
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', ('"{0}"' -f $full), '-Port', "$port") `
    -WindowStyle Hidden
}
Start-GuiScript '托盘插件' 'menubar\tray.ps1'
Start-GuiScript '桌面卡片' 'desktop\widget.ps1'

Write-Host ''
Write-Host "[ai-quota] 完成。网页端: http://localhost:$port" -ForegroundColor Cyan
Write-Host '[ai-quota] 停止全部: .\stop-all.cmd'
