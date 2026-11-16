#!/bin/zsh
# 安装/卸载「流量看板」开机自启（macOS LaunchAgent，v1.8.2）
#
# 机制：~/Library/LaunchAgents/site.quota.autostart.plist
#   - RunAtLoad：每次登录（开机）自动执行 start-all.sh —— 服务 + 菜单栏 + 桌面卡片
#   - StartInterval 300：每 5 分钟幂等自检，服务挂了自动拉起（start-all.sh 自带探活，已运行则直接跳过）
#   - EnvironmentVariables PATH：launchd 最小 PATH 不含 Homebrew（cloud-sync 曾因此静默失败 3 天，
#     此处显式补齐，脚本里 node/python/curl 才找得到）
# 为什么不用「系统设置 → 登录项添加 start-all.sh」：macOS 13+ 登录项只执行注册过的 App，
# shell 脚本加进去会被当作文档丢给编辑器，不会运行。
#
# 用法: ./scripts/install-autostart.sh            安装（可重复执行=覆盖更新）
#       ./scripts/install-autostart.sh --uninstall 卸载
#       ./scripts/install-autostart.sh --status    查看装载状态与最近退出码
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL='site.quota.autostart'
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
TARGET="gui/$(id -u)/${LABEL}"

case "${1:-install}" in
  --uninstall)
    launchctl bootout "$TARGET" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✓ 自启已卸载（服务本体不受影响；要停服务用 ./stop-all.sh）"
    exit 0
    ;;
  --status)
    if launchctl print "$TARGET" >/dev/null 2>&1; then
      echo "✓ 已装载：$TARGET"
      launchctl print "$TARGET" | grep -E 'state|last exit code|run interval' | sed 's/^/  /'
      echo "日志：/tmp/ai-quota-autostart.log"
    else
      echo "✗ 未装载（先运行 ./scripts/install-autostart.sh）"
      exit 1
    fi
    exit 0
    ;;
  install) ;;
  *) echo "用法: install-autostart.sh [--uninstall|--status]"; exit 2 ;;
esac

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${REPO}/start-all.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>/tmp/ai-quota-autostart.log</string>
  <key>StandardErrorPath</key><string>/tmp/ai-quota-autostart.log</string>
</dict>
</plist>
EOF

# 重复安装：先卸旧再装新（bootout 对未装载任务报错可忽略）
launchctl bootout "$TARGET" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ 自启已安装：开机登录后自动启动看板；另每 5 分钟自愈（服务挂掉会自动拉起）"
echo "  plist: $PLIST"
echo "  日志:  /tmp/ai-quota-autostart.log"
echo "  验证:  ./scripts/install-autostart.sh --status   （或重启电脑后 1 分钟内打开 http://localhost:7788）"
