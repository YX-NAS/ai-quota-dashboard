'use strict';
// 公共模型价格目录（LiteLLM 社区维护 model_prices_and_context_window，jsDelivr 镜像可达）：
// 目录口径是「$/token」，这里归一化成「裸模型名 → $/百万 token」，供「缺失单价自动补充」：
// 本地单价表（默认表 + 覆盖表）查不到的模型（如新上 GPT 系）从这里精确匹配补价。
// 原则：宁缺勿错 —— 只做精确裸名匹配（大小写不敏感），不做模糊截断；无 in/out 的条目跳过。
const priceSource = require('./price-source');

const DEFAULT_CATALOG_URL = 'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json';
const CATALOG_LIMIT_BYTES = 8 * 1024 * 1024; // 目录 ~3MB（单价源默认 256KB 上限不适用）
const CATALOG_TIMEOUT_MS = 30_000;

// 同名多提供商条目的优先级：官方线 > 托管线，取排最前者
const PROVIDER_PRIORITY = ['openai', 'zhipu', 'deepseek', 'minimax', 'moonshot', 'anthropic'];
const providerRank = p => { const i = PROVIDER_PRIORITY.indexOf(p); return i === -1 ? 99 : i; };

// 解析（纯函数）：目录 JSON 文本 → { ok, byName, total, priced } 或 { ok:false, error }。
// byName：小写裸名 → { in, out, cacheRead, cacheWrite, provider }（$/百万 token）；
// 裸名 = 键去掉「提供商/」前缀与「品牌.」前缀（azure/gpt-6.1-sol、openai.gpt-6-sol → gpt-6.1-sol / gpt-6-sol）。
function parseCatalog(text) {
  let j;
  try { j = JSON.parse(text); } catch { return { ok: false, error: '目录 JSON 解析失败' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, error: '目录顶层必须是 JSON 对象' };
  const byName = new Map();
  let priced = 0;
  const numOrNull = x => (x == null || x === '' ? NaN : Number(x)); // null ≠ 0：缺价条目必须跳过（Number(null)===0 会把缺价当免费）
  for (const [key, v] of Object.entries(j)) {
    if (!v || typeof v !== 'object') continue;
    const inUsd = numOrNull(v.input_cost_per_token);      // LiteLLM 口径：$/token
    const outUsd = numOrNull(v.output_cost_per_token);
    if (!Number.isFinite(inUsd) || !Number.isFinite(outUsd) || inUsd < 0 || outUsd < 0) continue; // 缺价/坏值条目跳过
    priced++;
    const num = x => { const n = numOrNull(x); return Number.isFinite(n) && n >= 0 ? n * 1e6 : null; };
    const r6 = n => Math.round(n * 1e6) / 1e6; // 浮点尾噪规整（1e-07×1e6 → 恰好 0.1）
    const e = {
      in: r6(inUsd * 1e6),
      out: r6(outUsd * 1e6),
      cacheRead: (() => { const c = num(v.cache_read_input_token_cost); return c == null ? null : r6(c); })(),
      cacheWrite: (() => { const c = num(v.cache_creation_input_token_cost); return c == null ? null : r6(c); })(),
      provider: String(v.litellm_provider || '').toLowerCase(),
    };
    const bare = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
    const name = bare.replace(/^[a-z]+\./, '').trim().toLowerCase();
    if (!name) continue;
    const prev = byName.get(name);
    if (!prev || providerRank(e.provider) < providerRank(prev.provider)) byName.set(name, e);
  }
  return { ok: true, byName, total: Object.keys(j).length, priced };
}

// 匹配（纯函数）：missing 模型名 → { matched: {原名: 目录价}, missed: [原名] }。
// 精确裸名匹配（大小写不敏感）；命不中进 missed（调用方如实呈报，不瞎补）。
function matchCatalog(byName, missing) {
  const matched = {}, missed = [];
  for (const m of missing) {
    const hit = byName.get(String(m || '').trim().toLowerCase());
    if (hit) matched[m] = hit; else missed.push(m);
  }
  return { matched, missed };
}

// 拉取（有副作用）：与 fetchPrices 同一套 SSRF 口径（协议白名单/拒重定向/30s 超时），上限 8MB
async function fetchCatalog(url = DEFAULT_CATALOG_URL) {
  return priceSource.fetchPrices(url, CATALOG_TIMEOUT_MS, CATALOG_LIMIT_BYTES);
}

module.exports = { parseCatalog, matchCatalog, fetchCatalog, DEFAULT_CATALOG_URL, CATALOG_LIMIT_BYTES };
