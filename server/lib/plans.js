'use strict';
// plans.json 读写：用户配置的额度 / 汇率 / 单价覆盖
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const PLANS_FILE = path.join(CONFIG_DIR, 'plans.json');

const TEMPLATE = {
  usdCnyRate: 7.2,
  // 每个工具的套餐配置：plan = 套餐名（设置面板可改）；cnyPerMonth = 等价月额度（null = 未配置）
  plans: {
    codex:         { label: 'ChatGPT · Codex', plan: null, cnyPerDay: null, cnyPerMonth: null },
    claudeDesktop: { label: 'Claude Desktop',  plan: null, cnyPerDay: null, cnyPerMonth: null },
    claudeCode:    { label: 'Claude Code',     plan: null, cnyPerDay: null, cnyPerMonth: null },
    zcode:         { label: 'ZCode',           plan: null, cnyPerDay: null, cnyPerMonth: null },
    workbuddy:     { label: 'WorkBuddy',       plan: null, cnyPerDay: null, cnyPerMonth: null },
  },
  priceOverrides: {},
  // 当日目标成本（等价成本 ¥）：网页横幅 / 菜单栏 / 桌面卡片的预算进度条
  dailyGoal: { cny: 200 },
  // 套餐实时额度的手动 key 配置：非空优先，留空回退各采集器的自动发现
  quotaKeys: {
    zhipu:   { token: '', organizationId: '', projectId: '' },
    minimax: { apiKey: '' },
    chatgpt: { accessToken: '' },
  },
};

// 各工具 key 字段里属于机密的（接口返回需脱敏，保存时区分「未改动回显」与「新值」）
const QUOTA_KEY_FIELDS = {
  zhipu:   { secrets: ['token'], plain: ['organizationId', 'projectId'] },
  minimax: { secrets: ['apiKey'], plain: [] },
  chatgpt: { secrets: ['accessToken'], plain: [] },
};

function maskSecret(s) {
  const v = String(s || '');
  if (!v) return '';
  return v.length > 12 ? v.slice(0, 4) + '…' + v.slice(-4) : '••••';
}

// GET 用：返回配置副本，机密字段脱敏（org/project 等非机密保持原值）
function maskQuotaKeys(cfg) {
  const out = JSON.parse(JSON.stringify(cfg || {}));
  const qk = out.quotaKeys || {};
  for (const [tool, spec] of Object.entries(QUOTA_KEY_FIELDS)) {
    qk[tool] = qk[tool] || {};
    for (const f of spec.secrets) qk[tool][f] = maskSecret(qk[tool][f]);
  }
  out.quotaKeys = qk;
  return out;
}

// POST 用：把表单提交的 quotaKeys 合并进现有配置（纯函数，不改入参）
// 语义：空串 = 清除（回退自动发现）；机密字段值等于已存值的脱敏形态 = 未改动，保留原值；其余 = 新值
function applyQuotaKeysUpdate(current, incoming) {
  const cur = (current && current.quotaKeys) || {};
  const inc = incoming || {};
  const out = {};
  for (const [tool, spec] of Object.entries(QUOTA_KEY_FIELDS)) {
    const t = out[tool] = {};
    for (const f of [...spec.secrets, ...spec.plain]) {
      const v = String((inc[tool] || {})[f] ?? '').trim();
      const prev = String((cur[tool] || {})[f] ?? '');
      if (v === '') t[f] = '';
      else if (spec.secrets.includes(f) && v === maskSecret(prev)) t[f] = prev;
      else t[f] = v;
    }
  }
  return out;
}

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(PLANS_FILE, 'utf8'));
    // 补齐新增 key（保留已有自定义值）
    for (const [k, v] of Object.entries(TEMPLATE)) {
      if (cache[k] === undefined) cache[k] = v;
    }
    for (const [k, v] of Object.entries(TEMPLATE.plans)) {
      if (!cache.plans[k]) cache.plans[k] = v;
      else if (v.plan !== undefined && cache.plans[k].plan === undefined) cache.plans[k].plan = v.plan;
    }
  } catch {
    cache = JSON.parse(JSON.stringify(TEMPLATE));
    save(cache); // 首次生成模板
  }
  return cache;
}

function save(next) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PLANS_FILE, JSON.stringify(next, null, 2));
  cache = next;
}

module.exports = { load, save, maskQuotaKeys, applyQuotaKeysUpdate, maskSecret, QUOTA_KEY_FIELDS, PLANS_FILE };
