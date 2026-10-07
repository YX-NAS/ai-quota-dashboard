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
const { makePricer, DEFAULT_PRICING } = require('../server/lib/pricing');

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

  // 思考折叠口径：output_tokens=10 + reasoning_tokens=5
  const zdb2 = new DatabaseSync(path.join(TMP_DIR, 'zcode-reasoning.sqlite'));
  zdb2.exec(`CREATE TABLE model_usage (started_at, model_id, input_tokens, output_tokens,
    reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, status)`);
  zdb2.prepare(`INSERT INTO model_usage VALUES (?, 'glm-5.3', 100, 10, 5, 0, 2, 'completed')`).run(now);
  zdb2.close();

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
t('zcode collect：思考 token 折入 outputTokens（按输出价计），reasoningTokens 保留明细', () => {
  const r = zcode.collect(path.join(TMP_DIR, 'zcode-reasoning.sqlite'));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].outputTokens, 15, 'outputTokens = 10 输出 + 5 思考');
  assert.equal(r.rows[0].reasoningTokens, 5, '思考明细保留（不重复计价）');
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
t('priceOverrides 白名单含 cacheWrite：合法保留、非法剔除', () => {
  const next = applyPlansUpdate({ priceOverrides: {} }, {
    priceOverrides: { 'glm-5.3': { cacheWrite: 12, in: -1 }, ghost: { cacheWrite: NaN } },
  });
  assert.deepEqual(next.priceOverrides, { 'glm-5.3': { cacheWrite: 12 } });
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
  const IHOOK = 'https://api.day.app/SECRET-KEY-XYZ';
  plansStore.save({
    usdCnyRate: 7.2, plans: {}, priceOverrides: {}, dailyGoal: { cny: 200 },
    quotaKeys: { zhipu: { token: ITOKEN, organizationId: 'org-IT', projectId: 'proj-IT' }, minimax: { apiKey: '' }, chatgpt: { accessToken: IJWT } },
    alerts: { enabled: false, webhookType: 'generic', webhookUrl: IHOOK, thresholds: { fiveHour: 85, weekly: 85, dailyGoalPct: 100 }, cooldownMinutes: 60 },
  });

  await ta('buildSnapshot：形状齐全（builtAt / agg.daily / agg.models / collectorErrors / rowStats 四采集器）', async () => {
    const s = await buildSnapshot();
    assert.ok(Number.isFinite(s.builtAt));
    assert.ok(s.agg && typeof s.agg.daily === 'object' && typeof s.agg.models === 'object');
    assert.deepEqual(Object.keys(s.rowStats).sort(), ['ccswitch', 'claudeCode', 'workbuddy', 'zcode']);
    for (const v of Object.values(s.rowStats)) assert.ok(Number.isInteger(v) && v >= 0, `rowStats 应为非负整数，got ${v}`);
    assert.ok(typeof s.collectorErrors === 'object');
    for (const v of Object.values(s.collectorErrors)) assert.equal(typeof v, 'string');
  });

  let snap1;
  await ta('buildSnapshot：对外快照已脱敏（quotaKeys 机密掩码、org/project 原值、alerts.webhookUrl 掩码）', async () => {
    snap1 = await buildSnapshot();
    assert.equal(snap1.plans.quotaKeys.zhipu.token, 'real…3456');
    assert.equal(snap1.plans.quotaKeys.zhipu.organizationId, 'org-IT', '非机密字段原样保留');
    assert.equal(snap1.plans.quotaKeys.zhipu.projectId, 'proj-IT');
    assert.equal(snap1.plans.quotaKeys.chatgpt.accessToken, '••••….sig', 'JWT 掩码不保留头部特征');
    assert.equal(snap1.plans.alerts.webhookUrl, 'https://api.day.app/••••');
    assert.equal(snap1.plans.alerts.thresholds.fiveHour, 85, '非机密 alerts 字段原样');
    const blob = JSON.stringify(snap1.plans);
    assert.ok(!blob.includes(ITOKEN) && !blob.includes('SECRET-KEY-XYZ') && !blob.includes(IJWT), '任何明文机密不得外泄');
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

  await ta('Host 白名单（HTTP 层实测）：Host: evil.com / localhost.evil.com 一律 403', async () => {
    assert.equal((await httpJson(P, '/api/plans', { host: 'evil.com' })).status, 403);
    assert.equal((await httpJson(P, '/api/report', { host: 'localhost.evil.com' })).status, 403);
    assert.equal((await httpJson(P, '/api/plans', { host: `localhost:${P}` })).status, 200, '本机 Host 正常放行');
  });

  console.log('== 集成：alerts 端到端（loopback sink + 真实 httpRequest 发送路径） ==');
  const e2eHits = [];
  const e2eSink = http.createServer((rq, rs) => {
    let b = '';
    rq.on('data', c => { b += c; });
    rq.on('end', () => { e2eHits.push({ url: rq.url, headers: rq.headers, body: b }); rs.writeHead(200); rs.end('{}'); });
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
