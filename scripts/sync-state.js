#!/usr/bin/env node
'use strict';
// 云同步失败监测状态机（v1.7.3）：cloud-sync.sh 的成败经 trap 汇入这里。
// 连续失败 3 轮 → 走主端已配置的预警通道（alerts.send）推手机 + 站内通知；此后每 24h 重推一次直到恢复。
// 成功一轮即清零。通道未配置时至少站内通知与日志留痕；本脚本自身任何异常都 exit 0——
// 监测器绝不能把同步脚本拖崩（观测层故障不扩散到数据层）。
const fs = require('node:fs');
const path = require('node:path');
const notify = require('../server/lib/notify');

const FAILS_TO_ALERT = 3;
const RETALERT_MS = 24 * 3600e3;
const STATE_FILE = () => path.join(require('../server/lib/plans').CONFIG_DIR, 'sync-state.json');

// 纯函数（导出供测试）：{fails, lastOkAt, lastFailAt, lastAlertAt} → 下一状态 + 是否该推预警
function updateState(state, ok, now = Date.now()) {
  const s = state || {};
  if (ok) return { next: { fails: 0, lastOkAt: now, lastFailAt: s.lastFailAt ?? null, lastAlertAt: s.lastAlertAt ?? null }, shouldAlert: false };
  const fails = (s.fails || 0) + 1;
  const shouldAlert = fails === FAILS_TO_ALERT || (fails > FAILS_TO_ALERT && now - (s.lastAlertAt || 0) > RETALERT_MS);
  return {
    next: {
      fails,
      lastOkAt: s.lastOkAt ?? null,
      lastFailAt: now,
      lastAlertAt: shouldAlert ? now : (s.lastAlertAt ?? null),
    },
    shouldAlert,
  };
}

async function main() {
  const ok = process.argv.includes('--ok');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { /* 首轮/损坏按空状态 */ }
  const { next, shouldAlert } = updateState(state, ok);
  try {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    const tmp = STATE_FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, STATE_FILE());
  } catch { /* 状态写不进（网盘抖动）：计数下轮自然重来，不抛 */ }

  if (!shouldAlert) { if (!ok) console.log(`云同步失败（连续 ${next.fails} 轮，未达预警阈值 ${FAILS_TO_ALERT}）`); return; }

  const title = `☁️ 云同步已连续失败 ${next.fails} 轮`;
  const since = next.lastOkAt ? new Date(next.lastOkAt).toLocaleString('zh-CN') : '从未成功';
  const message = `最近成功同步：${since}。云端 quota 站点数据正在陈旧（页面会显示陈旧横幅）。请检查主端 launchd/cron 是否在跑、网络与服务器可达性；日志见 /tmp/aqd-sync.log`;
  notify.add({ type: 'sync', title, body: message }); // 主端站内铃铛
  try {
    const alerts = require('../server/lib/alerts');
    const cfg = require('../server/lib/plans').load().alerts || {};
    if (cfg.enabled && cfg.webhookUrl) {
      await alerts.send(cfg.webhookType || 'ntfy', { title, message, severity: 'warning', webhookUrl: cfg.webhookUrl });
      console.log('已推送云同步失败预警');
    } else {
      console.log('预警通道未启用/未配置：仅站内通知留痕');
    }
  } catch (e) { console.log('预警推送失败（不影响计数状态）:', e.message); }
}

if (require.main === module) main().catch(() => { /* 观测层永不炸 */ });
module.exports = { updateState, FAILS_TO_ALERT, RETALERT_MS };
