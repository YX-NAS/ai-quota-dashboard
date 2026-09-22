# AI 额度看板 · Windows 桌面小组件（单文件 PowerShell + WinForms/GDI+，零依赖）
# 与 macOS desktop-widget.swift 功能对齐：暗色霓虹小卡片贴桌面，常驻置顶、
# 可拖动（位置自动记住）、可收起、右键菜单（置顶/收起/网页/刷新/退出），每 5 分钟自刷。
# 依赖看板服务 http://127.0.0.1:<Port>（scripts/start-all.ps1 或 node server/index.js）。
# 启动: powershell -NoProfile -ExecutionPolicy Bypass -File desktop\widget.ps1 [-Port 7788]
param(
  [int]$Port = 7788,
  [int]$IntervalSec = 300
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 高 DPI 下字体/坐标不虚（用户态 API，无需清单）
try {
  Add-Type -Namespace AiQuotaWidget -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
  [void][AiQuotaWidget.Native]::SetProcessDPIAware()
} catch { }

$script:Api = "http://127.0.0.1:$Port"
$script:WebUrl = "http://localhost:$Port"
$script:CardW = 262

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
  if ($h -gt 0) { return "${h}h${m}m" }
  return "${m}m"
}
function Get-GoalMessage([double]$pct) {
  if ($pct -lt 1) { return '新的一天，预算就位' }
  elseif ($pct -lt 25) { return '预算充裕，安心干活' }
  elseif ($pct -lt 50) { return '消耗平稳，余量尚多' }
  elseif ($pct -lt 75) { return '已用过半，留意节奏' }
  elseif ($pct -lt 100) { return '预算将尽，要紧的优先' }
  elseif ($pct -lt 150) { return '目标成本已用完' }
  else { return '已大幅超出目标成本' }
}
function Get-Color([int]$r, [int]$g, [int]$b) { [System.Drawing.Color]::FromArgb($r, $g, $b) }
function Get-BarColor([int]$pct) {
  if ($pct -gt 85) { return (Get-Color 244 67 54) }
  elseif ($pct -gt 60) { return (Get-Color 255 193 7) }
  return (Get-Color 76 175 80)
}
function Lighten([System.Drawing.Color]$c, [double]$f) {
  $r = [int][math]::Min(255, [math]::Round($c.R + (255 - $c.R) * $f))
  $g = [int][math]::Min(255, [math]::Round($c.G + (255 - $c.G) * $f))
  $b = [int][math]::Min(255, [math]::Round($c.B + (255 - $c.B) * $f))
  return [System.Drawing.Color]::FromArgb($r, $g, $b)
}

# ---------- 状态（对齐 macOS WidgetData） ----------
$script:W = @{
  ok = $false
  req = 0; tok = [long]0; cny = 0.0; payUsd = 0.0
  weekCny = 0.0; goalCny = 0.0; goalPct = 0.0
  quotas = @()            # @{ short; provider; u5; r5; u7; r7 }
  fetchedAt = $null
  collapsed = $false
}

$script:StateDir = Join-Path $env:LOCALAPPDATA 'ai-quota-dashboard'
$script:StateFile = Join-Path $script:StateDir 'widget-state.json'
function Save-WidgetState {
  try {
    New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null
    @{ x = $script:Form.Left; y = $script:Form.Top; top = [bool]$script:Form.TopMost; col = [bool]$script:W.collapsed } |
      ConvertTo-Json | Set-Content -Path $script:StateFile -Encoding UTF8
  } catch { }
}

# ---------- 数据刷新 ----------
function Update-Data {
  $s = $null
  try { $s = Invoke-RestMethod -Uri "$script:Api/api/summary?days=8" -TimeoutSec 6 } catch { }

  if (-not $s -or -not $s.agg) {
    $script:W.ok = $false
    Build-Layout
    return
  }

  $today = Get-BjToday
  $day = $s.agg.daily.$today            # 今天没有用量时为 $null，不算错误
  [int]$req = 0; [long]$tok = 0; [double]$cny = 0.0; [double]$pay = 0.0
  if ($day) {
    $tot = $day.'__total'
    if ($tot) {
      $req = [int]$tot.requests
      $tok = [long]$tot.inputTokens + [long]$tot.outputTokens
      $cny = [double]$tot.costCny + [double]$tot.equivalentCny
    }
    foreach ($p in $day.PSObject.Properties) {
      if ($p.Name -eq '__total') { continue }
      $pay += [double]$p.Value.payUsd
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
  $shorts = @{ chatgptQuota = 'ChatGPT'; minimaxQuota = 'MiniMax'; zhipuQuota = '智谱' }
  foreach ($key in 'chatgptQuota', 'minimaxQuota', 'zhipuQuota') {
    $q = $s.$key
    if ($null -eq $q -or -not $q.available) { continue }
    $qs += @{
      short = $shorts[$key]; provider = [string]$q.provider
      u5 = $q.fiveHour.usedPercent; r5 = $q.fiveHour.resetMsLeft
      u7 = $q.weekly.usedPercent;  r7 = $q.weekly.resetMsLeft
    }
  }

  $script:W.ok = $true
  $script:W.req = $req; $script:W.tok = $tok; $script:W.cny = $cny; $script:W.payUsd = $pay
  $script:W.weekCny = $wk
  $script:W.quotas = $qs
  $script:W.fetchedAt = Get-Date
  $script:W.goalCny = [double]$s.plans.dailyGoal.cny
  $script:W.goalPct = 0.0
  if ($script:W.goalCny -gt 0) {
    $script:W.goalPct = [math]::Min($cny / $script:W.goalCny * 100.0, 999.0)
  }

  Build-Layout
}

# ---------- 布局（生成绘制指令表 + 计算卡片高度） ----------
$script:Ops = @()      # @{ t='text';x;y;w;h;s;fam;size;style;c;align;grad } / @{ t='bar';x;y;w;h;pct;c }
$script:Btns = @()     # @{ id;x;y }
$script:FontCache = @{}
function Get-Font([string]$fam, [float]$size, [string]$style) {
  $key = "$fam|$size|$style"
  if (-not $script:FontCache.ContainsKey($key)) {
    $fs = [System.Drawing.FontStyle]::Regular
    if ($style -eq 'b') { $fs = [System.Drawing.FontStyle]::Bold }
    try { $script:FontCache[$key] = New-Object System.Drawing.Font($fam, $size, $fs, [System.Drawing.GraphicsUnit]::Point) }
    catch { $script:FontCache[$key] = New-Object System.Drawing.Font('Segoe UI', $size, $fs, [System.Drawing.GraphicsUnit]::Point) }
  }
  return $script:FontCache[$key]
}

$script:C2 = Get-Color 158 162 178     # secondary
$script:C3 = Get-Color 122 126 142     # tertiary
$script:CWhite = Get-Color 235 238 245
$script:CGreen = Get-Color 76 175 80
$script:COrange = Get-Color 255 152 0

function Add-Text([float]$x, [float]$y, [float]$w, [string]$s, [string]$fam, [float]$size, [string]$style, $c, [string]$align, [bool]$grad) {
  $script:Ops += @{ t = 'text'; x = $x; y = $y; w = $w; s = $s; fam = $fam; size = $size; style = $style; c = $c; align = $align; grad = $grad }
}
function Add-Bar([float]$x, [float]$y, [float]$w, [float]$h, [int]$pct, $c) {
  $script:Ops += @{ t = 'bar'; x = $x; y = $y; w = $w; h = $h; pct = $pct; c = $c }
}

function Build-Layout {
  $pad = 14.0
  $cw = [float]($script:CardW - 2 * $pad)
  $script:Ops = @()

  # 头部：标题 + 更新时间 + 三个圆形按钮（刷新 / 收起 / 关闭）
  Add-Text $pad 10.0 120.0 '今日 AI 用量' 'Segoe UI' 9.0 'r' $script:C2 'l' $false
  if ($script:W.fetchedAt) {
    Add-Text $pad 11.0 ($cw - 70.0) ($script:W.fetchedAt.ToString('HH:mm')) 'Segoe UI' 8.0 'r' $script:C3 'r' $false
  }
  $script:Btns = @(
    @{ id = 'close';    x = $script:CardW - $pad - 18; y = 8 },
    @{ id = 'collapse'; x = $script:CardW - $pad - 40; y = 8 },
    @{ id = 'refresh';  x = $script:CardW - $pad - 62; y = 8 }
  )

  if (-not $script:W.ok) {
    Add-Text $pad 60.0 $cw '看板服务未响应' 'Segoe UI' 10.5 'r' $script:C2 'c' $false
    Add-Text $pad 80.0 $cw '启动: node server/index.js' 'Segoe UI' 9.0 'r' $script:C3 'c' $false
    Set-CardHeight 110
    return
  }

  $amount = Format-Cny $script:W.cny
  $suffix = '全部在套餐内'
  $suffixColor = $script:CGreen
  if ($script:W.payUsd -gt 0.005) { $suffix = '实扣 ${0:N2}' -f $script:W.payUsd; $suffixColor = $script:C2 }

  if ($script:W.collapsed) {
    # 折叠态：费用 + 次数 + 各套餐 5h 一行 + 目标一行
    Add-Text $pad 32.0 ($cw - 92.0) $amount 'Segoe UI Semibold' 13.0 'r' $null 'l' $true
    Add-Text $pad 38.0 $cw $suffix 'Segoe UI' 8.0 'r' $suffixColor 'r' $false
    Add-Text $pad 56.0 $cw ('{0} 次 · {1} tokens' -f $script:W.req, (Format-Tok $script:W.tok)) 'Segoe UI' 8.5 'r' $script:C2 'l' $false
    $y = 74.0
    if ($script:W.quotas.Count -gt 0) {
      $line = '5h  '
      $tight = 0
      foreach ($q in $script:W.quotas) {
        $u = '—'; if ($null -ne $q.u5) { $u = "$([int]$q.u5)%"; if ([int]$q.u5 -gt $tight) { $tight = [int]$q.u5 } }
        $line += ('{0} {1} · ' -f $q.short, $u)
      }
      $line = $line.TrimEnd(' ', '·')
      Add-Text $pad $y $cw $line 'Segoe UI' 8.5 'r' (Get-BarColor $tight) 'l' $false
      $y += 16.0
    }
    if ($script:W.goalCny -gt 0) {
      Add-Text $pad $y $cw ('目标 {0:N0}%   ¥{1:N0}/¥{2:N0}' -f $script:W.goalPct, $script:W.cny, $script:W.goalCny) 'Segoe UI' 8.5 'r' $(if ($script:W.goalPct -ge 75) { $script:COrange } else { $script:CGreen }) 'l' $false
      $y += 16.0
    }
    Set-CardHeight ([int]($y + $pad))
    return
  }

  # 展开态
  Add-Text $pad 34.0 $cw $amount 'Segoe UI Semibold' 20.0 'r' $null 'l' $true
  Add-Text $pad 54.0 $cw $suffix 'Segoe UI' 8.5 'r' $suffixColor 'r' $false
  $y = 74.0
  Add-Text $pad $y $cw ('{0} 次 · {1} tokens' -f $script:W.req, (Format-Tok $script:W.tok)) 'Segoe UI' 9.0 'r' $script:C2 'l' $false
  $y += 17.0
  Add-Text $pad $y $cw ('本周累计 {0}（周一起）' -f (Format-Cny $script:W.weekCny)) 'Segoe UI' 8.5 'r' $script:C3 'l' $false
  $y += 18.0

  foreach ($q in $script:W.quotas) {
    Add-Text $pad $y $cw $q.short 'Segoe UI' 9.0 'b' $script:C2 'l' $false
    $y += 14.0
    foreach ($pair in @(@('5h', $q.u5, $q.r5), @('周', $q.u7, $q.r7))) {
      $label = $pair[0]; $u = $pair[1]; $r = $pair[2]
      $val = '—'
      $vc = $script:C3
      if ($null -ne $u) {
        $val = '{0}%{1}' -f [int]$u, $(if ($r) { ' · ' + (Format-Reset $r) } else { '' })
        $vc = $script:C2
        if ([int]$u -gt 85) { $vc = (Get-Color 244 67 54) }
      }
      Add-Text $pad ($y + 1.0) $cw $label 'Segoe UI' 8.0 'r' $script:C3 'l' $false
      Add-Text $pad ($y + 1.0) $cw $val 'Segoe UI' 8.0 'r' $vc 'r' $false
      $barC = Get-BarColor 0
      $barPct = 0
      if ($null -ne $u) { $barPct = [int]$u; $barC = Get-BarColor $barPct }
      Add-Bar $pad ($y + 13.0) $cw 4.0 $barPct $barC
      $y += 20.0
    }
    $y += 4.0
  }

  if ($script:W.goalCny -gt 0) {
    $y += 4.0
    Add-Text $pad $y $cw '当日目标成本' 'Segoe UI' 9.0 'b' $script:C2 'l' $false
    $pctColor = $script:COrange
    if ($script:W.goalPct -ge 100) { $pctColor = (Get-Color 244 67 54) }
    elseif ($script:W.goalPct -lt 75) { $pctColor = $script:CGreen }
    Add-Text $pad $y $cw ('{0:N0}%' -f [math]::Min($script:W.goalPct, 999)) 'Segoe UI' 9.0 'r' $pctColor 'r' $false
    $y += 15.0
    $goalBarColor = $script:CGreen
    if ($script:W.goalPct -ge 100) { $goalBarColor = (Get-Color 244 67 54) }
    elseif ($script:W.goalPct -ge 75) { $goalBarColor = (Get-Color 255 152 0) }
    Add-Bar $pad $y $cw 6.0 ([int][math]::Min($script:W.goalPct, 100)) $goalBarColor
    $y += 10.0
    Add-Text $pad $y $cw (Get-GoalMessage $script:W.goalPct) 'Segoe UI' 8.0 'r' $script:C3 'l' $false
    $y += 14.0
  }

  Set-CardHeight ([int]($y + $pad))
}

function Set-CardHeight([int]$h) {
  if ($h -lt 80) { $h = 80 }
  if ($script:Form.Height -ne $h) { $script:Form.Height = $h }
  try {
    $gp = New-RoundRect 0.0 0.0 ([float]$script:CardW) ([float]$h) 16.0
    $script:Form.Region = New-Object System.Drawing.Region($gp)
    $gp.Dispose()
  } catch { }
  $script:Form.Invalidate()
}

# ---------- GDI 绘制 ----------
function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  if ($r -lt 0.0) { $r = 0.0 }
  $d = 2.0 * $r
  $gp.AddArc($x, $y, $d, $d, 180, 90)
  $gp.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
  $gp.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
  $gp.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
  $gp.CloseFigure()
  return $gp
}

$script:Sf = New-Object System.Drawing.StringFormat
function Draw-Paint($g) {
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

  foreach ($op in $script:Ops) {
    if ($op.t -eq 'text') {
      $font = Get-Font $op.fam $op.size $op.style
      if ($op.align -eq 'r') { $script:Sf.Alignment = [System.Drawing.StringAlignment]::Far }
      elseif ($op.align -eq 'c') { $script:Sf.Alignment = [System.Drawing.StringAlignment]::Center }
      else { $script:Sf.Alignment = [System.Drawing.StringAlignment]::Near }
      $rect = New-Object System.Drawing.RectangleF($op.x, $op.y, $op.w, 200.0)
      if ($op.grad) {
        # 金额主数：火焰渐变（与网页横幅/桌面卡片同款渐变语言）
        $sz = $g.MeasureString($op.s, $font)
        $gr = New-Object System.Drawing.RectangleF($op.x, $op.y, ($sz.Width + 2.0), ($sz.Height + 2.0))
        $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($gr, [System.Drawing.Color]::Black, [System.Drawing.Color]::Black, 0.0)
        $blend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
        $blend.Colors = [System.Drawing.Color]::FromArgb(255, 199, 64), [System.Drawing.Color]::FromArgb(255, 115, 107), [System.Drawing.Color]::FromArgb(232, 120, 250)
        $blend.Positions = [single[]](0.0, 0.5, 1.0)
        $brush.InterpolationColors = $blend
        $g.DrawString($op.s, $font, $brush, (New-Object System.Drawing.PointF($op.x, $op.y)))
        $brush.Dispose()
      } else {
        $brush = New-Object System.Drawing.SolidBrush($op.c)
        $g.DrawString($op.s, $font, $brush, $rect, $script:Sf)
        $brush.Dispose()
      }
    } elseif ($op.t -eq 'bar') {
      # 底槽
      $bg = New-RoundRect $op.x $op.y $op.w $op.h ($op.h / 2.0)
      $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(22, 255, 255, 255))
      $g.FillPath($bgBrush, $bg)
      $bgBrush.Dispose(); $bg.Dispose()
      if ($op.pct -gt 0) {
        $fw = [math]::Min($op.pct, 100) / 100.0 * $op.w
        if ($fw -lt 3.0) { $fw = 3.0 }
        # 光晕（更宽的半透明层）+ 主体（亮色→纯色纵向渐变）
        $glow = New-RoundRect ($op.x - 1.0) ($op.y - 1.5) ($fw + 2.0) ($op.h + 3.0) (($op.h + 3.0) / 2.0)
        $glowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(60, $op.c))
        $g.FillPath($glowBrush, $glow)
        $glowBrush.Dispose(); $glow.Dispose()
        $body = New-RoundRect $op.x $op.y $fw $op.h ($op.h / 2.0)
        $mainBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
          (New-Object System.Drawing.Rectangle([int]$op.x, [int]$op.y, [int][math]::Ceiling($fw), [int][math]::Ceiling($op.h))),
          (Lighten $op.c 0.45), $op.c, 90.0)
        $g.FillPath($mainBrush, $body)
        $mainBrush.Dispose(); $body.Dispose()
      }
    }
  }

  # 三个圆形按钮：刷新（圆弧箭头）/ 收起（chevron）/ 关闭（X）
  $circleBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(24, 255, 255, 255))
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(215, 235, 238, 245), 1.4)
  foreach ($b in $script:Btns) {
    $g.FillEllipse($circleBrush, $b.x, $b.y, 18, 18)
    if ($b.id -eq 'refresh') {
      $cx = $b.x + 9; $cy = $b.y + 9
      $g.DrawArc($pen, ($b.x + 4.0), ($b.y + 4.0), 10.0, 10.0, -60.0, 300.0)
      $pts = New-Object System.Drawing.PointF[] 3
      $pts[0] = New-Object System.Drawing.PointF(($cx - 1.0), ($cy - 7.2))
      $pts[1] = New-Object System.Drawing.PointF(($cx + 2.6), ($cy - 4.6))
      $pts[2] = New-Object System.Drawing.PointF(($cx - 1.6), ($cy - 2.6))
      $g.DrawLines($pen, $pts)
    } elseif ($b.id -eq 'collapse') {
      if ($script:W.collapsed) {
        $g.DrawLine($pen, ($b.x + 5.0), ($b.y + 7.0), ($b.x + 9.0), ($b.y + 11.0))
        $g.DrawLine($pen, ($b.x + 9.0), ($b.y + 11.0), ($b.x + 13.0), ($b.y + 7.0))
      } else {
        $g.DrawLine($pen, ($b.x + 5.0), ($b.y + 11.0), ($b.x + 9.0), ($b.y + 7.0))
        $g.DrawLine($pen, ($b.x + 9.0), ($b.y + 7.0), ($b.x + 13.0), ($b.y + 11.0))
      }
    } elseif ($b.id -eq 'close') {
      $g.DrawLine($pen, ($b.x + 6.0), ($b.y + 6.0), ($b.x + 12.0), ($b.y + 12.0))
      $g.DrawLine($pen, ($b.x + 12.0), ($b.y + 6.0), ($b.x + 6.0), ($b.y + 12.0))
    }
  }
  $pen.Dispose(); $circleBrush.Dispose()

  # 霓虹渐变描边（青→紫→粉，与 macOS 卡片同款色环的低配实现）
  $h = [float]$script:Form.Height
  $borderPath = New-RoundRect 0.5 0.5 ([float]($script:CardW - 1)) ($h - 1.0) 15.5
  $borderBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Rectangle(0, 0, $script:CardW, [int][math]::Ceiling($h))),
    (Get-Color 46 214 245), (Get-Color 232 120 250), 25.0)
  $borderPen = New-Object System.Drawing.Pen($borderBrush, 1.2)
  $g.DrawPath($borderPen, $borderPath)
  $borderPen.Dispose(); $borderBrush.Dispose(); $borderPath.Dispose()
}

# ---------- 窗口 ----------
$script:Form = New-Object System.Windows.Forms.Form
$script:Form.Text = 'AIQuotaWidget'
$script:Form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$script:Form.BackColor = Get-Color 23 23 31
$script:Form.ShowInTaskbar = $false
$script:Form.TopMost = $true
$script:Form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$script:Form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$script:Form.Size = New-Object System.Drawing.Size($script:CardW, 160)

# 默认位置：主屏右上；有记忆位置则校验后恢复
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$initX = $wa.Right - $script:CardW - 24
$initY = $wa.Top + 60
try {
  if (Test-Path $script:StateFile) {
    $saved = Get-Content $script:StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $sx = [int]$saved.x; $sy = [int]$saved.y
    if ($sx -ge $wa.Left -and $sx -lt ($wa.Right - 60) -and $sy -ge $wa.Top -and $sy -lt ($wa.Bottom - 40)) { $initX = $sx; $initY = $sy }
    if ($saved.col) { $script:W.collapsed = $true }
    if ($saved.top -eq $false) { $script:Form.TopMost = $false }
  }
} catch { }
$script:Form.Location = New-Object System.Drawing.Point($initX, $initY)

# 双缓冲，避免自绘闪烁
try {
  $pi = $script:Form.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic')
  $pi.SetValue($script:Form, $true, $null)
} catch { }

$script:Form.Add_Paint({ param($sender, $e) Draw-Paint $e.Graphics })

# 拖动 + 按钮（按下命中按钮则不拖动；位移 <6px 视为点击）
$script:Drag = @{ on = $false; dx = 0; dy = 0; moved = 0.0 }
$script:Pressed = $null
$script:Form.Add_MouseDown({
  param($sender, $e)
  if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  foreach ($b in $script:Btns) {
    if ($e.X -ge ($b.x - 3) -and $e.X -le ($b.x + 21) -and $e.Y -ge ($b.y - 3) -and $e.Y -le ($b.y + 21)) {
      $script:Pressed = $b.id; return
    }
  }
  $script:Pressed = $null
  $script:Drag.on = $true; $script:Drag.dx = $e.X; $script:Drag.dy = $e.Y; $script:Drag.moved = 0.0
})
$script:Form.Add_MouseMove({
  param($sender, $e)
  if (-not $script:Drag.on) { return }
  $dx = $e.X - $script:Drag.dx; $dy = $e.Y - $script:Drag.dy
  if ($dx -eq 0 -and $dy -eq 0) { return }
  $script:Drag.moved += [math]::Abs($dx) + [math]::Abs($dy)
  $sender.Left += $dx; $sender.Top += $dy
})
$script:Form.Add_MouseUp({
  param($sender, $e)
  if ($script:Drag.on) {
    $script:Drag.on = $false
    if ($script:Drag.moved -gt 6.0) { Save-WidgetState; return }
  }
  if ($script:Pressed) {
    $id = $script:Pressed; $script:Pressed = $null
    switch ($id) {
      'refresh' { Update-Data }
      'collapse' {
        $script:W.collapsed = -not $script:W.collapsed
        Save-WidgetState
        Build-Layout
      }
      'close' { $sender.Close() }
    }
  }
})

# 右键菜单
$ctx = New-Object System.Windows.Forms.ContextMenuStrip
function New-Mi([string]$text, $handler) {
  $mi = New-Object System.Windows.Forms.ToolStripMenuItem
  $mi.Text = $text
  $mi.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  if ($handler) { $mi.Add_Click($handler) }
  return $mi
}
[void]$ctx.Items.Add((New-Mi '切换置顶/普通' { $script:Form.TopMost = -not $script:Form.TopMost; Save-WidgetState }))
[void]$ctx.Items.Add((New-Mi '收起/展开卡片' { $script:W.collapsed = -not $script:W.collapsed; Save-WidgetState; Build-Layout }))
[void]$ctx.Items.Add((New-Mi '打开看板网页' { Start-Process $script:WebUrl }))
[void]$ctx.Items.Add((New-Mi '立即刷新' { Update-Data }))
[void]$ctx.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$ctx.Items.Add((New-Mi '退出' { $script:Form.Close() }))
$script:Form.ContextMenuStrip = $ctx

$script:Form.Add_FormClosed({ param($sender, $e) Save-WidgetState; $script:Timer.Stop() })

# 服务未就绪时 15s 快速重试，正常后回到 5 分钟
$script:Timer = New-Object System.Windows.Forms.Timer
$script:Timer.Interval = 15000
$script:Timer.Add_Tick({
  if ($script:W.ok) { $script:Timer.Interval = $IntervalSec * 1000 }
  Update-Data
})

$script:Timer.Start()
Update-Data
[System.Windows.Forms.Application]::Run($script:Form)
