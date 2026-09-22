# AI 额度看板 · Windows 托盘插件（单文件 PowerShell + WinForms，零依赖）
# 与 macOS 菜单栏 menubar.swift 功能对齐：常驻托盘图标（颜色跟随当日目标进度）、
# 点开是全部明细、套餐 5h/周实时额度、目标过半/用完系统通知，每 5 分钟自刷。
# 依赖看板服务 http://127.0.0.1:<Port>（scripts/start-all.ps1 或 node server/index.js）。
# 启动: powershell -NoProfile -ExecutionPolicy Bypass -File menubar\tray.ps1 [-Port 7788]
param(
  [int]$Port = 7788,
  [int]$IntervalSec = 300
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:Api = "http://127.0.0.1:$Port"
$script:WebUrl = "http://localhost:$Port"

# ---------- 北京时间（UTC+8，与网页/服务端同口径） ----------
function Get-BjNow { [DateTime]::UtcNow.AddHours(8) }
function Get-BjToday { (Get-BjNow).ToString('yyyy-MM-dd') }
function Get-BjMonday {
  $d = Get-BjNow
  $offset = ([int]$d.DayOfWeek + 6) % 7
  $d.AddDays(-$offset).ToString('yyyy-MM-dd')
}

# ---------- 格式化 ----------
function Format-Cny([double]$v) { '¥{0:N2}' -f $v }
function Format-Cny0([double]$v) { '¥{0:N0}' -f $v }
function Format-Tok([long]$v) {
  if ($v -ge 100000000) { '{0:N2}亿' -f ($v / 100000000.0) }
  elseif ($v -ge 10000) { '{0:N1}万' -f ($v / 10000.0) }
  else { "$v" }
}
function Format-Reset($ms) {
  if ($null -eq $ms) { return '' }
  $t = [double]$ms
  if ($t -le 0) { return '' }
  $h = [int][math]::Floor($t / 3600000.0)
  $m = [int][math]::Floor(($t % 3600000.0) / 60000.0)
  return "剩${h}h${m}m"
}
function Get-GoalMessage([double]$pct) {
  if ($pct -lt 1) { return '新的一天，预算就位 🚀' }
  elseif ($pct -lt 25) { return '预算充裕，安心干活 💭' }
  elseif ($pct -lt 50) { return '消耗平稳，余量尚多 ✨' }
  elseif ($pct -lt 75) { return '已用过半，留意节奏 🌀' }
  elseif ($pct -lt 100) { return '预算将尽，要紧的优先 ⚠️' }
  elseif ($pct -lt 150) { return '目标成本已用完 💸' }
  else { return '已大幅超出目标成本 🚨' }
}
function Get-Color([int]$r, [int]$g, [int]$b) { [System.Drawing.Color]::FromArgb($r, $g, $b) }

# ---------- 状态 ----------
$script:State = @{
  ok = $false
  err = '尚未获取'
  toolRows = @()          # @{ name; req; tok; cny }
  req = 0; tok = [long]0; cny = 0.0; payUsd = 0.0
  weekCny = 0.0; ySameCny = 0.0
  goalCny = 0.0; goalPct = 0.0
  quotas = @()            # @{ provider; u5; r5; u7; r7 }
  fetchedAt = $null
}

# 里程碑通知进度（50% / 100% 各一次，跨天自动重置），落盘 %LOCALAPPDATA%
$script:Notify = @{ date = ''; stage = 0 }
$script:StateDir = Join-Path $env:LOCALAPPDATA 'ai-quota-dashboard'
$script:StateFile = Join-Path $script:StateDir 'tray-state.json'
try {
  if (Test-Path $script:StateFile) {
    $saved = Get-Content $script:StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $script:Notify.date = [string]$saved.date
    $script:Notify.stage = [int]$saved.stage
  }
} catch { }
function Save-NotifyState {
  try {
    New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null
    @{ date = $script:Notify.date; stage = $script:Notify.stage } |
      ConvertTo-Json | Set-Content -Path $script:StateFile -Encoding UTF8
  } catch { }
}

# ---------- 托盘图标（按目标进度换色：灰=无数据 绿=健康 橙=接近 红=超出） ----------
function New-DiscIcon([int]$r, [int]$g, [int]$b) {
  $bmp = New-Object System.Drawing.Bitmap(32, 32)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $gfx.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush((Get-Color $r $g $b))
  $gfx.FillEllipse($brush, 3, 3, 26, 26)
  $font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $rect = New-Object System.Drawing.RectangleF(0, 0, 32, 32)
  $gfx.DrawString('¥', $font, $white, $rect, $sf)
  $ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $gfx.Dispose(); $brush.Dispose(); $white.Dispose(); $font.Dispose(); $sf.Dispose(); $bmp.Dispose()
  return $ico
}
$script:IcoGray = New-DiscIcon 120 124 135
$script:IcoGreen = New-DiscIcon 67 160 71
$script:IcoOrange = New-DiscIcon 245 150 0
$script:IcoRed = New-DiscIcon 233 60 50

# ---------- 里程碑系统通知（Win10+ 走系统 Toast） ----------
function Show-Balloon([string]$title, [string]$body, [string]$kind) {
  $tip = [System.Windows.Forms.ToolTipIcon]::Info
  if ($kind -eq 'Warning') { $tip = [System.Windows.Forms.ToolTipIcon]::Warning }
  $script:Tray.ShowBalloonTip(6000, $title, $body, $tip)
}

# ---------- 数据刷新 ----------
function Update-State {
  $s = $null
  try { $s = Invoke-RestMethod -Uri "$script:Api/api/summary?days=8" -TimeoutSec 6 }
  catch { $script:State.err = "服务未响应（node server/index.js 启动了吗？）" }

  if (-not $s -or -not $s.agg) {
    $script:State.ok = $false
    $script:State.toolRows = @()      # 失败清空，菜单显示获取失败（与 macOS 版一致）
    Update-Tray
    return
  }

  $today = Get-BjToday
  $day = $s.agg.daily.$today            # 今天没有用量时为 $null，不算错误

  $names = [ordered]@{
    codex = 'ChatGPT·Codex'; claudeDesktop = 'Claude Desktop'; claudeCode = 'Claude Code'
    zcode = 'ZCode'; workbuddy = 'WorkBuddy'
  }
  $rows = @(); [int]$req = 0; [long]$tok = 0; [double]$cny = 0.0; [double]$pay = 0.0
  if ($day) {
    foreach ($k in $names.Keys) {
      $a = $day.$k
      if ($null -eq $a) { continue }
      $t = [long]$a.inputTokens + [long]$a.outputTokens
      $c = [double]$a.costCny + [double]$a.equivalentCny
      $rows += @{ name = $names[$k]; req = [int]$a.requests; tok = $t; cny = $c }
      $req += [int]$a.requests; $tok += $t; $cny += $c; $pay += [double]$a.payUsd
    }
  }

  # 本周合计（北京 ISO 周一起）
  $monday = Get-BjMonday
  [double]$wk = 0.0
  foreach ($p in $s.agg.daily.PSObject.Properties) {
    if ($p.Name -lt $monday) { continue }
    $t = $p.Value.'__total'
    if ($t) { $wk += [double]$t.costCny + [double]$t.equivalentCny }
  }

  # 套餐实时额度
  $qs = @()
  foreach ($key in 'chatgptQuota', 'minimaxQuota', 'zhipuQuota') {
    $q = $s.$key
    if ($null -eq $q -or -not $q.available) { continue }
    $qs += @{
      provider = [string]$q.provider
      u5 = $q.fiveHour.usedPercent; r5 = $q.fiveHour.resetMsLeft
      u7 = $q.weekly.usedPercent;  r7 = $q.weekly.resetMsLeft
    }
  }

  $script:State.ok = $true
  $script:State.toolRows = $rows
  $script:State.req = $req; $script:State.tok = $tok; $script:State.cny = $cny; $script:State.payUsd = $pay
  $script:State.weekCny = $wk
  $script:State.ySameCny = [double]$s.cmp.yesterdaySameTime.total.cny
  $script:State.quotas = $qs
  $script:State.fetchedAt = Get-Date
  $script:State.goalCny = [double]$s.plans.dailyGoal.cny
  $script:State.goalPct = 0.0
  if ($script:State.goalCny -gt 0) {
    $script:State.goalPct = [math]::Min($cny / $script:State.goalCny * 100.0, 999.0)
    # 里程碑通知（跨天重置）
    if ($script:Notify.date -ne $today) { $script:Notify.date = $today; $script:Notify.stage = 0 }
    if ($script:State.goalPct -ge 50 -and $script:Notify.stage -lt 50) {
      $script:Notify.stage = 50
      Show-Balloon '今日成本已过半 🌀' ('已 {0} / 目标 {1}，留意消耗节奏' -f (Format-Cny0 $cny), (Format-Cny0 $script:State.goalCny)) 'Info'
    }
    if ($script:State.goalPct -ge 100 -and $script:Notify.stage -lt 100) {
      $script:Notify.stage = 100
      Show-Balloon '🎯 当日目标成本已用完 💸' ('已花 {0} · 达到目标 {1}，继续跑将超出' -f (Format-Cny0 $cny), (Format-Cny0 $script:State.goalCny)) 'Warning'
    }
    Save-NotifyState
  }

  Update-Tray
}

# ---------- 托盘呈现 ----------
function Update-Tray {
  $st = $script:State
  if (-not $st.ok) {
    $script:Tray.Icon = $script:IcoGray
    $script:Tray.Text = '⚡ AI 额度看板 · ' + $st.err
    if ($script:Tray.Text.Length -gt 63) { $script:Tray.Text = $script:Tray.Text.Substring(0, 63) }
  } else {
    $ico = $script:IcoGreen
    if ($st.goalCny -gt 0) {
      if ($st.goalPct -ge 100) { $ico = $script:IcoRed }
      elseif ($st.goalPct -ge 75) { $ico = $script:IcoOrange }
    }
    $script:Tray.Icon = $ico
    $tip = '⚡ {0} · {1} 次' -f (Format-Cny $st.cny), $st.req
    if ($st.goalCny -gt 0) { $tip += ' · 目标{0:N0}%' -f $st.goalPct }
    $max5 = $null
    foreach ($q in $st.quotas) { if ($null -ne $q.u5 -and ($null -eq $max5 -or [int]$q.u5 -gt $max5)) { $max5 = [int]$q.u5 } }
    if ($null -ne $max5) { $tip += ' · 5h {0}%' -f $max5 }
    $script:Tray.Text = $tip
  }
  Rebuild-Menu
}

# ---------- 菜单 ----------
function New-Mi([string]$text, $color, [bool]$bold, [bool]$mono, $handler) {
  $mi = New-Object System.Windows.Forms.ToolStripMenuItem
  $mi.Text = $text
  $style = [System.Drawing.FontStyle]::Regular
  if ($bold) { $style = [System.Drawing.FontStyle]::Bold }
  $family = 'Segoe UI'
  if ($mono) { $family = 'Consolas' }
  $mi.Font = New-Object System.Drawing.Font($family, 9, $style, [System.Drawing.GraphicsUnit]::Point)
  if ($color) { $mi.ForeColor = $color }
  if ($handler) { $mi.Add_Click($handler) }
  return $mi
}

function Rebuild-Menu {
  $st = $script:State
  $gold = Get-Color 255 214 25
  $cyan = Get-Color 51 219 255
  $pink = Get-Color 255 74 130
  $orange = Get-Color 255 179 64
  $lime = Get-Color 181 255 64
  $violet = Get-Color 199 145 255
  $green = Get-Color 76 175 80
  $red = Get-Color 233 60 50
  $yellow = Get-Color 255 193 7
  $white = [System.Drawing.Color]::White

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  [void]$menu.Items.Add((New-Mi '⚡ 今日 AI 用量（北京时间）' $gold $true $false $null))
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  if ($st.toolRows.Count -eq 0) {
    $line = '今天还没有请求'
    if (-not $st.ok) { $line = '获取失败: ' + $st.err }
    [void]$menu.Items.Add((New-Mi $line ([System.Drawing.Color]::Silver) $false $true $null))
  } else {
    # 工具行（多巴胺配色，与 macOS 菜单栏同款）
    $toolColors = @{
      'ChatGPT·Codex' = $lime; 'Claude Desktop' = $orange; 'Claude Code' = $pink
      'ZCode' = $cyan; 'WorkBuddy' = $violet
    }
    foreach ($r in $st.toolRows) {
      $c = $toolColors[$r.name]; if (-not $c) { $c = $white }
      $text = '{0,-16} {1,5} 次  ¥{2,7:N2}' -f $r.name, $r.req, $r.cny
      [void]$menu.Items.Add((New-Mi $text $c $false $true $null))
    }
    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    [void]$menu.Items.Add((New-Mi ('合计 {0} 次 · {1} · 等价 {2}' -f $st.req, (Format-Tok $st.tok), (Format-Cny $st.cny)) $gold $true $true $null))
    [void]$menu.Items.Add((New-Mi ('本周（周一起）等价 {0}' -f (Format-Cny $st.weekCny)) $gold $true $true $null))
    if ($st.ySameCny -gt 0.005) {
      $delta = $st.cny / $st.ySameCny * 100.0 - 100.0
      $arrow = '↑'; $dc = $green
      if ($delta -lt 0) { $arrow = '↓'; $dc = $orange }
      [void]$menu.Items.Add((New-Mi ('昨日同期 {0} · 今日 {1}{2:N0}%' -f (Format-Cny $st.ySameCny), $arrow, [math]::Abs($delta)) $dc $true $true $null))
    }
    if ($st.payUsd -gt 0.005) {
      [void]$menu.Items.Add((New-Mi ('真实扣费 ${0:N2}（其余为套餐等价）' -f $st.payUsd) $red $true $true $null))
    }
    # 当日目标成本（方块进度条 + 提示语）：绿=健康 橙=接近 红=用完/超出
    if ($st.goalCny -gt 0) {
      [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
      $filled = [int][math]::Floor($st.goalPct / 100.0 * 10.0)
      if ($filled -lt 0) { $filled = 0 }; if ($filled -gt 10) { $filled = 10 }
      $bar = ('▓' * $filled) + ('░' * (10 - $filled))
      $gc = $green; if ($st.goalPct -ge 100) { $gc = $red } elseif ($st.goalPct -ge 75) { $gc = $orange }
      [void]$menu.Items.Add((New-Mi ('🎯 成本 {0} {1:N0}%  {2}/{3}' -f $bar, $st.goalPct, (Format-Cny0 $st.cny), (Format-Cny0 $st.goalCny)) $gc $true $true $null))
      [void]$menu.Items.Add((New-Mi ('   ' + (Get-GoalMessage $st.goalPct)) $gc $false $false $null))
    }
  }

  # 套餐实时额度
  if ($st.quotas.Count -gt 0) {
    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    [void]$menu.Items.Add((New-Mi '📶 套餐实时额度' $cyan $true $false $null))
    foreach ($q in $st.quotas) {
      if ($null -eq $q.u5) { continue }
      $pct = [int]$q.u5
      if ($null -ne $q.u7 -and [int]$q.u7 -gt $pct) { $pct = [int]$q.u7 }
      $qc = $green; if ($pct -gt 85) { $qc = $red } elseif ($pct -gt 60) { $qc = $yellow }
      $w = -1; if ($null -ne $q.u7) { $w = [int]$q.u7 }
      [void]$menu.Items.Add((New-Mi ('  {0}  5h {1,3}% {2} ｜ 周 {3,3}% {4}' -f $q.provider, [int]$q.u5, (Format-Reset $q.r5), $w, (Format-Reset $q.r7)) $qc $true $true $null))
    }
  }

  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void]$menu.Items.Add((New-Mi '打开看板网页' $null $false $false { Start-Process $script:WebUrl }))
  [void]$menu.Items.Add((New-Mi '立即刷新' $null $false $false { Update-State }))
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void]$menu.Items.Add((New-Mi '退出' $null $false $false { Stop-Tray }))

  $old = $script:Tray.ContextMenuStrip
  $script:Tray.ContextMenuStrip = $null
  if ($old) { $old.Dispose() }
  $script:Tray.ContextMenuStrip = $menu
}

# ---------- 主程序 ----------
$script:Tray = New-Object System.Windows.Forms.NotifyIcon
$script:Tray.Icon = $script:IcoGray
$script:Tray.Visible = $true
$script:Tray.Text = '⚡ AI 额度看板 · 启动中…'

# 左键点托盘 = 弹菜单（对齐 macOS 菜单栏交互；MouseClick 才带 MouseEventArgs）
$script:Tray.Add_MouseClick({
  if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $m = $script:Tray.ContextMenuStrip
    if ($m) { $m.Show([System.Windows.Forms.Cursor]::Position) }
  }
})

function Stop-Tray {
  $script:Timer.Stop()
  [System.Windows.Forms.Application]::Exit()
}

# 服务未就绪时 15s 快速重试，正常后回到 5 分钟
$script:Timer = New-Object System.Windows.Forms.Timer
$script:Timer.Interval = 15000
$script:Timer.Add_Tick({
  if ($script:State.ok) { $script:Timer.Interval = $IntervalSec * 1000 }
  Update-State
})

$script:Timer.Start()
Update-State
[System.Windows.Forms.Application]::Run()

$script:Tray.Visible = $false
$script:Tray.Dispose()
