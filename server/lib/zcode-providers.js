'use strict';
// ZCode 自定义模型服务商发现：~/.zcode/v2/provider_config.json 为「看板该展示哪些服务商」的事实源。
// 每次快照构建都重新读（mtime 缓存），用户在 ZCode 里增删服务商 ≤60s 自动反映到看板。
// 输出描述符 [{providerId, label, vendor, billingKind, models, probe, keyMasked}]：
//   vendor      计费归属（与 pricing.vendorForRow 口径一致；未知服务商 null）
//   billingKind sk-cp- 前缀或 id 含 coding/start-plan = 订阅套餐（subscription，等价成本），其余按量（payg）
//   probe       key 健康探测端点：config.api.baseUrl 通用规则优先（anthropic-messages → base+/v1/models
//               x-api-key；其余 base+/models Bearer），无 baseUrl 时按内置模板表推断；都没有 = 不探测
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROVIDER_FILE = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');

const VENDOR_LABELS = {
  zhipu: '智谱', deepseek: 'DeepSeek', bailian: '阿里云百炼', moonshot: 'Kimi（月之暗面）',
  minimax: 'MiniMax', anthropic: 'Anthropic', openai: 'OpenAI', volcengine: '火山方舟',
};

// providerId/templateId → 服务商（关键词顺序敏感：model-studio 要在大模型厂商词之前无冲突）
function inferVendor(id) {
  const s = String(id || '').toLowerCase();
  if (s.includes('bigmodel') || s.includes('zhipu') || s.includes('glm')) return 'zhipu';
  if (s.includes('model-studio') || s.includes('bailian') || s.includes('dashscope') || s.includes('qwen') || s.includes('tongyi')) return 'bailian';
  if (s.includes('deepseek')) return 'deepseek';
  if (s.includes('moonshot') || s.includes('kimi')) return 'moonshot';
  if (s.includes('minimax') || s.includes('hailuo')) return 'minimax';
  // 火山方舟（ark 命名易撞 spark，须排除后再认）
  if (s.includes('volc') || s.includes('doubao') || (s.includes('ark') && !s.includes('spark'))) return 'volcengine';
  if (s.includes('anthropic') || s.includes('claude')) return 'anthropic';
  if (s.includes('openai') || s.includes('gpt')) return 'openai';
  return null;
}

// 无自定义 baseUrl 时按服务商推断 OpenAI 兼容探活端点（2026-10-30 五家实测全部 200）
function templateProbeHost(vendor) {
  switch (vendor) {
    case 'zhipu': return { host: 'open.bigmodel.cn', path: '/api/paas/v4/models', auth: 'bearer' };
    case 'deepseek': return { host: 'api.deepseek.com', path: '/models', auth: 'bearer' };
    case 'bailian': return { host: 'dashscope.aliyuncs.com', path: '/compatible-mode/v1/models', auth: 'bearer' };
    case 'moonshot': return { host: 'api.moonshot.cn', path: '/v1/models', auth: 'bearer' };
    case 'minimax': return { host: 'api.minimaxi.com', path: '/v1/models', auth: 'bearer' };
    case 'volcengine': return { host: 'ark.cn-beijing.volces.com', path: '/api/v3/models', auth: 'bearer' };
    default: return null;
  }
}

// config.api.baseUrl → 通用探测描述 { host, path, auth }；anthropic-messages 走 x-api-key + /v1/models
function baseUrlProbe(api) {
  const url = api && api.baseUrl;
  if (!url) return null;
  try {
    const u = new URL(url);
    const anthropic = api.type === 'anthropic-messages';
    const base = u.pathname.replace(/\/+$/, '');
    return {
      host: u.hostname,
      path: base + (anthropic ? '/v1/models' : '/models'),
      auth: anthropic ? 'x-api-key' : 'bearer',
    };
  } catch { return null; }
}

function maskKey(k) {
  const s = String(k || '');
  return s.length > 10 ? s.slice(0, 6) + '…' + s.slice(-3) : (s ? '••••' : '');
}

// 纯函数：provider_config.json 内容 → 服务商描述符数组（供采集与测试共用）
function parseRules(raw) {
  let cfg;
  try { cfg = JSON.parse(raw); } catch { return []; }
  const rules = (((cfg && cfg.config || {}).providerConfigRules || {}).providerRules) || [];
  const out = [];
  for (const r of rules) {
    const id = String((r && r.providerId) || '').trim();
    if (!id) continue;
    const c = (r && r.config) || {};
    const apiKey = String((c.access || {}).apiKey || '');
    if (!apiKey) continue; // 无 key 的规则不参与计费展示
    const vendor = inferVendor(id) || inferVendor(r.templateId || '');
    const subscription = /^sk-cp-/.test(apiKey) || /coding-plan|start-plan|token-plan/.test((id + ' ' + (r.templateId || '')).toLowerCase());
    const probe = baseUrlProbe(c.api) || templateProbeHost(vendor);
    // 火山方舟：/api/compatible/v1/models 实测只认 Bearer（x-api-key 401，聊天端点仍走 x-api-key），探活强制 Bearer
    if (vendor === 'volcengine' && probe) probe.auth = 'bearer';
    out.push({
      providerId: id,
      label: r.providerName || VENDOR_LABELS[vendor] || id,
      vendor,
      billingKind: subscription ? 'subscription' : 'payg',
      models: Array.isArray(c.personalModelIds) ? c.personalModelIds.slice(0, 8) : [],
      keyMasked: maskKey(apiKey),
      apiKey, // 服务端内部使用（探测/余额链），不得进快照
      probe,
    });
  }
  return out;
}

let cache = { mtimeMs: 0, list: [] };

function load() {
  let st = null;
  try { st = fs.statSync(PROVIDER_FILE); } catch { return []; }
  if (st.mtimeMs === cache.mtimeMs) return cache.list;
  let list = [];
  try { list = parseRules(fs.readFileSync(PROVIDER_FILE, 'utf8')); } catch { list = []; }
  cache = { mtimeMs: st.mtimeMs, list };
  return list;
}

// 快照对外形态：去掉 apiKey 等敏感内部字段
function publicView(list) {
  return list.map(p => ({
    providerId: p.providerId, label: p.label, vendor: p.vendor,
    billingKind: p.billingKind, models: p.models, keyMasked: p.keyMasked,
    hasProbe: !!p.probe,
  }));
}

module.exports = { load, parseRules, publicView, VENDOR_LABELS, inferVendor, maskKey };
