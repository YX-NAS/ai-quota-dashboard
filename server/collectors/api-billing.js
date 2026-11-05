'use strict';
// API 按量计费采集：各 AI 服务商账户余额（尽力而为，失败不阻塞快照）
//
// 智谱（open.bigmodel.cn）:
//   端点: GET /api/biz/customer/getCustomerInfo → data.balance / availableBalance / rechargeAmount / giveAmount
//   凭证链（同 zhipu-quota.js）: plans.json quotaKeys.zhipu.token → ZCode OAuth（credentials.json enc:v1 解密）
//     → ~/.workbuddy-ai/models.json 的 GLM Coding Plan key → ZCode config 的 bigmodel key
//   （2026-10-30 起用户停用团队套餐，ZCode 走个人按量计费账户；未充值时余额字段为 null）
// DeepSeek（api.deepseek.com）:
//   端点: GET /user/balance → balance_infos[] total_balance / granted_balance / topped_up_balance
//   凭证链: plans.json quotaKeys.deepseek.apiKey → ~/.zcode/v2/provider_config.json 的 deepseek 自定义供应商
//     → ~/.cc-switch/cc-switch.db providers 表的 DeepSeek 行
// 阿里云百炼（账户余额在阿里云侧，DashScope 无按量余额接口——已实测端点均 404）:
//   端点: BSS OpenAPI GET https://business.aliyuncs.com/?Action=GetAccountBalance（RPC HMAC-SHA1 签名）
//   凭证: plans.json quotaKeys.bailian.accessKeyId/accessKeySecret（可选，未配置 = 卡片只展示用量费用）
// 火山方舟（ark.cn-beijing.volces.com，豆包系列 + 方舟托管三方模型）:
//   端点: GET /api/v3/models → 在售模型清单（无余额接口，卡片以模型清单 + Key 探活代替余额）
//   凭证链: ZCode 自定义 volcengine 供应商 key → plans.json quotaKeys.volcengine.apiKey
// 响应 60s 进程内缓存：快照周期 60s + 手动 /api/refresh 共用，避免重复请求
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { getJson: getJsonUrl, withTimeout } = require('../lib/http-json');
const { decryptZcodeValue } = require('../lib/zcode-credential');
const plansStore = require('../lib/plans');
const zcodeProviders = require('../lib/zcode-providers');

const ZHIPU_HOST = 'open.bigmodel.cn';
const DEEPSEEK_HOST = 'api.deepseek.com';
const BSS_HOST = 'business.aliyuncs.com';
const MOONSHOT_HOST = 'api.moonshot.cn';
const CREDS_FILE = path.join(os.homedir(), '.zcode', 'v2', 'credentials.json');
const ZCODE_CONFIG = path.join(os.homedir(), '.zcode', 'v2', 'config.json');
const WB_MODELS = path.join(os.homedir(), '.workbuddy-ai', 'models.json');
const CCSWITCH_DB = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const CACHE_TTL = 60_000;

// ---------- ZCode 凭证解密 ----------
// enc:v1 AES-256-GCM 实现已抽到 server/lib/zcode-credential.js（与 zhipu-quota.js 共用）

// ---------- 凭证发现 ----------
// 智谱：plans.json 手动配置优先，其次 ZCode OAuth，再 WorkBuddy / ZCode config 的 key
function getZhipuCredentials() {
  const out = { configured: null, oauth: null, apiKeys: [] };
  try {
    const qk = (plansStore.load().quotaKeys || {}).zhipu || {};
    out.configured = String(qk.token || '').trim() || null;
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
    for (const k of ['builtin:bigmodel', 'builtin:bigmodel-coding-plan']) {
      const v = cfg.provider && cfg.provider[k] && cfg.provider[k].options && cfg.provider[k].options.apiKey;
      if (v && !out.apiKeys.includes(v)) out.apiKeys.push(v);
    }
  } catch { /* 无 ZCode 配置 */ }
  for (const v of providerKeysForVendor('zhipu')) { // ZCode 自定义按量供应商的 key
    if (!out.apiKeys.includes(v)) out.apiKeys.push(v);
  }
  return out;
}

// ZCode 自定义模型供应商（provider_config.json，经 zcode-providers 解析）→ 某服务商的 keys（ZCode 实际使用的 key）
function providerKeysForVendor(vendor) {
  const keys = [];
  if (!vendor) return keys;
  for (const p of zcodeProviders.load()) {
    if (p.vendor === vendor && p.apiKey && !keys.includes(p.apiKey)) keys.push(p.apiKey);
  }
  return keys;
}

// DeepSeek：ZCode 自定义供应商 key 优先，其次 plans.json 手动配置，再 cc-switch db
function getDeepSeekKeys() {
  const keys = [];
  const push = k => { if (k && !keys.includes(k)) keys.push(k); };
  for (const k of providerKeysForVendor('deepseek')) push(k);
  try {
    const qk = (plansStore.load().quotaKeys || {}).deepseek || {};
    push(String(qk.apiKey || '').trim());
  } catch { /* 忽略 */ }
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(CCSWITCH_DB, { readOnly: true });
    try {
      const rows = db.prepare("SELECT settings_config FROM providers WHERE name = 'DeepSeek'").all();
      for (const r of rows) {
        let cfg = {};
        try { cfg = JSON.parse(r.settings_config || '{}'); } catch { continue; }
        const k = (cfg.env && cfg.env.ANTHROPIC_AUTH_TOKEN)
          || (cfg.auth && (cfg.auth.OPENAI_API_KEY || cfg.auth.OPENAI_KEY));
        push(k);
      }
    } finally {
      try { db.close(); } catch {}
    }
  } catch { /* 无 cc-switch 配置 */ }
  return keys;
}

// ---------- HTTP ----------
// 统一返回 { ok, status, data?, reason? }。实现移到 server/lib/http-json.js 的 getJson：
//  - [P1] 响应体超限先 resolve 再 destroy（旧内联实现 destroy 后 end/error 不触发，promise 悬挂）；
//  - [P2] 非 200 的响应体片段经 sanitizeReason 脱敏（sk/rk/ark/Bearer 形态 → '[redacted]'）
//         并截 120 字符后才进 reason，不再原样透传错误体；
//  - 超时 status -1、体超限 status -2，对外返回契约与旧实现一致。
function getJson(host, pathWithQuery, headers, timeoutMs = 10_000) {
  return getJsonUrl('https://' + host + pathWithQuery, { headers, timeoutMs });
}

// ---------- 纯解析（导出供测试） ----------
const toNum = v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

// getCustomerInfo 响应 → 账户余额字段；不合法响应返回 null
function parseCustomerInfo(d) {
  if (!d || d.success === false || !d.data || typeof d.data !== 'object') return null;
  const a = d.data;
  return {
    customerNumber: String(a.customerNumber || ''),
    balance: toNum(a.balance),
    availableBalance: toNum(a.availableBalance),
    rechargeAmount: toNum(a.rechargeAmount),
    giveAmount: toNum(a.giveAmount),
  };
}

// DeepSeek /user/balance 响应 → 余额字段（取 CNY 行，缺省取第一条）；不合法返回 null
function parseDeepSeekBalance(d) {
  if (!d || d.is_available !== true || !Array.isArray(d.balance_infos) || !d.balance_infos.length) return null;
  const b = d.balance_infos.find(x => x.currency === 'CNY') || d.balance_infos[0];
  if (!b || b.total_balance == null) return null;
  return {
    total: toNum(b.total_balance),
    granted: toNum(b.granted_balance),
    toppedUp: toNum(b.topped_up_balance),
  };
}

// ---------- 采集 ----------
async function collectZhipu() {
  const creds = getZhipuCredentials();
  const auths = [creds.configured, creds.oauth, ...creds.apiKeys].filter(Boolean);
  if (!auths.length) {
    return { available: false, notConfigured: true, reason: '未找到智谱凭证（设置面板可配 API Key，或 ZCode / WorkBuddy 自动发现）', source: 'open.bigmodel.cn' };
  }
  let lastErr = null;
  for (const auth of auths) {
    const r = await getJson(ZHIPU_HOST, '/api/biz/customer/getCustomerInfo', { Authorization: 'Bearer ' + auth });
    if (!r.ok) { lastErr = r.reason; continue; }
    const parsed = parseCustomerInfo(r.data);
    if (!parsed) { lastErr = 'customerInfo 响应无 data'; continue; }
    return {
      available: true,
      account: parsed,
      fetchedAt: Date.now(),
      source: 'open.bigmodel.cn/api/biz/customer/getCustomerInfo',
    };
  }
  return { available: false, reason: lastErr || '余额查询失败', source: 'open.bigmodel.cn' };
}

async function collectDeepSeek() {
  const keys = getDeepSeekKeys();
  if (!keys.length) {
    return { available: false, notConfigured: true, reason: '未找到 DeepSeek key（设置面板可配置，或 ZCode 自定义模型 / cc-switch 自动发现）', source: 'api.deepseek.com' };
  }
  let lastErr = null;
  for (const key of keys) {
    const r = await getJson(DEEPSEEK_HOST, '/user/balance', { Authorization: 'Bearer ' + key });
    if (!r.ok) { lastErr = r.reason; continue; }
    const parsed = parseDeepSeekBalance(r.data);
    if (!parsed) { lastErr = '余额响应无 balance_infos'; continue; }
    return {
      available: true,
      balance: parsed,
      fetchedAt: Date.now(),
      source: 'api.deepseek.com/user/balance',
    };
  }
  return { available: false, reason: lastErr || '余额查询失败', source: 'api.deepseek.com' };
}

// ---------- 阿里云百炼（BSS 账户余额，需 AccessKey） ----------
// RPC 风格签名参数编码：encodeURIComponent 后按阿里云规范微调（+→%20、*→%2A、~ 还原）
const rpcEncode = s => encodeURIComponent(String(s))
  .replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');

function bssGetBalanceUrl(accessKeyId, accessKeySecret, nonce, now = Date.now()) {
  const params = {
    Action: 'GetAccountBalance',
    Version: '2017-12-14',
    Format: 'JSON',
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: nonce,
    Timestamp: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    RegionId: 'cn-hangzhou',
  };
  const canonical = Object.keys(params).sort()
    .map(k => rpcEncode(k) + '=' + rpcEncode(params[k])).join('&');
  const stringToSign = 'GET&%2F&' + rpcEncode(canonical);
  const signature = crypto.createHmac('sha1', accessKeySecret + '&').update(stringToSign).digest('base64');
  return { host: BSS_HOST, path: '/?' + canonical + '&Signature=' + rpcEncode(signature) };
}

// BSS GetAccountBalance 响应 → 归一余额（金额字段是字符串，防御性转数字）；不合法返回 null
function parseBssBalance(d) {
  if (!d || !d.Data || typeof d.Data !== 'object') return null;
  const a = d.Data;
  const total = toNum(a.AvailableAmount);
  if (total == null) return null;
  return {
    total,
    cash: toNum(a.BalanceAmount),
    credit: toNum(a.CreditAmount),
    currency: String(a.Currency || 'CNY'),
  };
}

// AccessKey 获取：plans.json quotaKeys.bailian（设置面板配置）→ 环境变量兜底
function getBailianAccessKey() {
  try {
    const qk = (plansStore.load().quotaKeys || {}).bailian || {};
    const id = String(qk.accessKeyId || '').trim();
    const sec = String(qk.accessKeySecret || '').trim();
    if (id && sec) return { id, sec };
  } catch { /* 忽略 */ }
  const id = (process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || '').trim();
  const sec = (process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || '').trim();
  if (id && sec) return { id, sec };
  return null;
}

async function collectBailian() {
  const ak = getBailianAccessKey();
  if (!ak) {
    return {
      available: false, notConfigured: true,
      reason: '未配置阿里云 AccessKey（设置面板可配，用于查询账户余额；百炼无按量余额接口）',
      source: 'business.aliyuncs.com',
    };
  }
  // nonce 每次现取时间戳+随机数，无需外部依赖
  const r = await getJsonFrom(bssGetBalanceUrl(ak.id, ak.sec, crypto.randomUUID()).path);
  if (!r.ok) return { available: false, reason: r.reason, source: 'business.aliyuncs.com' };
  const parsed = parseBssBalance(r.data);
  if (!parsed) return { available: false, reason: r.data && r.data.Message ? 'BSS: ' + r.data.Message : '余额响应无 Data', source: 'business.aliyuncs.com' };
  return { available: true, balance: parsed, fetchedAt: Date.now(), source: 'business.aliyuncs.com GetAccountBalance' };
}

// getJson 需要 host 参数化：BSS 与其余几家共用同一实现
function getJsonFrom(pathWithQuery) {
  return getJson(BSS_HOST, pathWithQuery, {});
}

// ---------- Kimi / Moonshot（真按量余额）----------
// ZCode 自定义 kimi key → plans.json quotaKeys.moonshot → cc-switch 'Kimi' 行 → workbuddy Moonshot 模型
function getMoonshotKeys() {
  const keys = [];
  const push = k => { if (k && !keys.includes(k)) keys.push(k); };
  for (const k of providerKeysForVendor('moonshot')) push(k);
  try {
    const qk = (plansStore.load().quotaKeys || {}).moonshot || {};
    push(String(qk.apiKey || '').trim());
  } catch { /* 忽略 */ }
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(CCSWITCH_DB, { readOnly: true });
    try {
      const rows = db.prepare("SELECT settings_config FROM providers WHERE name = 'Kimi'").all();
      for (const r of rows) {
        let cfg = {}; try { cfg = JSON.parse(r.settings_config || '{}'); } catch { continue; }
        push((cfg.auth && (cfg.auth.OPENAI_API_KEY || cfg.auth.OPENAI_KEY)) || (cfg.env && cfg.env.ANTHROPIC_AUTH_TOKEN));
      }
    } finally { try { db.close(); } catch {} }
  } catch { /* 无 cc-switch */ }
  try {
    const arr = JSON.parse(fs.readFileSync(WB_MODELS, 'utf8'));
    for (const m of arr) if ((m.vendor || '').toLowerCase().includes('moonshot') && m.apiKey) push(m.apiKey);
  } catch { /* 无 workbuddy */ }
  return keys;
}

// Moonshot /v1/users/me/balance 响应 → {total(可用), cash, credit(代金券)}；不合法返回 null
function parseMoonshotBalance(d) {
  if (!d || d.code !== 0 || !d.data) return null;
  const total = toNum(d.data.available_balance);
  if (total == null) return null;
  return { total, cash: toNum(d.data.cash_balance), credit: toNum(d.data.voucher_balance) };
}

async function collectMoonshot() {
  const keys = getMoonshotKeys();
  if (!keys.length) return { available: false, notConfigured: true, reason: '未找到 Kimi/Moonshot key', source: 'api.moonshot.cn' };
  let lastErr = null;
  for (const key of keys) {
    const r = await getJson(MOONSHOT_HOST, '/v1/users/me/balance', { Authorization: 'Bearer ' + key });
    if (!r.ok) { lastErr = r.reason; continue; }
    const parsed = parseMoonshotBalance(r.data);
    if (!parsed) { lastErr = '余额响应无 data'; continue; }
    return { available: true, balance: parsed, fetchedAt: Date.now(), source: 'api.moonshot.cn/v1/users/me/balance' };
  }
  return { available: false, reason: lastErr || '余额查询失败', source: 'api.moonshot.cn' };
}

// ---------- 火山方舟（Ark：豆包系列 + 方舟托管三方模型）----------
// 方舟无按量余额接口（/api/v3/users/me/balance 等 2026-10-31 实测均 404，计费在火山引擎账户侧），
// 本节用 GET /api/v3/models 拉在售模型清单（只读不耗额度），兼做 Key 探活
const ARK_HOST = 'ark.cn-beijing.volces.com';

// Key 链：ZCode 自定义 volcengine/ark 供应商 → plans.json quotaKeys.volcengine（设置面板）
function getVolcengineKeys() {
  const keys = [];
  const push = k => { if (k && !keys.includes(k)) keys.push(k); };
  for (const k of providerKeysForVendor('volcengine')) push(k);
  try {
    const qk = (plansStore.load().quotaKeys || {}).volcengine || {};
    push(String(qk.apiKey || '').trim());
  } catch { /* 忽略 */ }
  return keys;
}

// /api/v3/models 响应 → 模型清单（status 缺省 = 在售；Shutdown / Retiring 分列计数）；不合法返回 null
function parseArkModels(d) {
  if (!d || !Array.isArray(d.data) || !d.data.length) return null;
  const active = [];
  let retiring = 0, shutdown = 0;
  for (const m of d.data) {
    const id = String((m && m.id) || '').trim();
    if (!id) continue;
    const st = String((m && m.status) || '');
    if (st === 'Shutdown') shutdown++;
    else if (st === 'Retiring') retiring++;
    else active.push(id);
  }
  active.sort();
  return { active, activeCount: active.length, retiringCount: retiring, shutdownCount: shutdown, totalCount: d.data.length };
}

async function collectVolcengine(providers) {
  const keys = getVolcengineKeys();
  if (!keys.length) {
    return { available: false, notConfigured: true, reason: '未找到火山方舟 Key（设置面板可配，或 ZCode 自定义模型自动发现）', source: ARK_HOST };
  }
  let lastErr = null;
  for (const key of keys) {
    const r = await getJson(ARK_HOST, '/api/v3/models', { Authorization: 'Bearer ' + key });
    if (!r.ok) { lastErr = r.reason; continue; }
    const parsed = parseArkModels(r.data);
    if (!parsed) { lastErr = 'models 响应无 data'; continue; }
    // 同 key 已配置为 ZCode 自定义模型 → provider 卡已展示模型清单，标记供前端去重
    const linked = (providers || []).find(p => p.vendor === 'volcengine' && p.apiKey === key);
    return {
      available: true,
      models: parsed,
      keyMasked: plansStore.maskSecret(key),
      checked: true, ok: true, reason: '', checkedAt: Date.now(), // /api/v3/models 拉取成功即探活通过
      linkedProvider: linked ? linked.providerId : null,
      fetchedAt: Date.now(),
      source: ARK_HOST + '/api/v3/models',
    };
  }
  return { available: false, checked: true, ok: false, reason: lastErr || '模型列表查询失败', source: ARK_HOST };
}

// ---------- Key 健康探测（随时检测）----------
// 用 provider 自身配置的 apiKey 打其 /models 端点：只读不耗额度，200=有效
// anthropic-messages 型用 x-api-key 头，其余 Bearer
function probeKeyHeaders(p) {
  const auth = p.probe && p.probe.auth;
  return auth === 'x-api-key'
    ? { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' }
    : { 'Authorization': 'Bearer ' + p.apiKey };
}

function probeKey(p) {
  if (!p || !p.probe || !p.apiKey) return Promise.resolve({ checked: false, ok: false, reason: '无探测端点' });
  const { host, path } = p.probe;
  return getJson(host, path, probeKeyHeaders(p), 8000).then(r => ({
    checked: true, ok: r.ok === true, httpStatus: r.status,
    reason: r.ok ? '' : String(r.reason || 'HTTP ' + r.status).slice(0, 120),
    checkedAt: Date.now(),
  }));
}

// ---------- 智谱「其他 Key」（设置面板 quotaKeys.zhipu.extraKeys） ----------
// 独立于自己账户主 Key 的第二把及以后智谱 Key（如「可用api」）：逐把探活，
// 智谱标准 Key 无余额查询接口（getCustomerInfo 仅认 OAuth JWT，实测 APIKey not allow access），只做健康检测
function getZhipuExtraKeys() {
  try {
    const qk = (plansStore.load().quotaKeys || {}).zhipu || {};
    return (Array.isArray(qk.extraKeys) ? qk.extraKeys : [])
      .map(x => ({
        label: String((x && x.label) || '').trim() || '智谱 Key',
        apiKey: String((x && x.apiKey) || '').trim(),
      }))
      .filter(x => x.apiKey);
  } catch { return []; }
}

async function collectZhipuExtras(providers) {
  const keys = getZhipuExtraKeys();
  if (!keys.length) return [];
  return Promise.all(keys.map(async k => {
    const r = await getJson(ZHIPU_HOST, '/api/paas/v4/models', { Authorization: 'Bearer ' + k.apiKey }, 8000);
    // 同 key 已配置为 ZCode 自定义模型 → 已有独立 provider 卡，标记供前端去重
    const linked = (providers || []).find(p => p.vendor === 'zhipu' && p.apiKey === k.apiKey);
    return {
      label: k.label,
      keyMasked: plansStore.maskSecret(k.apiKey),
      checked: true,
      ok: r.ok === true,
      httpStatus: r.status,
      reason: r.ok ? '' : String(r.reason || 'HTTP ' + r.status).slice(0, 120),
      checkedAt: Date.now(),
      linkedProvider: linked ? linked.providerId : null,
    };
  }));
}

// 可查金额余额的按量服务商采集器（订阅服务商无金额余额接口，不在此列）
const MONEY_BALANCE = { zhipu: collectZhipu, deepseek: collectDeepSeek, bailian: collectBailian, moonshot: collectMoonshot };
// ZCode 配置缺失时（独立运行）仍展示的基线；moonshot 无 key 时 collectMoonshot 不发网络请求，入基线零成本
const BASELINE_VENDORS = ['zhipu', 'deepseek', 'bailian', 'moonshot'];

let cache = { at: 0, value: null };

async function collect() {
  const now = Date.now();
  if (cache.value && now - cache.at < CACHE_TTL) return cache.value;
  const providers = zcodeProviders.load();
  // 需要查余额的服务商 = 基线 ∪ ZCode 里出现的按量服务商（去重）；key 探测覆盖全部 provider
  const want = new Set(BASELINE_VENDORS);
  for (const p of providers) if (p.billingKind === 'payg' && p.vendor && MONEY_BALANCE[p.vendor]) want.add(p.vendor);
  const balances = {};
  const keyChecks = {};
  // 四组只共同依赖顶部 providers，互不依赖 → 并行（原串行 await 最坏 35s+，超 index.js
  // 的 10s race 把整个 apiBilling 拖成 null；并行后最坏 ≈ 单组 9s）。单家兜底超时见各自
  // withTimeout：采集器内部 key 链是顺序尝试（每把最坏 10s），不加这层一家慢就拖穿外层。
  // 组 3/4 的结果经外层 let 接收——Promise.all 数组项的返回值本身会被丢弃，不得在
  // 返回对象里引用「同名的旧串行局部变量」（曾因此 ReferenceError 整体降级）。
  let zhipuExtraKeys = [];
  let volcengine = { available: false, reason: '采集超时（9s）', source: 'ark.cn-beijing.volces.com' };
  await Promise.all([
    // 1) 金额余额桶（zhipu/deepseek/bailian/moonshot）
    Promise.all([...want].map(async v => {
      try {
        const r = await withTimeout(MONEY_BALANCE[v](), 9000);
        balances[v] = r || { available: false, reason: '采集超时（9s）', source: v };
      } catch (e) { balances[v] = { available: false, reason: '采集异常: ' + e.message, source: v }; }
    })),
    // 2) key 健康探测：原来唯一没有超时保护的请求，包 8s 兜底（超时按「探测超时」降级，
    //    形态与正常结果一致，前端无需感知）。并行下各 provider 写各自的 providerId 键，无竞态。
    Promise.all(providers.map(async p => {
      keyChecks[p.providerId] = (await withTimeout(probeKey(p), 8000))
        || { checked: true, ok: false, reason: '探测超时（8s）', checkedAt: Date.now() };
    })),
    // 3) 智谱「其他 Key」探活
    withTimeout(collectZhipuExtras(providers), 9000).then(r => { zhipuExtraKeys = r || []; }),
    // 4) 火山方舟：模型清单采集独立于余额桶（无余额接口），结果单独成字段
    withTimeout(collectVolcengine(providers), 9000)
      .then(r => { volcengine = r || { available: false, reason: '采集超时（9s）', source: 'ark.cn-beijing.volces.com' }; }),
  ]);
  const value = { ...balances, volcengine, zhipuExtraKeys, providers: zcodeProviders.publicView(providers), keyChecks, vendors: [...want], fetchedAt: now };
  cache = { at: now, value };
  return value;
}

module.exports = {
  collect, parseCustomerInfo, parseDeepSeekBalance, parseBssBalance, parseMoonshotBalance,
  bssGetBalanceUrl, getDeepSeekKeys, getZhipuCredentials, getMoonshotKeys, probeKey, probeKeyHeaders,
  getZhipuExtraKeys, collectZhipuExtras, parseArkModels, getVolcengineKeys, collectVolcengine,
};
