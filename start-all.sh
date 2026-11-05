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
# 探活统一走 /api/health：该端点不触发快照全量构建，冷启动也能秒回——
# 旧版打 /api/summary 会在冷启动期 2s 超时 → 误判未运行 → 拉起双实例互写 .port
PORT_NOW="$(cat "$DIR/config/.port" 2>/dev/null || echo 7788)"
if curl -s --max-time 2 -o /dev/null "http://127.0.0.1:${PORT_NOW}/api/health"; then
  echo "看板服务已在运行"
else
  echo "启动看板服务..."
  nohup "$NODE" "$DIR/server/index.js" > /tmp/ai-quota-server.log 2>&1 &
  sleep 2
  # 启动后重读 .port：7788 被占时服务会自动后移，探活与提示都必须跟实际端口走
  PORT_NOW="$(cat "$DIR/config/.port" 2>/dev/null || echo "$PORT_NOW")"
  curl -s --max-time 3 -o /dev/null -w "服务状态: HTTP %{http_code}（冷启动约需 30s）\n" "http://127.0.0.1:${PORT_NOW}/api/health"
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
