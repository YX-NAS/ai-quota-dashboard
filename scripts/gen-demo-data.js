#!/usr/bin/env node
'use strict';
// 生成「演示数据」HOME 目录：用于截图 / 演示 / 测试，不碰真实数据。
// 用法：node scripts/gen-demo-data.js <目标HOME目录>
//   然后以 HOME=<目标目录> 启动服务即可读到这批假数据：
//   HOME=<目标目录> PORT=7790 node server/index.js
// 说明：
//   - 成本口径与 server/lib/pricing.js 完全一致（直接 require 复用公式），
//     按每个工具的「目标日消耗」反推请求条数，保证看板上的额度条 / 横幅比例可控。
//   - 时间锚点取运行时刻：今日数据落在 08:05 ~ 现在（北京时间），
//     因此「当日目标成本」横幅、昨日同期对比都能呈现出真实感。

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_PRICING } = require(path.join(__dirname, '..', 'server', 'lib', 'pricing'));

const target = process.argv[2];
if (!target) { console.error('用法: node scripts/gen-demo-data.js <目标HOME目录>'); process.exit(1); }
fs.rmSync(target, { recursive: true, force: true });

const FX = 7.2;
const BJ = 8 * 3600e3;
const bjDay = ts => new Date(ts + BJ).toISOString().slice(0, 10);
const now = Date.now();
const msToday = (now + BJ) % 86400e3; // 北京时间今日已过毫秒

// ---------- 可复现随机数 ----------
let seed = 20260922;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const jit = f => 1 + (rnd() - 0.5) * f; // ±f/2 的抖动系数

// ---------- 日期刻度：近 30 个整天 + 今日（部分天） ----------
// growth：使用强度缓慢爬坡；spike：某几天冲刺；昨天(-1)与今天故意是高强度日，
// 让「昨日同期对比 ↑」「当日目标成本 ~64%」都有戏可看。
const DAYS = [];
for (let off = -29; off <= 0; off++) {
  const dayStart = now - msToday + off * 86400e3; // 北京时间当日 0 点
  const d = new Date(dayStart + BJ);
  const wd = d.getUTCDay(); // 0=周日
  const weekend = wd === 0 || wd === 6;
  const growth = 0.75 + (29 + off) / 29 * 0.4; // 0.75 → 1.15
  const spike = off === -12 ? 2.1 : off === -5 ? 1.75 : off === -1 ? 2.2 : 1;
  const scale = growth * spike * jit(0.3) * (weekend ? 0.35 : 1);
  const partial = off === 0;
  // 今日请求时间窗：08:05 ~ 现在（提前 3 分钟，避免压到采集时刻）
  const from = partial ? dayStart + 8 * 3600e3 + 5 * 60e3 : dayStart + 8 * 3600e3;
  const to = partial ? now - 3 * 60e3 : dayStart + 23.5 * 3600e3;
  DAYS.push({ off, key: bjDay(dayStart), scale, partial, from, to, spike });
}

// ---------- 每工具目标日消耗（scale=1 时，¥ 或 $） ----------
// 期望的月末读数（配 demo plans.json 的月额度）：
//   zcode   ~¥390 / ¥598 ≈ 65%   · claudeCode ~¥85 / ¥144 ≈ 59%
//   workbuddy ~¥340 / ¥399 ≈ 85% · 智谱合并等价 (390+85)/598 ≈ 80%（黄条）
// 今日（burst 早晨）：合计 ≈ ¥128 / 目标 ¥200 ≈ 64%
const DAILY_CNY = { zcode: 17.7, claudeCode: 4.0, workbuddy: 15.5 };
const DAILY_USD = { codexSub: 1.8, codexPay: 0.4, claudeDesktop: 0.6 };
const TODAY_CNY = { zcode: 34, claudeCode: 22, workbuddy: 31 };
const TODAY_USD = { codexSub: 2.4, codexPay: 0.8, claudeDesktop: 1.8 };

// 每个模型的单请求画像（token 数量级参考真实编码会话）
const PROFILES = {
  zcode: [
    { model: 'glm-5.3', in: 60000, cache: 45000, out: 4000, think: 300 },
    { model: 'GLM-5.3-Flash', in: 30000, cache: 20000, out: 2500, think: 0 },
  ],
  claudeCode: [
    { model: 'glm-5.3', in: 55000, cache: 40000, out: 3500, think: 250 },
    { model: 'MiniMax-M3', in: 50000, cache: 35000, out: 3000, think: 0 },
    { model: 'deepseek-v4-pro', in: 55000, cache: 40000, out: 3000, think: 0 },
  ],
  workbuddy: [
    { model: 'MiniMax-M3', in: 120000, cache: 90000, out: 6000, think: 0 },
    { model: 'deepseek-v4-flash', in: 60000, cache: 45000, out: 3000, think: 0 },
  ],
  codexSub: [
    { model: 'gpt-5.2', in: 38000, cache: 26000, out: 2200, usd: 0.30 },
    { model: 'gpt-5.2-codex', in: 42000, cache: 30000, out: 2600, usd: 0.22 },
  ],
  codexPay: [
    { model: 'deepseek-v4-pro', in: 46000, cache: 32000, out: 3000, usd: 0.45 },
  ],
  claudeDesktop: [
    { model: 'claude-sonnet-4.5', in: 25000, cache: 15000, out: 2500, usd: 0.11 },
  ],
};

const cnyOf = p => {
  const t = DEFAULT_PRICING[p.model];
  if (!t) throw new Error('演示画像里有未收录模型: ' + p.model);
  const cached = Math.min(p.cache, p.in);
  return (p.in - cached) / 1e6 * t.in + cached / 1e6 * (t.cacheRead ?? t.in) + p.out / 1e6 * t.out;
};
const tsBetween = (from, to) => from + rnd() * (to - from);
const pick = arr => arr[Math.floor(rnd() * arr.length)];

const rows = { zcode: [], cc: [], ccClaude: [], claudeCode: [], workbuddy: [] };
let msgId = 0;

function emit(kind, ts, profile) {
  const jitIn = Math.round(jit(0.5)), jitOut = Math.round(jit(0.7));
  const inT = Math.round(profile.in * jitIn / 100) * 100;
  const cache = Math.round(Math.min(profile.cache * jitIn, inT * 0.9) / 100) * 100;
  const outT = Math.round(profile.out * jitOut / 100) * 100;
  if (kind === 'zcode') {
    rows.zcode.push({ ts: Math.round(ts), model: profile.model, in: inT, out: outT,
      think: Math.round(profile.think * jitOut), cache });
  } else if (kind === 'claudeCode') {
    rows.claudeCode.push({ ts: new Date(ts).toISOString(), model: profile.model, in: inT, out: outT,
      think: Math.round(profile.think * jitOut), cache, id: 'msg_demo_' + (++msgId) });
  } else if (kind === 'workbuddy') {
    rows.workbuddy.push({ ts: Math.round(ts), model: profile.model, in: inT, out: outT, cache, id: 'wb_' + (++msgId) });
  } else { // cc-switch：codex 套餐 / codex 第三方 / claude-desktop
    const usd = profile.usd * jit(0.6);
    if (kind === 'ccClaude') rows.ccClaude.push({ ts: Math.round(ts) / 1000, model: profile.model, in: inT, out: outT, cache, usd });
    else rows.cc.push({ ts: Math.round(ts) / 1000, model: profile.model, in: inT, out: outT, cache, usd });
  }
}

// 按目标日消耗填充：估算单请求成本，逐条累加到目标值
function fill(kind, profiles, targetCny, from, to, weighted) {
  let got = 0;
  let guard = 0;
  while (got < targetCny && guard++ < 4000) {
    const p = weighted ? weighted(profiles) : pick(profiles);
    const cost = p.usd != null ? p.usd * FX : cnyOf(p);
    emit(kind, tsBetween(from, to), p);
    got += cost;
  }
  return got;
}
// 让 glm-5.3 占大头（贴合真实使用分布）
const weightGLM = ps => rnd() < 0.6 ? ps.filter(p => /glm/i.test(p.model))[0] || ps[0] : pick(ps);

for (const d of DAYS) {
  const cnySpec = d.partial ? TODAY_CNY : { zcode: DAILY_CNY.zcode * d.scale, claudeCode: DAILY_CNY.claudeCode * d.scale, workbuddy: DAILY_CNY.workbuddy * d.scale };
  const usdSpec = d.partial ? TODAY_USD : { codexSub: DAILY_USD.codexSub * d.scale, codexPay: DAILY_USD.codexPay * d.scale, claudeDesktop: DAILY_USD.claudeDesktop * d.scale };
  if (d.off === -1) {
    // 昨天：上午（08:00 ~ 此刻）拿下约 58%，其余分布在下午 —— 同期对比 ~↑47%
    const cut = d.from + (msToday - 8 * 3600e3 - 5 * 60e3);
    const jobs = [
      ['zcode', PROFILES.zcode, cnySpec.zcode, weightGLM],
      ['claudeCode', PROFILES.claudeCode, cnySpec.claudeCode, weightGLM],
      ['workbuddy', PROFILES.workbuddy, cnySpec.workbuddy, null],
      ['cc', PROFILES.codexSub, usdSpec.codexSub * FX, null],
      ['cc', PROFILES.codexPay, usdSpec.codexPay * FX, null],
      ['ccClaude', PROFILES.claudeDesktop, usdSpec.claudeDesktop * FX, null],
    ];
    for (const [kind, ps, target, w] of jobs) {
      fill(kind, ps, target * 0.58, d.from, cut, w);
      fill(kind, ps, target * 0.42, cut, d.to, w);
    }
  } else {
    fill('zcode', PROFILES.zcode, cnySpec.zcode, d.from, d.to, weightGLM);
    fill('claudeCode', PROFILES.claudeCode, cnySpec.claudeCode, d.from, d.to, weightGLM);
    fill('workbuddy', PROFILES.workbuddy, cnySpec.workbuddy, d.from, d.to, null);
    fill('cc', PROFILES.codexSub, usdSpec.codexSub * FX, d.from, d.to, null);
    fill('cc', PROFILES.codexPay, usdSpec.codexPay * FX, d.from, d.to, null);
    fill('ccClaude', PROFILES.claudeDesktop, usdSpec.claudeDesktop * FX, d.from, d.to, null);
  }
}

// ---------- 落盘 ----------
// ~/.zcode/cli/db/db.sqlite
const zcDir = path.join(target, '.zcode', 'cli', 'db');
fs.mkdirSync(zcDir, { recursive: true });
const zc = new DatabaseSync(path.join(zcDir, 'db.sqlite'));
zc.exec(`CREATE TABLE model_usage (started_at INTEGER, model_id TEXT, input_tokens INTEGER,
  output_tokens INTEGER, reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER,
  cache_read_input_tokens INTEGER, status TEXT)`);
const insZc = zc.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?)');
for (const r of rows.zcode) insZc.run(r.ts, r.model, r.in, r.out, r.think, 0, r.cache, 'completed');
zc.close();

// ~/.cc-switch/cc-switch.db
const ccDir = path.join(target, '.cc-switch');
fs.mkdirSync(ccDir, { recursive: true });
const cc = new DatabaseSync(path.join(ccDir, 'cc-switch.db'));
cc.exec(`CREATE TABLE proxy_request_logs (app_type TEXT, model TEXT, input_tokens INTEGER,
  output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
  total_cost_usd REAL, created_at INTEGER)`);
const insCc = cc.prepare('INSERT INTO proxy_request_logs VALUES (?,?,?,?,?,?,?,?)');
for (const r of rows.cc) insCc.run('codex', r.model, r.in, r.out, r.cache, 0, r.usd, r.ts);
for (const r of rows.ccClaude) insCc.run('claude-desktop', r.model, r.in, r.out, r.cache, 0, r.usd, r.ts);
cc.close();

// ~/.claude/projects/<proj>/<session>.jsonl —— 每 3 天的行合并进一个会话文件
const clDir = path.join(target, '.claude', 'projects', 'demo-app');
fs.mkdirSync(clDir, { recursive: true });
const clByDay = {};
for (const r of rows.claudeCode) (clByDay[bjDay(Date.parse(r.ts))] ||= []).push(r);
const clDays = Object.keys(clByDay).sort();
for (let i = 0; i < clDays.length; i += 3) {
  const lines = clDays.slice(i, i + 3).flatMap(day => clByDay[day].map(r => JSON.stringify({
    timestamp: r.ts,
    message: { id: r.id, model: r.model, usage: {
      input_tokens: r.in, output_tokens: r.out,
      cache_read_input_tokens: r.cache, cache_creation_input_tokens: 0,
      output_tokens_details: { thinking_tokens: r.think },
    } },
  })));
  fs.writeFileSync(path.join(clDir, `sess-${i / 3}.jsonl`), lines.join('\n') + '\n');
}

// ~/.workbuddy-ai/projects/<proj>/<chat>.jsonl
const wbDir = path.join(target, '.workbuddy-ai', 'projects', 'demo-app');
fs.mkdirSync(wbDir, { recursive: true });
fs.writeFileSync(path.join(wbDir, 'chats.jsonl'),
  rows.workbuddy.map(r => JSON.stringify({
    timestamp: r.ts, id: 'line_' + r.id,
    providerData: { model: r.model, messageId: r.id, rawUsage: {},
      usage: { inputTokens: r.in, outputTokens: r.out, inputTokensDetails: { cached_tokens: r.cache } } },
  })).join('\n') + '\n');

// ---------- 汇总核对 ----------
const tsMs = r => typeof r.ts === 'number' ? (r.ts > 1e11 ? r.ts : r.ts * 1000) : Date.parse(r.ts);
const dayKeyOf = r => bjDay(tsMs(r)); // bjDay 内部已 +8h 折算北京时间
const eqCny = r => cnyOf({ model: r.model, in: r.in, cache: r.cache, out: r.out });
const mon = bjDay(now).slice(0, 7);
const sum = {};
for (const [k, list] of [['zcode', rows.zcode], ['claudeCode', rows.claudeCode], ['workbuddy', rows.workbuddy]]) {
  sum[k] = list.filter(r => dayKeyOf(r).startsWith(mon)).reduce((s, r) => s + eqCny(r), 0);
}
const ccMonthUsd = [...rows.cc, ...rows.ccClaude].filter(r => dayKeyOf(r).startsWith(mon)).reduce((s, r) => s + r.usd, 0);
const todayCny = [...rows.zcode, ...rows.claudeCode, ...rows.workbuddy].filter(r => dayKeyOf(r) === bjDay(now)).reduce((s, r) => s + eqCny(r), 0)
  + [...rows.cc, ...rows.ccClaude].filter(r => dayKeyOf(r) === bjDay(now)).reduce((s, r) => s + r.usd * FX, 0);

console.log(`[demo] 生成完毕 → ${target}`);
console.log(`[demo] 行数: zcode=${rows.zcode.length} cc(codex)=${rows.cc.length} cc(claude)=${rows.ccClaude.length} claudeCode=${rows.claudeCode.length} workbuddy=${rows.workbuddy.length}`);
console.log(`[demo] 本月等价 ¥: zcode=${sum.zcode.toFixed(0)} claudeCode=${sum.claudeCode.toFixed(0)} workbuddy=${sum.workbuddy.toFixed(0)} cc合计=$${ccMonthUsd.toFixed(2)}`);
console.log(`[demo] 今日(等价¥)=${todayCny.toFixed(0)} → 横幅 ${(todayCny / 200 * 100).toFixed(0)}% of ¥200`);
