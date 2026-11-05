'use strict';
// 套餐实时额度采集：智谱 Coding Plan（团队版，5h 窗口 + 周额度）
// 端点: https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2
//   请求头: authorization + bigmodel-organization + bigmodel-project（团队版必须）
//   响应 limits[]: {type: TOKENS_LIMIT|CREDIT_LIMIT|TIME_LIMIT, unit, number, usage, currentValue, remaining, percentage, nextResetTime}
//   5h 窗口 = unit 3 + number 5；周窗口 = unit 6（与 ZCode 客户端判定一致）；TIME_LIMIT 是 MCP 月额度，不展示
// 组织/项目发现: /api/biz/customer/getCustomerInfo（需 OAuth）→ organizations[].projects[projectType=2 团队编程套餐项目]
// 凭证来源（按序取用）:
//   0) config/plans.json 的 quotaKeys.zhipu（设置面板手动配置，token + 可选 org/project，优先级最高）
//   1) ~/.zcode/v2/credentials.json 的 oauth:bigmodel:access_token（enc:v1 AES-256-GCM，本机可解密，与 ZCode 同源）
//   2) ~/.workbuddy-ai/models.json 的 GLM Coding Plan apiKey
//   3) ~/.zcode/v2/config.json 的 builtin:bigmodel-coding-plan apiKey
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getJson } = require('../lib/http-json');
const { decryptZcodeValue } = require('../lib/zcode-credential');
const plansStore = require('../lib/plans');

const HOST = 'open.bigmodel.cn';
const CREDS_FILE = path.join(os.homedir(), '.zcode', 'v2', 'credentials.json');
const ZCODE_CONFIG = path.join(os.homedir(), '.zcode', 'v2', 'config.json');
const WB_MODELS = path.join(os.homedir(), '.workbuddy-ai', 'models.json');
// 团队 org/project 缓存：进程内 10 分钟 + 落盘（OAuth 失效时仍可凭 key + 缓存查询）
const CTX_CACHE_FILE = path.join(__dirname, '..', '..', 'config', '.zhipu-team-context.json');
const CTX_TTL = 10 * 60_000;

// ---------- ZCode 凭证解密 ----------
// enc:v1 AES-256-GCM 实现已抽到 server/lib/zcode-credential.js（与 api-billing.js 共用）

function getCredentials() {
  const out = { configured: { token: null, org: null, proj: null }, oauth: null, apiKeys: [] };
  try {
    const qk = (plansStore.load().quotaKeys || {}).zhipu || {};
    out.configured.token = String(qk.token || '').trim() || null;
    out.configured.org = String(qk.organizationId || '').trim() || null;
    out.configured.proj = String(qk.projectId || '').trim() || null;
  } catch { /* 配置读取失败按未配置处理 */ }
  try {
    const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    const tok = decryptZcodeValue(creds['oauth:bigmodel:access_token']);
    if (tok && tok.includes('.')) out.oauth = tok; // JWT 形态才算解密成功
  } catch { /* 无 ZCode 凭证 */ }
  try {
    const arr = JSON.parse(fs.readFileSync(WB_MODELS, 'utf8'));
    for (const m of arr) {
      if ((m.vendor || '').includes('GLM Coding Plan') && m.apiKey && !out.apiKeys.includes(m.apiKey)) {
        out.apiKeys.push(m.apiKey);
      }
    }
  } catch { /* 无 WorkBuddy 配置 */ }
  try {
    const cfg = JSON.parse(fs.readFileSync(ZCODE_CONFIG, 'utf8'));
    const k = cfg.provider && cfg.provider['builtin:bigmodel-coding-plan']
      && cfg.provider['builtin:bigmodel-coding-plan'].options && cfg.provider['builtin:bigmodel-coding-plan'].options.apiKey;
    if (k && !out.apiKeys.includes(k)) out.apiKeys.push(k);
  } catch { /* 无 ZCode 配置 */ }
  return out;
}

// ---------- HTTP ----------
// 实现移到 server/lib/http-json.js 的 getJson（[P1] 体超限先 resolve 再 destroy 修悬挂；
// 非 200 reason 带脱敏后的响应体片段，本采集器对外契约仍是 { ok, data?, reason? }）。
// 注：本采集器有自己的双层缓存（内存 ctxCache + 落盘 CTX_CACHE_FILE，键为 org/project 对），
// 与 http-json 无关，保持原样。
function get(pathWithQuery, headers, timeoutMs = 10_000) {
  return getJson('https://' + HOST + pathWithQuery, { headers, timeoutMs });
}

// ---------- 团队 org/project 发现 ----------
let ctxCache = { at: 0, ctx: null };

function loadPersistedCtx() {
  try { return JSON.parse(fs.readFileSync(CTX_CACHE_FILE, 'utf8')); } catch { return null; }
}
function persistCtx(ctx) {
  try { fs.mkdirSync(path.dirname(CTX_CACHE_FILE), { recursive: true }); fs.writeFileSync(CTX_CACHE_FILE, JSON.stringify(ctx)); } catch { /* 只读环境忽略 */ }
}

// 枚举账号下所有「团队编程套餐项目」（projectType=2），逐个试额度，取有数据的那个
async function discoverTeamContext(oauth) {
  if (!oauth) return null;
  const r = await get('/api/biz/customer/getCustomerInfo', { authorization: oauth });
  if (!r.ok || !r.data || r.data.code !== 200) return null;
  const candidates = [];
  for (const org of (r.data.data && r.data.data.organizations) || []) {
    for (const p of org.projects || []) {
      if (p.projectType === 2 && p.status === 'active') {
        candidates.push({ organizationId: p.organizationId || org.organizationId, projectId: p.projectId, orgName: org.organizationName, projName: p.projectName });
      }
    }
  }
  return candidates;
}

async function fetchQuotaRaw(auth, ctx) {
  const r = await get('/api/monitor/usage/quota/limit?type=2', {
    authorization: auth,
    'bigmodel-organization': ctx.organizationId,
    'bigmodel-project': ctx.projectId,
  });
  if (!r.ok) return { error: r.reason };
  if (!r.data || r.data.success === false) return { error: (r.data && r.data.msg) || 'business error' };
  return { data: r.data.data || {} };
}

// limits[] → 5h/周窗口（纯函数，供测试）
function parseQuotaLimits(limits, now = Date.now()) {
  const win = e => {
    const usedPercent = Number.isFinite(e.percentage) ? Math.round(e.percentage)
      : (e.usage > 0 ? Math.round(e.currentValue / e.usage * 100) : null);
    const resetMsLeft = Number.isFinite(e.nextResetTime) && e.nextResetTime > now ? e.nextResetTime - now : null;
    return {
      usedPercent,
      remainingPercent: usedPercent == null ? null : 100 - usedPercent,
      used: e.currentValue ?? null, total: e.usage ?? null, remaining: e.remaining ?? null,
      resetAt: Number.isFinite(e.nextResetTime) ? e.nextResetTime : null,
      resetMsLeft,
    };
  };
  const five = (limits || []).find(e => (e.type === 'TOKENS_LIMIT' || e.type === 'CREDIT_LIMIT') && e.unit === 3 && e.number === 5);
  const week = (limits || []).find(e => (e.type === 'TOKENS_LIMIT' || e.type === 'CREDIT_LIMIT') && e.unit === 6);
  return { fiveHour: five ? win(five) : null, weekly: week ? win(week) : null };
}

async function collect() {
  const creds = getCredentials();
  if (!creds.configured.token && !creds.oauth && !creds.apiKeys.length) {
    return { available: false, notConfigured: true, reason: '未找到智谱凭证（设置面板可手动配置，或 ZCode / WorkBuddy 自动发现）', source: CREDS_FILE };
  }

  // 1) 团队 org/project：手动配置优先 → 内存缓存 → 落盘缓存 → OAuth 发现
  let ctxs = [];
  const cf = creds.configured;
  if (cf.org && cf.proj) {
    ctxs.push({ organizationId: cf.org, projectId: cf.proj, orgName: '手动配置', projName: '手动配置' });
  }
  if (Date.now() - ctxCache.at < CTX_TTL && ctxCache.ctx) {
    for (const c of ctxCache.ctx) if (!ctxs.some(x => x.organizationId === c.organizationId && x.projectId === c.projectId)) ctxs.push(c);
  } else {
    const persisted = loadPersistedCtx();
    if (persisted && persisted.length) {
      ctxCache = { at: Date.now(), ctx: persisted };
      for (const c of persisted) if (!ctxs.some(x => x.organizationId === c.organizationId && x.projectId === c.projectId)) ctxs.push(c);
    }
    const discovered = await discoverTeamContext(creds.oauth);
    if (discovered && discovered.length) {
      ctxCache = { at: Date.now(), ctx: discovered };
      persistCtx(discovered);
      for (const c of discovered) if (!ctxs.some(x => x.organizationId === c.organizationId && x.projectId === c.projectId)) ctxs.push(c);
    }
  }
  if (!ctxs.length) {
    return { available: false, notConfigured: true, reason: creds.oauth ? '未发现团队编程套餐项目' : 'OAuth 不可用且无缓存，无法定位团队项目（设置面板可手动填 org/project）', source: HOST };
  }

  // 2) 逐个项目查额度，取有 limits 的；配置 token 排最前
  const auths = [creds.configured.token, creds.oauth, ...creds.apiKeys].filter(Boolean);
  let lastErr = '';
  for (const ctx of ctxs) {
    let result = null;
    for (const auth of auths) {
      const r = await fetchQuotaRaw(auth, ctx);
      if (r.error) { lastErr = r.error; continue; }
      if (r.data && Array.isArray(r.data.limits) && r.data.limits.length) { result = r.data; break; }
      lastErr = '空额度'; // 项目无有效订阅：同项目其余凭证再试（原 break 会直接弃掉整个项目）；全空才换下一项目
      continue;
    }
    if (!result) continue;
    const { fiveHour, weekly } = parseQuotaLimits(result.limits);
    if (!fiveHour && !weekly) continue;
    return {
      available: true,
      provider: '智谱 Coding Plan',
      planLevel: result.level || null,
      team: { organizationName: ctx.orgName, projectName: ctx.projName },
      fiveHour, weekly,
      raw: result,
      fetchedAt: Date.now(),
      source: HOST + '/api/monitor/usage/quota/limit',
    };
  }
  return { available: false, reason: lastErr || '团队项目均无额度数据', source: HOST };
}

module.exports = { collect, parseQuotaLimits };
