'use strict';
// 计价引擎：单价表（元/百万 token）+ 成本计算
// 单价可在 config/plans.json 的 priceOverrides 里覆盖

const DEFAULT_PRICING = {
  // 元 / 百万 tokens。cacheRead: 缓存命中输入价
  'glm-5.3':        { in: 8,   out: 28,  cacheRead: 2 },
  'glm-5.2':        { in: 8,   out: 28,  cacheRead: 2 },
  'glm-5.3-flash':  { in: 0.8, out: 2.8, cacheRead: 0.23 },
  'GLM-5.3-Flash':  { in: 0.8, out: 2.8, cacheRead: 0.23 }, // ZCode 同款
  'GLM-5.3':        { in: 8,   out: 28,  cacheRead: 2 },
  'MiniMax-M3':     { in: 4.2, out: 16.8, cacheRead: 0.845 },
  'MiniMax-M2.7':   { in: 2.1, out: 8.4,  cacheRead: null },
  'MiniMax-M2.7-highspeed': { in: 2.1, out: 8.4, cacheRead: null },
  'deepseek-v4-pro':    { in: 4,   out: 16,  cacheRead: 0.8 },
  'deepseek-v4-flash':  { in: 1,   out: 4,   cacheRead: 0.2 },
};

// 订阅制工具：成本是「等价按量成本」，非实际扣费
const SUBSCRIPTION_TOOLS = new Set(['zcode', 'workbuddy', 'claudeCode']);

// Codex 下 GPT 系列走 ChatGPT Plus 套餐（等价），其余（切 cc-switch 第三方）为真实按量
const OPENAI_SUB_MODEL = /^(gpt[-_ ]|codex-auto-review|chatgpt)/i;

function classifyRow(row) {
  if (row.tool === 'codex') row.subscription = OPENAI_SUB_MODEL.test(row.model || '');
  return row;
}

function makePricer(plans) {
  const overrides = (plans && plans.priceOverrides) || {};
  const table = Object.assign({}, DEFAULT_PRICING);
  for (const [k, v] of Object.entries(overrides)) table[k] = Object.assign({}, table[k], v);

  const fx = (plans && plans.usdCnyRate) || 7.2;

  // costUsd 已知的（cc-switch）直接采信；否则按单价表算等价成本
  function price(row) {
    if (row.costUsd != null) return { usd: row.costUsd, cny: row.costUsd * fx, equivalent: false };
    const p = table[row.model];
    if (!p) return { usd: null, cny: null, equivalent: true, noPrice: true };
    const cached = Math.min(row.cacheReadTokens || 0, row.inputTokens || 0);
    const plainIn = (row.inputTokens || 0) - cached;
    const inCost = plainIn / 1e6 * p.in + (p.cacheRead != null ? cached / 1e6 * p.cacheRead : cached / 1e6 * p.in);
    const outCost = (row.outputTokens || 0) / 1e6 * p.out;
    const cny = inCost + outCost;
    return { usd: null, cny, equivalent: true };
  }

  return { price, classifyRow, fx, table, isSubscription: t => SUBSCRIPTION_TOOLS.has(t) };
}

module.exports = { makePricer, DEFAULT_PRICING, SUBSCRIPTION_TOOLS, OPENAI_SUB_MODEL };
