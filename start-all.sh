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

# 2) 看板服务
if ! pgrep -f "server/index.js" > /dev/null; then
  echo "启动看板服务..."
  nohup "$NODE" "$DIR/server/index.js" > /tmp/ai-quota-server.log 2>&1 &
  sleep 2
  curl -s --max-time 3 -o /dev/null -w "服务状态: HTTP %{http_code}（冷启动约需 30s）\n" http://127.0.0.1:7788/
else
  echo "看板服务已在运行"
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

echo "完成。网页端: http://localhost:7788"
