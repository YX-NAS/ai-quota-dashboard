'use strict';
// 套餐实时额度采集：MiniMax Token Plan（5h 窗口 + 周额度）
// 端点: https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains
// key 来源：config/plans.json 的 quotaKeys.minimax.apiKey（设置面板配置，优先），
//           否则从 ~/.workbuddy-ai/models.json 的 MiniMax 自定义模型里取
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getJson } = require('../lib/http-json');
const plansStore = require('../lib/plans');

const MODELS_FILE = path.join(os.homedir(), '.workbuddy-ai', 'models.json');

function getMiniMaxKey() {
  try {
    const arr = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    const hit = arr.find(x => (x.vendor || '').toLowerCase().includes('minimax') && x.apiKey);
    return hit ? hit.apiKey : null;
  } catch { return null; }
}

// HTTP 实现移到 server/lib/http-json.js 的 getJson（[P1] 体超限先 resolve 再 destroy 修悬挂；
// 非 200 reason 带脱敏后的响应体片段）。对外契约不变：{ ok, data?, reason? }；
// base_resp.status_code 业务校验保留在本层（原实现里与 HTTP 层合一，语义等价）。
async function fetchRemains(apiKey) {
  const r = await getJson('https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains', {
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    timeoutMs: 10_000,
    maxBytes: 128 * 1024, // 本端点响应很小，保留原实现的 128KB 上限（其余端点默认 256KB）
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  const d = r.data;
  if ((d && d.base_resp && d.base_resp.status_code) === 0) return { ok: true, data: d };
  return { ok: false, reason: (d && d.base_resp && d.base_resp.status_msg) || 'bad payload' };
}

async function collect() {
  let configured = null;
  try { configured = String(((plansStore.load().quotaKeys || {}).minimax || {}).apiKey || '').trim() || null; } catch { /* 忽略 */ }
  const key = configured || getMiniMaxKey();
  if (!key) return { available: false, notConfigured: true, reason: '未找到 MiniMax key（设置面板可配置，或 models.json 自动发现）', source: configured ? 'plans.json quotaKeys.minimax' : MODELS_FILE };

  const r = await fetchRemains(key);
  if (!r.ok) return { available: false, reason: r.reason, source: 'minimaxi.com coding_plan/remains' };

  // general 通道 = 文本模型的 5h/周额度
  const gen = (r.data.model_remains || []).find(x => x.model_name === 'general')
    || (r.data.model_remains || [])[0];
  if (!gen) return { available: false, reason: '无 model_remains', source: 'minimaxi.com' };

  return {
    available: true,
    provider: 'MiniMax Token Plan MAX',
    fiveHour: {
      usedPercent: gen.current_interval_remaining_percent != null
        ? 100 - gen.current_interval_remaining_percent : null,
      remainingPercent: gen.current_interval_remaining_percent ?? null,
      windowStart: gen.start_time, windowEnd: gen.end_time,
      resetMsLeft: gen.remains_time,
    },
    weekly: {
      usedPercent: gen.current_weekly_remaining_percent != null
        ? 100 - gen.current_weekly_remaining_percent : null,
      remainingPercent: gen.current_weekly_remaining_percent ?? null,
      resetMsLeft: gen.weekly_remains_time,
    },
    raw: gen,
    fetchedAt: Date.now(),
    source: 'minimaxi.com/v1/api/openplatform/coding_plan/remains',
  };
}

module.exports = { collect };
