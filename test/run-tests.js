'use strict';
// 测试：store 聚合 + pricing 计价 + forecast
// 运行：node test/run-tests.js
const assert = require('node:assert');
const { aggregate, monthlyForecast } = require('../server/lib/store');
const { makePricer } = require('../server/lib/pricing');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok -', name); }
  catch (e) { fail++; console.error('  FAIL -', name, '\n   ', e.message); }
}

const plans = { usdCnyRate: 7.2, priceOverrides: {} };
const pricer = makePricer(plans);

console.log('== pricing ==');
t('Codex 已带 costUsd 直接采信并按 7.2 折算', () => {
  const r = pricer.price({ model: 'gpt-x', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 1 });
  assert.equal(r.usd, 1);
  assert.ok(Math.abs(r.cny - 7.2) < 1e-9);
  assert.equal(r.equivalent, false);
});
t('glm-5.3 无 costUsd 走单价表：等价成本', () => {
  // 100万输入(20万缓存命中) + 50万输出 = (80万*8 + 20万*2)/100万 + 50万*28/100万 = 6.4+0.4+14 = 20.8 元
  const r = pricer.price({ model: 'glm-5.3', inputTokens: 1e6, outputTokens: 5e5, cacheReadTokens: 2e5, costUsd: null });
  assert.equal(r.equivalent, true);
  assert.ok(Math.abs(r.cny - 20.8) < 1e-6, `got ${r.cny}`);
});
t('缓存命中数超过输入时封顶为输入', () => {
  const r = pricer.price({ model: 'glm-5.3', inputTokens: 1e4, outputTokens: 0, cacheReadTokens: 9e4, costUsd: null });
  const r2 = pricer.price({ model: 'glm-5.3', inputTokens: 1e4, outputTokens: 0, cacheReadTokens: 1e4, costUsd: null });
  assert.ok(Math.abs(r.cny - r2.cny) < 1e-9);
});
t('未知模型只计 token 不计费', () => {
  const r = pricer.price({ model: 'hy4-preview', inputTokens: 1e6, outputTokens: 1, cacheReadTokens: 0, costUsd: null });
  assert.ok(r.noPrice && r.cny == null);
});

console.log('== aggregate ==');
const rows = [
  // UTC 9-14 20:00 = 北京 9-15 04:00 → 归 09-15
  { tool: 'codex', ts: Date.UTC(2026, 8, 14, 20, 0), model: 'gpt-5.6', inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, costUsd: 1, dedupKey: 'a' },
  { tool: 'codex', ts: Date.UTC(2026, 8, 14, 20, 0), model: 'gpt-5.6', inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, costUsd: 1, dedupKey: 'b' },
  // UTC 9-14 06:30 = 北京 9-14 14:30 → 归 09-14
  { tool: 'zcode', ts: Date.UTC(2026, 8, 14, 6, 30), model: 'GLM-5.3-Flash', inputTokens: 1e6, outputTokens: 5e5, reasoningTokens: 0, cacheReadTokens: 2e5, costUsd: null, dedupKey: 'c' },
  // UTC 8-31 16:01 = 北京 9-1 00:01 → 归 2026-09 月；改用 UTC 8-31 06:00 = 北京 8-31 14:00 → 归 08 月
  { tool: 'workbuddy', ts: Date.UTC(2026, 7, 31, 6, 0), model: 'glm-5.3-flash', inputTokens: 1e5, outputTokens: 1e3, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null, dedupKey: 'd' },
];
const agg = aggregate(rows, pricer);
t('按北京日期切分：UTC 20:00 归次日、UTC 06:30 归当日', () => {
  assert.ok(agg.daily['2026-09-15'].zcode === undefined, 'zcode 应在 09-14');
  assert.ok(agg.daily['2026-09-14'].zcode, 'zcode 应在 09-14');
  assert.ok(agg.daily['2026-09-15'].codex, 'codex 应在 09-15');
});
t('北京 8-31 归 2026-08 月', () => {
  assert.ok(agg.monthly['2026-08'].workbuddy);
});
t('Codex 双条累计 costUsd=2 → ¥14.4', () => {
  const a = agg.daily['2026-09-15'].codex;
  assert.equal(a.requests, 2);
  assert.ok(Math.abs(a.costCny - 14.4) < 1e-6);
});
t('推理 token 并入输出统计', () => {
  const a = agg.daily['2026-09-15'].codex;
  assert.equal(a.outputTokens, 20);
});
t('模型维度聚合独立成表', () => {
  assert.equal(agg.models.codex['gpt-5.6'].requests, 2);
  assert.equal(agg.models.zcode['GLM-5.3-Flash'].requests, 1);
});

console.log('== forecast ==');
t('月内线性外推 = 日均 × 当月天数', () => {
  // 手工构造：daily 里只有 09-15 一天 zcode ¥20.8，9 月 30 天
  const daily = { '2026-09-15': { zcode: { requests: 1, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, costUsd: 0, costCny: 0, equivalentCny: 20.8 } } };
  const now = Date.UTC(2026, 8, 15, 4, 0); // 北京 09-15 12:00
  const f = monthlyForecast(daily, 'zcode', now);
  assert.equal(f.daysInMonth, 30);
  assert.ok(Math.abs(f.forecastCny - 20.8 * 30) < 1e-6, `got ${f.forecastCny}`);
});

console.log('== 昨日对比 ==');
const { compareYesterday } = require('../server/lib/store');
t('昨日同期 = 昨日 0 点到昨日此刻；全天 = 昨日 24 小时', () => {
  // 北京 09-16 12:00 = UTC 09-16 04:00；昨日 = 北京 09-15，同期截止北京 09-15 12:00 = UTC 09-15 04:00
  const now = Date.UTC(2026, 8, 16, 4, 0);
  const rows = [
    { tool: 'zcode', ts: Date.UTC(2026, 8, 14, 20, 0), model: 'glm-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null }, // 北京 09-15 04:00 → 同期 + 全天
    { tool: 'zcode', ts: Date.UTC(2026, 8, 15, 10, 0), model: 'glm-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null }, // 北京 09-15 18:00 → 仅全天
    { tool: 'codex', ts: Date.UTC(2026, 8, 15, 6, 0), model: 'gpt', inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, costUsd: 1 },            // 北京 09-15 14:00 → 仅全天（超同期）
    { tool: 'workbuddy', ts: Date.UTC(2026, 8, 15, 20, 0), model: 'glm-5.3-flash', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null }, // 北京 09-16 04:00 → 昨日之外（今日）
  ];
  const cmp = compareYesterday(rows, pricer, now);
  assert.equal(cmp.yesterdaySameTime.total.requests, 1, '同期只含 04:00 那条');
  assert.ok(Math.abs(cmp.yesterdaySameTime.total.cny - 8) < 1e-6, 'glm-5.3 100万输入 = ¥8');
  assert.equal(cmp.yesterdayFull.total.requests, 3);
  assert.ok(Math.abs(cmp.yesterdayFull.total.cny - (8 + 8 + 7.2)) < 1e-6, '全天 ¥8+¥8+codex $1×7.2');
  assert.ok(Math.abs(cmp.yesterdayFull.tools.codex.cny - 7.2) < 1e-6, '按工具分桶');
  assert.equal(cmp.yesterdayFull.tools.workbuddy, undefined, '今日数据不入昨日');
});

console.log('== zhipu quota 解析 ==');
const { parseQuotaLimits } = require('../server/collectors/zhipu-quota');
t('CREDIT_LIMIT: unit3+number5 归 5h、unit6 归周，带用量与倒计时', () => {
  const now = Date.now();
  const limits = [
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 15000, currentValue: 1009, remaining: 13990, percentage: 6, nextResetTime: now + 3600e3 },
    { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 66000, currentValue: 27141, remaining: 38858, percentage: 41, nextResetTime: now + 7200e3 },
    { type: 'TIME_LIMIT', unit: 9, number: 1, usage: 100, currentValue: 1, remaining: 99, percentage: 1, nextResetTime: now + 86400e3 },
  ];
  const { fiveHour, weekly } = parseQuotaLimits(limits, now);
  assert.equal(fiveHour.usedPercent, 6);
  assert.equal(fiveHour.remainingPercent, 94);
  assert.equal(fiveHour.total, 15000);
  assert.ok(Math.abs(fiveHour.resetMsLeft - 3600e3) < 5, `got ${fiveHour.resetMsLeft}`);
  assert.equal(weekly.usedPercent, 41);
  assert.equal(weekly.remaining, 38858);
});
t('TOKENS_LIMIT（个人版形态）同样可解析', () => {
  const now = Date.now();
  const { fiveHour, weekly } = parseQuotaLimits([
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 100, currentValue: 50, remaining: 50, percentage: 50, nextResetTime: now - 1 },
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 200, currentValue: 10, remaining: 190, percentage: 5, nextResetTime: null },
  ], now);
  assert.equal(fiveHour.usedPercent, 50);
  assert.equal(fiveHour.resetMsLeft, null, '过期重置时间应置空');
  assert.equal(weekly.usedPercent, 5);
});
t('无 percentage 时按 currentValue/usage 计算', () => {
  const { fiveHour } = parseQuotaLimits([
    { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 1000, currentValue: 250, remaining: 750 },
  ], Date.now());
  assert.equal(fiveHour.usedPercent, 25);
});
t('空 limits 返回两个空窗口', () => {
  const { fiveHour, weekly } = parseQuotaLimits([], Date.now());
  assert.equal(fiveHour, null);
  assert.equal(weekly, null);
});

console.log('== quotaKeys 脱敏/合并 ==');
const { maskSecret, maskQuotaKeys, applyQuotaKeysUpdate } = require('../server/lib/plans');
t('maskSecret：长 key 掐头去尾，短 key 全遮', () => {
  assert.equal(maskSecret('88b9bae46e074c44a5af286187a1f450.TvRgrz8RRNRNGXlN'), '88b9…GXlN');
  assert.equal(maskSecret('short'), '••••');
  assert.equal(maskSecret(''), '');
});
t('maskQuotaKeys：机密脱敏，org/project 保持原值', () => {
  const cfg = { quotaKeys: { zhipu: { token: 'abcd1234efgh5678', organizationId: 'org-X', projectId: 'proj-Y' }, minimax: { apiKey: 'ey-abcdef123456' } } };
  const m = maskQuotaKeys(cfg);
  assert.equal(m.quotaKeys.zhipu.token, 'abcd…5678');
  assert.equal(m.quotaKeys.zhipu.organizationId, 'org-X');
  assert.equal(m.quotaKeys.zhipu.projectId, 'proj-Y');
  assert.equal(m.quotaKeys.minimax.apiKey, 'ey-a…3456');
  assert.equal(cfg.quotaKeys.zhipu.token, 'abcd1234efgh5678', '入参不被修改');
});
t('applyQuotaKeysUpdate：未改动的脱敏回显保留原值', () => {
  const cur = { quotaKeys: { zhipu: { token: 'real-token-value-123456', organizationId: 'org-A', projectId: 'proj-A' }, minimax: { apiKey: '' }, chatgpt: { accessToken: '' } } };
  const inc = { zhipu: { token: 'real…3456', organizationId: 'org-A', projectId: 'proj-A' }, minimax: { apiKey: '' }, chatgpt: { accessToken: '' } };
  const next = applyQuotaKeysUpdate(cur, inc);
  assert.equal(next.zhipu.token, 'real-token-value-123456');
  assert.equal(next.zhipu.organizationId, 'org-A');
});
t('applyQuotaKeysUpdate：新值覆盖、空串清除、纯文本字段直接更新', () => {
  const cur = { quotaKeys: { zhipu: { token: 'old-token-123456789', organizationId: 'org-old', projectId: 'proj-old' }, minimax: { apiKey: 'mm-old-key-123456' }, chatgpt: { accessToken: '' } } };
  const inc = {
    zhipu: { token: 'new-token-87654321', organizationId: 'org-new', projectId: '' },
    minimax: { apiKey: '' }, // 清除 → 回退自动发现
    chatgpt: { accessToken: ' ey-jwt-token ' }, // 带空白应 trim
  };
  const next = applyQuotaKeysUpdate(cur, inc);
  assert.equal(next.zhipu.token, 'new-token-87654321');
  assert.equal(next.zhipu.organizationId, 'org-new');
  assert.equal(next.zhipu.projectId, '');
  assert.equal(next.minimax.apiKey, '');
  assert.equal(next.chatgpt.accessToken, 'ey-jwt-token');
});
t('applyQuotaKeysUpdate：配置原样传递时结构完整', () => {
  const cur = { quotaKeys: undefined };
  const inc = { zhipu: {}, minimax: {}, chatgpt: {} };
  const next = applyQuotaKeysUpdate(cur, inc);
  assert.deepEqual(Object.keys(next).sort(), ['chatgpt', 'minimax', 'zhipu']);
  assert.equal(next.zhipu.token, '');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
