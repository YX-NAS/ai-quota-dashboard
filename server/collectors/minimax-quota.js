'use strict';
// 套餐实时额度采集：MiniMax Token Plan（5h 窗口 + 周额度）
// 端点: https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains
// key 来源：config/plans.json 的 quotaKeys.minimax.apiKey（设置面板配置，优先），
//           否则从 ~/.workbuddy-ai/models.json 的 MiniMax 自定义模型里取
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const plansStore = require('../lib/plans');

const MODELS_FILE = path.join(os.homedir(), '.workbuddy-ai', 'models.json');

function getMiniMaxKey() {
  try {
    const arr = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    const hit = arr.find(x => (x.vendor || '').toLowerCase().includes('minimax') && x.apiKey);
    return hit ? hit.apiKey : null;
  } catch { return null; }
}

function fetchRemains(apiKey) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.minimaxi.com',
      path: '/v1/api/openplatform/coding_plan/remains',
      method: 'GET',
      timeout: 10_000,
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; if (buf.length > 128 * 1024) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, reason: 'HTTP ' + res.statusCode });
        try {
          const d = JSON.parse(buf);
          if ((d.base_resp && d.base_resp.status_code) === 0) return resolve({ ok: true, data: d });
          resolve({ ok: false, reason: (d.base_resp && d.base_resp.status_msg) || 'bad payload' });
        } catch (e) { resolve({ ok: false, reason: 'bad json' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', e => resolve({ ok: false, reason: e.message }));
    req.end();
  });
}

async function collect() {
  let configured = null;
  try { configured = String(((plansStore.load().quotaKeys || {}).minimax || {}).apiKey || '').trim() || null; } catch { /* 忽略 */ }
  const key = configured || getMiniMaxKey();
  if (!key) return { available: false, reason: '无 MiniMax key（设置面板可配置，或 models.json 自动发现）', source: configured ? 'plans.json quotaKeys.minimax' : MODELS_FILE };

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
