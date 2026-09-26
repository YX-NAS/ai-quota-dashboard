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
  const inc = { zhipu: {}, minimax: {}, chatgpt: {} };
  const next = applyQuotaKeysUpdate(cur, inc);
  assert.deepEqual(Object.keys(next).sort(), ['chatgpt', 'minimax', 'zhipu']);
  assert.equal(next.zhipu.token, '');
});

console.log('== workbuddy：cached_tokens 求和 + NaN 防护 + mtime 跳过 ==');
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
  assert.ok(fs.statSync(freshFile).mtimeMs > 0);
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
    reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, status)`);
  const zi = zdb.prepare(`INSERT INTO model_usage VALUES (?, 'glm-5.3', 100, 10, 0, 0, 2, ?)`);
  zi.run(now, 'completed');                 // 正常 → 保留
  zi.run('not-a-timestamp', 'completed');   // 时间非法（文本）→ NaN 防护跳过
  zi.run(now - 400 * 86400e3, 'completed'); // 早于 SQL 下界 → 跳过
  zi.run(now + 1, 'error');                 // 非 completed → 跳过
  zdb.close();

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

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
process.exit(fail ? 1 : 0);
