#!/bin/zsh
# 云端数据同步（v1.7）：本机采集 → 脱敏打包 → rsync 推送到云服务器。密钥零出境（deploy-pack 保证）。
# 可靠性（v1.7.3）：
# - 入口 node 自检（launchd 环境 PATH 不含 Homebrew 曾导致 3 天静默失败，exit 127）
# - trap 统一上报成败到 scripts/sync-state.js：连续 3 轮失败 → 走预警通道推手机 + 站内通知，之后每日重推
# - sync-marker.json 只有本轮 pack+rsync 全部成功才刷新云端时间戳 → 云端陈旧横幅诚实反映断供时长
# 用法: ./scripts/cloud-sync.sh user@server:/srv/ai-quota-config
#        （rsync 目标 = 服务器上的 AI_QUOTA_CONFIG_DIR；先跑一次手动确认，再进 cron/launchd）
# 建议 cron（每 10 分钟，错峰整点）: */10 * * * * cd /path/to/ai-quota-dashboard && ./scripts/cloud-sync.sh … >> /tmp/aqd-sync.log 2>&1
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?用法: cloud-sync.sh user@server:/srv/ai-quota-config}"

# launchd 最小 PATH 兜底：显式补常见 node 安装位置；再找不到就 127 报错（trap 会计数推送）
command -v node >/dev/null 2>&1 || export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v node >/dev/null 2>&1 || { echo "cloud-sync: 找不到 node（需 Node ≥22.13）" >&2; exit 127; }

# 成败统一经 trap 上报；sync-state.js 自身出错绝不级联（|| true）
trap 'rc=$?
  if [ $rc -eq 0 ]; then node "$DIR/scripts/sync-state.js" --ok || true
  else node "$DIR/scripts/sync-state.js" --fail || true; fi' EXIT

set -e
node "$DIR/scripts/deploy-pack.js" "$DIR/dist/cloud-pack"

# -z 压缩：归档数 MB，跨境/透明代理链路下未压缩的批量传输易卡死（实测 8.9MB 挂起，180KB 秒过）
rsync -az --checksum "$DIR/dist/cloud-pack/history.sqlite" "$DIR/dist/cloud-pack/vpn-state.json" "$DEST/"
[ -f "$DIR/dist/cloud-pack/notifications.json" ] && rsync -az --checksum "$DIR/dist/cloud-pack/notifications.json" "$DEST/" || true
# 实时额度展示快照（主端剥 raw 后的百分比/倒计时数据；无密钥无 PII）——云端额度卡回退渲染依赖
[ -f "$DIR/dist/cloud-pack/quota-snapshot.json" ] && rsync -az --checksum "$DIR/dist/cloud-pack/quota-snapshot.json" "$DEST/" || true
# plans.json 每次覆盖：包内是脱敏展示配置（无任何密钥，deploy-pack 机械保证），以主端为准；
# 服务器独有的只有 auth.json（不在包内）
rsync -az --checksum "$DIR/dist/cloud-pack/plans.json" "$DEST/"
# marker 最后推：前面任何一步失败都不会刷新云端「上次成功同步」时刻
rsync -az --checksum "$DIR/dist/cloud-pack/sync-marker.json" "$DEST/"
echo "✓ 已同步到 $DEST（云服务器只读消费，下一快照周期自动生效）"
