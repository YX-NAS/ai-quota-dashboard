#!/bin/zsh
# 云端数据同步（v1.7）：本机采集 → 脱敏打包 → rsync 推送到云服务器。密钥零出境（deploy-pack 保证）。
# 用法: ./scripts/cloud-sync.sh user@server:/srv/ai-quota-config
#        （rsync 目标 = 服务器上的 AI_QUOTA_CONFIG_DIR；先跑一次手动确认，再进 cron）
# 建议 cron（每 10 分钟，错峰整点）: */10 * * * * cd /path/to/ai-quota-dashboard && ./scripts/cloud-sync.sh … >> /tmp/aqd-sync.log 2>&1
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?用法: cloud-sync.sh user@server:/path/to/cloud-config-dir}"

node "$DIR/scripts/deploy-pack.js" "$DIR/dist/cloud-pack"

# plans.json 只在首次推送（服务器上可能有独立改动如推送开关，不覆盖）；归档与运行数据常覆盖
rsync -a --checksum "$DIR/dist/cloud-pack/history.sqlite" "$DIR/dist/cloud-pack/vpn-state.json" "$DEST/" 2>/dev/null || true
[ -f "$DIR/dist/cloud-pack/notifications.json" ] && rsync -a --checksum "$DIR/dist/cloud-pack/notifications.json" "$DEST/" || true
if ssh "${DEST%%:*}" "test ! -f ${DEST##*:}/plans.json" 2>/dev/null; then
  rsync -a "$DIR/dist/cloud-pack/plans.json" "$DEST/"
fi
echo "✓ 已同步到 $DEST（云服务器只读消费，下一快照周期自动生效）"
