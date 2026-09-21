#!/bin/zsh
# 启动 AI 用量菜单栏插件（若未运行）
if ! pgrep -x AIQuota >/dev/null; then
  open "$(dirname "$0")/AIQuota.app"
  echo "AIQuota 已启动"
else
  echo "AIQuota 已在运行"
fi
