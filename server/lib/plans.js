'use strict';
// plans.json 读写：用户配置的额度 / 汇率 / 单价覆盖
const fs = require('node:fs');
const path = require('node:path');

// 可用环境变量重定向配置目录（测试 / 便携安装用），默认仓库根 config/
const CONFIG_DIR = process.env.AI_QUOTA_CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
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
  // 当日目标成本（等价成本 ¥）：网页横幅 / 菜单栏 / 桌面卡片的预算进度条（0 = 关闭目标）
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
  // JWT（eyJ 开头）不保留头部特征：掩码本身不得含明文片段（接口响应 grep 不到 eyJ）
  if (v.startsWith('eyJ')) return '••••…' + v.slice(-4);
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

// POST /api/plans 用：按白名单合并表单更新，非法值剔除该字段（保留原值）。纯函数，不改入参
function applyPlansUpdate(current, body) {
  const next = JSON.parse(JSON.stringify(current || {}));
  const num = v => Number(v);

  // 汇率：必须有限正数
  if (body && body.usdCnyRate != null) {
    const n = num(body.usdCnyRate);
    if (Number.isFinite(n) && n > 0) next.usdCnyRate = n;
  }
  // 套餐额度：允许 null（未配置）或有限非负数
  if (body && body.plans) for (const [k, v] of Object.entries(body.plans)) {
    if (!next.plans[k] || !v || typeof v !== 'object') continue;
    for (const f of ['cnyPerDay', 'cnyPerMonth']) {
      if (!(f in v)) continue;
      const n = v[f] === null || v[f] === '' ? null : num(v[f]);
      if (n === null || (Number.isFinite(n) && n >= 0)) next.plans[k][f] = n;
    }
  }
  // 模型单价覆盖：in/out/cacheRead 必须有限非负数，非法剔除该字段；全空 = 清除该模型覆盖
  if (body && body.priceOverrides && typeof body.priceOverrides === 'object') {
    const po = {};
    for (const [m, o] of Object.entries(body.priceOverrides)) {
      if (!o || typeof o !== 'object') continue;
      const e = {};
      for (const f of ['in', 'out', 'cacheRead']) {
        const n = num(o[f]);
        if (o[f] != null && o[f] !== '' && Number.isFinite(n) && n >= 0) e[f] = n;
      }
      if (Object.keys(e).length) po[m] = e;
    }
    next.priceOverrides = po;
  }
  // 实时额度 keys：沿用既有合并语义
  if (body && body.quotaKeys) next.quotaKeys = applyQuotaKeysUpdate(next, body.quotaKeys);
  // 当日目标：0 = 关闭目标；负数/非法保留原值
  if (body && body.dailyGoal && typeof body.dailyGoal === 'object') {
    const n = num(body.dailyGoal.cny);
    if (Number.isFinite(n) && n >= 0) next.dailyGoal = { cny: n };
  }
  return next;
}

let cache = null;
let cacheMtimeMs = 0; // 缓存对应文件的 mtime，外部改动后自动失效

function load() {
  let st = null;
  try { st = fs.statSync(PLANS_FILE); } catch { /* 首次运行尚未生成 */ }
  if (cache && st && st.mtimeMs === cacheMtimeMs) return cache;
  if (cache && !st) return cache; // 文件暂时不可见（如网络盘抖动）：继续用内存缓存，不回模板
  try {
    cache = JSON.parse(fs.readFileSync(PLANS_FILE, 'utf8'));
    cacheMtimeMs = st ? st.mtimeMs : 0;
  } catch {
    if (st) {
      // JSON 损坏：先把坏文件备份为 .bak，再落模板，不直接吞掉
      try { fs.copyFileSync(PLANS_FILE, PLANS_FILE + '.bak'); } catch { /* 备份失败继续 */ }
    }
    cache = JSON.parse(JSON.stringify(TEMPLATE));
    save(cache); // 首次生成模板
    return cache;
  }
  // 补齐新增 key（保留已有自定义值）
  for (const [k, v] of Object.entries(TEMPLATE)) {
    if (cache[k] === undefined) cache[k] = v;
  }
  for (const [k, v] of Object.entries(TEMPLATE.plans)) {
    if (!cache.plans[k]) cache.plans[k] = v;
    else if (v.plan !== undefined && cache.plans[k].plan === undefined) cache.plans[k].plan = v.plan;
  }
  return cache;
}

function save(next) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // 原子写：同目录临时文件 + rename，避免半截 JSON；含实时额度密钥，权限收紧 0600
  const tmp = PLANS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, PLANS_FILE);
  cache = next;
  try { cacheMtimeMs = fs.statSync(PLANS_FILE).mtimeMs; } catch { cacheMtimeMs = 0; }
}

module.exports = {
  load, save, maskQuotaKeys, applyQuotaKeysUpdate, applyPlansUpdate,
  maskSecret, QUOTA_KEY_FIELDS, CONFIG_DIR, PLANS_FILE,
};
