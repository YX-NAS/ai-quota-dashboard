#!/bin/zsh
# 生成「AI 额度看板」启动器 .app 并安装到 /Applications
# 产物：/Applications/AI额度看板.app —— 双击 = 启动服务(+菜单栏/桌面卡片，若已编译) + 打开看板网页
# 用法: ./scripts/make-launcher.sh   （可重复执行，覆盖旧版本）
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="AI额度看板"
DIST="${REPO}/dist"
APP="${DIST}/${APP_NAME}.app"

rm -rf "${APP}"
mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources"

# ---------- 启动脚本（.app 的主可执行文件） ----------
# GUI 启动的进程 PATH 只有系统默认值，必须补 Homebrew 路径才能找到 node/python3
cat > "${APP}/Contents/MacOS/launch" <<EOF
#!/bin/zsh
# AI 额度看板 · 应用程序启动器（由 scripts/make-launcher.sh 生成，勿手改）
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
REPO="${REPO}"

# 一键启动：服务（幂等）+ 菜单栏 + 桌面卡片；日志落地便于排查
"\$REPO/start-all.sh" > /tmp/ai-quota-launcher.log 2>&1

# 端口发现契约：服务可能因 7788 被占自动 +1，读 config/.port 拿实际端口
PORT=\$(cat "\$REPO/config/.port" 2>/dev/null || echo 7788)
open "http://localhost:\${PORT}"
EOF
chmod 755 "${APP}/Contents/MacOS/launch"

# ---------- Info.plist：LSUIElement = 纯启动器（不占 Dock、执行完即退） ----------
cat > "${APP}/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>AI 额度看板</string>
  <key>CFBundleDisplayName</key><string>AI 额度看板</string>
  <key>CFBundleIdentifier</key><string>local.ai-quota.launcher</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

# ---------- 图标：复用菜单栏应用的霓虹表盘 icns ----------
cp "${REPO}/menubar/AIQuota.app/Contents/Resources/AppIcon.icns" "${APP}/Contents/Resources/AppIcon.icns"

# ---------- 安装到 /Applications（已存在则覆盖） ----------
if [ -d "/Applications/${APP_NAME}.app" ]; then
  rm -rf "/Applications/${APP_NAME}.app"
fi
cp -R "${APP}" "/Applications/${APP_NAME}.app"
# 让 LaunchPad 立即看到新应用
touch "/Applications/${APP_NAME}.app"

echo "完成：/Applications/${APP_NAME}.app"
echo "双击或 Spotlight 搜「AI 额度看板」即可一键启动；dist/ 里保留了同一份构建产物"
