'use strict';
// 测试：store 聚合 + pricing 计价 + forecast
// 运行：node test/run-tests.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 配置目录重定向到临时目录：单测不读写真实 config/plans.json（必须在 require server 模块前设置）
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aqd-test-'));
process.env.AI_QUOTA_CONFIG_DIR = TMP_DIR;

const { aggregate, vendorAggregate, apiAggregate, modelAggregate, projectAggregate, monthlyForecast } = require('../server/lib/store');
const { makePricer, DEFAULT_PRICING, vendorOf } = require('../server/lib/pricing');

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

console.log('== pricing：cacheWrite 缓存写入计价 ==');
t('cacheWrite 缺省按输入价计 cache_creation', () => {
  // 100万输入 + 100万缓存写入 = 8 + 8 = 16 元
  const r = pricer.price({ model: 'glm-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1e6, costUsd: null });
  assert.ok(Math.abs(r.cny - 16) < 1e-6, `got ${r.cny}`);
});
t('priceOverrides 覆盖 cacheWrite 生效', () => {
  const pr = makePricer({ usdCnyRate: 7.2, priceOverrides: { 'glm-5.3': { cacheWrite: 16 } } });
  // 100万输入 + 100万缓存写入 = 8 + 16 = 24 元
  const r = pr.price({ model: 'glm-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1e6, costUsd: null });
  assert.ok(Math.abs(r.cny - 24) < 1e-6, `got ${r.cny}`);
});
t('DEFAULT_PRICING 不预填任何 cacheWrite（缺省=按输入价）', () => {
  for (const [m, p] of Object.entries(DEFAULT_PRICING)) assert.equal(p.cacheWrite, undefined, `${m} 不应预填 cacheWrite`);
});

console.log('== vendorOf：模型 → 服务商 ==');
t('vendorOf 映射：大小写不敏感 + 前缀/包含规则', () => {
  assert.equal(vendorOf('glm-5.3'), 'zhipu');
  assert.equal(vendorOf('GLM-5.3-Flash'), 'zhipu');
  assert.equal(vendorOf('glm-5.3-flash'), 'zhipu');
  assert.equal(vendorOf('MiniMax-M3'), 'minimax');
  assert.equal(vendorOf('MiniMax-M3.1-Flash'), 'minimax');
  assert.equal(vendorOf('deepseek-v4-pro'), 'deepseek');
  assert.equal(vendorOf('deepseek-chat'), 'deepseek');
  assert.equal(vendorOf('Kimi K2.7 Code'), 'moonshot');
  assert.equal(vendorOf('kimi-k2-thinking'), 'moonshot');
  assert.equal(vendorOf('k2.7-code'), 'moonshot');
  assert.equal(vendorOf('moonshot-v1-8k'), 'moonshot');
  assert.equal(vendorOf('claude-sonnet-4-5'), 'anthropic');
  assert.equal(vendorOf('gpt-5.6'), 'openai');
  assert.equal(vendorOf('o3'), 'openai');
  assert.equal(vendorOf('codex-1'), 'openai');
});
t('vendorOf：未识别/空值返回 null', () => {
  assert.equal(vendorOf('hy4-preview'), null);
  assert.equal(vendorOf(''), null);
  assert.equal(vendorOf(null), null);
  assert.equal(vendorOf(undefined), null);
});
t('vendorOf：qwen 系 → 阿里云百炼', () => {
  assert.equal(vendorOf('qwen3.8-flash'), 'bailian');
  assert.equal(vendorOf('Qwen3.7-Max'), 'bailian');
  assert.equal(vendorOf('qwq-32b'), 'bailian');
  assert.equal(vendorOf('tongyi-x-coder'), 'bailian');
});
t('vendorOf：豆包系原生模型 → 火山方舟', () => {
  assert.equal(vendorOf('doubao-seed-2-1-pro-260915'), 'volcengine');
  assert.equal(vendorOf('Doubao-seed-1-6-250615'), 'volcengine');
  assert.equal(vendorOf('doubao-seedance-2-5-260628'), 'volcengine');
  assert.equal(vendorOf('doubao-seedream-5-0-pro-260628'), 'volcengine');
  assert.equal(vendorOf('hunyuan-turbo'), 'volcengine');
});

console.log('== vendorForRow：provider_id 归因（按量口径） ==');
const { vendorForRow } = require('../server/lib/pricing');
t('vendorForRow：provider 映射优先于模型名', () => {
  assert.equal(vendorForRow({ providerId: 'bigmodel-api', model: 'GLM-5.3' }), 'zhipu');
  assert.equal(vendorForRow({ providerId: 'deepseek', model: 'deepseek-v4-pro' }), 'deepseek');
  // 百炼托管三方模型：计费在阿里云侧，按 provider 归 bailian（模型名会误判 zhipu/moonshot）
  assert.equal(vendorForRow({ providerId: 'qwen-alibaba-model-studio-cn', model: 'glm-5.3' }), 'bailian');
  assert.equal(vendorForRow({ providerId: 'qwen-alibaba-model-studio-cn', model: 'kimi-k3' }), 'bailian');
  assert.equal(vendorForRow({ providerId: 'qwen-alibaba-model-studio-cn', model: 'qwen3.8-flash' }), 'bailian');
  assert.equal(vendorForRow({ providerId: 'minimax', model: 'MiniMax-M3.1-Flash' }), 'minimax');
});
t('vendorForRow：订阅制 provider 返回 null（套餐等价不进按量桶）', () => {
  assert.equal(vendorForRow({ providerId: 'account:bigmodel-team-coding-plan', model: 'GLM-5.3' }), null);
  assert.equal(vendorForRow({ providerId: 'account:bigmodel-start-plan', model: 'GLM-5.3' }), null);
  assert.equal(vendorForRow({ providerId: 'zai-coding-plan', model: 'GLM-5.3' }), null);
});
t('vendorForRow：无 provider 回退模型名规则', () => {
  assert.equal(vendorForRow({ model: 'deepseek-v4-flash' }), 'deepseek');
  assert.equal(vendorForRow({ providerId: 'some-unknown-hub', model: 'glm-5.2' }), 'zhipu');
});
t('vendorForRow：方舟线路托管三方模型 → volcengine（模型名不改判）', () => {
  // 方舟托管的 glm/deepseek/kimi/qwen 计费在火山侧，provider 优先于模型名（同百炼托管规则）
  assert.equal(vendorForRow({ providerId: 'volcengine-ark-cn', model: 'glm-5.3' }), 'volcengine');
  assert.equal(vendorForRow({ providerId: 'ark-doubao', model: 'deepseek-v4-pro' }), 'volcengine');
  assert.equal(vendorForRow({ providerId: 'doubao-ark', model: 'kimi-k3' }), 'volcengine');
  // ark 关键词不误伤讯飞 spark
  assert.equal(vendorForRow({ providerId: 'iflytek-spark', model: 'glm-5.3' }), 'zhipu');
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
t('applyCost 累计 cacheCreationTokens（tool/__total/models 桶）', () => {
  const a2 = aggregate([{
    tool: 'zcode', ts: Date.UTC(2026, 8, 14, 6, 30), model: 'GLM-5.3-Flash',
    inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 2, cacheCreationTokens: 7, costUsd: null,
  }], pricer);
  assert.equal(a2.daily['2026-09-14'].zcode.cacheCreationTokens, 7);
  assert.equal(a2.daily['2026-09-14'].__total.cacheCreationTokens, 7);
  assert.equal(a2.models.zcode['GLM-5.3-Flash'].cacheCreationTokens, 7);
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

console.log('== vendorAggregate：API 按量计费按服务商聚合 ==');
t('vendorAggregate：跨工具归集今日/本月，窗口外行不建桶', () => {
  const now = Date.UTC(2026, 8, 15, 12, 0); // 北京 2026-09-15 20:00
  const rows = [
    { tool: 'zcode', ts: now - 3600e3, model: 'glm-5.3', inputTokens: 1e6, outputTokens: 5e5, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },        // 智谱 ¥22
    { tool: 'workbuddy', ts: now - 7200e3, model: 'GLM-5.3-Flash', inputTokens: 1e5, outputTokens: 1e3, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null },                        // 智谱 ¥0.0828
    { tool: 'claudeCode', ts: now - 86400e3 * 20, model: 'deepseek-v4-flash', inputTokens: 2e5, outputTokens: 1e5, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null },              // 上月 → 不建桶
    { tool: 'codex', ts: now - 3600e3, model: 'gpt-5.6', inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, costUsd: 1 },                                       // OpenAI 真实扣费 ¥7.2
  ];
  const v = vendorAggregate(rows, pricer, now);
  assert.ok(Math.abs(v.zhipu.today.costCny - 22.0828) < 1e-6, `got ${v.zhipu.today.costCny}`);
  assert.equal(v.zhipu.today.requests, 2);
  assert.equal(v.zhipu.today.inputTokens, 1.1e6);
  assert.equal(v.zhipu.month.requests, 2, '今日行同属本月');
  assert.ok(Math.abs(v.openai.today.costCny - 7.2) < 1e-6, 'costUsd 直接采信 × 7.2');
  assert.equal(v.openai.today.requests, 1);
  assert.equal(v.deepseek, undefined, '窗口外的行不建全 0 桶');
});
t('vendorAggregate：无单价 / 未识别模型不计费不建桶', () => {
  const now = Date.UTC(2026, 8, 15, 12, 0);
  const rows = [
    { tool: 'zcode', ts: now, model: 'hy4-preview', inputTokens: 1e6, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null },
    { tool: 'zcode', ts: now, model: 'unknown-model', inputTokens: 1e6, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null },
  ];
  assert.deepEqual(vendorAggregate(rows, pricer, now), {});
  assert.deepEqual(vendorAggregate([], pricer, now), {});
});
t('vendorAggregate：订阅行剔除 + 百炼托管三方模型归 bailian + qwen 单价', () => {
  const now = Date.UTC(2026, 8, 15, 12, 0); // 北京 09-15 20:00
  const rows = [
    // 团队套餐（订阅）的 glm 行：不进 zhipu 按量桶
    { tool: 'zcode', ts: now - 1000, providerId: 'account:bigmodel-team-coding-plan', model: 'GLM-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null },
    // 智谱按量线路 glm 行：进 zhipu，100万输入 = ¥8
    { tool: 'zcode', ts: now - 1000, providerId: 'bigmodel-api', model: 'GLM-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null },
    // 百炼托管的 glm 模型：归 bailian 而非 zhipu
    { tool: 'zcode', ts: now - 1000, providerId: 'qwen-alibaba-model-studio-cn', model: 'glm-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null },
    // qwen3.8-flash：输入 100万 输出 10万 = 0.8 + 0.27 = ¥1.07
    { tool: 'zcode', ts: now - 1000, providerId: 'qwen-alibaba-model-studio-cn', model: 'qwen3.8-flash', inputTokens: 1e6, outputTokens: 1e5, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null },
  ];
  const v = vendorAggregate(rows, pricer, now);
  assert.equal(v.zhipu.today.requests, 1, '订阅行被剔除，只剩按量 glm');
  assert.ok(Math.abs(v.zhipu.today.costCny - 8) < 1e-6);
  assert.equal(v.bailian.today.requests, 2, '百炼自营 + 托管 glm 都归 bailian');
  assert.ok(Math.abs(v.bailian.today.costCny - (8 + 1.07)) < 1e-6, `got ${v.bailian.today.costCny}`);
});

t('vendorAggregate：无单价模型的行仍计入用量（noPriceRequests 单列，费用为 0）', () => {
  const now = Date.UTC(2026, 8, 15, 12, 0); // 北京 09-15 20:00
  const rows = [
    { tool: 'zcode', ts: now - 1000, providerId: 'moonshot-kimi', model: 'kimi-k3.1-pro', inputTokens: 5e5, outputTokens: 1e5, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null }, // 无单价
    { tool: 'zcode', ts: now - 1000, providerId: 'moonshot-kimi', model: 'kimi-k3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null }, // 同样无单价
    { tool: 'zcode', ts: now - 1000, providerId: 'deepseek', model: 'deepseek-v4-flash', inputTokens: 2e5, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null }, // 有单价：¥0.3
  ];
  const v = vendorAggregate(rows, pricer, now);
  assert.equal(v.moonshot.today.requests, 2, '未计价行不能从用量桶消失');
  assert.equal(v.moonshot.today.noPriceRequests, 2);
  assert.equal(v.moonshot.today.costCny, 0);
  assert.equal(v.moonshot.today.inputTokens, 1.5e6);
  assert.equal(v.moonshot.month.noPriceRequests, 2, '今日行同属本月');
  assert.equal(v.deepseek.today.noPriceRequests, 0);
  assert.ok(Math.abs(v.deepseek.today.costCny - 0.3) < 1e-9, `got ${v.deepseek.today.costCny}`);
});

console.log('== apiAggregate：API 维度（每把 Key 一桶 × 模型明细） ==');
t('apiAggregate：同厂商多 Key 分桶 + 无 provider 行落按模型归因桶 + 各桶合计与 vendorAggregate 对账', () => {
  const now = Date.UTC(2026, 9, 31, 4, 0); // 北京 2026-10-31 12:00
  const rows = [
    // 智谱主 Key 按量：100万输入 = ¥8
    { tool: 'zcode', ts: now - 1000, providerId: 'bigmodel-api', model: 'GLM-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
    // 第二把智谱 Key：GLM-5.3-Flash 10万输入+1千输出 = ¥0.0828
    { tool: 'zcode', ts: now - 2000, providerId: 'bigmodel-api-usable', model: 'GLM-5.3-Flash', inputTokens: 1e5, outputTokens: 1e3, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
    // Claude Code 路由的 glm（无 provider 标记）→ model:zhipu 桶，¥8
    { tool: 'claudeCode', ts: now - 3000, model: 'glm-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
    // 团队套餐（订阅）行：剔除
    { tool: 'zcode', ts: now - 4000, providerId: 'account:bigmodel-team-coding-plan', model: 'GLM-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
  ];
  const au = apiAggregate(rows, pricer, now);
  assert.deepEqual(Object.keys(au).sort(), ['bigmodel-api', 'bigmodel-api-usable', 'model:zhipu'], '三桶：两把 Key + 按模型归因');
  assert.equal(au['bigmodel-api'].vendor, 'zhipu');
  assert.ok(Math.abs(au['bigmodel-api'].today.costCny - 8) < 1e-6);
  assert.ok(Math.abs(au['bigmodel-api'].month.costCny - 8) < 1e-6, '今日行同属本月');
  assert.ok(Math.abs(au['bigmodel-api'].today.models['GLM-5.3'].costCny - 8) < 1e-6, '模型明细 = 桶合计');
  assert.equal(au['bigmodel-api'].today.models['GLM-5.3'].requests, 1);
  assert.ok(Math.abs(au['bigmodel-api-usable'].today.costCny - 0.0828) < 1e-6);
  assert.equal(au['bigmodel-api-usable'].today.models['GLM-5.3-Flash'].requests, 1, '桶内模型按调用拆行');
  assert.equal(au['model:zhipu'].vendor, 'zhipu');
  assert.ok(Math.abs(au['model:zhipu'].today.costCny - 8) < 1e-6, '无 provider 行按模型归因');
  assert.equal(au['model:zhipu'].today.models['glm-5.3'].requests, 1);
  // 对账：同服务商各桶合计 == vendorAggregate 同口径
  const v = vendorAggregate(rows, pricer, now);
  const sum = au['bigmodel-api'].month.costCny + au['bigmodel-api-usable'].month.costCny + au['model:zhipu'].month.costCny;
  assert.ok(Math.abs(sum - v.zhipu.month.costCny) < 1e-9, `对账 ${sum} vs ${v.zhipu.month.costCny}`);
  assert.ok(Math.abs(sum - 16.0828) < 1e-6, '订阅行不入任何桶');
});
t('apiAggregate：窗口——本月早先行只进月桶、上月行不建桶、无单价模型计入用量', () => {
  const now = Date.UTC(2026, 9, 31, 4, 0); // 北京 2026-10-31 12:00
  const rows = [
    // 本月 10 号的行：只进 month
    { tool: 'zcode', ts: now - 21 * 86400e3, providerId: 'deepseek', model: 'deepseek-v4-flash', inputTokens: 2e5, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null }, // ¥0.3
    // 上月的行：不建桶
    { tool: 'zcode', ts: now - 40 * 86400e3, providerId: 'deepseek', model: 'deepseek-v4-flash', inputTokens: 2e5, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
    // 今日无单价模型：计入用量与模型明细，费用 0
    { tool: 'zcode', ts: now - 1000, providerId: 'moonshot-kimi', model: 'kimi-k3.1-pro', inputTokens: 5e5, outputTokens: 1e5, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
  ];
  const au = apiAggregate(rows, pricer, now);
  assert.equal(au.deepseek.today.requests, 0, '本月早先行不进今日桶');
  assert.equal(au.deepseek.month.requests, 1);
  assert.ok(Math.abs(au.deepseek.month.costCny - 0.3) < 1e-9);
  assert.equal(au.deepseek.today.models['deepseek-v4-flash'], undefined, '今日未用该模型');
  assert.equal(au['moonshot-kimi'].today.noPriceRequests, 1);
  assert.equal(au['moonshot-kimi'].today.costCny, 0);
  assert.equal(au['moonshot-kimi'].today.models['kimi-k3.1-pro'].noPriceRequests, 1, '无单价模型的明细行也在');
  assert.equal(au['moonshot-kimi'].today.models['kimi-k3.1-pro'].requests, 1);
  // 上月行不产生额外桶（deepseek 桶由本月行建立）
  assert.equal(Object.keys(au).length, 2);
});
t('apiAggregate：百炼托管三方模型按 provider 归属（key=providerId，vendor=bailian）', () => {
  const now = Date.UTC(2026, 9, 31, 4, 0);
  const rows = [
    { tool: 'zcode', ts: now - 1000, providerId: 'qwen-alibaba-model-studio-cn', model: 'glm-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
  ];
  const au = apiAggregate(rows, pricer, now);
  assert.equal(au['qwen-alibaba-model-studio-cn'].vendor, 'bailian', 'provider 归属优先于模型名');
  assert.ok(Math.abs(au['qwen-alibaba-model-studio-cn'].today.models['glm-5.3'].costCny - 8) < 1e-6);
  assert.equal(au['model:bailian'], undefined, '有 provider 标记的行不落归因桶');
});

console.log('== modelAggregate / projectAggregate：今日模型排行 + 项目维度聚合 ==');
t('modelAggregate：跨工具合并今日，费用口径分列，vendor 附带，无单价行计用量', () => {
  const now = Date.UTC(2026, 8, 15, 12, 0); // 北京 2026-09-15 20:00
  const rows = [
    { tool: 'zcode', ts: now - 1000, model: 'glm-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
    { tool: 'workbuddy', ts: now - 2000, model: 'glm-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
    { tool: 'codex', ts: now - 3000, model: 'gpt-5.6', inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 1 },
    { tool: 'zcode', ts: now - 45 * 86400e3, model: 'glm-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null }, // 上月 → 两窗口都不建
    { tool: 'zcode', ts: now - 1000, model: 'kimi-k3.1-pro', inputTokens: 1e5, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null }, // 无单价
  ];
  const mu = modelAggregate(rows, pricer, now);
  assert.equal(mu['glm-5.3'].today.requests, 2, '跨工具合并今日');
  assert.equal(mu['glm-5.3'].today.inputTokens, 2e6);
  assert.equal(mu['glm-5.3'].month.requests, 2, '今日行同属本月计入 month；45 天前的 8 月行不计入任何窗口');
  assert.equal(mu['glm-5.3'].vendor, 'zhipu');
  assert.ok(Math.abs(mu['glm-5.3'].today.equivalentCny - 16) < 1e-6, '订阅等价 ¥16 走 equivalentCny');
  assert.ok(Math.abs(mu['gpt-5.6'].today.costCny - 7.2) < 1e-6, '真实扣费走 costCny');
  assert.equal(mu['kimi-k3.1-pro'].today.noPriceRequests, 1);
  assert.equal(mu['kimi-k3.1-pro'].today.requests, 1, '无单价行仍计用量');
});
t('modelAggregate：本月早先行只进 month 桶不进 today', () => {
  const now = Date.UTC(2026, 9, 31, 4, 0); // 北京 2026-10-31 12:00
  const rows = [
    { tool: 'zcode', ts: now - 10 * 86400e3, model: 'glm-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
  ];
  const mu = modelAggregate(rows, pricer, now);
  assert.equal(mu['glm-5.3'].today.requests, 0);
  assert.equal(mu['glm-5.3'].month.requests, 1);
});
t('projectAggregate：无项目行剔除 + 今日/累计双窗口 + 模型子桶 + label 回退', () => {
  const now = Date.UTC(2026, 8, 15, 12, 0);
  const rows = [
    { tool: 'zcode', ts: now - 1000, model: 'glm-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, project: 'proj_a', projectLabel: 'a' },
    { tool: 'zcode', ts: now - 3 * 86400e3, model: 'glm-5.3-flash', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, project: 'proj_a', projectLabel: 'a' },
    { tool: 'zcode', ts: now - 1000, model: 'glm-5.3', inputTokens: 1e5, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null }, // 无项目 → 剔除
    { tool: 'claudeCode', ts: now - 2000, model: 'deepseek-v4-flash', inputTokens: 2e5, outputTokens: 1e5, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, project: '/Users/x/proj-b', projectLabel: 'proj-b' },
    { tool: 'zcode', ts: now - 1000, model: 'glm-5.3-flash', inputTokens: 1e5, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, project: 'proj_c' }, // 无 label → 回退键
  ];
  const pj = projectAggregate(rows, pricer, now);
  assert.equal(Object.keys(pj).length, 3, '无项目行不建桶（proj_a / proj-b / proj_c）');
  const a = pj['proj_a'];
  assert.equal(a.today.requests, 1, '3 天前的行不进今日');
  assert.equal(a.total.requests, 2, '累计含 3 天前那条');
  assert.ok(a.total.models['glm-5.3-flash'], '模型子桶按项目拆');
  assert.equal(a.label, 'a');
  const b = pj['/Users/x/proj-b'];
  assert.equal(b.label, 'proj-b');
  // deepseek-v4-flash 分时均值价：2e5×1.5/1e6 + 1e5×6/1e6 = 0.9
  assert.ok(Math.abs(b.today.costCny + b.today.equivalentCny - 0.9) < 1e-6, `got ${b.today.costCny + b.today.equivalentCny}`);
  assert.equal(pj['proj_c'].label, 'proj_c', 'label 缺省回退聚合键');
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
t('maskSecret：JWT 不保留头部特征，掩码里 grep 不到 eyJ', () => {
  const m = maskSecret('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc.def');
  assert.ok(!m.includes('eyJ'), `got ${m}`);
  assert.ok(m.endsWith('c.def'.slice(-4)));
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
  const inc = { zhipu: {}, minimax: {}, chatgpt: {}, deepseek: {} };
  const next = applyQuotaKeysUpdate(cur, inc);
  assert.deepEqual(Object.keys(next).sort(), ['bailian', 'chatgpt', 'deepseek', 'minimax', 'moonshot', 'volcengine', 'vpnPanel', 'zhipu']);
  assert.equal(next.zhipu.token, '');
  assert.equal(next.volcengine.apiKey, '', 'volcengine 缺省为空（回退 ZCode 自动发现）');
});
t('applyQuotaKeysUpdate：deepseek apiKey 新值覆盖 / 脱敏回显保留 / 空串清除', () => {
  const cur = { quotaKeys: { deepseek: { apiKey: 'sk-old-key-1234567890' } } };
  const next = applyQuotaKeysUpdate(cur, { deepseek: { apiKey: 'sk-new-key-abcdefghij' } });
  assert.equal(next.deepseek.apiKey, 'sk-new-key-abcdefghij');
  const keep = applyQuotaKeysUpdate(cur, { deepseek: { apiKey: maskSecret('sk-old-key-1234567890') } });
  assert.equal(keep.deepseek.apiKey, 'sk-old-key-1234567890', '脱敏回显 = 未改动');
  const clear = applyQuotaKeysUpdate(cur, { deepseek: { apiKey: '' } });
  assert.equal(clear.deepseek.apiKey, '', '空串 = 清除回退自动发现');
});
t('applyQuotaKeysUpdate：bailian AccessKey —— Secret 脱敏往返，ID 原样', () => {
  const cur = { quotaKeys: { bailian: { accessKeyId: 'LTAI5tRealId', accessKeySecret: 'real-secret-value-9876' } } };
  const m = require('../server/lib/plans').maskQuotaKeys(cur);
  assert.equal(m.quotaKeys.bailian.accessKeyId, 'LTAI5tRealId', 'accessKeyId 非机密原样');
  assert.equal(m.quotaKeys.bailian.accessKeySecret, 'real…9876');
  const keep = applyQuotaKeysUpdate(cur, { bailian: { accessKeyId: 'LTAI5tRealId', accessKeySecret: 'real…9876' } });
  assert.equal(keep.bailian.accessKeySecret, 'real-secret-value-9876');
  assert.equal(keep.bailian.accessKeyId, 'LTAI5tRealId');
});
t('maskQuotaKeys：zhipu.extraKeys 数组逐项脱敏 apiKey，label 原样', () => {
  const EXTRA = 'ff00bb44de220c11ab55cd33ef778899.t3stKeyNOTrEAL0000';
  const cfg = { quotaKeys: { zhipu: { token: '', extraKeys: [
    { label: '可用api', apiKey: EXTRA },
    { label: '备用', apiKey: 'short' },
  ] } } };
  const m = maskQuotaKeys(cfg);
  assert.equal(m.quotaKeys.zhipu.extraKeys[0].label, '可用api', 'label 非机密原样');
  assert.equal(m.quotaKeys.zhipu.extraKeys[0].apiKey, 'ff00…0000');
  assert.equal(m.quotaKeys.zhipu.extraKeys[1].apiKey, '••••', '短 key 全遮');
  assert.equal(cfg.quotaKeys.zhipu.extraKeys[0].apiKey, EXTRA, '入参不被修改');
});
t('applyQuotaKeysUpdate：zhipu.extraKeys 新值 / 掩码回显保留（可改名）/ 去重 / 默认名 / 清除', () => {
  const EXTRA = 'ff00bb44de220c11ab55cd33ef778899.t3stKeyNOTrEAL0000';
  const cur = { quotaKeys: { zhipu: { token: '', extraKeys: [{ label: '可用api', apiKey: EXTRA }] } } };
  const masked = maskSecret(EXTRA);
  // 掩码回显 + 改名 → 保留原 key；新 label 空补默认名
  const keep = applyQuotaKeysUpdate(cur, { zhipu: { extraKeys: [
    { label: '可用api改名', apiKey: masked },
    { label: '', apiKey: 'id2222.secret22222222222222' },
  ] } });
  assert.equal(keep.zhipu.extraKeys[0].apiKey, EXTRA, '掩码回显 = 未改动保留原值');
  assert.equal(keep.zhipu.extraKeys[0].label, '可用api改名', 'label 可独立修改');
  assert.equal(keep.zhipu.extraKeys[1].label, '智谱 Key 2', 'label 空补默认名');
  // 同 key 去重
  const dup = applyQuotaKeysUpdate(cur, { zhipu: { extraKeys: [
    { label: 'A', apiKey: 'k1234567890abcdefgh' }, { label: 'B', apiKey: 'k1234567890abcdefgh' },
  ] } });
  assert.equal(dup.zhipu.extraKeys.length, 1, '同 key 去重');
  // 空 apiKey 丢弃 / 未提交 = 整体清除（与标量语义一致）
  const drop = applyQuotaKeysUpdate(cur, { zhipu: { extraKeys: [{ label: 'x', apiKey: '' }] } });
  assert.deepEqual(drop.zhipu.extraKeys, [], '空 apiKey 丢弃');
  const clear = applyQuotaKeysUpdate(cur, { zhipu: {} });
  assert.deepEqual(clear.zhipu.extraKeys, [], '未提交 = 清除');
});

console.log('== api-billing：余额解析 ==');
const { parseCustomerInfo, parseDeepSeekBalance, parseBssBalance, parseMoonshotBalance, bssGetBalanceUrl } = require('../server/collectors/api-billing');
t('parseCustomerInfo：数字/字符串/null 余额字段归一为数字', () => {
  const p = parseCustomerInfo({
    success: true, code: 200,
    data: { customerNumber: '63011793342200398', balance: '12.50', availableBalance: 12.5, rechargeAmount: 100, giveAmount: 0 },
  });
  assert.equal(p.customerNumber, '63011793342200398');
  assert.equal(p.balance, 12.5);
  assert.equal(p.availableBalance, 12.5);
  assert.equal(p.rechargeAmount, 100);
  assert.equal(p.giveAmount, 0);
});
t('parseCustomerInfo：新账户未充值 → 全 null；坏响应 → null', () => {
  const p = parseCustomerInfo({ success: true, data: { balance: null, availableBalance: null, rechargeAmount: null, giveAmount: null } });
  assert.equal(p.balance, null);
  assert.equal(p.availableBalance, null);
  assert.equal(parseCustomerInfo({ success: false, msg: 'x' }), null);
  assert.equal(parseCustomerInfo({ success: true, data: null }), null);
  assert.equal(parseCustomerInfo(null), null);
});
t('parseDeepSeekBalance：CNY 行优先 + 字符串金额转数字', () => {
  const p = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '1.00', granted_balance: '0', topped_up_balance: '1.00' },
      { currency: 'CNY', total_balance: '6448.51', granted_balance: '0.00', topped_up_balance: '6448.51' },
    ],
  });
  assert.equal(p.total, 6448.51);
  assert.equal(p.granted, 0);
  assert.equal(p.toppedUp, 6448.51);
});
t('parseDeepSeekBalance：不可用 / 空列表 / 无 total → null', () => {
  assert.equal(parseDeepSeekBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '1' }] }), null);
  assert.equal(parseDeepSeekBalance({ is_available: true, balance_infos: [] }), null);
  assert.equal(parseDeepSeekBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: null }] }), null);
});
t('parseBssBalance：字符串金额转数字 + 现金/代金券；坏响应 null', () => {
  const p = parseBssBalance({ Code: 'Success', Data: { AvailableAmount: '123.45', BalanceAmount: '100.00', CreditAmount: '23.45', Currency: 'CNY' } });
  assert.equal(p.total, 123.45);
  assert.equal(p.cash, 100);
  assert.equal(p.credit, 23.45);
  assert.equal(p.currency, 'CNY');
  assert.equal(parseBssBalance({ Code: 'AuthFailure' }), null);
  assert.equal(parseBssBalance({ Code: 'Success', Data: { AvailableAmount: null } }), null);
  assert.equal(parseBssBalance(null), null);
});
t('bssGetBalanceUrl：RPC 签名 URL 结构（排序参数 + Signature）', () => {
  const { host, path } = bssGetBalanceUrl('TestId', 'TestSecret', 'fixed-nonce', Date.UTC(2026, 9, 30, 12, 0, 0));
  assert.equal(host, 'business.aliyuncs.com');
  assert.ok(path.startsWith('/?AccessKeyId='), '参数按字母序（AccessKeyId 在 Action 前）');
  assert.ok(path.includes('Action=GetAccountBalance'));
  assert.ok(path.includes('&Timestamp=2026-10-30T12%3A00%3A00Z'), '冒号已百分号编码');
  assert.ok(/[&?]Signature=/.test(path), '末尾带 Signature');
  // 同参重放签名稳定（HMAC-SHA1 确定性）
  const again = bssGetBalanceUrl('TestId', 'TestSecret', 'fixed-nonce', Date.UTC(2026, 9, 30, 12, 0, 0));
  assert.equal(again.path, path);
});

t('probeKeyHeaders：anthropic-messages 用 x-api-key，其余 Bearer', () => {
  const p = { apiKey: 'sk-test-123', probe: { auth: 'x-api-key' } };
  const h = require('../server/collectors/api-billing').probeKeyHeaders(p);
  assert.equal(h['x-api-key'], 'sk-test-123');
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert.equal(h.Authorization, undefined);
  const h2 = require('../server/collectors/api-billing').probeKeyHeaders({ apiKey: 'sk-test-123', probe: { auth: 'bearer' } });
  assert.equal(h2.Authorization, 'Bearer sk-test-123');
});
t('parseMoonshotBalance：available/cash/voucher；坏响应 null', () => {
  const p = parseMoonshotBalance({ code: 0, data: { available_balance: 9100.937, cash_balance: 9100.937, voucher_balance: 0 } });
  assert.equal(p.total, 9100.937);
  assert.equal(p.cash, 9100.937);
  assert.equal(p.credit, 0);
  assert.equal(parseMoonshotBalance({ code: 401, error: 'x' }), null);
  assert.equal(parseMoonshotBalance({ code: 0, data: { available_balance: null } }), null);
});
t('parseArkModels：status 缺省=在售，Shutdown/Retiring 分列；坏响应 null', () => {
  const { parseArkModels } = require('../server/collectors/api-billing');
  const p = parseArkModels({ data: [
    { id: 'doubao-seed-2-1-pro-260915' },
    { id: 'doubao-lite-4k-240328', status: 'Shutdown' },
    { id: 'doubao-embedding-text-240515', status: 'Retiring' },
    { id: 'glm-5-2-260617' },
  ] });
  assert.equal(p.activeCount, 2);
  assert.equal(p.retiringCount, 1);
  assert.equal(p.shutdownCount, 1);
  assert.equal(p.totalCount, 4);
  assert.deepEqual(p.active, ['doubao-seed-2-1-pro-260915', 'glm-5-2-260617'], '在售清单按 id 排序');
  assert.equal(parseArkModels({ data: [] }), null, '空列表 → null');
  assert.equal(parseArkModels({ data: null }), null);
  assert.equal(parseArkModels(null), null);
});

console.log('== zcode-providers：自定义模型服务商发现 ==');
const zp = require('../server/lib/zcode-providers');
const RULES_FIXTURE = JSON.stringify({
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: [
      { providerId: 'bigmodel-api', templateId: 'bigmodel-api', config: { access: { type: 'api-key', apiKey: '9b22db81f93d4b5898f0cf412abbf3f2.Y35YrqOPY5q4mxey' } } },
      { providerId: 'qwen-alibaba-model-studio-cn', templateId: 'qwen-alibaba-model-studio-cn', config: { access: { apiKey: 'sk-8944dea1234567890abcdef' }, personalModelIds: ['kimi-k3', 'glm-5.3'] } },
      { providerId: 'moonshot-kimi', templateId: 'moonshot-kimi', config: { access: { apiKey: 'sk-H86abcdef123456' } } },
      { providerId: 'minimax', providerName: 'MiniMax', config: { access: { apiKey: 'sk-cp-iF7Zabcdef5F-g' }, api: { type: 'anthropic-messages', baseUrl: 'https://api.minimaxi.com/anthropic' }, personalModelIds: ['MiniMax-M3'] } },
      { providerId: 'no-key-hub', config: { access: {} } },
      { providerId: 'weird-xyz', config: { access: { apiKey: 'sk-weird' } } },
    ] },
  },
});
t('parseRules：vendor 推断 / 订阅分类 / 探测端点（模板表 + baseUrl 规则）', () => {
  const list = zp.parseRules(RULES_FIXTURE);
  const byId = Object.fromEntries(list.map(p => [p.providerId, p]));
  assert.deepEqual(list.map(p => p.providerId), ['bigmodel-api', 'qwen-alibaba-model-studio-cn', 'moonshot-kimi', 'minimax', 'weird-xyz'], '无 key 的规则剔除');
  assert.equal(byId['bigmodel-api'].vendor, 'zhipu');
  assert.equal(byId['bigmodel-api'].billingKind, 'payg');
  assert.equal(byId['bigmodel-api'].probe.host, 'open.bigmodel.cn');
  assert.equal(byId['bigmodel-api'].probe.path, '/api/paas/v4/models');
  assert.equal(byId['qwen-alibaba-model-studio-cn'].vendor, 'bailian');
  assert.deepEqual(byId['qwen-alibaba-model-studio-cn'].models, ['kimi-k3', 'glm-5.3']);
  assert.equal(byId['moonshot-kimi'].vendor, 'moonshot');
  assert.equal(byId['minimax'].billingKind, 'subscription', 'sk-cp- 前缀 = 订阅');
  assert.equal(byId['minimax'].label, 'MiniMax', 'providerName 覆盖');
  assert.equal(byId['minimax'].probe.host, 'api.minimaxi.com', 'api.baseUrl 优先于模板表');
  assert.equal(byId['minimax'].probe.path, '/anthropic/v1/models', 'anthropic-messages → base + /v1/models');
  assert.equal(byId['minimax'].probe.auth, 'x-api-key');
  assert.equal(byId['weird-xyz'].vendor, null, '未知服务商');
  assert.equal(byId['weird-xyz'].label, 'weird-xyz', '无 vendor 时 label 回落 providerId');
  assert.equal(byId['weird-xyz'].probe, null, '无 baseUrl 无模板 → 不探测');
});
t('parseRules：坏 JSON / 空配置 → []；publicView 不带 apiKey 与 probe', () => {
  assert.deepEqual(zp.parseRules('not-json'), []);
  assert.deepEqual(zp.parseRules('{}'), []);
  const view = zp.publicView(zp.parseRules(RULES_FIXTURE));
  const blob = JSON.stringify(view);
  assert.ok(!blob.includes('sk-cp-iF7Z') && !blob.includes('9b22db81'), '快照不得出现明文 key');
  assert.ok(view.every(p => !('apiKey' in p) && !('probe' in p)));
  assert.ok(view.every(p => 'keyMasked' in p && 'hasProbe' in p));
});
t('inferVendor 与 maskKey', () => {
  assert.equal(zp.inferVendor('moonshot-kimi'), 'moonshot');
  assert.equal(zp.inferVendor('volcengine-ark-cn'), 'volcengine');
  assert.equal(zp.inferVendor('ark-doubao'), 'volcengine');
  assert.equal(zp.inferVendor('volc-ark'), 'volcengine', '2026-10-31 起火山方舟入识别表');
  assert.equal(zp.inferVendor('iflytek-spark'), null, 'ark 子串不误伤讯飞 spark');
  assert.equal(zp.maskKey('sk-8ea5ac5123456789abcdefghij2223'), 'sk-8ea…223');
  assert.equal(zp.maskKey('short'), '••••');
});
t('parseRules：火山方舟 provider 探活强制 Bearer（/api/compatible/v1/models 实测拒 x-api-key）', () => {
  const list = zp.parseRules(JSON.stringify({
    schemaVersion: 1,
    config: { providerConfigRules: { providerRules: [
      { providerId: 'volcengine-ark', templateId: 'volcengine-ark',
        config: { access: { apiKey: 'ark-df05c061-test-87907' },
          api: { type: 'anthropic-messages', baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible' },
          personalModelIds: ['doubao-seed-2-1-pro-260915', 'doubao-seed-evolving'] } },
    ] } },
  }));
  assert.equal(list.length, 1);
  const p = list[0];
  assert.equal(p.vendor, 'volcengine');
  assert.equal(p.billingKind, 'payg', 'ark- 前缀 key 非订阅');
  assert.deepEqual(p.models, ['doubao-seed-2-1-pro-260915', 'doubao-seed-evolving']);
  assert.equal(p.probe.host, 'ark.cn-beijing.volces.com');
  assert.equal(p.probe.path, '/api/compatible/v1/models', 'baseUrl 规则：anthropic-messages → base + /v1/models');
  assert.equal(p.probe.auth, 'bearer', '方舟探活必须 Bearer（x-api-key 实测 401）');
});
const wb = require('../server/collectors/workbuddy');
t('cachedFromDetails：数组元素缺 cached_tokens 按 0 计，不清零整个和', () => {
  assert.equal(wb.cachedFromDetails([{ cached_tokens: 5 }, {}, { cached_tokens: 7 }]), 12, '旧写法会得到 7');
  assert.equal(wb.cachedFromDetails([{ cached_tokens: 5 }, null, undefined]), 5);
  assert.equal(wb.cachedFromDetails({ cached_tokens: 9 }), 9);
  assert.equal(wb.cachedFromDetails(undefined), 0);
});
(function wbFixture() {
  // 构造临时 jsonl：正常行 / 时间非法行 / token 非法行 / mtime 过旧文件
  const wbDir = path.join(TMP_DIR, 'wb-projects', 'p1');
  fs.mkdirSync(wbDir, { recursive: true });
  const mk = (mid, usage, timestamp) => JSON.stringify({
    timestamp,
    id: mid,
    providerData: { model: 'glm-5.3-flash', messageId: mid, usage, rawUsage: {} },
  });
  const usage = extra => Object.assign({ inputTokens: 100, outputTokens: 50, inputTokensDetails: [{ cached_tokens: 5 }, {}, { cached_tokens: 7 }] }, extra);
  const lines = [
    mk('m1', usage(), Date.now()),                          // 正常 → 保留，缓存命中 = 12
    mk('m2', usage(), 'not-a-timestamp'),                   // 时间非法 → 跳过
    mk('m3', usage({ inputTokens: 'oops' }), Date.now()),   // token 非法 → 跳过
    mk('m4', usage(), undefined),                           // 缺时间戳 → 跳过
  ];
  fs.writeFileSync(path.join(wbDir, 'fresh.jsonl'), lines.join('\n') + '\n');
  const oldFile = path.join(wbDir, 'ancient.jsonl');
  fs.writeFileSync(oldFile, mk('old', usage(), Date.now()) + '\n');
  const old = new Date(Date.now() - 400 * 86400e3); // 400 天前，早于默认 365 天下界
  fs.utimesSync(oldFile, old, old);
})();
t('workbuddy collect：正常行保留（缓存求和=12），时间/token 非法的脏行跳过', () => {
  const freshFile = path.join(TMP_DIR, 'wb-projects', 'p1', 'fresh.jsonl');
  const r = wb.collect(path.join(TMP_DIR, 'wb-projects'));
  assert.equal(r.rows.length, 1, `应只剩 1 条，got ${r.rows.length}`);
  assert.equal(r.rows[0].dedupKey, 'fresh.jsonl|m1|glm-5.3-flash');
  assert.equal(r.rows[0].cacheReadTokens, 12);
  // 恒真断言改为有意义断言：fresh 文件的 mtime 必须落在扫描窗口内——
  // 这正是它被扫描、而 400 天前的 ancient.jsonl 被整体跳过的前提
  assert.ok(fs.statSync(freshFile).mtimeMs > Date.now() - 365 * 86400e3,
    'fresh 文件 mtime 应在 365 天扫描窗口内');
});
t('workbuddy collect：mtime 早于历史下界的 jsonl 整个文件跳过', () => {
  const r = wb.collect(path.join(TMP_DIR, 'wb-projects'));
  assert.ok(!r.rows.some(x => x.dedupKey.includes('|old|')), '旧文件不应产出任何行');
});

console.log('== claudecode：mtime 跳过 ==');
const clc = require('../server/collectors/claudecode');
(function claudeFixture() {
  const dir = path.join(TMP_DIR, 'claude-projects', 'p1');
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), message: { id: 'a1', model: 'glm-5.3', usage: { input_tokens: 10, output_tokens: 5 } } });
  fs.writeFileSync(path.join(dir, 'fresh.jsonl'), line + '\n');
  const oldFile = path.join(dir, 'ancient.jsonl');
  fs.writeFileSync(oldFile, line + '\n');
  const old = new Date(Date.now() - 400 * 86400e3);
  fs.utimesSync(oldFile, old, old);
})();
t('claudecode collect：新鲜文件可解析，过旧文件整体跳过', () => {
  const r = clc.collect(path.join(TMP_DIR, 'claude-projects'));
  assert.equal(r.rows.length, 1, `got ${r.rows.length}`);
  assert.equal(r.rows[0].model, 'glm-5.3');
});

console.log('== sqlite 采集器：SQL 下界 + NaN 防护 ==');
const { DatabaseSync } = require('node:sqlite');
const zcode = require('../server/collectors/zcode');
const ccswitch = require('../server/collectors/ccswitch');
(function sqliteFixtures() {
  const now = Date.now();
  const zdb = new DatabaseSync(path.join(TMP_DIR, 'zcode.sqlite'));
  zdb.exec(`CREATE TABLE model_usage (started_at, model_id, input_tokens, output_tokens,
    reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, status, provider_id)`);
  const zi = zdb.prepare(`INSERT INTO model_usage (started_at, model_id, input_tokens, output_tokens,
    reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, status, provider_id)
    VALUES (?, 'glm-5.3', 100, 10, 0, 0, 2, ?, 'bigmodel-api')`);
  zi.run(now, 'completed');                 // 正常 → 保留
  zi.run('not-a-timestamp', 'completed');   // 时间非法（文本）→ NaN 防护跳过
  zi.run(now - 400 * 86400e3, 'completed'); // 早于 SQL 下界 → 跳过
  zi.run(now + 1, 'error');                 // 非 completed → 跳过
  zdb.close();

  // 思考折叠口径：output_tokens=10 + reasoning_tokens=5
  const zdb2 = new DatabaseSync(path.join(TMP_DIR, 'zcode-reasoning.sqlite'));
  zdb2.exec(`CREATE TABLE model_usage (started_at, model_id, input_tokens, output_tokens,
    reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, status, provider_id)`);
  zdb2.prepare(`INSERT INTO model_usage (started_at, model_id, input_tokens, output_tokens,
    reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, status, provider_id)
    VALUES (?, 'glm-5.3', 100, 10, 5, 0, 2, 'completed', 'account:bigmodel-team-coding-plan')`).run(now);
  zdb2.close();

  // 项目维度：session 表存在时 JOIN 取 project_id/directory；session 缺失行 LEFT JOIN 为 NULL
  const zdb3 = new DatabaseSync(path.join(TMP_DIR, 'zcode-project.sqlite'));
  zdb3.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id, directory);
    CREATE TABLE model_usage (started_at, model_id, input_tokens, output_tokens,
    reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, status, provider_id, session_id)`);
  zdb3.prepare(`INSERT INTO session VALUES ('s1', 'proj_users-x-github-demo', '/Users/x/Github/demo')`).run();
  const zi3 = zdb3.prepare(`INSERT INTO model_usage (started_at, model_id, input_tokens, output_tokens,
    reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, status, provider_id, session_id)
    VALUES (?, 'glm-5.3', 100, 10, 0, 0, 2, 'completed', 'bigmodel-api', ?)`);
  zi3.run(now, 's1');   // 有会话 → 行带项目
  zi3.run(now, null);   // 会话缺失 → 行保留但无项目
  zdb3.close();

  // 最老库：无 session 表且 model_usage 无 provider_id 列——回退二（最小列集）兜底，采集不报错
  const zdb4 = new DatabaseSync(path.join(TMP_DIR, 'zcode-legacy.sqlite'));
  zdb4.exec(`CREATE TABLE model_usage (started_at, model_id, input_tokens, output_tokens,
    reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, status)`);
  zdb4.prepare(`INSERT INTO model_usage VALUES (?, 'glm-5.3', 100, 10, 0, 0, 2, 'completed')`).run(now);
  zdb4.close();

  const cdb = new DatabaseSync(path.join(TMP_DIR, 'cc-switch.sqlite'));
  cdb.exec(`CREATE TABLE proxy_request_logs (app_type, model, input_tokens, output_tokens,
    cache_read_tokens, cache_creation_tokens, total_cost_usd, created_at)`);
  const ci = cdb.prepare(`INSERT INTO proxy_request_logs VALUES (?, 'gpt-5.6', 100, 10, 2, 0, ?, ?)`);
  const nowSec = Math.floor(now / 1000);
  ci.run('codex', 1.5, nowSec);           // 正常 codex → 保留
  ci.run('codex', null, nowSec - 400 * 86400); // 早于下界（秒）→ 跳过
  ci.run('codex', 'abc', nowSec);         // 成本非法 → 跳过
  cdb.prepare(`INSERT INTO proxy_request_logs VALUES ('codex', 'gpt-5.6', 100, 10, 2, 0, NULL, ?)`).run(nowSec); // NULL 成本 → 保留（costUsd=null）
  cdb.prepare(`INSERT INTO proxy_request_logs VALUES ('claude-desktop', 'glm-5.3', 100, 10, 2, 0, NULL, ?)`).run(nowSec); // 拆分 claudeDesktop
  cdb.prepare(`INSERT INTO proxy_request_logs VALUES ('codex', 'gpt-5.6', 100, 10, 2, 0, 1, 'not-a-ts')`).run(); // 时间非法 → 跳过
  cdb.close();
})();
t('zcode collect：只留下界内且 completed、时间合法的行', () => {
  const r = zcode.collect(path.join(TMP_DIR, 'zcode.sqlite'));
  assert.equal(r.rows.length, 1, `got ${r.rows.length}`);
  assert.equal(r.rows[0].cacheReadTokens, 2);
  assert.equal(r.rows[0].providerId, 'bigmodel-api', 'provider_id 随行携带（按量归因用）');
});
t('zcode collect：思考 token 折入 outputTokens（按输出价计），reasoningTokens 保留明细', () => {
  const r = zcode.collect(path.join(TMP_DIR, 'zcode-reasoning.sqlite'));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].outputTokens, 15, 'outputTokens = 10 输出 + 5 思考');
  assert.equal(r.rows[0].reasoningTokens, 5, '思考明细保留（不重复计价）');
  assert.equal(r.rows[0].providerId, 'account:bigmodel-team-coding-plan');
});
t('zcode collect：JOIN session 携带项目维度，会话缺失行降级为无项目', () => {
  const r = zcode.collect(path.join(TMP_DIR, 'zcode-project.sqlite'));
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].project, 'proj_users-x-github-demo');
  assert.equal(r.rows[0].projectLabel, 'demo', '展示名 = directory basename');
  assert.equal(r.rows[1].project, null, 'session 缺失 → 无项目（行保留）');
  assert.equal(r.rows[1].projectLabel, null);
});
t('zcode collect：最老库（无 session 表且无 provider_id 列）三级回退不报错，仅缺按量/项目维度', () => {
  const r = zcode.collect(path.join(TMP_DIR, 'zcode-legacy.sqlite'));
  assert.equal(r.error, null, `collect 不应报错: ${r.error}`);
  assert.equal(r.rows.length, 1, `got ${r.rows.length}`);
  assert.equal(r.rows[0].providerId, null, '无 provider_id 列 → 按量归因退化为模型名');
  assert.equal(r.rows[0].project, null, '无 session 表 → 无项目维度');
  assert.equal(r.rows[0].outputTokens, 10, '用量数字照常采集');
});
t('ccswitch collect：时间/成本非法行跳过，app_type 拆分与 NULL 成本保留', () => {
  const r = ccswitch.collect(path.join(TMP_DIR, 'cc-switch.sqlite'));
  assert.equal(r.rows.length, 3, `got ${r.rows.length}`);
  const codex = r.rows.find(x => x.tool === 'codex' && x.costUsd != null);
  assert.equal(codex.costUsd, 1.5);
  assert.ok(r.rows.some(x => x.tool === 'claudeDesktop'));
  assert.ok(r.rows.some(x => x.tool === 'codex' && x.costUsd === null));
});

console.log('== POST 校验过滤（applyPlansUpdate） ==');
const { applyPlansUpdate } = require('../server/lib/plans');
t('usdPerMonth 白名单合并：合法设值、null 清除、非法剔除', () => {
  const cur = { plans: { codex: { label: 'ChatGPT · Codex', plan: null, cnyPerDay: null, cnyPerMonth: null, usdPerMonth: null } } };
  const set = applyPlansUpdate(cur, { plans: { codex: { usdPerMonth: 19.9 } } });
  assert.equal(set.plans.codex.usdPerMonth, 19.9);
  assert.equal(set.plans.codex.cnyPerMonth, null, '未提交的字段不动');
  const clr = applyPlansUpdate(set, { plans: { codex: { usdPerMonth: null } } });
  assert.equal(clr.plans.codex.usdPerMonth, null, 'null = 清除');
  const bad = applyPlansUpdate(set, { plans: { codex: { usdPerMonth: 'abc' } } });
  assert.equal(bad.plans.codex.usdPerMonth, 19.9, '非法值剔除保留原值');
});

t('非法值剔除该字段保留原值；0 目标=关闭；汇率必须有限正数', () => {
  const cur = {
    usdCnyRate: 7.2,
    plans: { zcode: { label: 'ZCode', plan: null, cnyPerDay: null, cnyPerMonth: 300 } },
    priceOverrides: {},
    dailyGoal: { cny: 200 },
    quotaKeys: { zhipu: { token: '', organizationId: '', projectId: '' }, minimax: { apiKey: '' }, chatgpt: { accessToken: '' } },
  };
  const next = applyPlansUpdate(cur, {
    usdCnyRate: -1,                                            // 非法 → 保留 7.2
    plans: { zcode: { cnyPerMonth: -5, cnyPerDay: 30 } },      // -5 非法保留 300；30 合法
    priceOverrides: { 'glm-5.3': { in: 8, out: -1, cacheRead: 'abc' }, ghost: { in: NaN } }, // 只留 in:8
    dailyGoal: { cny: 0 },                                     // 0 = 关闭目标，允许
    quotaKeys: { zhipu: { token: '', organizationId: 'org-1', projectId: '' }, minimax: { apiKey: '' }, chatgpt: { accessToken: '' } },
  });
  assert.equal(next.usdCnyRate, 7.2);
  assert.equal(next.plans.zcode.cnyPerMonth, 300, '负数月额度应保留原值');
  assert.equal(next.plans.zcode.cnyPerDay, 30);
  assert.deepEqual(next.priceOverrides, { 'glm-5.3': { in: 8 } }, '非法单价字段应剔除，全空模型不出现');
  assert.equal(next.dailyGoal.cny, 0);
  assert.equal(next.quotaKeys.zhipu.organizationId, 'org-1');
  assert.equal(cur.plans.zcode.cnyPerMonth, 300, '入参不被修改');
});
t('合法更新生效：汇率 7.5、目标 100、月额度清空为 null', () => {
  const cur = { usdCnyRate: 7.2, plans: { zcode: { cnyPerDay: null, cnyPerMonth: 300 } }, priceOverrides: {}, dailyGoal: { cny: 200 } };
  const next = applyPlansUpdate(cur, {
    usdCnyRate: 7.5,
    plans: { zcode: { cnyPerMonth: null } },
    dailyGoal: { cny: 100 },
  });
  assert.equal(next.usdCnyRate, 7.5);
  assert.equal(next.plans.zcode.cnyPerMonth, null);
  assert.equal(next.dailyGoal.cny, 100);
});
t('dailyGoal.networkGB 每日流量目标：白名单合并、仅改一项保留另一项、非法剔除、老配置补齐', () => {
  const cur = { dailyGoal: { cny: 200, networkGB: 0 } };
  const both = applyPlansUpdate(cur, { dailyGoal: { cny: 100, networkGB: 5 } });
  assert.deepEqual(both.dailyGoal, { cny: 100, networkGB: 5 });
  const onlyGb = applyPlansUpdate({ dailyGoal: { cny: 200, networkGB: 0 } }, { dailyGoal: { networkGB: 5 } });
  assert.deepEqual(onlyGb.dailyGoal, { cny: 200, networkGB: 5 }, '仅提交 networkGB 时 cny 保留');
  const keepGb = applyPlansUpdate({ dailyGoal: { cny: 200, networkGB: 5 } }, { dailyGoal: { cny: 150 } });
  assert.deepEqual(keepGb.dailyGoal, { cny: 150, networkGB: 5 }, '仅提交 cny 时 networkGB 保留');
  const bad = applyPlansUpdate({ dailyGoal: { cny: 200, networkGB: 5 } }, { dailyGoal: { cny: -1, networkGB: 'abc' } });
  assert.deepEqual(bad.dailyGoal, { cny: 200, networkGB: 5 }, '非法值整体不动');
  const legacy = applyPlansUpdate({ dailyGoal: { cny: 200 } }, { dailyGoal: { cny: 100 } });
  assert.deepEqual(legacy.dailyGoal, { cny: 100, networkGB: 0 }, '老配置无 networkGB 按模板默认补 0');
  // load() 补齐走磁盘重读路径（save() 直写缓存不经补齐）：裸写老配置文件 → mtime 变化 → load 重读补齐
  const plansMod = require('../server/lib/plans');
  const orig = plansMod.load();
  fs.writeFileSync(plansMod.PLANS_FILE, JSON.stringify({ usdCnyRate: 7.2, dailyGoal: { cny: 200 } }));
  assert.equal(plansMod.load().dailyGoal.networkGB, 0, 'load() 对老配置补齐 networkGB 默认值');
  assert.equal(plansMod.load().dailyGoal.cny, 200, '补齐不动已有自定义值');
  plansMod.save(orig); // 还原现场（后续集成测试依赖完整配置）
});
t('hiddenCards 卡片显隐：白名单过滤 + 去重；非数组忽略保留原值；空数组 = 全部恢复显示', () => {
  const cur = { hiddenCards: ['zcode'], plans: {}, priceOverrides: {}, dailyGoal: { cny: 0 } };
  const next = applyPlansUpdate(cur, {
    hiddenCards: ['claudeDesktop', 'claudeCode', 'claudeCode', 'bogus-tool', 42],
  });
  assert.deepEqual(next.hiddenCards, ['claudeDesktop', 'claudeCode'], '非法 key 剔除、重复去重');
  const keep = applyPlansUpdate({ hiddenCards: ['zcode'] }, { hiddenCards: 'not-array' });
  assert.deepEqual(keep.hiddenCards, ['zcode'], '非数组整体忽略');
  const clear = applyPlansUpdate(cur, { hiddenCards: [] });
  assert.deepEqual(clear.hiddenCards, [], '空数组 = 全部显示');
});
t('priceOverrides 白名单含 cacheWrite：合法保留、非法剔除', () => {
  const next = applyPlansUpdate({ priceOverrides: {} }, {
    priceOverrides: { 'glm-5.3': { cacheWrite: 12, in: -1 }, ghost: { cacheWrite: NaN } },
  });
  assert.deepEqual(next.priceOverrides, { 'glm-5.3': { cacheWrite: 12 } });
});
t('applyPlansUpdate：quotaKeys 非对象（字符串/数组）整体忽略，已存机密不清空', () => {
  const cur = { quotaKeys: { chatgpt: { accessToken: 'real-access-token-123' }, zhipu: { token: 'real-zhipu-token-456', organizationId: 'org-K', projectId: 'proj-K' } } };
  // 回归：旧实现 `if (body.quotaKeys)` 对字符串/数组 truthy 放行，
  // applyQuotaKeysUpdate 里 (inc[tool]||{}) 全 undefined → 已存机密被清空
  for (const bad of ['not-an-object', 42, ['x']]) {
    const next = applyPlansUpdate(cur, { quotaKeys: bad });
    assert.equal(next.quotaKeys.chatgpt.accessToken, 'real-access-token-123', `字符串形态应保留原值（${JSON.stringify(bad)}）`);
    assert.equal(next.quotaKeys.zhipu.token, 'real-zhipu-token-456', `zhipu 机密应保留原值（${JSON.stringify(bad)}）`);
    assert.equal(next.quotaKeys.zhipu.organizationId, 'org-K', `非机密字段同样保留（${JSON.stringify(bad)}）`);
  }
});

console.log('== /api/summary 脱敏口径 ==');
// maskQuotaKeys 已在上方「quotaKeys 脱敏/合并」段引入
t('maskQuotaKeys 后序列化不含 JWT 明文，非机密字段原样保留', () => {
  const cfg = {
    usdCnyRate: 7.2,
    dailyGoal: { cny: 200 },
    plans: { zcode: { label: 'ZCode', plan: 'Max', cnyPerMonth: 300 } },
    quotaKeys: { chatgpt: { accessToken: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig' }, zhipu: { token: '88b9bae46e074c44a5af286187a1f450.TvRgrz8RRNRNGXlN', organizationId: 'org-X', projectId: 'proj-Y' } },
  };
  const s = JSON.stringify(maskQuotaKeys(cfg));
  assert.ok(!s.includes('eyJhbGciOi'), 'accessToken 不得以明文出现');
  assert.ok(!s.includes('88b9bae46e074c44a5af286187a1f450'), 'token 不得以明文出现');
  assert.ok(s.includes('••••….sig'), '应保留掩码形态（JWT 无头部特征）');
  assert.ok(s.includes('"cnyPerMonth":300') && s.includes('"dailyGoal"') && s.includes('org-X'), 'plans/dailyGoal/plain 字段必须保留');
});

console.log('== plans.json 原子写 / 缓存失效 / 坏文件恢复 ==');
const plansStore = require('../server/lib/plans');
t('save 原子写：0600 权限、无 .tmp 残留、内容完整', () => {
  plansStore.save({ usdCnyRate: 7.2, dailyGoal: { cny: 50 }, plans: {}, priceOverrides: {}, quotaKeys: {} });
  assert.ok(fs.existsSync(plansStore.PLANS_FILE));
  assert.ok(!fs.existsSync(plansStore.PLANS_FILE + '.tmp'), '临时文件应已被 rename');
  const mode = fs.statSync(plansStore.PLANS_FILE).mode & 0o777;
  assert.equal(mode, 0o600, `got ${mode.toString(8)}`);
  assert.ok(fs.readFileSync(plansStore.PLANS_FILE, 'utf8').includes('"cny": 50'));
});
t('load 缓存失效：外部改文件（mtime 变化）后重读，不回旧缓存', () => {
  const external = JSON.stringify({ usdCnyRate: 8.8, dailyGoal: { cny: 50 }, plans: {}, priceOverrides: {}, quotaKeys: {} });
  fs.writeFileSync(plansStore.PLANS_FILE, external);
  assert.equal(plansStore.load().usdCnyRate, 8.8, '应感知外部修改');
});
t('load 遇 JSON 损坏：备份为 .bak 再落模板，不直接吞掉', () => {
  fs.writeFileSync(plansStore.PLANS_FILE, '{broken json!!');
  const cfg = plansStore.load();
  assert.equal(cfg.usdCnyRate, 7.2, '损坏后应落模板');
  assert.equal(fs.readFileSync(plansStore.PLANS_FILE + '.bak', 'utf8'), '{broken json!!');
  assert.ok(fs.existsSync(plansStore.PLANS_FILE), '模板应已写回');
});
t('load：plans.json 根为标量/null/数组视同损坏——备份 .bak 再落模板（回归：parse 成功但后续崩溃）', () => {
  // 回归：旧实现对 `42` / `null` / `[]` 这类能 JSON.parse 成功的标量根直接放行，
  // 后续字段访问崩溃且不走 .bak 分支
  for (const bad of ['42', 'null', '"x"', '[]']) {
    fs.writeFileSync(plansStore.PLANS_FILE, bad);
    const cfg = plansStore.load();
    assert.equal(cfg.usdCnyRate, 7.2, `标量根 ${bad} 应落模板`);
    assert.equal(fs.readFileSync(plansStore.PLANS_FILE + '.bak', 'utf8'), bad, `原文件应备份为 .bak（${bad}）`);
    assert.equal(JSON.parse(fs.readFileSync(plansStore.PLANS_FILE, 'utf8')).usdCnyRate, 7.2, `模板应写回（${bad}）`);
  }
});

console.log('== HTTP Host 白名单 + 端口文件 ==');
const { hostAllowed, writePortFile } = require('../server/index.js');
t('hostAllowed：仅 localhost/127.0.0.1/[::1] 带任意端口，其余 403 口径', () => {
  assert.equal(hostAllowed('localhost:7788'), true);
  assert.equal(hostAllowed('localhost'), true);
  assert.equal(hostAllowed('127.0.0.1:7795'), true);
  assert.equal(hostAllowed('[::1]:7795'), true);
  assert.equal(hostAllowed('evil.com'), false);
  assert.equal(hostAllowed('localhost.evil.com:80'), false);
  assert.equal(hostAllowed(''), false);
  assert.equal(hostAllowed(undefined), false);
});
t('writePortFile：listen 成功后把实际端口写入 config/.port', () => {
  writePortFile(7795);
  assert.equal(fs.readFileSync(path.join(TMP_DIR, '.port'), 'utf8'), '7795');
});

console.log('== history：归档库（建表/UPSERT/merge/重估/容错） ==');
const history = require('../server/lib/history');
// 构造某北京日期的 zcode 原始行：UTC 04:00 = 北京 12:00 归当日；glm-5.3 100万输入 = 等价 ¥8
const zRow = (d, model = 'glm-5.3') => ({
  tool: 'zcode', ts: Date.parse(d + 'T04:00:00Z'), model,
  inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0,
  cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null,
});
const codexRow = d => ({
  tool: 'codex', ts: Date.parse(d + 'T04:00:00Z'), model: 'gpt-5.6',
  inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 1,
});

t('open：单例连接、建表幂等', () => {
  const db1 = history.open();
  assert.ok(db1, '归档库应成功打开');
  assert.equal(history.open(), db1, '重复 open 应返回单例');
  history.ensureSchema(db1); // 二次执行不抛
  const names = db1.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const tb of ['daily', 'daily_model', 'meta']) assert.ok(names.includes(tb), `缺表 ${tb}`);
});

t('syncFromAgg：UPSERT 幂等不翻倍、二次同步覆盖为新值、__total 不入库', () => {
  const d = '2026-01-01';
  assert.equal(history.syncFromAgg(aggregate([zRow(d)], pricer)), true);
  assert.equal(history.syncFromAgg(aggregate([zRow(d)], pricer)), true, '重复同步同一份');
  assert.equal(history.syncFromAgg(aggregate([zRow(d), zRow(d)], pricer)), true);
  const db = history.open();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily').get().n, 1, '同 (date,tool) 只有 1 行');
  assert.equal(db.prepare('SELECT requests FROM daily WHERE date=?').get(d).requests, 2, '应覆盖为最新值');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM daily WHERE tool='__total'").get().n, 0, '__total 不入库');
});

t('syncFromAgg 指纹跳过：同内容第二轮零写入（updated_at 不动）、内容变化后仅脏行写入', () => {
  const d1 = '2027-02-01', d2 = '2027-02-02';
  const aggA = aggregate([zRow(d1), zRow(d2)], pricer); // 每日 zcode → daily + daily_model 各 1 行
  history.close(); // 清指纹缓存，隔离前序用例的指纹状态
  assert.equal(history.syncFromAgg(aggA), true);
  let s = history.syncStats();
  assert.equal(s.rows, 4, '两日 × (daily + daily_model) = 4 行');
  assert.equal(s.written, 4, '首轮全脏全写');
  assert.equal(s.skipped, 0);
  const db = history.open();
  const atBefore = db.prepare('SELECT updated_at FROM daily WHERE date=?').get(d1).updated_at;
  assert.equal(history.syncFromAgg(aggA), true); // 同内容第二轮（60s 稳态场景）
  s = history.syncStats();
  assert.equal(s.written, 0, '同内容全部跳过');
  assert.equal(s.skipped, 4);
  assert.equal(db.prepare('SELECT updated_at FROM daily WHERE date=?').get(d1).updated_at, atBefore, '跳过的行不重写 → updated_at 不变');
  // d2 内容变化（请求翻倍）：只写 d2 的 daily + daily_model 两行，d1 仍跳过
  const aggB = aggregate([zRow(d1), zRow(d2), zRow(d2)], pricer);
  assert.equal(history.syncFromAgg(aggB), true);
  s = history.syncStats();
  assert.equal(s.written, 2, '仅脏日的 (date,tool) 两行');
  assert.equal(s.skipped, 2);
  assert.equal(db.prepare('SELECT updated_at FROM daily WHERE date=?').get(d1).updated_at, atBefore, '未变行仍不动');
  assert.equal(db.prepare('SELECT requests FROM daily WHERE date=?').get(d2).requests, 2, '脏行覆盖为新值');
});

t('merge：raw 优先——同 (date,tool) 以原始扫描为准，不被归档污染', () => {
  const d = '2026-01-02';
  history.syncFromAgg(aggregate([zRow(d), zRow(d)], pricer)); // 归档 2 条
  const rawAgg = aggregate([zRow(d)], pricer);                                // raw 只剩 1 条
  const merged = history.mergeArchived(rawAgg.daily, rawAgg.models, pricer);
  assert.equal(merged.daily[d].zcode.requests, 1, 'raw 的 1 条胜出');
  assert.equal(merged.daily[d].__total.requests, 1);
});

t('merge：archive 补缺——raw 窗口外的日期补回，等价成本按当前单价，keys 重排', () => {
  const d = '2025-06-01';
  history.syncFromAgg(aggregate([zRow(d)], pricer));
  const merged = history.mergeArchived({}, {}, pricer);
  assert.ok(merged.daily[d] && merged.daily[d].zcode, '归档日应补回');
  assert.equal(merged.daily[d].__total.requests, 1, '__total 由 per-tool 行重算');
  assert.ok(Math.abs(merged.daily[d].__total.equivalentCny - 8) < 1e-6, 'glm-5.3 100万输入 = ¥8');
  assert.deepEqual(merged.dailyKeys, [...merged.dailyKeys].sort(), 'dailyKeys 应有序');
});

t('merge 口径一致性：含思考行归档补缺后等价成本与 raw 完全一致（回归：重估漂移 ~2.6%）', () => {
  const d = '2025-06-06';
  // 行级归一契约：outputTokens 已含思考（1e5），raw 计价 = 1e6×8/M + 5e5×28/M = ¥22
  const row = { tool: 'zcode', ts: Date.parse(d + 'T04:00:00Z'), model: 'glm-5.3',
    inputTokens: 1e6, outputTokens: 5e5, reasoningTokens: 1e5,
    cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null };
  const rawAgg = aggregate([row], pricer);
  const rawCny = rawAgg.daily[d].zcode.equivalentCny;
  assert.ok(Math.abs(rawCny - 22) < 1e-6, `raw 应为 ¥22，got ${rawCny}`);
  history.syncFromAgg(rawAgg);
  const merged = history.mergeArchived({}, {}, pricer); // 模拟原始日志被清、纯归档补回
  const archCny = merged.daily[d].zcode.equivalentCny;
  assert.ok(Math.abs(archCny - rawCny) < 1e-9, `补缺 ${archCny} 应与 raw ${rawCny} 完全一致（思考不得被二次计价）`);
});

t('merge：双算防护——同日部分工具日志被清，raw 工具保留 + 归档补缺其余，total 合并不双算', () => {
  const d = '2025-06-02';
  history.syncFromAgg(aggregate([zRow(d), zRow(d), codexRow(d)], pricer)); // 归档全量：zcode 2 + codex 1
  const rawAgg = aggregate([codexRow(d)], pricer); // raw：zcode 日志已被清，只剩 codex
  const merged = history.mergeArchived(rawAgg.daily, rawAgg.models, pricer);
  const day = merged.daily[d];
  assert.equal(day.codex.requests, 1, 'raw codex 保留 1 条');
  assert.equal(day.zcode.requests, 2, 'zcode 从归档补回 2 条');
  assert.equal(day.__total.requests, 3, 'total = 1 + 2，无双算');
  assert.equal(day.__total.costUsd, 1, 'codex 实扣只计一次');
});

t('merge：重估逻辑——改 priceOverrides 后补缺日金额跟随新价', () => {
  const d = '2025-06-03';
  history.syncFromAgg(aggregate([zRow(d, 'glm-5.2')], pricer)); // 写入时点等价 ¥8
  const pricerNew = makePricer({ usdCnyRate: 7.2, priceOverrides: { 'glm-5.2': { in: 16, out: 56, cacheRead: 4 } } });
  const merged = history.mergeArchived({}, {}, pricerNew);
  assert.ok(Math.abs(merged.daily[d].zcode.equivalentCny - 16) < 1e-6, 'tool 行按新价 ¥16 重估');
  assert.ok(Math.abs(merged.models.zcode['glm-5.2'].equivalentCny - 16) < 1e-6, 'models 全历史桶同样按新价');
});

t('merge：cost_usd（实扣）与 sub_usd/pay_usd 不重估、保留归档原值', () => {
  const d = '2025-06-04';
  history.syncFromAgg(aggregate([codexRow(d)], pricer)); // gpt 走订阅，costUsd=1 记入 subUsd
  const merged = history.mergeArchived({}, {}, makePricer({ usdCnyRate: 7.2, priceOverrides: {} }));
  const a = merged.daily[d].codex;
  assert.equal(a.costUsd, 1, '实扣保留归档原值');
  assert.ok(Math.abs(a.costCny - 7.2) < 1e-6, '人民币按当前汇率折算');
  assert.equal(a.equivalentCny, 0, 'gpt 无表价，不重估出等价成本');
  assert.equal(a.subUsd, 1);
  assert.equal(a.subRequests, 1);
});

t('merge：models 全历史桶 raw 优先、缺的 (tool,model) 从 daily_model 聚合补', () => {
  const d = '2025-06-05';
  history.syncFromAgg(aggregate([zRow(d)], pricer));
  const rawModels = { zcode: { 'glm-5.3': { requests: 5, inputTokens: 9, outputTokens: 9, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, costCny: 0, equivalentCny: 40 } } };
  const merged = history.mergeArchived({}, rawModels, pricer);
  assert.equal(merged.models.zcode['glm-5.3'].requests, 5, 'raw 已有的模型原样优先');
  history.syncFromAgg(aggregate([{
    tool: 'workbuddy', ts: Date.parse(d + 'T04:00:00Z'), model: 'glm-5.3-flash',
    inputTokens: 2e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null,
  }], pricer));
  const merged2 = history.mergeArchived({}, { workbuddy: {} }, pricer);
  const m = merged2.models.workbuddy['glm-5.3-flash'];
  assert.equal(m.requests, 1, '缺的模型从归档补出');
  assert.ok(Math.abs(m.equivalentCny - 1.6) < 1e-6, 'glm-5.3-flash 2e6 × 0.8/M = ¥1.6');
});

t('merge：models 全历史补缺带实扣——cost_usd 从 daily_model 聚合补出（回归：此前被丢弃记 0）', () => {
  const d = '2025-06-07';
  // 专属模型名隔离前序用例的归档累计；costUsd 由 pricer 直接采信（与模型名无关）
  const costRow = {
    tool: 'codex', ts: Date.parse(d + 'T04:00:00Z'), model: 'gpt-5.6-it-costcheck',
    inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 1,
  };
  history.syncFromAgg(aggregate([costRow, costRow], pricer)); // 同日两条：daily_model.cost_usd 累计 = 2
  const merged = history.mergeArchived({}, {}, pricer);
  const m = merged.models.codex['gpt-5.6-it-costcheck'];
  assert.equal(m.costUsd, 2, '实扣应从 daily_model 聚合补出，不得记 0（丢实扣）');
  assert.ok(Math.abs(m.costCny - 14.4) < 1e-6, `人民币按当前汇率折算，got ${m.costCny}`);
  assert.equal(m.equivalentCny, 0, '无表价模型不重估出等价成本');
  assert.equal(m.requests, 2);
});

t('merge：纯函数——不改入参', () => {
  const d = '2026-01-03';
  const rawAgg = aggregate([zRow(d)], pricer);
  const before = JSON.stringify([rawAgg.daily, rawAgg.models]);
  history.syncFromAgg(aggregate([zRow(d), zRow(d)], pricer));     // 同日归档比 raw 多
  history.syncFromAgg(aggregate([zRow('2025-01-01')], pricer));   // 另有 raw 没有的日期
  history.mergeArchived(rawAgg.daily, rawAgg.models, pricer);
  assert.equal(JSON.stringify([rawAgg.daily, rawAgg.models]), before, '入参未被修改');
});

t('AI_QUOTA_HISTORY=0：直通——不打开库、sync/merge 直接返回', () => {
  history.close();
  process.env.AI_QUOTA_HISTORY = '0';
  assert.equal(history.open(), null);
  assert.equal(history.syncFromAgg(aggregate([zRow('2026-01-04')], pricer)), false);
  assert.equal(history.mergeArchived({}, {}, pricer), null);
  delete process.env.AI_QUOTA_HISTORY;
  assert.ok(history.open(), '恢复开关后可重新打开');
});

t('坏库容错：损坏的归档文件打开返回 null、sync 抛错给调用方记 error、merge 直通', () => {
  history.close();
  fs.writeFileSync(history.DB_PATH, 'this is not a sqlite database');
  assert.equal(history.open(), null, '坏库应返回 null 而非抛错');
  assert.throws(() => history.syncFromAgg(aggregate([zRow('2026-01-05')], pricer)), /打开失败/, 'sync 应抛错供 collectorErrors.history 记录');
  assert.equal(history.mergeArchived({}, {}, pricer), null, 'merge 直通不抛');
  fs.rmSync(history.DB_PATH, { force: true }); // open 无进程级熔断，删坏库即可自愈
  assert.ok(history.open(), '删除坏库后应可重建');
});

console.log('== network-traffic：netstat 解析 / SSID / 差分 / 归档 ==');
const netTraffic = require('../server/collectors/network-traffic');

t('parseNetstatIb：只留 en* 的 Link 行，字节取末 7 列布局位', () => {
  const text = [
    'Timestamp', // 某些版本会出现的头行：直接跳过
    'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
    'lo0        16384 <Link#1>                       1889918     0 1754731902  1889918     0 1754731902     0',
    'lo0        16384 127           localhost        1889918     - 1754731902  1889918     - 1754731902     -',
    'utun3      1380  <Link#20>                          0     0          0        0     0          0     0',
    'anpi0      1500  <Link#5>    3a:eb:37:fd:f3:df        0     0          0        0     0          0     0',
    'en0        1500  <Link#13>   a4:83:e7:a3:7c:e8/rlm  234377     0 45556518   205411     0 8332221     0',
    'en0        1500  fe80::/64   fe80::1081:9665:2ce:..  234377     -          -   205411     -          -     -',
    'en5        1500  <Link#8>    3a:eb:37:fd:f3:c0        0     0          0        0     0          0     0',
  ].join('\n');
  const rows = netTraffic.parseNetstatIb(text);
  assert.deepEqual(rows.map(r => r.name).sort(), ['en0', 'en5'], 'lo0/utun/anpi/非 Link 行全部滤除');
  const en0 = rows.find(r => r.name === 'en0');
  assert.equal(en0.ibytes, 45556518);
  assert.equal(en0.obytes, 8332221);
});

t('parseNetstatIb：空/垃圾输入返回空数组不抛', () => {
  assert.deepEqual(netTraffic.parseNetstatIb(''), []);
  assert.deepEqual(netTraffic.parseNetstatIb(null), []);
  assert.deepEqual(netTraffic.parseNetstatIb('garbage text\nno columns here'), []);
});

t('parseSsid：两种排版兼容；<redacted>/空按未取到；BSSID 不误配', () => {
  assert.equal(netTraffic.parseSsid('  SSID : MyHome\n  BSSID : aa:bb'), 'MyHome');
  assert.equal(netTraffic.parseSsid(' SSID: Office-5G'), 'Office-5G');
  assert.equal(netTraffic.parseSsid('  SSID : <redacted>'), null, '定位未授权的打码值按未取到处理');
  assert.equal(netTraffic.parseSsid('  BSSID : aa:bb:cc'), null, 'BSSID 行不得误配成 SSID');
  assert.equal(netTraffic.parseSsid(''), null);
  assert.equal(netTraffic.parseSsid(null), null);
});

t('parseAirportNetwork：Current Wi-Fi Network 行解析与未关联降级', () => {
  assert.equal(netTraffic.parseAirportNetwork('Current Wi-Fi Network: HomeWifi'), 'HomeWifi');
  assert.equal(netTraffic.parseAirportNetwork('You are not associated with an AirPort network.'), null);
  assert.equal(netTraffic.parseAirportNetwork(null), null);
});

t('computeDeltas：差分正确；计数器回绕按 0 计；首次观测无基准不计', () => {
  const { deltas, counters } = netTraffic.computeDeltas(
    [{ name: 'en0', ibytes: 1000, obytes: 2000 }, { name: 'en5', ibytes: 500, obytes: 300 }],
    { en0: { ib: 400, ob: 1500 } },
  );
  assert.deepEqual(deltas.en0, { rx: 600, tx: 500 });
  assert.deepEqual(deltas.en5, { rx: 0, tx: 0 }, '首次观测无基准，本轮不计增量');
  assert.equal(counters.en0.ib, 1000);
  const wrapped = netTraffic.computeDeltas([{ name: 'en0', ibytes: 10, obytes: 5 }], { en0: { ib: 1000, ob: 2000 } });
  assert.deepEqual(wrapped.deltas.en0, { rx: 0, tx: 0 }, '重启/唤醒计数器清零：按 0 计');
});

t('buildEntries：无流量不产条目；identities 缺失回退 iface:名；按北京时间切日', () => {
  const ts = Date.parse('2026-11-05T16:30:00Z'); // 北京 2026-11-06 00:30
  const entries = netTraffic.buildEntries(
    { en0: { rx: 1024, tx: 0 }, en5: { rx: 0, tx: 0 } },
    { en0: { key: 'wifi:Home', label: 'Home' } },
    ts,
  );
  assert.equal(entries.length, 1, '零流量接口不产条目');
  assert.deepEqual(entries[0], { date: '2026-11-06', network: 'wifi:Home', label: 'Home', rxBytes: 1024, txBytes: 0 });
  const fallback = netTraffic.buildEntries({ en9: { rx: 1, tx: 1 } }, {}, ts);
  assert.equal(fallback[0].network, 'iface:en9');
  assert.equal(fallback[0].label, 'en9');
});

t('pickCurrent：取流量最大接口；无流量沿用上次；无任何信息返回 null', () => {
  const ids = { en0: { key: 'wifi:A', label: 'A' }, en5: { key: 'iface:en5', label: 'USB LAN' } };
  assert.equal(netTraffic.pickCurrent({ en0: { rx: 1, tx: 1 }, en5: { rx: 500, tx: 0 } }, ids, null).iface, 'en5');
  const idle = netTraffic.pickCurrent({ en0: { rx: 0, tx: 0 } }, {}, { key: 'wifi:B', label: 'B', iface: 'en0' });
  assert.equal(idle.key, 'wifi:B', '全零流量（真实场景 identities 为空）沿用上次当前网络');
  const withId = netTraffic.pickCurrent({ en0: { rx: 0, tx: 0 } }, { en0: ids.en0 }, { key: 'wifi:B', label: 'B', iface: 'en0' });
  assert.equal(withId.key, 'wifi:A', 'identities 在场时优先本轮解析结果');
  assert.equal(netTraffic.pickCurrent({}, {}, null), null);
});

t('syncNetworkDaily + networkDaily：增量累加、label 跟随、窗口过滤、空入参直通', () => {
  const day = '2027-03-01'; // 未来日期：字符串比较仍在 31 天窗口内（cutoff = 今天-30 天）
  assert.equal(history.syncNetworkDaily([
    { date: day, network: 'wifi:Home', label: 'Home', rxBytes: 100, txBytes: 10 },
    { date: day, network: 'iface:en5', label: 'USB LAN', rxBytes: 5, txBytes: 1 },
  ]), true);
  assert.equal(history.syncNetworkDaily([{ date: day, network: 'wifi:Home', label: 'Home', rxBytes: 50, txBytes: 5 }]), true);
  const rows = history.networkDaily(31).filter(r => r.date === day);
  const home = rows.find(r => r.network === 'wifi:Home');
  assert.equal(home.rx, 150, '两次同步累加（增量 UPSERT 语义，非覆盖）');
  assert.equal(home.tx, 15);
  assert.equal(rows.find(r => r.network === 'iface:en5').rx, 5);
  history.syncNetworkDaily([{ date: '2020-01-01', network: 'wifi:Old', label: 'Old', rxBytes: 1, txBytes: 1 }]);
  assert.ok(!history.networkDaily(31).some(r => r.date === '2020-01-01'), '窗口外日期不返回');
  history.syncNetworkDaily([{ date: day, network: 'wifi:Home', label: '家里WiFi', rxBytes: 0, txBytes: 0 }]);
  assert.equal(history.open().prepare('SELECT label FROM daily_network WHERE date=? AND network=?').get(day, 'wifi:Home').label, '家里WiFi', 'label 跟随最新一条');
  assert.equal(history.syncNetworkDaily([]), false, '空数组直通');
  assert.equal(history.syncNetworkDaily(null), false, 'null 直通');
});

console.log('== VPN 流量包：订阅头解析 / 差分 / daily_vpn 归档 / 预警评估 ==');
const vpnQuota = require('../server/collectors/vpn-quota');

t('parseSubscriptionUserinfo：全字段解析、expire 秒→毫秒、缺计量/total=0/垃圾输入回 null', () => {
  const info = vpnQuota.parseSubscriptionUserinfo('upload=132626456142; download=731315190778; total=2684354560000; expire=1814201408');
  assert.deepEqual(info, { upload: 132626456142, download: 731315190778, total: 2684354560000, expire: 1814201408000 });
  assert.equal(info.upload + info.download, 863941646920, '累计口径 = upload+download');
  const noExpire = vpnQuota.parseSubscriptionUserinfo('upload=1; download=2; total=9');
  assert.equal(noExpire.expire, null, '无 expire 字段按永久');
  assert.equal(noExpire.total, 9);
  assert.equal(vpnQuota.parseSubscriptionUserinfo('upload=1; download=2; total=0'), null, 'total=0（不限流量）无从算占比');
  assert.equal(vpnQuota.parseSubscriptionUserinfo('upload=1; total=9'), null, '缺 download');
  assert.equal(vpnQuota.parseSubscriptionUserinfo(''), null);
  assert.equal(vpnQuota.parseSubscriptionUserinfo('{"ret":0,"msg":"订阅令牌无效或已过期"}'), null, '令牌失效 JSON 体不得误认作计量头');
});

t('nextDelta：正常差分、首采无基线记 0、续订计数器重置记 0 不出现负数', () => {
  assert.equal(vpnQuota.nextDelta(1000, 1500), 500);
  assert.equal(vpnQuota.nextDelta(null, 1500), 0, '首采只建基线');
  assert.equal(vpnQuota.nextDelta(1500, 100), 0, '负差（续订归零）记 0');
  assert.equal(vpnQuota.nextDelta(1500, 1500), 0);
});

t('maskSubUrl：token 不出现在掩码里（错误回显兜底）', () => {
  assert.equal(vpnQuota.maskSubUrl('https://sub.example.com/abcd1234efgh5678'), 'https://sub.example.com/***');
  assert.equal(vpnQuota.maskSubUrl('not-a-url'), '***');
});

t('friendlyReason：TLS 瞬断/超时/DNS 失败汉化，未知原因原样透传', () => {
  assert.ok(/瞬断/.test(vpnQuota.friendlyReason('Client network socket disconnected before secure TLS connection was established')));
  assert.ok(/重试/.test(vpnQuota.friendlyReason('socket hang up')));
  assert.ok(/超时/.test(vpnQuota.friendlyReason('timeout')));
  assert.ok(/解析/.test(vpnQuota.friendlyReason('getaddrinfo ENOTFOUND x.invalid')));
  assert.equal(vpnQuota.friendlyReason('HTTP 403'), 'HTTP 403', '非网络类原因不改写');
});

t('syncVpnDaily + vpnDaily：同日累加、total/expire 覆盖为最新、delta<=0 直通', () => {
  const day = '2027-03-02'; // 未来日期保证在 31 天读取窗口内（字符串比较）
  assert.equal(history.syncVpnDaily({ date: day, deltaBytes: 1000, totalBytes: 5000, expireAt: 1814201408000 }), true);
  assert.equal(history.syncVpnDaily({ date: day, deltaBytes: 500, totalBytes: 6000, expireAt: null }), true);
  const rows = history.vpnDaily(31).filter(r => r.date === day);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].used_bytes, 1500, '增量累加语义');
  assert.equal(rows[0].total_bytes, 6000, 'total 覆盖为最新');
  assert.equal(rows[0].expire_at, 1814201408000, 'expire=null 不清空已有值（COALESCE）');
  assert.equal(history.syncVpnDaily({ date: day, deltaBytes: 0, totalBytes: 6000 }), false, '零差值直通不写');
  assert.equal(history.syncVpnDaily({ date: null, deltaBytes: 5 }), false, '无日期直通');
});

t('alerts.evaluate：VPN 已用 ≥ vpnUsed 触发、按日冷却身份、99% 起 critical、卡片含剩余流量', () => {
  const alerts = require('../server/lib/alerts');
  const mkSnap = (pct) => ({ vpnQuota: { available: true, usedPercent: pct, usedBytes: 107374182400, totalBytes: 107374182400, remainingBytes: pct >= 100 ? 0 : 107374182400 - pct * 1073741824, expireAt: Date.now() + 235 * 86400e3 } });
  const now = Date.now();
  const evs = alerts.evaluate(mkSnap(92), { alerts: { thresholds: {} } }, now);
  const vpn = evs.filter(e => e.kind === 'vpn');
  assert.equal(vpn.length, 1, '默认阈值 90：92% 触发');
  assert.ok(vpn[0].key.startsWith('vpn|'), '冷却身份按北京日期');
  assert.equal(vpn[0].severity, 'warning');
  assert.equal(alerts.evaluate(mkSnap(89.4), { alerts: {} }, now).filter(e => e.kind === 'vpn').length, 0, '阈值下不触发');
  const hi = alerts.evaluate(mkSnap(99.5), { alerts: {} }, now).find(e => e.kind === 'vpn');
  assert.equal(hi.severity, 'critical');
  assert.ok(/GB|TB/.test(hi.title) && /剩/.test(hi.message), '文案带量级字节与剩余');
  const card = alerts.renderCard(hi);
  assert.ok(/剩余流量/.test(card), 'wecom 卡片含剩余流量行');
});

console.log('== auth：凭据哈希 / 会话 cookie / 限流 / 本机豁免 ==');
const auth = require('../server/lib/auth');

t('hashPassword ↔ verifyPassword：往返通过、错密码拒、畸形哈希拒', () => {
  const h = auth.hashPassword('S0me-Pass#2026');
  assert.ok(h.startsWith('scrypt$16384$8$1$'), '格式 scrypt$N$r$p$salt$hash');
  assert.ok(auth.verifyPassword('S0me-Pass#2026', h));
  assert.ok(!auth.verifyPassword('wrong', h));
  assert.ok(!auth.verifyPassword('x', ''));
  assert.ok(!auth.verifyPassword('x', 'bcrypt$1$2$3$4'));
  assert.ok(!auth.verifyPassword('x', 'scrypt$0$8$1$c2FsdA==$aGFzaA=='), 'N=0 拒绝（DoS 参数约束）');
  assert.ok(!auth.verifyPassword('x', 'scrypt$16384$8$1$not!!base64$also-bad'), '非法 base64 不抛');
  assert.notEqual(auth.hashPassword('same'), auth.hashPassword('same'), '每次哈希带新盐不重复');
});

t('parseCookies / sessionCookie：基本解析与属性齐备', () => {
  assert.deepEqual(auth.parseCookies('a=1; aqd_session=abc%20def; b=2'), { a: '1', aqd_session: 'abc def', b: '2' });
  const c = auth.sessionCookie('tok123', { secure: true });
  assert.ok(c.includes('aqd_session=tok123') && c.includes('HttpOnly') && c.includes('SameSite=Lax') && c.includes('Secure'));
  assert.ok(auth.sessionCookie('t', {}).toString().includes('Max-Age=604800') && !auth.sessionCookie('t', {}).includes('Secure'));
});

t('login：env 凭据校验 + 失败限流 10 次/窗 → 429 + 成功清零', () => {
  const hash = auth.hashPassword('pw-ok-123');
  process.env.AQD_AUTH_USER = 'tester';
  process.env.AQD_AUTH_PASS_HASH = hash;
  try {
    assert.equal(auth.isEnabled(), true);
    const now = Date.now();
    let r = auth.login('tester', 'wrong', '9.9.9.9', now);
    assert.equal(r.ok, false); assert.equal(r.code, 401);
    r = auth.login('other', 'pw-ok-123', '9.9.9.9', now);
    assert.equal(r.ok, false); assert.equal(r.code, 401, '用户名也校验');
    for (let i = 0; i < 8; i++) auth.login('tester', 'wrong', '9.9.9.9', now + i);
    r = auth.login('tester', 'pw-ok-123', '9.9.9.9', now + 100);
    assert.equal(r.ok, false); assert.equal(r.code, 429, '第 11 次失败被限流（正确密码也拒）');
    const ok = auth.login('tester', 'pw-ok-123', '8.8.8.8', now);
    assert.equal(ok.ok, true); assert.ok(ok.token.length === 64, 'token 32B hex');
    assert.ok(auth.checkSession({ headers: { cookie: `aqd_session=${ok.token}` } }) === 'tester');
    assert.equal(auth.checkSession({ headers: { cookie: 'aqd_session=forged' } }), null);
    assert.equal(auth.checkSession({ headers: {} }), null);
    auth.destroySession({ headers: { cookie: `aqd_session=${ok.token}` } });
    assert.equal(auth.checkSession({ headers: { cookie: `aqd_session=${ok.token}` } }), null, '登出即失效');
  } finally {
    delete process.env.AQD_AUTH_USER; delete process.env.AQD_AUTH_PASS_HASH;
  }
});

t('isEnabled / isLocalExempt：无凭据不启用；回环+localhost 豁免；域名 Host 不豁免', () => {
  assert.equal(auth.isEnabled(), false, 'env 未配 + tmp 无 auth.json');
  const mk = (ra, host) => ({ socket: { remoteAddress: ra }, headers: { host } });
  assert.equal(auth.isLocalExempt(mk('127.0.0.1', 'localhost:7788')), true);
  assert.equal(auth.isLocalExempt(mk('::ffff:127.0.0.1', '127.0.0.1')), true);
  assert.equal(auth.isLocalExempt(mk('127.0.0.1', 'quota.5176nas.site')), false, '反代转发域名 Host → 必须登录');
  assert.equal(auth.isLocalExempt(mk('203.0.113.9', 'localhost')), false, '非回环来源不豁免');
  process.env.AQD_TRUST_PROXY = '0';
  assert.equal(auth.isLocalExempt(mk('127.0.0.1', 'localhost')), false, 'AQD_TRUST_PROXY=0 连本机也要登录');
  delete process.env.AQD_TRUST_PROXY;
});

t('readonly 模式（云端部署）：sync 全部直通 false 零写入，读路径（merge/networkDaily/vpnDaily）正常', () => {
  history.close();
  process.env.AI_QUOTA_HISTORY = 'readonly';
  assert.equal(history.readOnly(), true);
  assert.equal(history.syncFromAgg(aggregate([zRow('2026-01-07')], pricer)), false, '主归档不写');
  assert.equal(history.syncNetworkDaily([{ date: '2026-01-07', network: 'wifi:x', label: 'x', rxBytes: 1, txBytes: 1 }]), false);
  assert.equal(history.syncVpnDaily({ date: '2026-01-07', deltaBytes: 5, totalBytes: 9 }), false);
  assert.ok(Array.isArray(history.networkDaily(31)), '读回不动');
  assert.ok(Array.isArray(history.vpnDaily(31)));
  const m = history.mergeArchived(aggregate([zRow('2020-05-05')], pricer).daily, {}, pricer);
  assert.ok(m === null || m.daily, 'merge 读路径可用');
  delete process.env.AI_QUOTA_HISTORY;
  history.close();
  assert.equal(history.syncFromAgg(aggregate([zRow('2026-01-07')], pricer)), true, '退出 readonly 后写恢复');
});

t('readonly 新鲜度：归档文件被 rsync 覆盖（mtime/size 变）后连接自动重开读到新数据', () => {
  history.close();
  const day = '2027-06-02';
  // ① 写模式落 Old 数据 → close
  assert.equal(history.syncNetworkDaily([{ date: day, network: 'wifi:Old', label: 'Old', rxBytes: 100, txBytes: 10 }]), true);
  history.close();
  // ② readonly 读到 Old（并建立单例连接，两次调用走复用路径不抛）
  process.env.AI_QUOTA_HISTORY = 'readonly';
  assert.equal(history.networkDaily(31).some(r => r.network === 'wifi:Old'), true);
  assert.equal(history.networkDaily(31).some(r => r.network === 'wifi:Old'), true);
  // ③ 模拟 cloud-sync 覆盖：文件内容变化（写模式加 New 行使 mtime+size 变）→ 切回 readonly 重开，应见全量
  delete process.env.AI_QUOTA_HISTORY;
  history.close();
  assert.equal(history.syncNetworkDaily([{ date: day, network: 'wifi:New', label: 'New', rxBytes: 500, txBytes: 5 }]), true);
  history.close();
  process.env.AI_QUOTA_HISTORY = 'readonly';
  const rows = history.networkDaily(31).filter(r => r.date === day);
  assert.ok(rows.some(r => r.network === 'wifi:Old') && rows.some(r => r.network === 'wifi:New'), '覆盖后重开读到新内容');
  delete process.env.AI_QUOTA_HISTORY;
  history.close();
});

console.log('== report：周/月报生成器 ==');
const { buildReport, weekStart } = require('../server/lib/report');
const NOW = Date.UTC(2026, 9, 7, 4, 0); // 北京 2026-10-07（周三）12:00 → 本周 = 10-05（周一）~ 10-11（周日）

t('weekStart：ISO 周边界——周一归本周、周日最后一秒仍归本周、北京周一 0 点归新一周', () => {
  assert.equal(weekStart(NOW), '2026-10-05', '周三 → 本周一');
  assert.equal(weekStart(Date.UTC(2026, 9, 5, 4)), '2026-10-05', '北京周一 12:00 → 当天');
  assert.equal(weekStart(Date.UTC(2026, 9, 11, 15, 59, 59)), '2026-10-05', '北京周日 23:59:59 → 仍属本周');
  assert.equal(weekStart(Date.UTC(2026, 9, 11, 16)), '2026-10-12', '北京周一 00:00 → 归新一周');
});

t('周报周期切分：闭区间含周一与周日，排除上周日与下周一', () => {
  const a = aggregate([zRow('2026-10-05'), zRow('2026-10-11'), zRow('2026-10-04'), zRow('2026-10-12')], pricer);
  const r = buildReport(a, {}, { type: 'week', offset: 0 }, NOW);
  assert.equal(r.data.start, '2026-10-05');
  assert.equal(r.data.end, '2026-10-11');
  assert.equal(r.data.totals.requests, 2, `got ${r.data.totals.requests}`);
  assert.equal(r.data.tools.length, 1, '只有 zcode 一个工具入榜');
});

t('月报周期与月末跨月：10-01 起至 10-31，9 月数据不混入', () => {
  // UTC 8-31 16:00 = 北京 9-1 00:01 段 → 归 9 月（跨月边界行）
  const a = aggregate([
    zRow('2026-10-01'), codexRow('2026-09-30'),
    { tool: 'zcode', ts: Date.UTC(2026, 7, 31, 16, 0), model: 'glm-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null },
  ], pricer);
  const r = buildReport(a, {}, { type: 'month', offset: 0 }, NOW);
  assert.equal(r.data.start, '2026-10-01');
  assert.equal(r.data.end, '2026-10-31');
  assert.equal(r.data.totals.requests, 1, '只有 10-01 那条入本期');
});

t('month offset=1 上期：9 月整月（含北京 9-1 边界行），排除 10 月', () => {
  const a = aggregate([
    zRow('2026-09-30'), codexRow('2026-09-15'), zRow('2026-10-01'),
    { tool: 'zcode', ts: Date.UTC(2026, 7, 31, 16, 0), model: 'glm-5.3', inputTokens: 1e6, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, costUsd: null },
  ], pricer);
  const r = buildReport(a, {}, { type: 'month', offset: 1 }, NOW);
  assert.equal(r.data.start, '2026-09-01');
  assert.equal(r.data.end, '2026-09-30');
  assert.equal(r.data.totals.requests, 3, `got ${r.data.totals.requests}`);
});

t('week offset=1 上期：上一整周（上周一 ~ 上周日）', () => {
  const a = aggregate([zRow('2026-09-28'), zRow('2026-10-04'), zRow('2026-10-05')], pricer);
  const r = buildReport(a, {}, { type: 'week', offset: 1 }, NOW);
  assert.equal(r.data.start, '2026-09-28');
  assert.equal(r.data.end, '2026-10-04');
  assert.equal(r.data.totals.requests, 2);
});

t('环比计算：本期 ¥21.6 vs 上期 ¥14.4 → ↑50%；下降方向 ↓ 正确', () => {
  const a = aggregate([
    codexRow('2026-10-06'), codexRow('2026-10-06'), codexRow('2026-10-07'), // 本期 3 × $1 = ¥21.6
    codexRow('2026-09-29'), codexRow('2026-09-30'),                          // 上期 2 × $1 = ¥14.4
  ], pricer);
  const up = buildReport(a, {}, { type: 'week' }, NOW);
  assert.ok(up.markdown.includes('↑50%'), '应含 ↑50%');
  assert.ok(Math.abs(up.data.totals.cnyDeltaPct - 50) < 1e-6);
  // 反向：本期 2 条、上期 3 条 → (14.4-21.6)/21.6 = -33.3%
  const down = buildReport(aggregate([
    codexRow('2026-10-06'), codexRow('2026-10-07'),
    codexRow('2026-09-29'), codexRow('2026-09-30'), codexRow('2026-10-01'),
  ], pricer), {}, { type: 'week' }, NOW);
  assert.ok(down.markdown.includes('↓33%'), '应含 ↓33%');
});

t('上期无数据：显示「上期无数据」，不给百分比', () => {
  const a = aggregate([zRow('2026-10-06')], pricer);
  const r = buildReport(a, {}, { type: 'week' }, NOW);
  assert.equal(r.data.prevHasData, false);
  assert.equal(r.data.totals.cnyDeltaPct, null);
  assert.ok(r.markdown.includes('上期无数据'));
  assert.ok(!r.markdown.includes('↑'), '无百分比箭头');
});

t('空 agg：不抛错、出「本期暂无数据」、保留总览节与脚注', () => {
  const r = buildReport(aggregate([], pricer), {}, { type: 'week' }, NOW);
  assert.equal(r.data.hasData, false);
  assert.ok(r.markdown.includes('## 总览'));
  assert.ok(r.markdown.includes('本期暂无数据'));
  assert.ok(r.markdown.includes('口径说明'));
});

t('markdown 七节标题齐全（有数据时）', () => {
  const a = aggregate([zRow('2026-10-06'), codexRow('2026-10-05')], pricer);
  const r = buildReport(a, { usdCnyRate: 7.2, dailyGoal: { cny: 200 }, plans: {}, priceOverrides: {} }, { type: 'week' }, NOW);
  assert.ok(r.markdown.includes('# AI 用量周报 · 2026-10-05 ~ 2026-10-11'), `标题应含周期起止：${r.title}`);
  assert.ok(r.markdown.includes('> 生成于 2026-10-07 12:00'), '应含生成时间');
  for (const h of ['## 总览', '## 工具榜', '## 模型榜 Top 5', '## 最贵的一天', '## 预算达成率', '口径说明']) {
    assert.ok(r.markdown.includes(h), `缺节：${h}`);
  }
  assert.ok(r.markdown.includes('**2026-10-06**'), '最贵的一天应加粗日期');
});

t('format:list 列表版（微信推送用）：三处表格降级为列表行，默认表格版不受影响', () => {
  const a = aggregate([zRow('2026-10-06'), codexRow('2026-10-05'), codexRow('2026-09-29')], pricer);
  const flat = buildReport(a, { dailyGoal: { cny: 200 } }, { type: 'week', offset: 0, format: 'list' }, NOW);
  assert.ok(!flat.markdown.includes('| ---') && !flat.markdown.includes('| 指标 |'), '列表版不得含表格');
  assert.ok(flat.markdown.includes('- 总成本（等价口径）：'), '总览列表行');
  assert.ok(flat.markdown.includes('- ZCode：'), '工具榜列表行');
  assert.ok(flat.markdown.includes('- glm-5.3（ZCode）：'), '模型榜列表行');
  assert.ok(flat.markdown.includes('## 预算达成率') && flat.markdown.includes('口径说明'), '预算/脚注节不变');
  const table = buildReport(a, { dailyGoal: { cny: 200 } }, { type: 'week', offset: 0 }, NOW);
  assert.ok(table.markdown.includes('| 指标 | 本期 | 环比上期 |'), '不传 format 仍为表格');
});

t('预算节：dailyGoal>0 时出现并算日均；未配置任何预算时不出现', () => {
  const a = aggregate([zRow('2026-10-06'), zRow('2026-10-07')], pricer); // 两天天各 ¥8
  const withGoal = buildReport(a, { dailyGoal: { cny: 200 } }, { type: 'week' }, NOW);
  assert.ok(withGoal.markdown.includes('## 预算达成率'));
  assert.ok(withGoal.markdown.includes('当日目标 ¥200'), '应含目标金额');
  assert.ok(withGoal.markdown.includes('按已过 3/7 天'), '本周三已过 3 天');
  const noBudget = buildReport(a, {}, { type: 'week' }, NOW);
  assert.ok(!noBudget.markdown.includes('## 预算达成率'), '无 dailyGoal 且无 cnyPerMonth 时不应出预算节');
});

t('预算节：工具 cnyPerMonth 配置时出现（月报直接比月额度）', () => {
  const a = aggregate([zRow('2026-10-06')], pricer);
  const p = { dailyGoal: { cny: 0 }, plans: { zcode: { cnyPerMonth: 300 } } };
  const r = buildReport(a, p, { type: 'month' }, NOW);
  assert.ok(r.markdown.includes('## 预算达成率'), 'cnyPerMonth 配置也应触发预算节');
  assert.ok(r.markdown.includes('月额度 ¥300'), '月报应含月额度对比');
  assert.ok(!r.markdown.includes('当日目标'), 'dailyGoal=0 不出目标行');
});

// == alerts：额度预警推送（异步段：run/send 返回 Promise，需 await 后再汇总） ==
(async () => {
  // 异步用例包装：与同步 t() 同样的计数与输出
  const ta = (name, fn) => fn().then(
    () => { pass++; console.log('  ok -', name); },
    e => { fail++; console.error('  FAIL -', name, '\n   ', e.message); });

  const alerts = require('../server/lib/alerts');
  const ALERT_PLANS = { alerts: { thresholds: { fiveHour: 85, weekly: 85, dailyGoalPct: 100 } } };
  const snapOf = over => Object.assign({ agg: { daily: {} }, zhipuQuota: null, minimaxQuota: null, chatgptQuota: null }, over);
  const RESET_AT = NOW + 47 * 60e3; // NOW 整除 5 分钟桶（UTC 整点），47 分钟对应文案断言
  const zhipuQ = (fiveHourPct, weeklyPct, resetAt = RESET_AT) => ({
    available: true, provider: '智谱 Coding Plan',
    fiveHour: { usedPercent: fiveHourPct, resetAt, resetMsLeft: null },
    weekly: { usedPercent: weeklyPct, resetAt, resetMsLeft: null },
    fetchedAt: NOW,
  });
  const memStore = () => {
    const m = new Map();
    return { get: k => (m.has(k) ? m.get(k).at : null), set: (k, at, st) => m.set(k, { at, st }), dump: () => m };
  };

  console.log('== alerts：evaluate（阈值触发 / 逐字段兜底 / 当日目标） ==');
  t('evaluate：三家 × 两窗口阈值触发/不触发，key 含 resetAt，文案只含百分比与倒计时', () => {
    const chatgptQ = {
      available: true, provider: 'ChatGPT PLUS',
      fiveHour: { usedPercent: 90, resetAt: '2026-10-07T12:47:00.000Z', resetMsLeft: null },
      weekly: { usedPercent: 88, resetAt: '2026-10-10T12:47:00.000Z', resetMsLeft: null },
      fetchedAt: NOW,
    };
    const ev = alerts.evaluate(snapOf({ zhipuQuota: zhipuQ(90, 80), chatgptQuota: chatgptQ }), ALERT_PLANS, NOW);
    assert.equal(ev.length, 3, `zhipu 5h + chatgpt 两窗口，got ${ev.length}`);
    const e0 = ev.find(e => e.key.startsWith('zhipu|fiveHour|'));
    assert.equal(e0.key, `zhipu|fiveHour|${RESET_AT}`);
    assert.ok(e0.title.includes('智谱 Coding Plan') && e0.title.includes('90%'));
    assert.equal(e0.message, '约 47 分钟后重置');
    assert.equal(e0.severity, 'warning');
    assert.ok(ev.some(e => e.key === `chatgpt|weekly|${Date.parse('2026-10-10T12:47:00.000Z')}`), 'ISO 串 resetAt 可解析入 key');
    assert.equal(alerts.evaluate(snapOf({ zhipuQuota: zhipuQ(84, 80) }), ALERT_PLANS, NOW).length, 0, '84% < 85% 不触发');
    assert.equal(alerts.evaluate(snapOf({ zhipuQuota: { available: false } }), ALERT_PLANS, NOW).length, 0, 'available=false 不评估');
    assert.equal(alerts.evaluate(snapOf({ minimaxQuota: { available: true, fiveHour: { resetAt: 1 }, weekly: null, fetchedAt: NOW } }), ALERT_PLANS, NOW).length, 0, '缺 usedPercent 不评估');
  });
  t('evaluate：阈值逐字段兜底 ?? 85/85/100（老配置缺 thresholds / 缺 alerts 块）', () => {
    assert.equal(alerts.evaluate(snapOf({ zhipuQuota: zhipuQ(85, 84) }), { alerts: {} }, NOW).length, 1, '85 ≥ 85 触发、84 < 85 不触发');
    assert.equal(alerts.evaluate(snapOf({ zhipuQuota: zhipuQ(99, 99) }), {}, NOW).length, 2, '无 alerts 块也按默认评估');
  });
  t('evaluate：severity 分级——窗口 ≥ 95% 为 critical', () => {
    assert.equal(alerts.evaluate(snapOf({ zhipuQuota: zhipuQ(96, 10) }), ALERT_PLANS, NOW)[0].severity, 'critical');
  });
  t('evaluate：当日目标事件（key=goal|北京日期、金额口径 costCny+equivalentCny、goal=0 关闭）', () => {
    const today = '2026-10-07'; // NOW = 北京 10-07 12:00
    const day = { [today]: { __total: { costCny: 12, equivalentCny: 200 } } }; // ¥212 / ¥200 = 106%
    const ev = alerts.evaluate(snapOf({ agg: { daily: day } }), { alerts: {}, dailyGoal: { cny: 200 } }, NOW);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].key, 'goal|2026-10-07');
    assert.ok(ev[0].title.includes('¥212') && ev[0].title.includes('106%'));
    assert.equal(ev[0].message, '已超支');
    assert.equal(ev[0].severity, 'critical');
    const low = snapOf({ agg: { daily: { [today]: { __total: { costCny: 0, equivalentCny: 100 } } } } });
    assert.equal(alerts.evaluate(low, { alerts: {}, dailyGoal: { cny: 200 } }, NOW).length, 0, '50% < 100% 不触发');
    assert.equal(alerts.evaluate(snapOf({ agg: { daily: day } }), { alerts: {}, dailyGoal: { cny: 0 } }, NOW).length, 0, 'goal=0 关闭');
  });

  console.log('== alerts：冷却 key 稳定性 ==');
  t('冷却 key：resetMsLeft 兜底在 ±2s 抖动下稳定（5 分钟桶量化）', () => {
    const mk = (fetchedAt, drift) => ({
      available: true, provider: 'MiniMax Token Plan MAX',
      fiveHour: { usedPercent: 90, resetAt: null, resetMsLeft: 3600e3 + drift },
      weekly: { usedPercent: 5, resetAt: null, resetMsLeft: 100e6 },
      fetchedAt,
    });
    const keyOf = q => alerts.evaluate(snapOf({ minimaxQuota: q }), ALERT_PLANS, NOW)[0].key;
    const base = keyOf(mk(NOW, 0));
    assert.equal(keyOf(mk(NOW + 2000, -2000)), base, '+2s 抖动后 key 不变');
    assert.equal(keyOf(mk(NOW - 2000, 2000)), base, '-2s 抖动后 key 不变');
    assert.ok(base.startsWith('minimax|fiveHour|~'), '兜底身份应带 ~ 桶标记');
  });
  t('冷却 key：无 resetAt 且无 resetMsLeft → 不发（无稳定冷却身份）', () => {
    const q = { available: true, provider: 'X', fiveHour: { usedPercent: 99, resetAt: null, resetMsLeft: null }, weekly: null, fetchedAt: NOW };
    assert.equal(alerts.evaluate(snapOf({ minimaxQuota: q }), ALERT_PLANS, NOW).length, 0);
  });

  console.log('== alerts：四适配器 payload ==');
  t('ntfy：POST 站点根 JSON，topic 提取正确（含逗号分隔多 topic），header 不含非 latin1', () => {
    const p = alerts.ADAPTERS.ntfy.buildPayload('https://ntfy.sh/my-topic', '智谱 5h 已用 91%', '约 47 分钟后重置');
    assert.equal(p.url, 'https://ntfy.sh/');
    const b = JSON.parse(p.body);
    assert.equal(b.topic, 'my-topic');
    assert.equal(b.title, '智谱 5h 已用 91%');
    assert.equal(b.message, '约 47 分钟后重置');
    assert.equal(b.priority, 'default');
    assert.deepEqual(b.tags, ['warning']);
    assert.ok(Object.values(p.headers).every(v => /^[\x00-\x7f]*$/.test(v)), 'header 不得含非 latin1 字符');
    const p2 = alerts.ADAPTERS.ntfy.buildPayload('https://ntfy.sh/t1,t2/', 'T', 'M');
    assert.equal(p2.url, 'https://ntfy.sh/');
    assert.equal(JSON.parse(p2.body).topic, 't1,t2', '逗号分隔多 topic 保留原样');
    assert.throws(() => alerts.ADAPTERS.ntfy.buildPayload('https://ntfy.sh/', 'T', 'M'), /topic/, '缺 topic 应抛错');
  });
  t('bark：POST 原 URL，JSON {title, body, group}', () => {
    const p = alerts.ADAPTERS.bark.buildPayload('https://api.day.app/KEY123', 'T', 'M');
    assert.equal(p.url, 'https://api.day.app/KEY123');
    assert.deepEqual(JSON.parse(p.body), { title: 'T', body: 'M', group: 'ai-quota' });
  });
  t('serverchan：form 编码 title/desp，中文与 Markdown 无损往返', () => {
    const p = alerts.ADAPTERS.serverchan.buildPayload('https://sctapi.ftqq.com/SENDKEY.send', '今日成本 ¥12', '- **已用 90%**');
    assert.equal(p.url, 'https://sctapi.ftqq.com/SENDKEY.send');
    assert.ok(p.headers['Content-Type'].includes('application/x-www-form-urlencoded'));
    const q = new URLSearchParams(p.body);
    assert.equal(q.get('title'), '今日成本 ¥12');
    assert.equal(q.get('desp'), '- **已用 90%**');
  });
  t('generic：JSON 含 severity/source/data{percent, resetAt}，extra 缺省兜 warning/null', () => {
    const p = alerts.ADAPTERS.generic.buildPayload('https://example.com/hook', 'T', 'M', { severity: 'critical', percent: 106, resetAt: 1893456000000 });
    const b = JSON.parse(p.body);
    assert.equal(b.title, 'T');
    assert.equal(b.message, 'M');
    assert.equal(b.severity, 'critical');
    assert.equal(b.source, 'ai-quota-dashboard');
    assert.deepEqual(b.data, { percent: 106, resetAt: 1893456000000 });
    const b2 = JSON.parse(alerts.ADAPTERS.generic.buildPayload('https://example.com/hook', 'T', 'M').body);
    assert.equal(b2.severity, 'warning');
    assert.deepEqual(b2.data, { percent: null, resetAt: null });
  });

  console.log('== alerts：wecom 适配器（企业微信群机器人）+ verify 响应体校验 + 卡片渲染 ==');
  t('wecom：markdown msgtype、severity 着色（critical=红/info=绿/其他=灰）、extra.card 优先、header 只 latin1', () => {
    const p = alerts.ADAPTERS.wecom.buildPayload('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K1', '⚠️ 智谱 5h窗口已用 90%', '约 47 分钟后重置', { severity: 'critical', card: '剩余额度：10%' });
    assert.equal(p.url, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K1');
    const b = JSON.parse(p.body);
    assert.equal(b.msgtype, 'markdown');
    assert.ok(b.markdown.content.startsWith('**<font color="warning">⚠️ 智谱 5h窗口已用 90%</font>**'), 'critical 标题红');
    assert.ok(b.markdown.content.includes('剩余额度：10%'), 'card 正文优先');
    assert.ok(!b.markdown.content.includes('约 47 分钟后重置'), '有 card 时不用 message');
    const gray = JSON.parse(alerts.ADAPTERS.wecom.buildPayload('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K1', 'T', 'M', { severity: 'warning' }).body);
    assert.ok(gray.markdown.content.includes('<font color="comment">'), 'warning 级灰色');
    assert.ok(gray.markdown.content.endsWith('M'), '无 card 回退 message');
    const green = JSON.parse(alerts.ADAPTERS.wecom.buildPayload('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K1', '📊 今日摘要', 'M', { severity: 'info' }).body);
    assert.ok(green.markdown.content.includes('<font color="info">'), 'info 级绿色（摘要/测试）');
    assert.ok(Object.values(p.headers).every(v => /^[\x00-\x7f]*$/.test(v)), 'header 不得含非 latin1 字符');
  });
  t('wecom verify：errcode 0 放行、非 0 抛 errmsg（HTTP 200 业务失败必须暴露）、非 JSON 体静默放过', () => {
    alerts.ADAPTERS.wecom.verify({ body: '{"errcode":0,"errmsg":"ok"}' });
    assert.throws(() => alerts.ADAPTERS.wecom.verify({ body: '{"errcode":93000,"errmsg":"invalid webhook url"}' }), /93000.*invalid webhook url/);
    assert.throws(() => alerts.ADAPTERS.wecom.verify({ body: '{"errcode":40036,"errmsg":"no response"}' }), /40036/);
    alerts.ADAPTERS.wecom.verify({ body: '<html>oops</html>' }); // 非 JSON：不抛，交给状态码
    alerts.ADAPTERS.wecom.verify({ body: '' });
  });
  t('serverchan：desp 优先用 extra.card（Server酱微信端渲染 Markdown），无 card 回退 message', () => {
    const p = alerts.ADAPTERS.serverchan.buildPayload('https://sctapi.ftqq.com/K.send', 'T', 'plain', { card: '剩余额度：10%' });
    assert.equal(new URLSearchParams(p.body).get('desp'), '剩余额度：10%');
  });
  t('renderCard：quota 事件（剩余百分比 + 绝对值千分位 + 倒计时）/ goal 事件（金额）/ 未知事件空串', () => {
    const card = alerts.renderCard({ kind: 'quota', remainingPercent: 13, amounts: { used: 870000, total: 1000000, remaining: 130000 }, message: '约 2 小时 15 分后重置' });
    assert.ok(card.includes('剩余额度：13%'));
    assert.ok(card.includes('已用 870,000 / 总量 1,000,000'), `千分位绝对值：${card}`);
    assert.ok(card.includes('约 2 小时 15 分后重置'));
    const noAmt = alerts.renderCard({ kind: 'quota', remainingPercent: 40, amounts: { used: null, total: null, remaining: null }, message: '' });
    assert.equal(noAmt, '剩余额度：40%', '无绝对值只出百分比行');
    const g = alerts.renderCard({ kind: 'goal', spent: 212, goal: 200, message: '已超支' });
    assert.ok(g.includes('已花 ¥212 / 目标 ¥200') && g.includes('已超支'));
    assert.equal(alerts.renderCard({ kind: 'digest', card: '自带卡片' }), '');
    assert.equal(alerts.renderCard({}), '');
  });
  t('evaluate 卡片数据：remainingPercent / amounts 随事件携带（智谱绝对值、缺省 null 不造假）', () => {
    const q = {
      available: true, provider: '智谱 Coding Plan',
      fiveHour: { usedPercent: 90, remainingPercent: 10, used: 90, total: 100, remaining: 10, resetAt: RESET_AT, resetMsLeft: null },
      weekly: { usedPercent: 91, resetAt: RESET_AT, resetMsLeft: null }, // 无绝对值字段
      fetchedAt: NOW,
    };
    const ev = alerts.evaluate(snapOf({ zhipuQuota: q }), ALERT_PLANS, NOW);
    const e5 = ev.find(e => e.key.startsWith('zhipu|fiveHour|'));
    assert.equal(e5.remainingPercent, 10);
    assert.deepEqual(e5.amounts, { used: 90, total: 100, remaining: 10 });
    const ew = ev.find(e => e.key.startsWith('zhipu|weekly|'));
    assert.equal(ew.remainingPercent, null, '缺 remainingPercent 如实 null');
    assert.deepEqual(ew.amounts, { used: null, total: null, remaining: null });
  });
  await ta('send：wecom 经 verify——HTTP 200 + errcode!=0 判失败（errmsg 上抛）；errcode=0 正常送达', async () => {
    await assert.rejects(
      alerts.send('wecom', { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=BAD', title: 'T', message: 'M', severity: 'info' },
        { sender: async () => ({ ok: true, status: 200, body: '{"errcode":93000,"errmsg":"invalid webhook url"}' }) }),
      /invalid webhook url/);
    await alerts.send('wecom', { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=OK', title: 'T', message: 'M', severity: 'info' },
      { sender: async () => ({ ok: true, status: 200, body: '{"errcode":0,"errmsg":"ok"}' }) });
    // 非 wecom 适配器无 verify 钩子 → 行为不变（200 即成功）
    await alerts.send('generic', { webhookUrl: 'http://127.0.0.1:9/hook', title: 'T', message: 'M' },
      { sender: async () => ({ ok: true, status: 200, body: 'whatever' }) });
  });

  console.log('== alerts：send 协议白名单与 sender 注入 ==');
  t('协议白名单：file:/data:/ftp: 显式抛错（拒绝而非静默）', () => {
    assert.throws(() => alerts.send('generic', { webhookUrl: 'file:///etc/passwd', title: 't', message: 'm' }), /协议/);
    assert.throws(() => alerts.send('generic', { webhookUrl: 'data:text/html,hi', title: 't', message: 'm' }), /协议/);
    assert.throws(() => alerts.send('generic', { webhookUrl: 'ftp://x/y', title: 't', message: 'm' }), /协议/);
  });
  await ta('send：sender 可注入——http 正常送达、非 2xx 抛错供 run 记状态', async () => {
    let seen;
    await alerts.send('generic',
      { webhookUrl: 'http://127.0.0.1:9/hook', title: 'T', message: 'M', severity: 'critical', percent: 95, resetAt: 123 },
      { sender: async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200 }; } });
    assert.equal(seen.url, 'http://127.0.0.1:9/hook');
    assert.equal(seen.opts.method, 'POST');
    assert.ok(seen.opts.body.includes('"source":"ai-quota-dashboard"'));
    await assert.rejects(
      alerts.send('generic', { webhookUrl: 'http://127.0.0.1:9/hook', title: 'T', message: 'M' },
        { sender: async () => ({ ok: false, status: 503, error: 'HTTP 503' }) }),
      /503/);
  });

  console.log('== alerts：run（冷却 / 开关 / 泄露面） ==');
  await ta('run：冷却窗内抑制、过期后再发；enabled=false / 空 webhookUrl 直接返回', async () => {
    const store = memStore();
    const urls = [];
    const sender = async url => { urls.push(url); return { ok: true, status: 200 }; };
    const p = {
      alerts: { enabled: true, webhookType: 'generic', webhookUrl: 'https://example.com/hook?key=SECRET', thresholds: { fiveHour: 85, weekly: 85 }, cooldownMinutes: 60 },
      dailyGoal: { cny: 0 },
    };
    const snap = snapOf({ zhipuQuota: zhipuQ(90, 10) });
    let r = await alerts.run(snap, p, { store, sender, now: NOW });
    assert.equal(r.sent, 1);
    assert.equal(r.events, 1);
    r = await alerts.run(snap, p, { store, sender, now: NOW + 60e3 });
    assert.equal(r.sent, 0, '冷却窗内抑制');
    assert.equal(r.suppressed, 1);
    r = await alerts.run(snap, p, { store, sender, now: NOW + 61 * 60e3 });
    assert.equal(r.sent, 1, '冷却过期后再发');
    assert.equal(urls.length, 2);
    assert.equal((await alerts.run(snap, { alerts: { enabled: false, webhookUrl: 'https://x.example/' } }, { sender })).sent, 0);
    assert.equal((await alerts.run(snap, { alerts: { enabled: true, webhookUrl: '' } }, { sender })).sent, 0);
  });
  await ta('run：单条 send 失败不抛、不影响其余事件；失败也占用冷却窗；console 只落 host', async () => {
    const store = memStore();
    let calls = 0;
    const sender = async () => { calls++; return calls === 1 ? { ok: false, status: 0, error: 'connect ECONNREFUSED' } : { ok: true, status: 200 }; };
    const p = { alerts: { enabled: true, webhookType: 'generic', webhookUrl: 'https://example.com/hook', thresholds: { fiveHour: 85, weekly: 85 } }, dailyGoal: { cny: 0 } };
    const snap = snapOf({ zhipuQuota: zhipuQ(90, 91) }); // 5h + 周窗口都触发
    const origErr = console.error;
    const errLines = [];
    console.error = (...a) => errLines.push(a.map(String).join(' '));
    let r;
    try { r = await alerts.run(snap, p, { store, sender, now: NOW }); } finally { console.error = origErr; }
    assert.equal(r.events, 2);
    assert.equal(r.sent, 1, '第二条照发');
    assert.equal(errLines.length, 1, '失败只打一条日志');
    assert.ok(errLines[0].includes('example.com') && !errLines[0].includes('/hook'), 'console 只落 host');
    const st = {};
    for (const [k, v] of store.dump()) st[k] = v.st;
    assert.ok(Object.values(st).some(s => s.startsWith('failed:')), '失败事件记 failed 状态');
    assert.ok(Object.values(st).some(s => s === 'success'), '成功事件记 success 状态');
    assert.equal(store.dump().size, 2, '失败也占用冷却窗');
  });
  await ta('run：alert_log 写入绝不落完整 webhookUrl（fake store 捕获断言）', async () => {
    const writes = [];
    const store = { get: () => null, set: (k, at, st) => writes.push({ k, at, st }) };
    const errLines = [];
    const origErr = console.error;
    console.error = (...a) => errLines.push(a.map(String).join(' '));
    let r;
    try {
      r = await alerts.run(snapOf({ zhipuQuota: zhipuQ(90, 10) }),
        { alerts: { enabled: true, webhookType: 'ntfy', webhookUrl: 'https://ntfy.sh/secret-topic-abc', thresholds: { fiveHour: 85 } }, dailyGoal: { cny: 0 } },
        { store, sender: async () => ({ ok: false, status: 0, error: 'connect ETIMEDOUT https://ntfy.sh/secret-topic-abc' }), now: NOW });
    } finally { console.error = origErr; }
    assert.equal(r.sent, 0);
    assert.equal(writes.length, 1, '失败也要写 alert_log 状态');
    const blob = JSON.stringify(writes) + '\n' + errLines.join('\n');
    assert.ok(!blob.includes('secret-topic-abc'), 'path/密钥不得出现');
    assert.ok(blob.includes('ntfy.sh'), 'host 可保留');
    assert.ok(writes[0].st.startsWith('failed:'));
  });

  console.log('== alerts：冷却存储（sqlite / 内存 / 兜底） ==');
  t('createSqliteStore：path 惰性打开、跨实例持久、db 注入共用同表；内存实现', () => {
    const dbPath = path.join(TMP_DIR, 'alerts-cooldown.sqlite');
    const s1 = alerts.createSqliteStore({ path: dbPath });
    s1.set('zhipu|fiveHour|123', 111, 'success');
    assert.equal(s1.get('zhipu|fiveHour|123'), 111);
    assert.equal(alerts.createSqliteStore({ path: dbPath }).get('zhipu|fiveHour|123'), 111, '冷却状态跨重启保留');
    const s3 = alerts.createSqliteStore({ db: new DatabaseSync(dbPath) }); // 注入已打开连接
    s3.set('zhipu|fiveHour|123', 222, 'failed: HTTP 500');
    assert.equal(s1.get('zhipu|fiveHour|123'), 222, '同库行被覆盖');
    const mem = alerts.createMemoryStore();
    assert.equal(mem.get('x'), null);
    mem.set('x', 9, 'success');
    assert.equal(mem.get('x'), 9);
  });
  t('createSqliteStore：坏库自动退化内存，get/set 不抛', () => {
    const bad = path.join(TMP_DIR, 'bad-alerts.sqlite');
    fs.writeFileSync(bad, 'not a sqlite database');
    const s = alerts.createSqliteStore({ path: bad });
    s.set('k', 1, 'success');
    assert.equal(s.get('k'), 1);
  });
  t('defaultStore：AI_QUOTA_HISTORY=0 → 内存；库可用 → 走 history.sqlite 的 alert_log', () => {
    process.env.AI_QUOTA_HISTORY = '0';
    assert.equal(alerts.defaultStore().backend, 'memory');
    delete process.env.AI_QUOTA_HISTORY;
    const s = alerts.defaultStore(); // history 单例已由前段测试打开
    assert.equal(s.backend, 'sqlite');
    s.set('goal|2099-01-01', 42, 'success');
    assert.equal(s.get('goal|2099-01-01'), 42);
    assert.equal(history.open().prepare("SELECT status FROM alert_log WHERE rule_key = 'goal|2099-01-01'").get().status, 'success');
  });

  console.log('== alerts：webhookUrl 掩码与 POST 合并 ==');
  t('maskWebhookUrl：保留 scheme://host/，path+query 整段 ••••（短 path 也不留明文）', () => {
    assert.equal(alerts.maskWebhookUrl('https://ntfy.sh/my-secret-topic'), 'https://ntfy.sh/••••');
    assert.equal(alerts.maskWebhookUrl('https://sctapi.ftqq.com/SENDKEY.send?x=1'), 'https://sctapi.ftqq.com/••••');
    assert.equal(alerts.maskWebhookUrl('https://api.day.app/ab'), 'https://api.day.app/••••', '短 path 全掩');
    assert.equal(alerts.maskWebhookUrl('https://ntfy.sh/'), 'https://ntfy.sh/');
    assert.equal(alerts.maskWebhookUrl(''), '');
    assert.equal(alerts.maskWebhookUrl('not a url'), '••••');
  });
  t('maskQuotaKeys：alerts.webhookUrl 出掩码形态，其余 alerts 字段原样；入参不被修改', () => {
    const cfg = { alerts: { enabled: true, webhookType: 'bark', webhookUrl: 'https://api.day.app/KEYXYZ', thresholds: { fiveHour: 80 }, cooldownMinutes: 30 } };
    const m = maskQuotaKeys(cfg);
    assert.equal(m.alerts.webhookUrl, 'https://api.day.app/••••');
    assert.equal(m.alerts.webhookType, 'bark');
    assert.equal(m.alerts.thresholds.fiveHour, 80);
    assert.equal(m.alerts.cooldownMinutes, 30);
    assert.equal(cfg.alerts.webhookUrl, 'https://api.day.app/KEYXYZ', '入参不被修改');
  });
  t('applyPlansUpdate alerts 三态：掩码回显保留原值 / 空串清除 / 新 http(s) 覆盖 / 非 http(s) 剔除', () => {
    const cur = { alerts: { enabled: false, webhookType: 'ntfy', webhookUrl: 'https://ntfy.sh/top-secret', thresholds: { fiveHour: 85, weekly: 85, dailyGoalPct: 100 }, cooldownMinutes: 60 } };
    assert.equal(applyPlansUpdate(cur, { alerts: { webhookUrl: alerts.maskWebhookUrl(cur.alerts.webhookUrl) } }).alerts.webhookUrl, 'https://ntfy.sh/top-secret', '掩码回显=未改动');
    assert.equal(applyPlansUpdate(cur, { alerts: { webhookUrl: '' } }).alerts.webhookUrl, '', '空串=清除');
    assert.equal(applyPlansUpdate(cur, { alerts: { webhookUrl: 'https://api.day.app/NEWKEY' } }).alerts.webhookUrl, 'https://api.day.app/NEWKEY', '新值覆盖');
    assert.equal(applyPlansUpdate(cur, { alerts: { webhookUrl: 'ftp://evil/x' } }).alerts.webhookUrl, 'https://ntfy.sh/top-secret', '非法协议剔除保留原值');
  });
  t('applyPlansUpdate alerts：字段校验（布尔/枚举/阈值 0~100/正整数）与模板打底', () => {
    const cur = { alerts: { enabled: false, webhookType: 'ntfy', webhookUrl: '', thresholds: { fiveHour: 85, weekly: 85, dailyGoalPct: 100 }, cooldownMinutes: 60 } };
    let next = applyPlansUpdate(cur, { alerts: { enabled: true, webhookType: 'serverchan', thresholds: { fiveHour: 70, weekly: 95, dailyGoalPct: 50 }, cooldownMinutes: 5 } });
    assert.equal(next.alerts.enabled, true);
    assert.equal(next.alerts.webhookType, 'serverchan');
    assert.deepEqual(next.alerts.thresholds, { fiveHour: 70, weekly: 95, dailyGoalPct: 50 });
    assert.equal(next.alerts.cooldownMinutes, 5);
    next = applyPlansUpdate(cur, { alerts: { enabled: 'yes', webhookType: 'sms', thresholds: { fiveHour: -1, weekly: 101, dailyGoalPct: 'abc' }, cooldownMinutes: 0 } });
    assert.equal(next.alerts.enabled, false, '非布尔剔除');
    assert.equal(next.alerts.webhookType, 'ntfy', '非枚举剔除');
    assert.deepEqual(next.alerts.thresholds, { fiveHour: 85, weekly: 85, dailyGoalPct: 100 }, '越界/非法阈值剔除');
    assert.equal(next.alerts.cooldownMinutes, 60, '非正整数剔除');
    next = applyPlansUpdate({}, { alerts: { enabled: true } }); // 老 plans.json 无 alerts 块
    assert.equal(next.alerts.enabled, true);
    assert.equal(next.alerts.webhookType, 'ntfy', '模板默认打底');
    assert.equal(next.alerts.cooldownMinutes, 60);
  });
  t('applyPlansUpdate alerts：wecom 枚举 + digest/reportPush 白名单（enabled 布尔 / hour 整数 0~23）', () => {
    const cur = { alerts: { enabled: false, webhookType: 'ntfy', webhookUrl: '', thresholds: { fiveHour: 85, weekly: 85, dailyGoalPct: 100 }, cooldownMinutes: 60 } };
    let next = applyPlansUpdate(cur, { alerts: { webhookType: 'wecom', digest: { enabled: true, hour: 22 }, reportPush: { week: { enabled: true, hour: 8 }, month: { enabled: true, hour: 0 } } } });
    assert.equal(next.alerts.webhookType, 'wecom', 'wecom 进枚举');
    assert.deepEqual(next.alerts.digest, { enabled: true, hour: 22 });
    assert.deepEqual(next.alerts.reportPush, { week: { enabled: true, hour: 8 }, month: { enabled: true, hour: 0 } }, 'hour=0 合法（0 点档）');
    next = applyPlansUpdate(cur, { alerts: { digest: { enabled: 'x', hour: 24 }, reportPush: { week: { enabled: true, hour: -1 }, month: { enabled: 1, hour: '9' } } } });
    assert.deepEqual(next.alerts.digest, { enabled: false, hour: 21 }, '非法 digest 保留模板默认');
    assert.deepEqual(next.alerts.reportPush.week, { enabled: true, hour: 9 }, 'hour=-1 剔除、enabled=true 合法保留');
    assert.deepEqual(next.alerts.reportPush.month, { enabled: false, hour: 9 }, '非布尔 enabled 剔除');
    // 未提交 digest/reportPush → 原值不动
    next = applyPlansUpdate(
      { alerts: { enabled: true, webhookType: 'wecom', webhookUrl: '', thresholds: {}, cooldownMinutes: 60, digest: { enabled: true, hour: 20 }, reportPush: { week: { enabled: true, hour: 10 }, month: { enabled: false, hour: 9 } } } },
      { alerts: { enabled: false } });
    assert.deepEqual(next.alerts.digest, { enabled: true, hour: 20 }, '未提交不动');
    assert.deepEqual(next.alerts.reportPush.week, { enabled: true, hour: 10 });
  });

  // == push：每日摘要构建 + 定时调度（digest / 周月报），全部注入 now/store/sender，零外呼 ==
  console.log('== push：buildDigest + runScheduled（每日摘要 / 周报 / 月报） ==');
  const push = require('../server/lib/push');
  const MON = Date.UTC(2026, 9, 5, 1, 30);   // 北京 2026-10-05（周一）09:30
  const NOV1 = Date.UTC(2026, 10, 1, 1, 30); // 北京 2026-11-01（周日）09:30
  const digiSnap = () => ({
    agg: { daily: { '2026-10-07': {
      __total: { requests: 12, inputTokens: 40000, outputTokens: 5000, costCny: 0, equivalentCny: 8.4 },
      zcode: { requests: 8, inputTokens: 30000, outputTokens: 4000, costCny: 0, equivalentCny: 5.2, models: {} },
      claudeCode: { requests: 4, inputTokens: 10000, outputTokens: 1000, costCny: 0, equivalentCny: 3.2, models: {} },
    } } },
    zhipuQuota: { available: true, provider: '智谱 Coding Plan', fiveHour: { usedPercent: 62 }, weekly: { usedPercent: 34 }, fetchedAt: NOW },
    minimaxQuota: null, chatgptQuota: null,
  });
  t('buildDigest：标题带目标进度、Top3 按成本降序、窗口用量行 available 才列、无目标不带进度', () => {
    const d = push.buildDigest(digiSnap(), { dailyGoal: { cny: 30 } }, NOW);
    assert.ok(d.title.includes('¥8.4') && d.title.includes('28%'), `title=${d.title}`);
    assert.ok(d.card.includes('当日目标 ¥30 · 已用 28%'));
    assert.ok(d.card.indexOf('ZCode') < d.card.indexOf('Claude Code'), 'Top3 按成本降序');
    assert.ok(d.card.includes('智谱 Coding Plan：5h 62% / 周 34%'), '窗口用量行');
    const d2 = push.buildDigest(digiSnap(), { dailyGoal: { cny: 0 } }, NOW);
    assert.ok(!d2.title.includes('目标') && !d2.card.includes('当日目标'), '无目标不带进度');
    const d3 = push.buildDigest({ agg: { daily: {} } }, {}, NOW);
    assert.ok(d3.title.includes('¥0'), '空数据不抛错');
  });
  await ta('runScheduled：每日摘要到点推送 + 同天去重 + 未到点不发 + 失败占本期不重试', async () => {
    const store = memStore();
    const sent = [];
    const sender = async (url, opts) => { sent.push(opts.body); return { ok: true, status: 200 }; };
    const plans = { alerts: { enabled: true, webhookType: 'generic', webhookUrl: 'https://example.com/h', digest: { enabled: true, hour: 9 } }, dailyGoal: { cny: 30 } };
    let r = await push.runScheduled(digiSnap(), plans, { store, sender, now: NOW }); // 北京 12:00 ≥ 9 点 → 推
    assert.equal(r.sent, 1, `got ${JSON.stringify(r)}`);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].includes('今日 AI 消耗'), '送达的是摘要事件');
    assert.ok(store.get('digest|2026-10-07') != null, '键为 digest|北京日期');
    r = await push.runScheduled(digiSnap(), plans, { store, sender, now: NOW + 3600e3 }); // 同天晚些
    assert.equal(r.held, 1, '同天第二次 → held');
    assert.equal(sent.length, 1, '不重发');
    const p21 = { alerts: { enabled: true, webhookType: 'generic', webhookUrl: 'https://example.com/h', digest: { enabled: true, hour: 21 } } };
    r = await push.runScheduled(digiSnap(), p21, { store, sender, now: NOW }); // 12 点 < 21 点
    assert.equal(r.sent + r.held + r.failed + r.empty, 0, '未到点不计任何动作');
    // 失败：也写 store，当天不再补试
    const st2 = memStore();
    let fails = 0;
    const senderFail = async () => { fails++; return { ok: false, status: 0, error: 'connect ECONNREFUSED' }; };
    await push.runScheduled(digiSnap(), plans, { store: st2, sender: senderFail, now: NOW });
    await push.runScheduled(digiSnap(), plans, { store: st2, sender: senderFail, now: NOW + 60e3 });
    assert.equal(fails, 1, '失败占本期，不再重试');
    // 摘要 disabled → 不动
    r = await push.runScheduled(digiSnap(), { alerts: { enabled: true, webhookType: 'generic', webhookUrl: 'https://example.com/h', digest: { enabled: false, hour: 9 } } }, { store, sender, now: NOW });
    assert.equal(r.sent + r.held + r.failed, 0);
  });
  await ta('runScheduled：周报仅周一推上一期（offset=1 列表版），非周一/已发/上周无数据三分支', async () => {
    const store = memStore();
    const sent = []; // wecom 通道：payload 即企业微信体，markdown.content = 彩色标题 + H1 剥离后的报告
    const sender = async (url, opts) => { sent.push(JSON.parse(opts.body).markdown.content); return { ok: true, status: 200 }; };
    const agg = { daily: { '2026-09-30': { zcode: { requests: 2, inputTokens: 1000, outputTokens: 0, costCny: 0, equivalentCny: 5, models: {} } } } };
    const plans = { alerts: { enabled: true, webhookType: 'wecom', webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K', reportPush: { week: { enabled: true, hour: 9 }, month: { enabled: false, hour: 9 } } } };
    let r = await push.runScheduled({ agg }, plans, { store, sender, now: NOW }); // 周三
    assert.equal(r.sent + r.held + r.failed + r.empty, 0, '周三不推周报');
    r = await push.runScheduled({ agg }, plans, { store, sender, now: MON }); // 周一 09:30
    assert.equal(r.sent, 1, `got ${JSON.stringify(r)}`);
    const c = sent[0];
    assert.ok(c.includes('09-28') && c.includes('10-04'), `推上一期：${c.slice(0, 60)}`);
    assert.ok(c.startsWith('**<font color="info">AI 用量周报'), '标题行代替 H1');
    assert.ok(!c.includes('# AI 用量周报'), 'H1 已剥离（避免标题重复）');
    assert.ok(!c.includes('| ---'), '列表版无表格');
    assert.ok(c.includes('ZCode'), '报告正文送达');
    assert.ok(store.get('report|week|2026-10-05') != null, '键以本周一为身份');
    r = await push.runScheduled({ agg }, plans, { store, sender, now: MON + 3600e3 }); // 同周一再跑
    assert.equal(r.held, 1);
    const st2 = memStore();
    r = await push.runScheduled({ agg: { daily: {} } }, plans, { store: st2, sender, now: MON }); // 上周无数据
    assert.equal(r.empty, 1, '无数据 → empty');
    assert.equal(st2.get('report|week|2026-10-05'), null, 'empty 不写 store（当天晚些出数据可再评估）');
  });
  await ta('runScheduled：月报仅每月 1 号推上一月；alerts.enabled=false 全直通；异常不逃逸', async () => {
    const store = memStore();
    const sent = [];
    const sender = async (url, opts) => { sent.push(opts.body); return { ok: true, status: 200 }; };
    const agg = { daily: { '2026-10-15': { zcode: { requests: 1, inputTokens: 1e6, outputTokens: 0, costCny: 0, equivalentCny: 8, models: {} } } } };
    const plans = { alerts: { enabled: true, webhookType: 'generic', webhookUrl: 'https://example.com/h', reportPush: { week: { enabled: false, hour: 9 }, month: { enabled: true, hour: 9 } } } };
    let r = await push.runScheduled({ agg }, plans, { store, sender, now: MON }); // 10-05 非 1 号
    assert.equal(r.sent + r.held + r.failed + r.empty, 0);
    r = await push.runScheduled({ agg }, plans, { store, sender, now: NOV1 }); // 11-01 周日 09:30
    assert.equal(r.sent, 1, `got ${JSON.stringify(r)}`);
    assert.ok(sent[0].includes('10-01') && sent[0].includes('10-31'), '推上月整月');
    assert.ok(store.get('report|month|2026-11') != null, '键以本月为身份');
    // enabled=false / 空 webhookUrl → 直通（不评估任何定时任务）
    for (const bad of [{ enabled: false, webhookUrl: 'https://x/', reportPush: { month: { enabled: true, hour: 9 } } },
                       { enabled: true, webhookUrl: '', reportPush: { month: { enabled: true, hour: 9 } } }]) {
      r = await push.runScheduled({ agg }, { alerts: bad }, { store, sender, now: NOV1 });
      assert.equal(r.sent + r.held + r.failed + r.empty, 0, '开关关闭直通');
    }
    // 形状异常快照不抛
    r = await push.runScheduled(null, plans, { store, sender, now: NOV1 });
    assert.ok(Number.isFinite(r.sent + r.held + r.failed + r.empty), 'null 快照不炸');
  });
  await ta('runScheduled：wecom 通道摘要卡片全链路（markdown + info 绿标题 + errcode 校验继承）', async () => {
    const store = memStore();
    const bodies = [];
    const sender = async (url, opts) => { bodies.push(JSON.parse(opts.body)); return { ok: true, status: 200, body: '{"errcode":0}' }; };
    const plans = { alerts: { enabled: true, webhookType: 'wecom', webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K', digest: { enabled: true, hour: 9 } }, dailyGoal: { cny: 30 } };
    const r = await push.runScheduled(digiSnap(), plans, { store, sender, now: NOW });
    assert.equal(r.sent, 1);
    assert.equal(bodies[0].msgtype, 'markdown');
    assert.ok(bodies[0].markdown.content.includes('<font color="info">📊 今日 AI 消耗'), '摘要标题绿色');
    assert.ok(bodies[0].markdown.content.includes('窗口用量'), '摘要正文送达');
    // sender 返回 errcode!=0 → 判失败（verify 经 alerts.send 生效）
    const senderBad = async () => ({ ok: true, status: 200, body: '{"errcode":93000,"errmsg":"invalid webhook url"}' });
    const st2 = memStore();
    const r2 = await push.runScheduled(digiSnap(), plans, { store: st2, sender: senderBad, now: NOW });
    assert.equal(r2.failed, 1, 'errcode!=0 计 failed');
    assert.ok(st2.get('digest|2026-10-07') != null, '失败也写 store');
  });

  // == 集成层（v1.5 补测）：buildSnapshot 进程内直调 / HTTP 层临时端口 / alerts 端到端 / mcp 冒烟 ==
  // 采集器读进程 HOME（真实 ~/.zcode 等，测试环境与开发机不同）：只断言形状与掩码，不断言数值
  const http = require('node:http');
  const { execFile } = require('node:child_process');
  const { buildSnapshot, requestHandler } = require('../server/index.js');
  const ROOT = path.join(__dirname, '..');

  console.log('== 集成：buildSnapshot（配置目录隔离到临时目录，已知机密打底验证脱敏） ==');
  // 已知机密先落 plans.json（TMP_DIR），脱敏断言才有确定值可比
  const ITOKEN = 'real-zhipu-token-abcdef123456';
  const IJWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.body.sig';
  const IDSKEY = 'sk-ds-real-key-123456';
  const IAKSEC = 'aliyun-real-accesskey-secret';
  const IEXKEY = 'sk-zhipu-extra-it-987654321';
  const IHOOK = 'https://api.day.app/SECRET-KEY-XYZ';
  plansStore.save({
    usdCnyRate: 7.2, plans: {}, priceOverrides: {}, dailyGoal: { cny: 200 },
    quotaKeys: { zhipu: { token: ITOKEN, organizationId: 'org-IT', projectId: 'proj-IT', extraKeys: [{ label: 'IT可用', apiKey: IEXKEY }] }, minimax: { apiKey: '' }, chatgpt: { accessToken: IJWT }, deepseek: { apiKey: IDSKEY }, bailian: { accessKeyId: 'LTAI5tItTest', accessKeySecret: IAKSEC } },
    alerts: { enabled: false, webhookType: 'generic', webhookUrl: IHOOK, thresholds: { fiveHour: 85, weekly: 85, dailyGoalPct: 100 }, cooldownMinutes: 60 },
  });

  await ta('buildSnapshot：形状齐全（builtAt / agg.daily / agg.models / collectorErrors / rowStats 五采集器）', async () => {
    const s = await buildSnapshot();
    assert.ok(Number.isFinite(s.builtAt));
    assert.ok(s.agg && typeof s.agg.daily === 'object' && typeof s.agg.models === 'object');
    assert.deepEqual(Object.keys(s.rowStats).sort(), ['ccswitch', 'claudeCode', 'codexSessions', 'workbuddy', 'zcode']);
    for (const v of Object.values(s.rowStats)) assert.ok(Number.isInteger(v) && v >= 0, `rowStats 应为非负整数，got ${v}`);
    assert.ok(typeof s.collectorErrors === 'object');
    for (const v of Object.values(s.collectorErrors)) assert.equal(typeof v, 'string');
    // VPN 流量包：临时配置无订阅地址 → notConfigured 对象（不外呼、不抛）；曾配置失败也只会是对象
    assert.ok(s.vpnQuota === null || typeof s.vpnQuota === 'object', 'vpnQuota 应为对象或 null');
    if (s.vpnQuota) assert.equal(typeof s.vpnQuota.available, 'boolean');
    // API 按量计费：vendors 恒为对象（纯计算）；apiBilling 为对象或 null（网络尽力而为）
    assert.ok(s.vendors && typeof s.vendors === 'object', 'vendors 应为纯计算恒有');
    assert.ok(s.modelUsage && typeof s.modelUsage === 'object', 'modelUsage 应为纯计算恒有（今日模型排行）');
    assert.ok(s.projectUsage && typeof s.projectUsage === 'object', 'projectUsage 应为纯计算恒有（项目统计）');
    for (const [k, v] of Object.entries(s.vendors)) {
      assert.ok(['zhipu', 'minimax', 'deepseek', 'bailian', 'moonshot', 'anthropic', 'openai'].includes(k), `未知服务商 ${k}`);
      for (const w of ['today', 'month']) {
        for (const f of ['requests', 'inputTokens', 'outputTokens', 'costCny']) {
          assert.ok(typeof v[w][f] === 'number' && Number.isFinite(v[w][f]), `vendors.${k}.${w}.${f} 应为数字`);
        }
      }
    }
    assert.ok(s.apiBilling === null || (typeof s.apiBilling === 'object' && 'zhipu' in s.apiBilling && 'deepseek' in s.apiBilling && 'bailian' in s.apiBilling
      && Array.isArray(s.apiBilling.providers) && typeof s.apiBilling.keyChecks === 'object' && Array.isArray(s.apiBilling.zhipuExtraKeys)),
      'apiBilling 应为 null 或含基线三家余额 + providers/keyChecks/zhipuExtraKeys');
    // providers 快照不得携带 apiKey（防泄漏）
    if (s.apiBilling && Array.isArray(s.apiBilling.providers)) {
      for (const p of s.apiBilling.providers) assert.ok(!('apiKey' in p) && !('probe' in p), 'provider 描述符只出公开字段');
    }
    // 智谱「其他 Key」快照形状：只出掩码与探活状态，不得携带明文 apiKey
    if (s.apiBilling && Array.isArray(s.apiBilling.zhipuExtraKeys)) {
      for (const x of s.apiBilling.zhipuExtraKeys) {
        assert.ok(!('apiKey' in x), 'zhipuExtraKeys 快照不带明文 apiKey');
        assert.ok(x.label && x.keyMasked && typeof x.checked === 'boolean' && typeof x.ok === 'boolean'
          && ('linkedProvider' in x) && Number.isFinite(x.checkedAt), 'zhipuExtraKeys 元素字段形状');
      }
    }
  });

  await ta('buildSnapshot：network 字段形状（error/current/today/month/series，macOS 采集 / 其他平台降级都不抛）', async () => {
    const s = await buildSnapshot();
    assert.ok(s.network && typeof s.network === 'object', 'network 应恒有（采集器内部降级，不外抛）');
    assert.ok(s.network.error === null || typeof s.network.error === 'string');
    assert.ok(s.network.current === null || (typeof s.network.current === 'object'
      && typeof s.network.current.key === 'string' && typeof s.network.current.label === 'string'
      && typeof s.network.current.iface === 'string' && Number.isFinite(s.network.current.rxRate)),
      'current 形状：{key,label,iface,rx,tx,rxRate,txRate} 或 null');
    if (s.network.today !== null) {
      for (const w of [s.network.today, s.network.month]) {
        assert.ok(Number.isFinite(w.rx) && Number.isFinite(w.tx) && w.rx >= 0 && w.tx >= 0, 'today/month 应为非负数');
      }
    }
    assert.ok(Array.isArray(s.network.series), 'series 应为数组');
    for (const d of s.network.series) {
      assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Array.isArray(d.networks) && d.networks.length > 0);
      for (const n of d.networks) {
        assert.ok(typeof n.key === 'string' && typeof n.label === 'string' && Number.isFinite(n.rx) && Number.isFinite(n.tx));
      }
      const sum = d.networks.reduce((x, n) => x + n.rx + n.tx, 0);
      assert.ok(Math.abs(sum - (d.total.rx + d.total.tx)) < 1e-6, 'total 应等于各网络之和（防双算/漏算）');
    }
  });

  let snap1;
  await ta('buildSnapshot：对外快照已脱敏（quotaKeys 机密掩码、org/project 原值、alerts.webhookUrl 掩码）', async () => {
    snap1 = await buildSnapshot();
    assert.equal(snap1.plans.quotaKeys.zhipu.token, 'real…3456');
    assert.equal(snap1.plans.quotaKeys.zhipu.organizationId, 'org-IT', '非机密字段原样保留');
    assert.equal(snap1.plans.quotaKeys.zhipu.projectId, 'proj-IT');
    assert.equal(snap1.plans.quotaKeys.zhipu.extraKeys[0].label, 'IT可用', 'extraKeys label 非机密原样');
    assert.equal(snap1.plans.quotaKeys.zhipu.extraKeys[0].apiKey, 'sk-z…4321', 'extraKeys apiKey 脱敏');
    assert.equal(snap1.plans.quotaKeys.chatgpt.accessToken, '••••….sig', 'JWT 掩码不保留头部特征');
    assert.equal(snap1.plans.quotaKeys.deepseek.apiKey, 'sk-d…3456', 'deepseek key 脱敏');
    assert.equal(snap1.plans.quotaKeys.bailian.accessKeyId, 'LTAI5tItTest', 'accessKeyId 非机密原样');
    assert.equal(snap1.plans.quotaKeys.bailian.accessKeySecret, 'aliy…cret', 'accessKeySecret 脱敏');
    assert.equal(snap1.plans.alerts.webhookUrl, 'https://api.day.app/••••');
    assert.equal(snap1.plans.alerts.thresholds.fiveHour, 85, '非机密 alerts 字段原样');
    const blob = JSON.stringify(snap1.plans);
    assert.ok(!blob.includes(ITOKEN) && !blob.includes('SECRET-KEY-XYZ') && !blob.includes(IJWT) && !blob.includes(IDSKEY) && !blob.includes(IAKSEC) && !blob.includes(IEXKEY), '任何明文机密不得外泄');
  });

  await ta('buildSnapshot：连续两次不抛错、daily 键稳定且有序、history 指纹命中跳过', async () => {
    const keys1 = Object.keys(snap1.agg.daily).sort();
    const snap2 = await buildSnapshot(); // 不抛错本身就是断言对象
    assert.deepEqual(Object.keys(snap2.agg.daily).sort(), keys1, '两次构建 daily 键应一致');
    assert.deepEqual(snap2.agg.dailyKeys, [...snap2.agg.dailyKeys].sort(), 'dailyKeys 应有序');
    const st = history.syncStats();
    assert.equal(st.rows, st.written + st.skipped, '行数守恒 written + skipped = rows');
    if (st.rows > 0) assert.ok(st.skipped > 0, `同内容第二轮应有指纹跳过（rows=${st.rows}, skipped=${st.skipped}）`);
  });

  await ta('buildSnapshot：modelUsage / projectUsage 数值对账（今日口径与 daily/models 一致、today ≤ total）', async () => {
    const { bjDate } = require('../server/lib/store');
    const s = await buildSnapshot();
    const today = bjDate(Date.now());
    const day = s.agg.daily[today] || {};
    // 对账一：modelUsage 今日请求数合计 == daily 今日各工具 models 子桶请求数合计
    //（两者都只统计 raw 行：归档补缺在测试环境为「同源回写」，raw 优先不引入额外行）
    let dailyModelReqs = 0;
    for (const [tool, a] of Object.entries(day)) {
      if (tool === '__total' || !a || typeof a !== 'object') continue;
      for (const mv of Object.values(a.models || {})) dailyModelReqs += mv.requests || 0;
    }
    let modelTodayReqs = 0;
    for (const m of Object.values(s.modelUsage || {})) modelTodayReqs += m.today.requests;
    assert.equal(modelTodayReqs, dailyModelReqs,
      `modelUsage 今日合计 ${modelTodayReqs} 应等于 daily 今日 models 子桶合计 ${dailyModelReqs}`);
    // 对账二：projectUsage 每桶 today ⊆ total（累计含今日，逐字段不超出）
    for (const [k, p] of Object.entries(s.projectUsage || {})) {
      assert.ok(p.today.requests <= p.total.requests, `projectUsage[${k}] today.requests ≤ total.requests`);
      assert.ok(p.today.inputTokens <= p.total.inputTokens, `projectUsage[${k}] today.inputTokens ≤ total.inputTokens`);
      assert.ok(p.today.outputTokens <= p.total.outputTokens, `projectUsage[${k}] today.outputTokens ≤ total.outputTokens`);
    }
  });

  console.log('== price-source（在线单价源：解析 / 差异 / 合并） ==');
  const priceSource = require('../server/lib/price-source');
  const PS_FILE = JSON.stringify({
    schema: 'ai-quota-prices/1', updated: '2026-10-23', source: 'test',
    models: {
      'glm-5.3': { in: 8, out: 28, cacheRead: 2 },
      'MiniMax-M3': { in: 2.1, out: 8.4, cacheRead: 0.42 },
      'brand-new-model': { in: 1, out: 2 },
      'bad-model': { in: -1, out: 'x' },  // in/out 全非法 → 整行跳过
      'half-model': { in: 3 },            // 缺 out → 跳过
    },
  });
  {
    const parsed = priceSource.parsePriceFile(PS_FILE);
    t('parsePriceFile：合法文件解析、坏行跳过、meta 截取', () => {
      assert.equal(parsed.ok, true);
      assert.deepEqual(Object.keys(parsed.models).sort(), ['MiniMax-M3', 'brand-new-model', 'glm-5.3']);
      assert.equal(parsed.meta.updated, '2026-10-23');
      assert.equal(parsed.meta.source, 'test');
    });
    t('parsePriceFile：非 JSON / 缺 models / 无合法模型 一律拒绝', () => {
      assert.equal(priceSource.parsePriceFile('not json').ok, false);
      assert.equal(priceSource.parsePriceFile('{"updated":"x"}').ok, false);
      assert.equal(priceSource.parsePriceFile('{"models":{"a":{"in":1}}}').ok, false);
    });
    t('diffPrices：字段变化逐条列出、新模型单列、一致计数', () => {
      const eff = { 'glm-5.3': { in: 8, out: 28, cacheRead: 2 }, 'MiniMax-M3': { in: 4.2, out: 16.8, cacheRead: 0.845 } };
      const d = priceSource.diffPrices(eff, parsed.models);
      assert.deepEqual(d.added, ['brand-new-model']);
      assert.equal(d.unchanged, 1, 'glm-5.3 与远端一致');
      assert.equal(d.changes.filter(c => c.model === 'MiniMax-M3').length, 3, 'in/out/cacheRead 三处变化');
      assert.deepEqual(d.changes.find(c => c.model === 'MiniMax-M3' && c.field === 'in'),
        { model: 'MiniMax-M3', field: 'in', from: 4.2, to: 2.1 });
    });
    t('mergeRemoteOverrides：同名模型整组替换（以远端为准）、未提及覆盖保留、纯函数', () => {
      const cur = { priceOverrides: { 'glm-5.3': { in: 9 }, keep: { in: 1, out: 2 } } };
      const next = priceSource.mergeRemoteOverrides(cur, { 'glm-5.3': { in: 8, out: 28 } });
      assert.deepEqual(next.priceOverrides['glm-5.3'], { in: 8, out: 28 }, '旧 in:9 被远端整组替换');
      assert.deepEqual(next.priceOverrides.keep, { in: 1, out: 2 });
      assert.deepEqual(cur.priceOverrides['glm-5.3'], { in: 9 }, '不改入参');
    });
    t('parsePriceFile：names 含坏行键名、skipped 列出被跳过行（下线判定防误报依据）', () => {
      assert.deepEqual(parsed.names.sort(), ['MiniMax-M3', 'bad-model', 'brand-new-model', 'glm-5.3', 'half-model']);
      assert.deepEqual(parsed.skipped, ['bad-model', 'half-model']);
    });
    t('diffPrices：prevSeen/remoteNames 支撑下线判定（坏行键名还在 → 不算下线）', () => {
      const eff = { 'glm-5.3': { in: 8, out: 28, cacheRead: 2 } };
      const d = priceSource.diffPrices(eff, parsed.models, ['glm-5.3', 'dead-model', 'bad-model'], parsed.names);
      assert.deepEqual(d.removed, ['dead-model']);
      const d2 = priceSource.diffPrices(eff, parsed.models, ['glm-5.3', 'dead-model'], null);
      assert.deepEqual(d2.removed, ['dead-model'], 'remoteNames 缺省回退 Object.keys(remote)');
    });
    await ta('fetchPrices：协议白名单拒绝 file:（不触达本机文件）', async () => {
      const r = await priceSource.fetchPrices('file:///etc/passwd');
      assert.equal(r.ok, false);
      assert.ok(r.error.includes('协议'), r.error);
    });
  }

  console.log('== price-auto（每周自动查价 + 调价/上线/下线通知） ==');
  const priceAuto = require('../server/lib/price-auto');
  {
    const AUTO_NOW = 1_735_689_600_000; // 固定 now，隔离真实时钟
    // 有效表 = DEFAULT_PRICING + 空覆盖（glm-5.3 为 8/28/2；qwen 系在表但来源从未收录）
    const remoteJson = JSON.stringify({
      schema: 'ai-quota-prices/1', updated: '2026-11-01', source: 'test',
      models: {
        'glm-5.3': { in: 8, out: 30, cacheRead: 2 },            // 输出调价 28 → 30
        'MiniMax-M3': { in: 2.1, out: 8.4, cacheRead: 0.42 },   // 一致
        'brand-new-model': { in: 1, out: 2 },                   // 上线
        'bad-model': { in: -1, out: 'x' },                      // 坏行：跳过，但键名仍在（不误报下线）
      },
    });
    const basePlans = () => ({
      usdCnyRate: 7.2,
      priceOverrides: {},
      alerts: { enabled: true, webhookType: 'generic', webhookUrl: 'https://hook.test/abc' },
      priceSource: {
        url: 'https://src.test/prices.json', auto: true, lastCheck: null, lastResult: '',
        modelsSeen: ['glm-5.3', 'MiniMax-M3', 'dead-model', 'bad-model'],
      },
    });
    const harness = (plans, over = {}) => {
      const saved = [];
      const calls = { ensureFresh: 0, notice: null };
      const deps = Object.assign({
        loadPlans: () => plans,
        savePlans: next => saved.push(next),
        ensureFresh: async force => { if (force) calls.ensureFresh++; },
        now: AUTO_NOW,
        fetchPrices: async () => ({ ok: true, text: remoteJson }),
        sender: async (url, opts) => { calls.notice = opts; return { ok: true }; },
        store: memStore(),
        log: { error: () => {} },
        notify: { added: [], add: function (ev) { this.added.push(ev); return ev; } }, // 站内通知 fake
        distinctModels: () => [], // 周检联动补充：测试环境无缺失模型（不真拉 3MB 目录）
      }, over);
      return { deps, saved, calls, inApp: deps.notify };
    };

    t('buildNoticeBody：三类分区 + 15 条截断 + meta 尾注', () => {
      const changes = Array.from({ length: 18 }, (_, i) => ({ model: 'm' + i, field: 'out', from: 1, to: 2 }));
      const b = priceAuto.buildNoticeBody({ changes, added: ['a1', 'a2'], removed: ['r1'] }, { updated: '2026-11-01', skipped: ['bad-row'] });
      assert.ok(b.title.includes('18 处价格变化') && b.title.includes('上线 2') && b.title.includes('下线 1'), b.title);
      assert.equal(b.message.split('\n').filter(l => l.startsWith('· m')).length, 15, '价格变化截 15 条');
      assert.ok(b.message.includes('…等共 18 处变化'));
      assert.ok(b.message.includes('上线模型：a1、a2'));
      assert.ok(b.message.includes('下线模型：r1'));
      assert.ok(b.message.includes('无效行跳过：bad-row'));
      assert.ok(b.message.includes('价格源更新于 2026-11-01'));
    });

    ta('runPriceAuto：无 URL / 关闭开关 / 未到 7 天 → 三种跳过', async () => {
      const noUrl = basePlans(); noUrl.priceSource.url = '';
      assert.deepEqual(await priceAuto.runPriceAuto(harness(noUrl).deps), { skipped: true, reason: 'no-url' });
      const off = basePlans(); off.priceSource.auto = false;
      assert.deepEqual(await priceAuto.runPriceAuto(harness(off).deps), { skipped: true, reason: 'disabled' });
      const fresh = basePlans();
      fresh.priceSource.lastCheck = new Date(AUTO_NOW - 3 * 24 * 3600e3).toISOString();
      assert.deepEqual(await priceAuto.runPriceAuto(harness(fresh).deps), { skipped: true, reason: 'interval' });
    });

    ta('runPriceAuto：拉取/校验失败 → lastResult 记 failed、lastCheck 不动（下轮重试）', async () => {
      const p = basePlans();
      const h = harness(p, { fetchPrices: async () => ({ ok: false, error: 'HTTP 500' }) });
      const r = await priceAuto.runPriceAuto(h.deps);
      assert.equal(r.ok, false);
      assert.equal(r.error, 'HTTP 500');
      assert.ok(h.saved[0].priceSource.lastResult.startsWith('failed: '), JSON.stringify(h.saved[0].priceSource));
      assert.equal(h.saved[0].priceSource.lastCheck, null, 'lastCheck 不推进');
      assert.equal(h.calls.ensureFresh, 0);
      assert.equal(h.inApp.added.length, 1, '检查失败入站内通知');
      assert.equal(h.inApp.added[0].type, 'price-error');
      assert.ok(h.inApp.added[0].body.includes('HTTP 500'));
    });

    ta('runPriceAuto：调价 + 上线 + 下线 → 应用/重算/通知，从未收录模型不误报下线', async () => {
      const p = basePlans();
      const h = harness(p);
      const r = await priceAuto.runPriceAuto(h.deps);
      assert.equal(r.ok, true);
      assert.equal(r.applied, true);
      assert.equal(r.notified, 'sent');
      assert.equal(h.calls.ensureFresh, 1, '应用后 force 重算');
      const last = h.saved[h.saved.length - 1];
      assert.deepEqual(last.priceOverrides['glm-5.3'], { in: 8, out: 30, cacheRead: 2 }, '调价写入覆盖表');
      assert.deepEqual(last.priceOverrides['brand-new-model'], { in: 1, out: 2 });
      assert.deepEqual(last.priceSource.modelsSeen, ['glm-5.3', 'MiniMax-M3', 'brand-new-model', 'bad-model'], 'modelsSeen 刷新为来源键名');
      assert.ok(r.diff.removed.includes('dead-model'), 'dead-model 下线');
      assert.ok(!r.diff.removed.includes('qwen3.7-max'), '从未收录的本地模型不误报');
      const body = String((h.calls.notice || {}).body || '');
      assert.ok(body.includes('1 处价格变化') && body.includes('上线 1') && body.includes('下线 1'), body.slice(0, 200));
      assert.ok(body.includes('glm-5.3 输出 28 → 30'), body.slice(0, 200));
      assert.ok(body.includes('上线模型：brand-new-model'), body.slice(0, 200));
      assert.ok(body.includes('下线模型：dead-model'), body.slice(0, 200));
      assert.ok(body.includes('无效行跳过：bad-model'), body.slice(0, 200));
      assert.ok(body.includes('价格源更新于 2026-11-01'), body.slice(0, 200));
      assert.equal(h.inApp.added.length, 1, '应用后入站内通知（与 webhook 无关）');
      assert.equal(h.inApp.added[0].type, 'price-update');
      assert.ok(h.inApp.added[0].title.includes('1 处价格变化'), h.inApp.added[0].title);
      assert.deepEqual(h.inApp.added[0].meta, { changes: 1, added: 1, removed: 1, updated: '2026-11-01' });
    });

    ta('runPriceAuto：无差异 → 只更新检查记录，不应用不通知', async () => {
      const same = JSON.stringify({
        schema: 'ai-quota-prices/1', updated: '2026-11-01', source: 'test',
        models: {
          'glm-5.3': { in: 8, out: 28, cacheRead: 2 },
          'MiniMax-M3': { in: 2.1, out: 8.4, cacheRead: 0.42 },
          'brand-new-model': { in: 1, out: 2 }, // 上一轮已见过 → 不算上线
        },
      });
      const p = basePlans();
      // 上一轮已把 brand-new-model 应用进覆盖表 → 本轮它进生效表，与远端一致不再算「上线」
      p.priceOverrides = { 'brand-new-model': { in: 1, out: 2 } };
      p.priceSource.modelsSeen = ['glm-5.3', 'MiniMax-M3', 'brand-new-model'];
      const h = harness(p, { fetchPrices: async () => ({ ok: true, text: same }) });
      const r = await priceAuto.runPriceAuto(h.deps);
      assert.equal(r.ok, true);
      assert.equal(r.applied, false);
      assert.equal(r.notified, 'skipped');
      assert.equal(h.calls.ensureFresh, 0);
      assert.equal(h.inApp.added.length, 0, '无差异不进站内通知');
      assert.deepEqual(h.saved[0].priceOverrides, { 'brand-new-model': { in: 1, out: 2 } }, '覆盖表保持原样（无新合并）');
      assert.ok(h.saved[0].priceSource.lastCheck, 'lastCheck 推进');
      assert.equal(h.saved[0].priceSource.lastResult, 'ok');
    });

    ta('runPriceAuto：webhook 发送失败 → notified=failed、应用不回滚、失败落冷却库', async () => {
      const p = basePlans();
      const store = memStore();
      const h = harness(p, { sender: async () => { throw new Error('boom'); }, store });
      const r = await priceAuto.runPriceAuto(h.deps);
      assert.equal(r.applied, true);
      assert.equal(r.notified, 'failed');
      assert.equal(h.calls.ensureFresh, 1);
      const entries = [...store.dump().values()];
      assert.ok(entries.some(e => String(e.st).startsWith('failed: ')), JSON.stringify(entries));
      assert.equal(h.inApp.added.length, 1, 'webhook 失败不影响站内通知（应用已发生）');
    });
  }

  console.log('== notify（站内通知存储：追加 / 上限 / 已读 / 清空） ==');
  {
    const notify = require('../server/lib/notify');
    const N = (t, extra = {}) => notify.add(Object.assign({ type: 'test', title: t, body: 'b' }, extra));
    t('notify：add/list/markRead 基本流转', () => {
      notify.clear();
      const a = N('第一条');
      assert.ok(a && a.id && a.ts && a.read === false);
      assert.equal(notify.list().unread, 1);
      notify.markRead(a.id);
      assert.equal(notify.list().unread, 0);
      assert.equal(notify.list().items[0].read, true);
    });
    t('notify：FIFO 上限 50 条、新的在前、空标题拒绝', () => {
      notify.clear();
      for (let i = 0; i < 55; i++) N('m' + i);
      const l = notify.list();
      assert.equal(l.items.length, notify.CAP);
      assert.equal(l.items[0].title, 'm54', '新的在前');
      assert.equal(l.items[49].title, 'm5', '最旧的被淘汰');
      assert.equal(notify.add({ type: 'test', title: '   ' }), null);
    });
    t('notify：markRead(null) 全部已读 + clear 清空', () => {
      notify.clear();
      N('a'); N('b'); N('c');
      assert.equal(notify.list().unread, 3);
      assert.equal(notify.markRead(null), 3);
      assert.equal(notify.list().unread, 0);
      assert.equal(notify.clear(), true);
      assert.deepEqual(notify.list().items, []);
    });
  }

  console.log('== subscriptions（套餐实体：白名单清洗） ==');
  {
    const plansMod = require('../server/lib/plans');
    t('applyPlansUpdate：subscriptions 逐项清洗（名称必填/价格钳 null/匹配小写去重/tools 白名单）', () => {
      const next = plansMod.applyPlansUpdate({ subscriptions: [{ name: 'Old', payCnyPerMonth: 1 }] }, { subscriptions: [
        { name: 'MiniMax', payCnyPerMonth: 119, usdPerMonth: '', modelMatch: ['MiniMAX', ' m3 '], tools: ['zcode', 'bogus'] },
        { name: '   ' },                                                       // 无名 → 丢弃
        { name: 'Bad', payCnyPerMonth: -5, modelMatch: 'x', tools: 'codex' },  // 非法类型 → 钳 null/[]
        'junk',                                                                // 非对象 → 丢弃
      ] });
      assert.deepEqual(next.subscriptions, [
        { name: 'MiniMax', payCnyPerMonth: 119, usdPerMonth: null, modelMatch: ['minimax', 'm3'], tools: ['zcode'] },
        { name: 'Bad', payCnyPerMonth: null, usdPerMonth: null, modelMatch: [], tools: [] },
      ]);
      assert.equal(next.subscriptions.length, 2, '无名/非对象项丢弃');
    });
    t('applyPlansUpdate：subscriptions 非数组整体忽略保留原值', () => {
      const cur = { subscriptions: [{ name: 'Keep', payCnyPerMonth: 9, usdPerMonth: null, modelMatch: ['k'], tools: [] }] };
      const next = plansMod.applyPlansUpdate(cur, { subscriptions: 'x' });
      assert.deepEqual(next.subscriptions, cur.subscriptions);
    });
  }

  console.log('== codex-sessions（~/.codex/sessions 采集：增量/token/模型跟随/下界过滤） ==');
  {
    const codexSessions = require('../server/collectors/codex-sessions');
    const sessDir = path.join(TMP_DIR, 'codex-sessions', '2026', '11', '01');
    fs.mkdirSync(sessDir, { recursive: true });
    const AFTER = Date.parse('2026-11-01T10:00:00Z');
    // 文件 1：turn_context 前的 token_count（model=unknown）、坏 JSON 行、下界外行、跨轮模型跟随、cwd 项目
    fs.writeFileSync(path.join(sessDir, 'rollout-2026-11-01T09-00-00-aaaa.jsonl'), [
      JSON.stringify({ timestamp: '2026-11-01T09:00:01Z', type: 'session_meta', payload: { id: 's1' } }),
      JSON.stringify({ timestamp: '2026-11-01T10:30:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110 } } } }),
      '{ broken json',
      JSON.stringify({ timestamp: '2026-11-01T09:30:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 } } } }),
      JSON.stringify({ timestamp: '2026-11-01T11:00:00Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol', cwd: '/Users/x/Github/Today' } }),
      JSON.stringify({ timestamp: '2026-11-01T11:05:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 200, cached_input_tokens: 150, cache_write_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 12, total_tokens: 230 } } } }),
      JSON.stringify({ timestamp: '2026-11-01T12:00:00Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol', cwd: '/Users/x/Github/Today' } }),
      JSON.stringify({ timestamp: '2026-11-01T12:01:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 6, reasoning_output_tokens: 0, total_tokens: 11 } } } }),
    ].join('\n'));
    // 文件 2：文件名起始日早于下界 1 天以上 → 整文件跳过
    fs.writeFileSync(path.join(sessDir, 'rollout-2026-10-01T00-00-00-bbbb.jsonl'), ' garbage\n');
    t('codex-sessions：增量行、模型跟随 turn_context、下界/坏行过滤、文件名预筛', () => {
      const r = codexSessions.collect(sessDir, AFTER);
      assert.equal(r.error, null);
      assert.equal(r.filesScanned, 1, '10 月文件被文件名预筛跳过');
      assert.equal(r.rows.length, 3, '下界前 1 行 + 下界后 2 行（坏 JSON 行不计）');
      assert.equal(r.parseErrors, 1);
      const byTs = r.rows.sort((a, b) => a.ts - b.ts);
      assert.equal(byTs[0].model, 'unknown', 'turn_context 前无模型 → unknown');
      assert.equal(byTs[1].model, 'gpt-6.1-sol');
      assert.equal(byTs[1].inputTokens, 200);
      assert.equal(byTs[1].outputTokens, 42, '输出 = 普通输出 + 思考（合并列口径）');
      assert.equal(byTs[1].reasoningTokens, 12);
      assert.equal(byTs[1].cacheReadTokens, 150);
      assert.equal(byTs[1].cacheCreationTokens, 20);
      assert.equal(byTs[1].costUsd, null, '会话文件无成本字段');
      assert.equal(byTs[1].project, '/Users/x/Github/Today');
      assert.equal(byTs[1].projectLabel, 'Today');
      assert.equal(byTs[2].model, 'gpt-5.6-sol', '模型跟随新一轮 turn_context');
      assert.equal(r.rows.every(x => x.tool === 'codex'), true);
    });
    t('codex-sessions：未变文件复用解析缓存（行集一致）', () => {
      const r1 = codexSessions.collect(sessDir, AFTER);
      const r2 = codexSessions.collect(sessDir, AFTER);
      assert.deepEqual(r2.rows, r1.rows);
      assert.equal(r2.error, null);
    });
  }

  console.log('== price-catalog + supplement（缺失单价自动补充） ==');
  {
    const priceCatalog = require('../server/lib/price-catalog');
    const priceAutoMod = require('../server/lib/price-auto');
    t('parseCatalog：per-token→$/百万、提供商优先、前缀剥离、缺价/负值条目跳过', () => {
      const cat = priceCatalog.parseCatalog(JSON.stringify({
        'gpt-6.1-sol': { input_cost_per_token: 2e-06, output_cost_per_token: 1e-05, cache_read_input_token_cost: 1e-07, cache_creation_input_token_cost: 2.5e-06, litellm_provider: 'openai' },
        'azure/gpt-6.1-sol': { input_cost_per_token: 9e-06, output_cost_per_token: 9e-05, litellm_provider: 'azure' },          // 同名，官方条目应优先
        'azure/gpt-9x': { input_cost_per_token: 3e-06, output_cost_per_token: 3e-05, litellm_provider: 'azure' },               // 仅前缀条目 → 裸名可命中
        'openai.gpt-7x': { input_cost_per_token: 1e-06, output_cost_per_token: 2e-05, litellm_provider: 'bedrock_converse' },   // 品牌点前缀剥离
        'chatgpt/gpt-nope': { input_cost_per_token: null, output_cost_per_token: null, litellm_provider: 'chatgpt' },           // 缺价 → 跳过
        'bad-entry': { input_cost_per_token: -1, output_cost_per_token: 1, litellm_provider: 'x' },                             // 负值 → 跳过
      }));
      assert.equal(cat.ok, true);
      assert.equal(cat.priced, 4, '缺价/负值条目不计入 priced');
      const g = cat.byName.get('gpt-6.1-sol');
      assert.equal(g.in, 2, '2e-06/token → $2/百万');
      assert.equal(g.out, 10);
      assert.equal(g.cacheRead, 0.1);
      assert.equal(g.cacheWrite, 2.5);
      assert.equal(g.provider, 'openai', '官方条目优先于 azure 前缀');
      assert.equal(cat.byName.get('gpt-9x').in, 3, '提供商前缀剥离');
      assert.equal(cat.byName.get('gpt-7x').in, 1, '品牌点前缀剥离');
      assert.equal(cat.byName.has('gpt-nope'), false, '缺价条目不入索引');
    });
    t('matchCatalog：精确大小写不敏感、未命中进 missed', () => {
      const byName = new Map([['gpt-6.1-sol', { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5, provider: 'openai' }]]);
      const { matched, missed } = priceCatalog.matchCatalog(byName, ['GPT-6.1-SOL', 'mystery-model']);
      assert.equal(matched['GPT-6.1-SOL'].in, 2);
      assert.deepEqual(missed, ['mystery-model']);
    });

    ta('runPriceSupplement：缺失模型补价（fx 折算入覆盖表）+ meta + 站内通知 + 重算', async () => {
      const catalogText = JSON.stringify({
        'gpt-6.1-sol': { input_cost_per_token: 2e-06, output_cost_per_token: 1e-05, cache_read_input_token_cost: 1e-07, litellm_provider: 'openai' },
        'glm-5.3': { input_cost_per_token: 1, output_cost_per_token: 2, litellm_provider: 'zhipu' }, // 已有价 → 不该被补
      });
      const plans0 = { usdCnyRate: 7.2, priceOverrides: {}, alerts: { enabled: false } };
      const saved = [];
      let recalc = 0;
      const inApp = { added: [], add(ev) { this.added.push(ev); return ev; } };
      const r = await priceAutoMod.runPriceSupplement({
        loadPlans: () => plans0,
        savePlans: n => saved.push(n),
        ensureFresh: async f => { if (f) recalc++; },
        fetchCatalog: async () => ({ ok: true, text: catalogText }),
        distinctModels: () => ['gpt-6.1-sol', 'gpt-6-sol'], // gpt-6-sol 目录没有 → missed
        notify: inApp,
        log: { error: () => {} },
      });
      assert.equal(r.ok, true);
      assert.deepEqual(r.matched, ['gpt-6.1-sol']);
      assert.deepEqual(r.missed, ['gpt-6-sol']);
      const last = saved[saved.length - 1];
      assert.deepEqual(last.priceOverrides['gpt-6.1-sol'], { in: 14.4, out: 72, cacheRead: 0.72 }, 'usd×7.2 折算为元/百万');
      assert.equal(last.priceOverrides['glm-5.3'], undefined, '已有价的模型不重复补');
      assert.deepEqual(last.priceAuto.matched, ['gpt-6.1-sol']);
      assert.deepEqual(last.priceAuto.missed, ['gpt-6-sol']);
      assert.equal(recalc, 1, '补价后强制重算历史');
      assert.equal(inApp.added.length, 1);
      assert.ok(inApp.added[0].title.includes('自动补充 1 个缺失模型单价'), inApp.added[0].title);
      assert.ok(inApp.added[0].body.includes('gpt-6.1-sol：输入 ¥14.4 / 输出 ¥72'), inApp.added[0].body);
    });
    ta('runPriceSupplement：目录拉取失败 → ok:false 且不动覆盖表', async () => {
      const saved = [];
      const r = await priceAutoMod.runPriceSupplement({
        loadPlans: () => ({ usdCnyRate: 7.2, priceOverrides: {} }),
        savePlans: n => saved.push(n),
        fetchCatalog: async () => ({ ok: false, error: 'HTTP 503' }),
        distinctModels: () => ['gpt-6.1-sol'],
        log: { error: () => {} },
      });
      assert.equal(r.ok, false);
      assert.equal(r.error, 'HTTP 503');
      assert.equal(saved.length, 0, '失败不落盘');
    });
    ta('runPriceSupplement：无缺失模型 → skipped 且不拉目录', async () => {
      let fetched = 0;
      const r = await priceAutoMod.runPriceSupplement({
        loadPlans: () => ({ usdCnyRate: 7.2, priceOverrides: {} }),
        savePlans: () => {},
        fetchCatalog: async () => { fetched++; return { ok: false, error: 'should-not-fetch' }; },
        distinctModels: () => ['glm-5.3'], // 单价表已有
        log: { error: () => {} },
      });
      assert.equal(r.skipped, 'no-missing');
      assert.equal(fetched, 0, '无缺失不浪费 3MB 拉取');
    });
  }

  console.log('== VPN 流量包：采集器端到端（本地 sink 订阅头 + 状态差分 + 脱敏合并） ==');
  const httpMod = require('node:http');
  await ta('collect：读头 / 差分 / 缺计量头降级不泄 token / 未配置 notConfigured', async () => {
    const plansMod = require('../server/lib/plans');
    const loadQuotaKeys = () => Object.assign({}, plansMod.load().quotaKeys);
    let counter = { upload: 1000, download: 2000 };
    let sendHeader = true;
    const sink = httpMod.createServer((req, res) => {
      const extra = sendHeader
        ? { 'subscription-userinfo': `upload=${counter.upload}; download=${counter.download}; total=100000; expire=1814201408` }
        : {};
      res.writeHead(200, Object.assign({ 'content-type': 'text/plain' }, extra));
      if (!sendHeader) res.write('{"ret":0,"msg":"订阅令牌无效或已过期"}');
      res.end();
    });
    await new Promise(r => sink.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${sink.address().port}/sub/TESTTOKEN123456`;
    const setUrl = (u) => { const qk = loadQuotaKeys(); qk.vpnPanel = { url: u }; plansMod.save(Object.assign({}, plansMod.load(), { quotaKeys: qk })); };
    try {
      setUrl('');
      const r0 = await vpnQuota.collect(Date.now());
      assert.equal(r0.available, false); assert.equal(r0.notConfigured, true, '未配置 = 引导态而非失败');

      setUrl(url);
      const t1 = 1793900000000; // 用未来时基绕开模块 60s 缓存（now 由参数注入）
      const r1 = await vpnQuota.collect(t1);
      assert.equal(r1.available, true);
      assert.equal(r1.usedBytes, 3000); assert.equal(r1.totalBytes, 100000);
      assert.equal(r1.remainingBytes, 97000); assert.equal(r1.usedPercent, 3);
      assert.equal(r1.expireAt, 1814201408000);
      assert.equal(r1.deltaBytes, 0, '首采只建基线');
      assert.equal(r1.provider, '127.0.0.1');

      counter = { upload: 1500, download: 2600 };
      const r2 = await vpnQuota.collect(t1 + 70_000);
      assert.equal(r2.usedBytes, 4100);
      assert.equal(r2.deltaBytes, 1100, '第二轮差值 = 累计增量');
      assert.equal(JSON.parse(fs.readFileSync(vpnQuota.STATE_FILE(), 'utf8')).used, 4100, '基线落盘');

      sendHeader = false; // 令牌失效形态：200 + JSON 体、无计量头（HEAD 缺头还会退回 GET 再确认）
      const r3 = await vpnQuota.collect(t1 + 140_000);
      assert.equal(r3.available, false);
      assert.ok(/流量计量|令牌/.test(r3.reason), 'reason 应提示计量/令牌问题：' + r3.reason);
      assert.ok(!r3.reason.includes('TESTTOKEN123456'), '错误文案不得携带订阅 token');
    } finally {
      sink.close();
      setUrl(''); // 还原未配置：后续集成段不打外网
    }
  });

  await ta('collect：网络瞬断自动重试一次即恢复（首连 destroy、重连正常 → available）', async () => {
    const plansMod = require('../server/lib/plans');
    let hits = 0;
    const sink = httpMod.createServer((req, res) => {
      if (++hits === 1) { res.socket.destroy(); return; } // 模拟 TLS-reset 级连接瞬断
      res.writeHead(200, { 'subscription-userinfo': 'upload=50; download=50; total=10000; expire=0' });
      res.end();
    });
    await new Promise(r => sink.listen(0, '127.0.0.1', r));
    const qk = Object.assign({}, plansMod.load().quotaKeys);
    qk.vpnPanel = { url: `http://127.0.0.1:${sink.address().port}/sub/RETRYTEST123` };
    plansMod.save(Object.assign({}, plansMod.load(), { quotaKeys: qk }));
    try {
      const r = await vpnQuota.collect(1793900600000); // 未来时基绕开模块缓存
      assert.equal(r.available, true, '一次瞬断应被重试抹平：' + r.reason);
      assert.equal(r.usedBytes, 100);
      assert.ok(hits >= 2, '应发生过一次重试');
    } finally {
      sink.close();
      const qk2 = Object.assign({}, plansMod.load().quotaKeys); qk2.vpnPanel = { url: '' };
      plansMod.save(Object.assign({}, plansMod.load(), { quotaKeys: qk2 }));
    }
  });

  await ta('vpnPanel.url 按机密脱敏：掩码回显未改动保留原值、明文不外泄、清空生效', async () => {
    const plansMod = require('../server/lib/plans');
    const SECRET = 'https://is.domainforsub.work/sub/abcdef1234567890';
    const loadQk = () => Object.assign({}, plansMod.load().quotaKeys);
    const qk = loadQk(); qk.vpnPanel = { url: SECRET };
    plansMod.save(Object.assign({}, plansMod.load(), { quotaKeys: qk }));
    try {
      const masked = plansMod.maskQuotaKeys(plansMod.load());
      assert.ok(!JSON.stringify(masked).includes('abcdef1234567890'), '掩码形态不含明文 token');
      // 合并基座 = 原始明文配置（与 applyPlansUpdate 真实链路一致），表单值 = 掩码回显
      const keep = plansMod.applyQuotaKeysUpdate(plansMod.load(), { vpnPanel: { url: masked.quotaKeys.vpnPanel.url } });
      assert.equal(keep.vpnPanel.url, SECRET, '掩码回显未改动 → 还原原值');
      const clr = plansMod.applyQuotaKeysUpdate(plansMod.load(), { vpnPanel: { url: '' } });
      assert.equal(clr.vpnPanel.url, '', '空串 = 清除');
    } finally {
      const qk2 = loadQk(); qk2.vpnPanel = { url: '' };
      plansMod.save(Object.assign({}, plansMod.load(), { quotaKeys: qk2 }));
    }
  });

  console.log('== 集成：HTTP 层（临时端口挂 requestHandler，端口 0 随机） ==');
  const httpJson = (port, reqPath, { method = 'GET', headers = {}, body = null, host } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method, path: reqPath,
        headers: Object.assign(
          host ? { Host: host } : {},
          body != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
          headers),
      }, res => {
        let buf = '';
        res.on('data', c => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', reject);
      if (body != null) req.write(body);
      req.end();
    });

  // 吸收 webhook 的本地 sink：POST /api/plans 开启预警后 ensureFresh 会真的评估推送，
  // webhookUrl 指向本机回环，绝不外呼；送达与否不在此断言（端到端断言在下一段专用 sink）
  const sink = http.createServer((rq, rs) => { rq.resume(); rs.writeHead(200); rs.end('ok'); });
  await new Promise(r => sink.listen(0, '127.0.0.1', r));
  const SINK_URL = `http://127.0.0.1:${sink.address().port}/hook/SECRET`;

  const hs = http.createServer(requestHandler);
  await new Promise(r => hs.listen(0, '127.0.0.1', r));
  const P = hs.address().port;

  await ta('GET /api/report：week/month 各一，title/data.type 对应、周跨度整 7 天、月起始为 1 号', async () => {
    const w = await httpJson(P, '/api/report?type=week');
    assert.equal(w.status, 200);
    const wj = JSON.parse(w.body);
    assert.equal(wj.ok, true);
    assert.equal(wj.data.type, 'week');
    assert.ok(wj.title.includes('周报'), `title=${wj.title}`);
    assert.ok(typeof wj.markdown === 'string' && wj.markdown.includes('## 总览'));
    assert.equal(Date.parse(wj.data.end) - Date.parse(wj.data.start), 6 * 86400e3, '周期应为一整周');
    const m = await httpJson(P, '/api/report?type=month');
    const mj = JSON.parse(m.body);
    assert.equal(mj.data.type, 'month');
    assert.ok(mj.title.includes('月报'));
    assert.ok(mj.data.start.endsWith('-01'), '月报起始为当月 1 号');
    assert.equal(mj.data.end.slice(0, 7), mj.data.start.slice(0, 7), '起止同月');
  });

  await ta('GET /api/report：非法 type 回退 week；offset 负数/越界/非数字一律钳 0', async () => {
    const bad = JSON.parse((await httpJson(P, '/api/report?type=bogus')).body);
    assert.equal(bad.data.type, 'week', '非法 type 应回退 week');
    for (const q of ['offset=-5', 'offset=99999', 'offset=abc']) {
      const j = JSON.parse((await httpJson(P, '/api/report?type=month&' + q)).body);
      assert.equal(j.data.offset, 0, `${q} 应钳 0`);
    }
    assert.equal(JSON.parse((await httpJson(P, '/api/report?offset=2')).body).data.offset, 2, '区间内 offset 原样生效');
  });

  await ta('GET /api/plans：alerts 块存在且 webhookUrl 只出掩码形态', async () => {
    const r = await httpJson(P, '/api/plans');
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.ok(j.alerts && typeof j.alerts === 'object', 'GET /api/plans 必须含 alerts 块');
    assert.equal(j.alerts.webhookUrl, 'https://api.day.app/••••', 'webhookUrl 只出掩码');
    assert.equal(j.alerts.enabled, false);
    assert.ok(!r.body.includes('SECRET-KEY-XYZ'), '明文 webhook 不得出现');
    assert.ok(j.pricingDefaults, '应附带内置默认单价表');
  });

  await ta('POST /api/plans 写 alerts → GET 回读掩码 → 掩码回显 POST 底层文件保留原 url', async () => {
    const post = o => httpJson(P, '/api/plans', { method: 'POST', body: JSON.stringify(o) });
    let r = await post({
      alerts: { enabled: true, webhookType: 'generic', webhookUrl: SINK_URL, thresholds: { fiveHour: 70, weekly: 80, dailyGoalPct: 90 }, cooldownMinutes: 30 },
    });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).ok, true);

    r = await httpJson(P, '/api/plans');
    const j = JSON.parse(r.body);
    assert.equal(j.alerts.enabled, true);
    assert.equal(j.alerts.webhookType, 'generic');
    assert.equal(j.alerts.webhookUrl, `http://127.0.0.1:${sink.address().port}/••••`, 'GET 回读只出掩码');
    assert.deepEqual(j.alerts.thresholds, { fiveHour: 70, weekly: 80, dailyGoalPct: 90 });
    assert.equal(j.alerts.cooldownMinutes, 30);

    // 前端把掩码原样回显提交 = 「未改动」：底层 plans.json 必须保留真实 webhook
    r = await post({ alerts: { webhookUrl: j.alerts.webhookUrl } });
    assert.equal(JSON.parse(r.body).ok, true);
    const onDisk = JSON.parse(fs.readFileSync(plansStore.PLANS_FILE, 'utf8'));
    assert.equal(onDisk.alerts.webhookUrl, SINK_URL, '掩码回显不得覆盖真实 webhook');
  });

  await ta('POST /api/prices/update：预览不落盘 → 应用写覆盖并记录 priceSource → 坏源/空 URL 报错', async () => {
    // 本地价格源：回环 HTTP 服务直接吐 JSON，绝不外呼
    const FIXTURE = JSON.stringify({
      schema: 'ai-quota-prices/1', updated: '2099-01-01', source: 'fixture',
      models: { 'glm-5.3': { in: 12, out: 30 }, 'fixture-new-model': { in: 1, out: 2 } },
    });
    const src = http.createServer((rq, rs) => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(FIXTURE); });
    await new Promise(r => src.listen(0, '127.0.0.1', r));
    const SRC = `http://127.0.0.1:${src.address().port}/prices.json`;
    const upd = (url, apply) => httpJson(P, '/api/prices/update', { method: 'POST', body: JSON.stringify({ url, apply }) });

    // 空串 URL 且配置里也没存过 → 400（须在应用前测，应用后配置里会记住 URL）
    assert.equal((await upd('', false)).status, 400, '无 URL 应 400');
    // file: 协议 → 502（fetchPrices 协议白名单）
    const fr = await upd('file:///etc/passwd', false);
    assert.equal(fr.status, 502);
    assert.ok(JSON.parse(fr.body).error.includes('协议'), JSON.parse(fr.body).error);

    // 预览：返回差异但不落盘
    let r = await upd(SRC, false);
    assert.equal(r.status, 200);
    let j = JSON.parse(r.body);
    assert.equal(j.applied, false);
    assert.ok(j.diff.added.includes('fixture-new-model'), '新模型应出现在 added');
    assert.ok(j.diff.changes.some(c => c.model === 'glm-5.3' && c.field === 'in' && c.from === 8 && c.to === 12));
    assert.equal(JSON.parse((await httpJson(P, '/api/plans')).body).priceOverrides['glm-5.3'], undefined, '预览不得写 priceOverrides');

    // 应用：写入覆盖 + priceSource 检查记录 + 立即重算
    r = await upd(SRC, true);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).applied, true);
    const after = JSON.parse((await httpJson(P, '/api/plans')).body);
    assert.deepEqual(after.priceOverrides['glm-5.3'], { in: 12, out: 30 });
    assert.deepEqual(after.priceOverrides['fixture-new-model'], { in: 1, out: 2 });
    assert.equal(after.priceSource.url, SRC);
    assert.equal(after.priceSource.updated, '2099-01-01');
    assert.equal(after.priceSource.lastResult, 'ok');
    assert.ok(after.priceSource.lastCheck, '记录最近检查时间');
    assert.equal(after.priceSource.models, 2);

    // 坏 JSON 源 → 422；空 URL 此时回退已存配置（不再 400）
    const bad = http.createServer((rq, rs) => { rs.writeHead(200); rs.end('not-json'); });
    await new Promise(r2 => bad.listen(0, '127.0.0.1', r2));
    assert.equal((await upd(`http://127.0.0.1:${bad.address().port}/x`, false)).status, 422);
    assert.equal((await upd('', false)).status, 200, '空 URL 应回退已存 priceSource.url');
    src.close(); bad.close();
  });

  await ta('Host 白名单（HTTP 层实测）：Host: evil.com / localhost.evil.com 一律 403', async () => {
    assert.equal((await httpJson(P, '/api/plans', { host: 'evil.com' })).status, 403);
    assert.equal((await httpJson(P, '/api/report', { host: 'localhost.evil.com' })).status, 403);
    assert.equal((await httpJson(P, '/api/plans', { host: `localhost:${P}` })).status, 200, '本机 Host 正常放行');
  });

  await ta('GET /api/health：200 + { ok, builtAt }，不触发快照构建（启动脚本探活契约）', async () => {
    const r = await httpJson(P, '/api/health');
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.ok, true);
    assert.ok(j.builtAt === null || Number.isFinite(j.builtAt), `builtAt 应为 null 或有限数，got ${j.builtAt}`);
  });

  await ta('/api/refresh 契约：GET → 405，POST → 200（跨 Agent：前端刷新按钮已改 POST）', async () => {
    const g = await httpJson(P, '/api/refresh');
    assert.equal(g.status, 405, 'GET 必须被拒（写操作不接受任意 method）');
    const p2 = await httpJson(P, '/api/refresh', { method: 'POST' });
    assert.equal(p2.status, 200);
    const j = JSON.parse(p2.body);
    assert.equal(j.ok, true);
    assert.ok(Number.isFinite(j.builtAt), 'POST 应返回重建时间戳');
  });

  await ta('POST /api/plans：多字节中文跨 chunk 不损坏（Buffer 聚合解码，回归 buf += c 劈坏 UTF-8）', async () => {
    const TOKEN = '中文密钥abcdef中文ghij'; // 16 字符：掩码形态 = 前4 + … + 后4
    const payload = JSON.stringify({ quotaKeys: { chatgpt: { accessToken: TOKEN } } });
    const buf = Buffer.from(payload, 'utf8');
    // 劈点强制落在多字节字符内部（'中' 的 3 字节 UTF-8 序列的中间）才测得到旧缺陷
    const zi = buf.indexOf(Buffer.from('中', 'utf8'));
    const splitAt = zi + 1;
    const post = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: P, method: 'POST', path: '/api/plans',
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
      }, res => {
        let b = '';
        res.on('data', c => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject);
      req.write(buf.slice(0, splitAt));               // 第一块：半个中文字
      setTimeout(() => req.end(buf.slice(splitAt)), 60); // 第二块：剩余字节（跨 chunk 多字节）
    });
    assert.equal(post.status, 200, `中文跨 chunk 不得破坏 JSON 解析：${post.body}`);
    // 回读验证：存进去的是完整中文字符串（若字节被劈坏，掩码会变成 U+FFFD 形态）
    const view = JSON.parse((await httpJson(P, '/api/plans')).body);
    assert.equal(view.quotaKeys.chatgpt.accessToken, '中文密钥…ghij',
      `掩码应基于完整中文明文，got ${view.quotaKeys.chatgpt.accessToken}`);
  });

  console.log('== 集成：登录门禁 HTTP 全流程（auth.json + 域名 Host + cookie 会话） ==');
  await ta('未登录：页面 302 /api 401 / health+login 免检 / 本机 localhost 豁免 / 登录后放行 / 登出作废', async () => {
    // 复用上面已挂载的 hs（端口 P）：门禁每请求现读凭据，auth.json 落盘即生效、删除即关闭
    const rawReq = (p, opt) => new Promise((resolve, reject) => {
      const o = opt || {};
      const req = http.request({
        host: '127.0.0.1', port: P, method: o.method || 'GET', path: p,
        headers: Object.assign(
          { Host: o.host || 'quota.test' },
          o.cookie ? { cookie: o.cookie } : {},
          o.body != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(o.body) } : {}),
      }, res => {
        let buf = ''; res.on('data', c => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      });
      req.on('error', reject);
      if (o.body != null) req.write(o.body);
      req.end();
    });
    const fs2 = require('node:fs'); const path2 = require('node:path');
    fs2.writeFileSync(path2.join(auth.AUTH_FILE()), JSON.stringify({ user: 'gate', passHash: auth.hashPassword('gate-pass-123') }));
    process.env.AQD_HOSTS = 'quota.test';
    try {
      let r = await rawReq('/api/summary');
      assert.equal(r.status, 401);
      assert.equal(JSON.parse(r.body).login, true, '前端据此跳登录页');
      r = await rawReq('/');
      assert.equal(r.status, 302); assert.equal(r.headers.location, '/login');
      r = await rawReq('/api/health'); assert.equal(r.status, 200, '探活免登录（启动脚本契约）');
      r = await rawReq('/login'); assert.equal(r.status, 200); assert.ok(r.body.includes('/api/login'), '登录页指向自身端点');
      r = await rawReq('/api/summary', { host: 'localhost' });
      assert.equal(r.status, 200, '本机回环 + localhost Host 豁免（菜单栏/组件零改动）');
      r = await rawReq('/api/summary', { host: 'evil.example' });
      assert.equal(r.status, 403, 'Host 白名单依旧兜底');
      r = await rawReq('/api/login', { method: 'POST', body: JSON.stringify({ user: 'gate', pass: 'nope' }) });
      assert.equal(r.status, 401);
      r = await rawReq('/api/login', { method: 'POST', body: JSON.stringify({ user: 'gate', pass: 'gate-pass-123' }) });
      assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).ok, true);
      const sc = String(r.headers['set-cookie'] || '');
      assert.ok(sc.includes('HttpOnly') && sc.includes('SameSite=Lax'), '会话 cookie 安全属性');
      const cookie = sc.split(';')[0];
      r = await rawReq('/api/summary', { cookie });
      assert.equal(r.status, 200); assert.ok(JSON.parse(r.body).agg, '登录后取到快照');
      r = await rawReq('/api/logout', { method: 'POST', cookie });
      assert.equal(r.status, 200);
      r = await rawReq('/api/summary', { cookie });
      assert.equal(r.status, 401, '登出后旧 cookie 作废');
      // 限流：10 次失败后正确密码也 429（本机豁免请求不计入此路径）
      for (let i = 0; i < 10; i++) await rawReq('/api/login', { method: 'POST', body: '{"user":"gate","pass":"x"}' });
      r = await rawReq('/api/login', { method: 'POST', body: JSON.stringify({ user: 'gate', pass: 'gate-pass-123' }) });
      assert.equal(r.status, 429, '失败 10 次后限流生效');
    } finally {
      fs2.rmSync(auth.AUTH_FILE(), { force: true });
      delete process.env.AQD_HOSTS;
    }
  });

  console.log('== 集成：alerts 端到端（loopback sink + 真实 httpRequest 发送路径） ==');
  const e2eHits = [];
  const e2eSink = http.createServer((rq, rs) => {
    let b = '';
    rq.on('data', c => { b += c; });
    rq.on('end', () => {
      e2eHits.push({ url: rq.url, headers: rq.headers, body: b });
      // 模拟企业微信：业务失败也回 HTTP 200 + errcode；其余路径回空 JSON
      const body = rq.url === '/wecom-bad' ? '{"errcode":93000,"errmsg":"invalid webhook url"}'
        : rq.url === '/wecom-ok' ? '{"errcode":0,"errmsg":"ok"}' : '{}';
      rs.writeHead(200); rs.end(body);
    });
  });
  await new Promise(r => e2eSink.listen(0, '127.0.0.1', r));
  const E2E_URL = `http://127.0.0.1:${e2eSink.address().port}/alert-hook`;
  const e2eStore = alerts.createMemoryStore(); // 两轮 run 共用（生产路径 defaultStore() 为持久库）

  await ta('端到端：超阈值事件送达 sink（title/message/severity/source/data 完整）', async () => {
    const p = { alerts: { enabled: true, webhookType: 'generic', webhookUrl: E2E_URL, thresholds: { fiveHour: 85, weekly: 85 }, cooldownMinutes: 60 }, dailyGoal: { cny: 0 } };
    const r = await alerts.run(snapOf({ zhipuQuota: zhipuQ(90, 10) }), p, { store: e2eStore, now: NOW });
    assert.equal(r.events, 1);
    assert.equal(r.sent, 1);
    assert.equal(e2eHits.length, 1, `sink 应收到 1 条，got ${e2eHits.length}`);
    const h = e2eHits[0];
    assert.equal(h.url, '/alert-hook');
    assert.equal(h.headers['content-type'], 'application/json; charset=utf-8');
    const b = JSON.parse(h.body);
    assert.ok(b.title.includes('智谱 Coding Plan') && b.title.includes('90%'), `title=${b.title}`);
    assert.equal(b.message, '约 47 分钟后重置');
    assert.equal(b.severity, 'warning');
    assert.equal(b.source, 'ai-quota-dashboard');
    assert.deepEqual(b.data, { percent: 90, resetAt: RESET_AT });
  });

  await ta('端到端：冷却窗内再次 run 不重发（sink 计数不变）', async () => {
    const p = { alerts: { enabled: true, webhookType: 'generic', webhookUrl: E2E_URL, thresholds: { fiveHour: 85, weekly: 85 }, cooldownMinutes: 60 }, dailyGoal: { cny: 0 } };
    const snap = snapOf({ zhipuQuota: zhipuQ(90, 10) }); // 与上例同一 resetAt → 同一冷却身份
    const r = await alerts.run(snap, p, { store: e2eStore, now: NOW + 60e3 }); // 同一冷却库（生产为持久 sqlite）
    assert.equal(r.sent, 0, '冷却窗内不得重发');
    assert.equal(r.suppressed, 1);
    assert.equal(e2eHits.length, 1, 'sink 计数应保持 1');
  });

  await ta('端到端：wecom 全链路（真实 httpRequest 收响应体 → verify errcode → markdown 卡片）', async () => {
    const base = `http://127.0.0.1:${e2eSink.address().port}`;
    const before = e2eHits.length;
    const zq = {
      available: true, provider: '智谱 Coding Plan',
      fiveHour: { usedPercent: 90, remainingPercent: 10, used: 90e4, total: 100e4, remaining: 10e4, resetAt: RESET_AT, resetMsLeft: null },
      weekly: { usedPercent: 5, resetAt: RESET_AT, resetMsLeft: null }, fetchedAt: NOW,
    };
    const p = { alerts: { enabled: true, webhookType: 'wecom', webhookUrl: base + '/wecom-ok', thresholds: { fiveHour: 85, weekly: 85 }, cooldownMinutes: 60 }, dailyGoal: { cny: 0 } };
    let r = await alerts.run(snapOf({ zhipuQuota: zq }), p, { store: alerts.createMemoryStore(), now: NOW });
    assert.equal(r.sent, 1, `errcode=0 应计成功：${JSON.stringify(r)}`);
    const h = e2eHits[e2eHits.length - 1];
    assert.equal(h.url, '/wecom-ok');
    const b = JSON.parse(h.body);
    assert.equal(b.msgtype, 'markdown');
    assert.ok(b.markdown.content.includes('<font color="comment">⚠️ 智谱 Coding Plan'), '预警(warning 级)标题灰色');
    assert.ok(b.markdown.content.includes('剩余额度：10%') && b.markdown.content.includes('已用 900,000 / 总量 1,000,000'), '卡片正文含数据');
    // errcode!=0 → 真实 httpRequest 路径上判失败（HTTP 200 但业务错）
    r = await alerts.run(snapOf({ zhipuQuota: zq }), { alerts: Object.assign({}, p.alerts, { webhookUrl: base + '/wecom-bad' }) }, { store: alerts.createMemoryStore(), now: NOW });
    assert.equal(r.sent, 0, 'errcode!=0 不得计成功');
    assert.equal(r.events, 1, '事件照常评估');
    assert.equal(e2eHits.length, before + 2, '两次各恰好触达 sink 一次（HTTP 请求均已发出）');
  });

  console.log('== 集成：POST /api/alerts/test（测试按钮端点） ==');
  await ta('POST /api/alerts/test：面板值优先 / 已存值回退 / 掩码映射 / errcode 透出 / 未配置 400', async () => {
    const post = o => httpJson(P, '/api/alerts/test', { method: 'POST', body: JSON.stringify(o) });
    const base = `http://127.0.0.1:${e2eSink.address().port}`;
    // 1) 显式面板值（保存前测试）：wecom ok 路径
    let r = await post({ webhookType: 'wecom', webhookUrl: base + '/wecom-ok' });
    assert.equal(r.status, 200);
    let j = JSON.parse(r.body);
    assert.equal(j.ok, true, r.body);
    assert.equal(j.type, 'wecom');
    // 2) errcode!=0 → ok:false 且 errmsg 透出（配置错了一目了然）
    r = await post({ webhookType: 'wecom', webhookUrl: base + '/wecom-bad' });
    j = JSON.parse(r.body);
    assert.equal(j.ok, false);
    assert.ok(j.error.includes('invalid webhook url'), `errmsg 透出：${j.error}`);
    // 3) 已存值回退 + 掩码回显映射：先存 generic → sink，再只传掩码测
    const save = await httpJson(P, '/api/plans', { method: 'POST', body: JSON.stringify({ alerts: { enabled: false, webhookType: 'generic', webhookUrl: E2E_URL } }) });
    assert.equal(save.status, 200);
    const before = e2eHits.length;
    r = await post({}); // 不带任何值 → 用已存配置
    j = JSON.parse(r.body);
    assert.equal(j.ok, true, '回退已存配置');
    assert.equal(j.type, 'generic');
    assert.equal(e2eHits.length, before + 1, '真实送达 sink');
    const plansView = JSON.parse((await httpJson(P, '/api/plans')).body);
    r = await post({ webhookUrl: plansView.alerts.webhookUrl }); // 只传掩码 → 后端换回已存值
    j = JSON.parse(r.body);
    assert.equal(j.ok, true, '掩码回显 = 未改动，用已存值');
    // 4) 未配置地址（存储与提交都空）→ 400
    await httpJson(P, '/api/plans', { method: 'POST', body: JSON.stringify({ alerts: { enabled: false, webhookUrl: '' } }) });
    r = await post({});
    assert.equal(r.status, 400);
    assert.ok(JSON.parse(r.body).error.includes('未配置'));
  });

  t('extractQuotaSnapshot：available 源入快照、剥 raw（PII 零出境）、不可用源省略', () => {
  const { extractQuotaSnapshot } = require('../scripts/deploy-pack.js');
  const sum = {
    chatgptQuota: { available: true, provider: 'ChatGPT Plus', fiveHour: { usedPercent: 63 }, fetchedAt: 1700000000000, raw: { user_id: 'user-SECRET', email: 'me@privaterelay.appleid.com' } },
    minimaxQuota: { available: false, reason: '未配置' },
    zhipuQuota: { available: true, provider: '智谱', weekly: { usedPercent: 10 }, fetchedAt: 1700000000001, raw: { org_id: 'org-SECRET' } },
    network: { current: { key: 'wifi:Home', label: 'Home', rxRate: 100, txRate: 200 }, today: { rx: 9, tx: 9 } },
  };
  const q = extractQuotaSnapshot(sum, 1700000001000);
  assert.equal(q.generatedAt, 1700000001000);
  assert.equal(q.chatgptQuota.fiveHour.usedPercent, 63);
  assert.ok(!('raw' in q.chatgptQuota), 'raw 必须剥离');
  assert.ok(!JSON.stringify(q).includes('user-SECRET') && !JSON.stringify(q).includes('me@privaterelay'), 'PII 不得出现在快照');
  assert.ok(!('minimaxQuota' in q), '不可用源省略');
  assert.equal(q.zhipuQuota.provider, '智谱');
  // v1.7.3：network 只带 current（today/month 云端从归档读）
  assert.deepEqual(q.network, { current: sum.network.current });
});

t('sync-state 状态机：3 连败首报、恢复清零、持续失败每日重推、成功不报警', () => {
  const { updateState, FAILS_TO_ALERT, RETALERT_MS } = require('../scripts/sync-state.js');
  const now = Date.now();
  let s = {};
  for (let i = 1; i < FAILS_TO_ALERT; i++) {
    const r = updateState(s, false, now + i);
    s = r.next;
    assert.equal(r.shouldAlert, false, `第 ${i} 次失败不报警`);
  }
  let r = updateState(s, false, now + FAILS_TO_ALERT);
  assert.equal(r.shouldAlert, true, '第 3 次连败报警');
  assert.equal(r.next.lastAlertAt, now + FAILS_TO_ALERT);
  s = r.next;
  r = updateState(s, false, now + FAILS_TO_ALERT + 3600e3);
  assert.equal(r.shouldAlert, false, '1 小时内继续失败不重复报');
  r = updateState(s, false, now + FAILS_TO_ALERT + RETALERT_MS + 1000);
  assert.equal(r.shouldAlert, true, '超 24h 重推');
  r = updateState(s, true, now + FAILS_TO_ALERT + 7200e3);
  assert.equal(r.next.fails, 0, '成功清零');
  assert.equal(r.shouldAlert, false);
  // 清零后重新计数：再 3 连败又能报警
  let t = {};
  for (let i = 0; i < FAILS_TO_ALERT; i++) t = updateState(t, false, now + i).next;
  assert.equal(t.fails, FAILS_TO_ALERT);
});

t('calcSyncStale：12h 阈值边界 / 时钟回拨防护 / 无 marker 返回 null', () => {
  const { calcSyncStale, STALE_AFTER_HOURS } = require('../server/lib/snapshot');
  const now = Date.now();
  assert.equal(calcSyncStale(null, now), null);
  assert.equal(calcSyncStale({ syncedAt: 'x' }, now), null, '脏值防御');
  assert.equal(calcSyncStale({ syncedAt: now + 60e3 }, now), null, '未来时间戳按不可信处理');
  let st = calcSyncStale({ syncedAt: now - 11.9 * 3600e3 }, now);
  assert.equal(st.active, false, '11.9h 未越阈值');
  st = calcSyncStale({ syncedAt: now - (STALE_AFTER_HOURS + 0.1) * 3600e3 }, now);
  assert.equal(st.active, true, '12.1h 越阈值');
  assert.equal(st.ageHours, 12.1);
  assert.equal(st.syncedAt, now - (STALE_AFTER_HOURS + 0.1) * 3600e3);
});

t('applyQuotaSnapshotFallback：只顶失败源 / 30 分钟新鲜窗 / archived 标记 / live 优先', () => {
  const { applyQuotaSnapshotFallback, QUOTA_SNAPSHOT_FRESH_MS } = require('../server/lib/snapshot');
  const now = Date.now();
  const qs = { generatedAt: now - 60e3, chatgptQuota: { available: true, provider: 'P', fiveHour: { usedPercent: 50 }, fetchedAt: now - 60e3 } };
  // 失败源被顶替 + archived 标记
  let d = { chatgptQuota: { available: false, notConfigured: true } };
  d = applyQuotaSnapshotFallback(d, qs, now);
  assert.equal(d.chatgptQuota.available, true); assert.equal(d.chatgptQuota.archived, true);
  // live 可用结果不被覆盖
  d = { chatgptQuota: { available: true, provider: 'live' } };
  d = applyQuotaSnapshotFallback(d, qs, now);
  assert.equal(d.chatgptQuota.provider, 'live', 'live 优先');
  assert.ok(!d.chatgptQuota.archived);
  // 超新鲜窗不使用
  d = { chatgptQuota: { available: false } };
  d = applyQuotaSnapshotFallback(d, { generatedAt: now - QUOTA_SNAPSHOT_FRESH_MS - 1, chatgptQuota: { available: true } }, now);
  assert.equal(d.chatgptQuota.available, false, '过期快照不回退');
  // 无文件直通
  d = applyQuotaSnapshotFallback({ minimaxQuota: null }, null, now);
  assert.equal(d.minimaxQuota, null);
  // 预警引擎跳过 archived（主端已推，防双发）
  const alerts = require('../server/lib/alerts');
  const evs = alerts.evaluate({ chatgptQuota: { available: true, archived: true, provider: 'P', fetchedAt: now, fiveHour: { usedPercent: 97, resetMsLeft: 3600e3 }, weekly: { usedPercent: 97, resetMsLeft: 7200e3 } } }, { alerts: {} }, now);
  assert.equal(evs.filter(e => e.kind === 'quota').length, 0, 'archived 额度不触发预警');
  const evs2 = alerts.evaluate({ chatgptQuota: { available: true, provider: 'P', fetchedAt: now, fiveHour: { usedPercent: 97, resetMsLeft: 3600e3 }, weekly: { usedPercent: 97, resetMsLeft: 7200e3 } } }, { alerts: {} }, now);
  assert.ok(evs2.filter(e => e.kind === 'quota').length >= 1, 'live 高用量照常预警');
});

console.log('== 集成：mcp.js report 冒烟（子进程 + 独立配置目录） ==');
  await ta('node mcp/mcp.js report week：exit 0 且 stdout 含「周报」', async () => {
    const mcpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqd-mcp-'));
    try {
      const { stdout, stderr } = await new Promise((resolve, reject) => {
        execFile(process.execPath, [path.join(ROOT, 'mcp', 'mcp.js'), 'report', 'week'], {
          cwd: ROOT, timeout: 120_000,
          env: Object.assign({}, process.env, { AI_QUOTA_CONFIG_DIR: mcpTmp }),
        }, (err, so, se) => (err ? reject(Object.assign(err, { stderr: se })) : resolve({ stdout: so, stderr: se })));
      });
      assert.ok(stdout.includes('周报'), `stdout 应含「周报」，got: ${stdout.slice(0, 80)}（stderr: ${String(stderr).slice(0, 120)}）`);
    } finally {
      fs.rmSync(mcpTmp, { recursive: true, force: true });
    }
  });

  await ta('node mcp.js report week：原始日志已清时从本地归档补缺（与 web 口径一致）', async () => {
    const mcpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqd-mcp2-'));
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aqd-home2-')); // 空 HOME：raw 全空，只剩归档
    try {
      const monday = weekStart(Date.now()); // 本期周一：归档里一条 zcode，glm-5.3 100万输入 = ¥8
      const db = new DatabaseSync(path.join(mcpTmp, 'history.sqlite'));
      db.exec(`CREATE TABLE daily (date TEXT NOT NULL, tool TEXT NOT NULL, requests INTEGER, input_tokens INTEGER,
        output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
        cost_usd REAL, cost_cny REAL, equivalent_cny REAL, sub_usd REAL, pay_usd REAL, sub_requests INTEGER,
        pay_requests INTEGER, updated_at INTEGER, PRIMARY KEY(date, tool))`);
      db.exec(`CREATE TABLE daily_model (date TEXT NOT NULL, tool TEXT NOT NULL, model TEXT NOT NULL, requests INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
        cost_usd REAL, cost_cny REAL, equivalent_cny REAL, updated_at INTEGER, PRIMARY KEY(date, tool, model))`);
      db.prepare(`INSERT INTO daily VALUES (?, 'zcode', 1, 1000000, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0)`).run(monday);
      db.prepare(`INSERT INTO daily_model VALUES (?, 'zcode', 'glm-5.3', 1, 1000000, 0, 0, 0, 0, 0, 8, 0)`).run(monday);
      db.close();
      const { stdout } = await new Promise((resolve, reject) => {
        execFile(process.execPath, [path.join(ROOT, 'mcp', 'mcp.js'), 'report', 'week'], {
          cwd: ROOT, timeout: 120_000,
          env: Object.assign({}, process.env, { AI_QUOTA_CONFIG_DIR: mcpTmp, HOME: emptyHome }),
        }, (err, so, se) => (err ? reject(Object.assign(err, { stderr: se })) : resolve({ stdout: so })));
      });
      assert.ok(stdout.includes('ZCode'), `报表应含归档补回的 ZCode，got: ${stdout.slice(0, 120)}`);
      assert.ok(stdout.includes('¥8'), `zcode 1 条 glm-5.3 100万输入应重估为 ¥8，got: ${stdout.slice(0, 300)}`);
    } finally {
      fs.rmSync(mcpTmp, { recursive: true, force: true });
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  for (const s of [hs, sink, e2eSink]) s.close();
  finish();
})().catch(e => { fail++; console.error('  FAIL - alerts 异步段:', e && e.message); finish(); });

function finish() {
  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
  process.exit(fail ? 1 : 0);
}
