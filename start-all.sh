#!/bin/zsh
# AI 额度看板一键启动：服务 + 菜单栏 + 桌面卡片（macOS）
# 用法: ./start-all.sh   （可重复执行，已启动的不会重复拉起）

DIR="$(cd "$(dirname "$0")" && pwd)"

# Node 检测：PATH 里的 node 优先，要求 >= 22（内置 node:sqlite）
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "未找到 node，请安装 Node.js 22+（https://nodejs.org）"
  exit 1
fi

# 1) 同步 ChatGPT token 快照（codex 会定期刷新 auth.json，启动时同步一次保证额度可用）
if [ -f "$HOME/.codex/auth.json" ]; then
  python3 "$DIR/scripts/sync-chatgpt-token.py" 2>/dev/null || echo "token 同步跳过（auth.json 不可读，沿用快照）"
fi

# 2) 看板服务（HTTP 探活判断，比 pgrep 可靠：进程僵死/退出中也算未运行）
# 探活统一走 /api/health 且校验响应指纹 {"ok":true,…}：该端点不触发快照全量构建，冷启动也能秒回。
# v1.8.3 双实例根因修复——旧版只信 config/.port 单端口：.port 一旦漂移（旧实例仍占默认端口、
# 新实例顺延端口写文件），探活就看不见那个活着的旧实例 → 再拉一个 → 双实例互写状态。
# 现在 .port 探不到时扫描默认端口段（7788~7807，服务自身的候选区间），发现带指纹的活实例
# 就复用并把 .port 纠正过去，绝不重复拉起。
probe_alive() { curl -s --max-time 2 "http://127.0.0.1:${1}/api/health" 2>/dev/null | grep -q '"ok":true'; }
PORT_NOW="$(cat "$DIR/config/.port" 2>/dev/null || echo 7788)"
if probe_alive "$PORT_NOW"; then
  echo "看板服务已在运行（:${PORT_NOW}）"
else
  FOUND=""
  for p in $(seq 7788 7807); do
    [ "$p" = "$PORT_NOW" ] && continue
    if probe_alive "$p"; then FOUND=$p; break; fi
  done
  if [ -n "$FOUND" ]; then
    echo "$FOUND" > "$DIR/config/.port"
    echo "检测到运行中的服务实例 :${FOUND}（.port 原指向 ${PORT_NOW} 已纠正）"
    PORT_NOW="$FOUND"
  else
    echo "启动看板服务..."
    # v1.8.3：服务进程必须脱离启动它的进程组——从 launchd autostart job 里跑本脚本时，
    # nohup 子进程仍在 job 进程组内，launchctl kickstart -k / bootout 会连服务一起 SIGKILL
    # （实测演练踩中）。用 perl POSIX::setsid 让服务成为独立会话首领（macOS 无 setsid 命令），
    # perl 不可用时退回 nohup（手动 shell 启动场景本就无此风险）。
    if command -v perl >/dev/null 2>&1; then
      perl -MPOSIX -e 'POSIX::setsid(); open(STDIN,"<","/dev/null") or die; open(STDOUT,">>","/tmp/ai-quota-server.log") or die; open(STDERR,">&STDOUT"); exec @ARGV or POSIX::_exit(127);' -- "$NODE" "$DIR/server/index.js" &
    else
      nohup "$NODE" "$DIR/server/index.js" > /tmp/ai-quota-server.log 2>&1 &
    fi
    sleep 2
    # 启动后重读 .port：7788 被占时服务会自动后移，探活与提示都必须跟实际端口走
    PORT_NOW="$(cat "$DIR/config/.port" 2>/dev/null || echo "$PORT_NOW")"
    if probe_alive "$PORT_NOW"; then
      echo "服务状态: 已启动（:${PORT_NOW}，冷启动构建约需 30s）"
    else
      echo "服务状态: 启动异常，查看 /tmp/ai-quota-server.log"
    fi
  fi
fi

# 3) 菜单栏应用（可选，仅 macOS 且已编译）
if [ -d "$DIR/menubar/AIQuota.app" ]; then
  if ! pgrep -x AIQuota > /dev/null; then
    echo "启动菜单栏应用..."
    open "$DIR/menubar/AIQuota.app"
  else
    echo "菜单栏应用已在运行"
  fi
fi

# 4) 桌面卡片（可选，仅 macOS 且已编译）
if [ -d "$DIR/desktop/AIQuotaWidget.app" ]; then
  if ! pgrep -x AIQuotaWidget > /dev/null; then
    echo "启动桌面卡片..."
    open "$DIR/desktop/AIQuotaWidget.app"
  else
    echo "桌面卡片已在运行"
  fi
fi

echo "完成。网页端: http://localhost:${PORT_NOW}"
