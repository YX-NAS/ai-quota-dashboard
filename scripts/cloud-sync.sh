#!/bin/zsh
# 云端数据同步（v1.7）：本机采集 → 脱敏打包 → rsync 推送到云服务器。密钥零出境（deploy-pack 保证）。
# 用法: ./scripts/cloud-sync.sh user@server:/srv/ai-quota-config
#        （rsync 目标 = 服务器上的 AI_QUOTA_CONFIG_DIR；先跑一次手动确认，再进 cron）
# 建议 cron（每 10 分钟，错峰整点）: */10 * * * * cd /path/to/ai-quota-dashboard && ./scripts/cloud-sync.sh … >> /tmp/aqd-sync.log 2>&1
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?用法: cloud-sync.sh user@server:/path/to/cloud-config-dir}"

node "$DIR/scripts/deploy-pack.js" "$DIR/dist/cloud-pack"

# -z 压缩：归档数 MB，跨境/透明代理链路下未压缩的批量传输易卡死（实测 8.9MB 挂起，180KB 秒过）
rsync -az --checksum "$DIR/dist/cloud-pack/history.sqlite" "$DIR/dist/cloud-pack/vpn-state.json" "$DEST/"
[ -f "$DIR/dist/cloud-pack/notifications.json" ] && rsync -az --checksum "$DIR/dist/cloud-pack/notifications.json" "$DEST/" || true
# plans.json 每次覆盖：包内是脱敏展示配置（无任何密钥，deploy-pack 机械保证），以主端为准；
# 服务器独有的只有 auth.json（不在包内）。旧「首次判断」会被服务自生成的模板挡掉，已废弃
rsync -az --checksum "$DIR/dist/cloud-pack/plans.json" "$DEST/"
echo "✓ 已同步到 $DEST（云服务器只读消费，下一快照周期自动生效）"
