#!/usr/bin/env node
'use strict';
// AI 用量看板 MCP Server（stdio JSON-RPC 2.0，零依赖）
// 供 ZCode / WorkBuddy / ChatGPT(Codex) / Claude Code 等任意 MCP 客户端使用
// 也支持 CLI 模式：node mcp.js [summary|today|quota|models|tool:zcode:7]
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { version: VERSION } = require(path.join(ROOT, 'package.json'));
const plansStore = require(path.join(ROOT, 'server', 'lib', 'plans'));
const { makePricer } = require(path.join(ROOT, 'server', 'lib', 'pricing'));
const { aggregate, compareYesterday } = require(path.join(ROOT, 'server', 'lib', 'store'));
const zcode = require(path.join(ROOT, 'server', 'collectors', 'zcode'));
const ccswitch = require(path.join(ROOT, 'server', 'collectors', 'ccswitch'));
const workbuddy = require(path.join(ROOT, 'server', 'collectors', 'workbuddy'));
const claudecode = require(path.join(ROOT, 'server', 'collectors', 'claudecode'));
const chatgptQuota = require(path.join(ROOT, 'server', 'collectors', 'chatgpt-quota'));
const minimaxQuota = require(path.join(ROOT, 'server', 'collectors', 'minimax-quota'));
const zhipuQuota = require(path.join(ROOT, 'server', 'collectors', 'zhipu-quota'));

let snapshotCache = null;
let quotaCache = { at: 0, chatgpt: null, minimax: null, zhipu: null };
async function getSnapshot() {
  // MCP 调用频率低，缓存 60s 足够
  if (snapshotCache && Date.now() - snapshotCache.builtAt < 60_000) return snapshotCache;
  const plans = plansStore.load();
  const pricer = makePricer(plans);
  const [zc, cc, wb, clc] = [zcode.collect(), ccswitch.collect(), workbuddy.collect(), claudecode.collect()];
  const rows = [...zc.rows, ...cc.rows, ...wb.rows, ...clc.rows].sort((a, b) => a.ts - b.ts);
  snapshotCache = {
    builtAt: Date.now(),
    plans,
    agg: aggregate(rows, pricer),
    cmp: compareYesterday(rows, pricer),
    rowStats: { zcode: zc.rows.length, ccswitch: cc.rows.length, workbuddy: wb.rows.length, claudeCode: clc.rows.length },
  };
  return snapshotCache;
}

async function getQuotas() {
  if (Date.now() - quotaCache.at < 5 * 60_000) return quotaCache;
  const t = p => Promise.race([p, new Promise(r => setTimeout(() => r(null), 10_000))]).catch(() => null);
  quotaCache = { at: Date.now(), chatgpt: await t(chatgptQuota.collect()), minimax: await t(minimaxQuota.collect()), zhipu: await t(zhipuQuota.collect()) };
  return quotaCache;
}

const TOOLS_DEF = [
  {
    name: 'ai_usage_summary',
    description: '获取本机所有 AI 工具（ChatGPT·Codex / Claude Desktop / Claude Code / ZCode / WorkBuddy）的用量汇总：今日/本月请求、token、成本（订阅制为等价按量成本）、各工具模型分布。days 参数控制回看天数。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '回看天数，默认 7，最大 365', default: 7 },
      },
    },
  },
  {
    name: 'ai_usage_today',
    description: '获取今天（北京时间）各 AI 工具的用量与成本简报。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ai_usage_tool',
    description: '查询单个 AI 工具的详细用量（每日明细 + 模型分布）。tool 取值：codex / claudeDesktop / claudeCode / zcode / workbuddy。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: ['codex', 'claudeDesktop', 'claudeCode', 'zcode', 'workbuddy'] },
        days: { type: 'number', description: '回看天数，默认 7', default: 7 },
      },
      required: ['tool'],
    },
  },
  {
    name: 'ai_usage_models',
    description: '按模型维度列出各工具的用量与费用（当前全部数据范围）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ai_quota_windows',
    description: '查询各套餐账号的实时额度：ChatGPT Plus / MiniMax Token Plan / 智谱 Coding Plan 团队版的 5 小时窗口/周窗口用量百分比与重置倒计时；智谱另附等价月进度。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function bjDay(ts) { return new Date(ts + 8 * 3600e3).toISOString().slice(0, 10); }
const cnyOf = a => (a.costCny || 0) + (a.equivalentCny || 0);
const fx = plans => plans.usdCnyRate || 7.2;

function fmtInt(n) { return (n == null ? 0 : n).toLocaleString('zh-CN', { maximumFractionDigits: 0 }); }
function fmtCny(n) { return '¥' + (n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 }); }
function fmtTok(n) { return n >= 1e8 ? (n / 1e8).toFixed(2) + '亿' : n >= 1e4 ? (n / 1e4).toFixed(1) + '万' : fmtInt(n); }

const TOOL_NAMES = { codex: 'ChatGPT·Codex', claudeDesktop: 'Claude Desktop', claudeCode: 'Claude Code', zcode: 'ZCode', workbuddy: 'WorkBuddy' };

async function callTool(name, args) {
  const snap = await getSnapshot();
  const { agg, plans, rowStats } = snap;
  args = args || {};

  if (name === 'ai_usage_summary') {
    const days = Math.min(Number(args.days) || 7, 365);
    const cutoff = bjDay(Date.now() - days * 86400e3);
    const lines = [`AI 工具用量汇总（近 ${days} 天，截至 ${bjDay(Date.now())}，北京时间）`];
    for (const [tool, label] of Object.entries(TOOL_NAMES)) {
      let req = 0, inT = 0, outT = 0, cost = 0, usd = 0, subUsd = 0, payUsd = 0;
      const mset = {};
      for (const [d, tools] of Object.entries(agg.daily)) {
        if (d < cutoff) continue;
        const a = tools[tool];
        if (!a) continue;
        req += a.requests; inT += a.inputTokens; outT += a.outputTokens;
        cost += cnyOf(a); usd += a.costUsd || 0;
        subUsd += a.subUsd || 0; payUsd += a.payUsd || 0;
        for (const [m, mv] of Object.entries(a.models || {})) mset[m] = (mset[m] || 0) + mv.requests;
      }
      if (!req) continue;
      const top = Object.entries(mset).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => `${m}×${n}`).join(', ');
      lines.push(`\n【${label}】${fmtInt(req)} 次 | in ${fmtTok(inT)} / out ${fmtTok(outT)} tk | ${usd > 0 ? `$${usd.toFixed(2)}（¥${cost.toFixed(2)}）` : '等价 ' + fmtCny(cost)}`);
      if (tool === 'codex' && usd > 0) {
        lines.push(`  计费拆分: Plus 套餐(GPT系列,等价) $${subUsd.toFixed(2)} + 第三方实扣 $${payUsd.toFixed(2)}`);
      }
      if (top) lines.push(`  模型: ${top}`);
    }
    lines.push(`\n数据源行数: ${JSON.stringify(rowStats)}；订阅制工具与 GPT 系列成本为等价按量成本，非实际扣费。`);
    return { text: lines.join('\n') };
  }

  if (name === 'ai_usage_today') {
    const today = bjDay(Date.now());
    const t = agg.daily[today];
    const lines = [`今日（${today}）用量：`];
    if (!t || !t.__total) { lines.push('  今天还没有任何请求记录'); }
    else for (const [tool, label] of Object.entries(TOOL_NAMES)) {
      const a = t[tool];
      if (!a) continue;
      lines.push(`  ${label}: ${fmtInt(a.requests)} 次, ${fmtTok(a.inputTokens + a.outputTokens)} tk, ${fmtCny(cnyOf(a))}${a.costUsd > 0 ? `（$${a.costUsd.toFixed(2)}）` : '（等价）'}`);
      if (tool === 'codex' && (a.subUsd || a.payUsd)) {
        lines.push(`    ├ Plus 套餐（GPT 系列）: ${fmtInt(a.subRequests || 0)} 次 · $${(a.subUsd || 0).toFixed(2)}（等价，不扣费）`);
        lines.push(`    └ 第三方实扣: ${fmtInt(a.payRequests || 0)} 次 · $${(a.payUsd || 0).toFixed(2)} ≈ ${fmtCny((a.payUsd || 0) * (snap.plans.usdCnyRate || 7.2))}`);
      }
    }
    // 昨日同期对比
    if (snap.cmp && snap.cmp.yesterdaySameTime && snap.cmp.yesterdaySameTime.total.cny > 0.005) {
      const ySame = snap.cmp.yesterdaySameTime.total;
      const yFull = snap.cmp.yesterdayFull ? snap.cmp.yesterdayFull.total.cny : 0;
      const todayCny = cnyOf(t && t.__total || {});
      const d = (todayCny - ySame.cny) / ySame.cny * 100;
      lines.push(`昨日同期: ${fmtCny(ySame.cny)}（今日 ${d >= 0 ? '↑' : '↓'}${Math.abs(d).toFixed(0)}%）${yFull > 0.005 ? ` · 昨日全天 ${fmtCny(yFull)}` : ''}`);
    }

    // 本周累计（北京 ISO 周，周一起）
    const wn = new Date(Date.now() + 8 * 3600e3);
    wn.setUTCDate(wn.getUTCDate() - (wn.getUTCDay() + 6) % 7);
    const wkStart = wn.toISOString().slice(0, 10);
    let weekSpent = 0;
    for (const [d, tools] of Object.entries(agg.daily)) {
      if (d >= wkStart && tools.__total) weekSpent += cnyOf(tools.__total);
    }
    lines.push(`本周累计（周一起）: ${fmtCny(weekSpent)}`);

    // 当日目标成本进度
    const goal = (plans.dailyGoal || {}).cny;
    if (goal > 0) {
      const spent = cnyOf(t && t.__total || {});
      const pct = spent / goal * 100;
      const tier = pct >= 150 ? '🚨 已大幅超出，记得收敛或上调目标' : pct >= 100 ? '💸 目标成本已用完，再跑要超支'
        : pct >= 75 ? '⚠️ 预算将尽，要紧的优先' : pct >= 50 ? '🌀 已用过半，留意节奏' : pct >= 25 ? '✨ 消耗平稳，余量尚多' : '💭 预算充裕，安心干活';
      lines.push('');
      lines.push(`🎯 当日目标成本: ${fmtCny(spent)} / ¥${goal}（${pct.toFixed(0)}%）· ${tier}`);
    }
    return { text: lines.join('\n') };
  }

  if (name === 'ai_usage_tool') {
    const tool = String(args.tool);
    if (!TOOL_NAMES[tool]) throw new Error(`未知工具 ${tool}，可选：${Object.keys(TOOL_NAMES).join('/')}`);
    const days = Math.min(Number(args.days) || 7, 365);
    const cutoff = bjDay(Date.now() - days * 86400e3);
    const lines = [`【${TOOL_NAMES[tool]}】近 ${days} 天每日明细：`];
    for (const [d, tools] of Object.entries(agg.daily)) {
      if (d < cutoff) continue;
      const a = tools[tool];
      if (!a) continue;
      lines.push(`  ${d}: ${fmtInt(a.requests)} 次, in ${fmtTok(a.inputTokens)} / out ${fmtTok(a.outputTokens)}, ${fmtCny(cnyOf(a))}`);
    }
    const ms = agg.models[tool] || {};
    lines.push('\n模型分布（全部范围）:');
    for (const [m, v] of Object.entries(ms).sort((a, b) => (cnyOf(b[1]) - cnyOf(a[1])))) {
      lines.push(`  ${m}: ${fmtInt(v.requests)} 次, ${fmtCny(cnyOf(v))}${v.costUsd > 0 ? `（$${v.costUsd.toFixed(2)}）` : ''}${v.noPrice ? ' [无单价]' : ''}`);
    }
    return { text: lines.join('\n') };
  }

  if (name === 'ai_usage_models') {
    const lines = ['模型维度用量与费用（全部范围）:'];
    for (const [tool, ms] of Object.entries(agg.models)) {
      lines.push(`\n【${TOOL_NAMES[tool] || tool}】`);
      for (const [m, v] of Object.entries(ms).sort((a, b) => cnyOf(b[1]) - cnyOf(a[1]))) {
        lines.push(`  ${m}: ${fmtInt(v.requests)} 次, in ${fmtTok(v.inputTokens)} / out ${fmtTok(v.outputTokens)}, ${fmtCny(cnyOf(v))}${v.costUsd > 0 ? `（$${v.costUsd.toFixed(2)}）` : ''}${v.noPrice ? ' [无单价]' : ''}`);
      }
    }
    return { text: lines.join('\n') };
  }

  if (name === 'ai_quota_windows') {
    const q = await getQuotas();
    const lines = ['套餐实时额度：'];
    const fmtReset = ms => {
      if (!ms) return '';
      const h = Math.floor(ms / 3600e3), m = Math.floor(ms % 3600e3 / 60e3);
      return `（${h}h${m}m 后重置）`;
    };
    const block = (title, note, qd) => {
      if (qd && qd.available) {
        lines.push(`\n【${qd.provider || title}】${note}`);
        const w = (label, win) => win && win.usedPercent != null
          ? `${label} 窗口: 已用 ${win.usedPercent}% / 剩 ${win.remainingPercent}% ${fmtReset(win.resetMsLeft)}`
          : `${label} 窗口: 不可用`;
        lines.push('  ' + w('5h', qd.fiveHour));
        lines.push('  ' + w('周', qd.weekly));
      } else {
        lines.push(`\n【${title}】${note}`);
        lines.push(`  实时额度不可用: ${(qd && qd.reason) || '未知原因'}`);
      }
    };
    block('ChatGPT Plus', 'Codex · GPT 系列', q.chatgpt);
    block('MiniMax Token Plan MAX', 'WorkBuddy / Codex 第三方', q.minimax);
    block('智谱 Coding Plan 团队版', 'ZCode / Claude Code / WorkBuddy' + (q.zhipu && q.zhipu.team ? ` · ${q.zhipu.team.organizationName}` : ''), q.zhipu);

    // 智谱：另附等价月进度
    const zp = plans.plans.zcode || {};
    if (zp.cnyPerMonth) {
      let used = 0;
      const mon = bjDay(Date.now()).slice(0, 7);
      for (const [d, tools] of Object.entries(agg.daily)) {
        if (!d.startsWith(mon)) continue;
        if (tools.zcode) used += cnyOf(tools.zcode);
        if (tools.claudeCode) used += cnyOf(tools.claudeCode);
      }
      lines.push(`  本月等价用量: ${fmtCny(used)} / 套餐 ¥${zp.cnyPerMonth}（${(used / zp.cnyPerMonth * 100).toFixed(1)}%）· 等价成本口径`);
    }
    return { text: lines.join('\n') };
  }

  throw new Error('unknown tool: ' + name);
}

// ---------- MCP stdio 协议 ----------
async function handleRpc(msg) {
  const { id, method, params } = msg;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') {
      return ok({
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ai-quota-dashboard', version: VERSION },
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TOOLS_DEF });
    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const r = await callTool(name, args);
      return ok({ content: [{ type: 'text', text: r.text }] });
    }
    return err(-32601, 'method not found: ' + method);
  } catch (e) {
    if (id == null) return null;
    return err(-32000, e.message);
  }
}

function main() {
  // CLI 模式：node mcp.js [summary|today|quota|models|tool:zcode:7] [days]
  const arg = process.argv[2];
  if (arg) {
    const daysArg = Number(process.argv[3]); // summary/models 支持天数参数
    const map = { summary: 'ai_usage_summary', today: 'ai_usage_today', models: 'ai_usage_models', quota: 'ai_quota_windows' };
    let name = map[arg], a = {};
    if (!name && arg.startsWith('tool:')) {
      const [tool, days] = arg.slice(5).split(':');
      name = 'ai_usage_tool'; a = { tool, days: days ? Number(days) : 7 };
    } else if (name && Number.isFinite(daysArg) && daysArg > 0) {
      a = { days: daysArg };
    }
    if (!name) { console.error('用法: node mcp.js [summary|today|quota|models|tool:zcode:7] [days]'); process.exit(1); }
    callTool(name, a).then(r => { console.log(r.text); process.exit(0); }, e => { console.error(e.message); process.exit(1); });
    return;
  }
  // stdio MCP 模式（单行上限 1MB，超长输入直接丢弃，防内存被打爆）
  const MAX_LINE = 1024 * 1024;
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    if (buf.length > MAX_LINE && !buf.includes('\n')) { buf = ''; return; } // 无换行的超长输入：整段丢弃
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      if (line.length > MAX_LINE) continue; // 超长行忽略
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handleRpc(msg).then(out => {
        if (out) process.stdout.write(JSON.stringify(out) + '\n');
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

main();
