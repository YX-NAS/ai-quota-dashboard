'use strict';
// 周/月报生成器（纯函数）：从聚合快照 agg 中切出目标周期，汇总出
// 总览 / 工具榜 / 模型榜 Top5 / 最贵的一天 / 预算达成率，渲染成 Markdown。
// 不落盘、不读库、不改入参；周期口径全部按北京时间。
//   周口径：ISO 周（周一 0 点起）；
//   月口径：北京自然月；
//   成本口径：daily[date][tool] 的 costCny + equivalentCny（F1 归档合并后 daily 已含历史日）。

const BJ = 8 * 3600e3; // 北京时区偏移

// 工具展示名（与 mcp.js / web 前端保持一致）
const TOOL_LABELS = {
  codex: 'ChatGPT·Codex',
  claudeDesktop: 'Claude Desktop',
  claudeCode: 'Claude Code',
  zcode: 'ZCode',
  workbuddy: 'WorkBuddy',
};

// ---------- 周期计算（北京日期串 YYYY-MM-DD 平面日历，按 UTC 运算） ----------

// 北京时间某时刻所在 ISO 周的周一（日期串）。UTC+8 平移后 (getUTCDay()+6)%7 即距周一的天数。
function weekStart(now = Date.now()) {
  const n = new Date(now + BJ);
  n.setUTCDate(n.getUTCDate() - (n.getUTCDay() + 6) % 7);
  return n.toISOString().slice(0, 10);
}

function bjToday(now = Date.now()) { return new Date(now + BJ).toISOString().slice(0, 10); }
function bjMonthOf(now = Date.now()) { return bjToday(now).slice(0, 7); }

// 日期串加减天数（不涉时区，纯字符串日历）
function addDays(dateStr, n) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
}
// 月份串（YYYY-MM）加减月数
function addMonths(ym, n) {
  const total = +ym.slice(0, 4) * 12 + (+ym.slice(5, 7) - 1) + n;
  return Math.floor(total / 12) + '-' + String(total % 12 + 1).padStart(2, '0');
}
// 某月天数（ym 所指月份）
function daysInMonth(ym) {
  return new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
}

// 周期区间（北京日期串，闭区间）：week = 周一起 7 天；month = 自然月
function periodRange(type, offset, now) {
  if (type === 'month') {
    const ym = addMonths(bjMonthOf(now), -offset);
    return { start: ym + '-01', end: ym + '-' + String(daysInMonth(ym)).padStart(2, '0') };
  }
  const start = addDays(weekStart(now), -7 * offset);
  return { start, end: addDays(start, 6) };
}
// 上一期区间（环比参照）
function prevRangeOf(type, range) {
  if (type === 'month') {
    const ym = addMonths(range.start.slice(0, 7), -1);
    return { start: ym + '-01', end: ym + '-' + String(daysInMonth(ym)).padStart(2, '0') };
  }
  return { start: addDays(range.start, -7), end: addDays(range.start, -1) };
}

// ---------- 数据切分 ----------

// 汇总一段日期区间（闭区间）：总量 / 按工具 / 按模型 / 逐日成本
function collect(agg, start, end) {
  const out = { requests: 0, tokens: 0, cny: 0, tools: {}, models: [], days: {} };
  const daily = (agg && agg.daily) || {};
  for (const [date, tools] of Object.entries(daily)) {
    if (date < start || date > end) continue;
    let dayCny = 0;
    for (const [tool, a] of Object.entries(tools || {})) {
      if (tool === '__total' || !a || typeof a !== 'object') continue;
      const cost = (a.costCny || 0) + (a.equivalentCny || 0);
      const tk = (a.inputTokens || 0) + (a.outputTokens || 0);
      out.requests += a.requests || 0;
      out.tokens += tk;
      out.cny += cost;
      dayCny += cost;
      const t = (out.tools[tool] ||= { requests: 0, tokens: 0, cny: 0 });
      t.requests += a.requests || 0;
      t.tokens += tk;
      t.cny += cost;
      // 模型维度：日桶的 a.models 里逐日累加，最后按 (tool,model) 去重合并
      for (const [model, mv] of Object.entries(a.models || {})) {
        out.models.push({ tool, model, requests: mv.requests || 0, cny: (mv.costCny || 0) + (mv.equivalentCny || 0) });
      }
    }
    out.days[date] = dayCny;
  }
  const merged = {};
  for (const m of out.models) {
    const k = m.tool + '|' + m.model;
    const t = (merged[k] ||= { tool: m.tool, model: m.model, requests: 0, cny: 0 });
    t.requests += m.requests;
    t.cny += m.cny;
  }
  out.models = Object.values(merged).sort((x, y) => y.cny - x.cny || y.requests - x.requests);
  return out;
}

// 周期内「已过天数」：本期（含今天）按今天截断，已完结周期取整期长度
function elapsedDays(type, range, now) {
  const len = type === 'week' ? 7 : daysInMonth(range.start.slice(0, 7));
  const today = bjToday(now);
  if (today > range.end) return len;
  if (today < range.start) return 1; // 防御：未来周期按 1 天计
  return Math.min(len, Math.round((Date.parse(today) - Date.parse(range.start)) / 86400e3) + 1);
}

// ---------- 格式化（与 mcp.js 的口径一致） ----------

function fmtInt(n) { return (n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 }); }
function fmtCny(n) { return '¥' + (n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 }); }
function fmtTok(n) {
  return n >= 1e8 ? (n / 1e8).toFixed(2) + '亿' : n >= 1e4 ? (n / 1e4).toFixed(1) + '万' : fmtInt(n);
}
// 环比展示：上期无记录 → 「上期无数据」；上期有记录但基数为 0 → 「—」（涨跌幅无意义）
function fmtDelta(curV, prevV, prevRecorded) {
  if (!prevRecorded) return '上期无数据';
  if (!(prevV > 0)) return '—';
  const d = (curV - prevV) / prevV * 100;
  return (d >= 0 ? '↑' : '↓') + Math.abs(d).toFixed(0) + '%';
}

// ---------- 主入口 ----------

// buildReport(agg, plans, opts, now) → { title, markdown, data }
// opts = { type: 'week'|'month', offset: 0 }（offset=0 本期，1 上一期…）
function buildReport(agg, plans, opts, now = Date.now()) {
  const type = opts && opts.type === 'month' ? 'month' : 'week';
  const offset = Math.max(0, Math.min(type === 'month' ? 120 : 520, Math.floor(Number(opts && opts.offset) || 0)));
  const range = periodRange(type, offset, now);
  const prevRange = prevRangeOf(type, range);
  const cur = collect(agg, range.start, range.end);
  const prev = collect(agg, prevRange.start, prevRange.end);
  const prevHasData = prev.requests > 0;
  const hasData = cur.requests > 0 || cur.cny > 0;

  const title = `AI 用量${type === 'week' ? '周报' : '月报'} · ${range.start} ~ ${range.end}`;
  const genAt = new Date(now + BJ).toISOString().slice(0, 16).replace('T', ' ');

  // ---- 预算：当日目标 + 工具月额度（周报里月额度按 7/30 折算成周预算再比） ----
  const goal = plans && plans.dailyGoal ? Number(plans.dailyGoal.cny) || 0 : 0;
  const quotas = [];
  const planCfg = (plans && plans.plans) || {};
  for (const [tool, label] of Object.entries(TOOL_LABELS)) {
    const limit = planCfg[tool] ? Number(planCfg[tool].cnyPerMonth) || 0 : 0;
    if (limit > 0) quotas.push({ tool, label, limit, spent: (cur.tools[tool] || {}).cny || 0 });
  }
  const el = elapsedDays(type, range, now);
  const periodLen = type === 'week' ? 7 : daysInMonth(range.start.slice(0, 7));

  // ---- 最贵的一天 ----
  let topDay = null;
  for (const [d, c] of Object.entries(cur.days)) {
    if (c > 0 && (!topDay || c > topDay.cny)) topDay = { date: d, cny: c };
  }

  // ---- Markdown 组装（七节：标题/总览/工具榜/模型榜/最贵的一天/预算达成率/口径脚注） ----
  const L = [];
  L.push(`# ${title}`, '', `> 生成于 ${genAt}（北京时间）`, '');

  L.push('## 总览', '');
  if (!hasData) {
    L.push('- 本期暂无数据', '');
  } else {
    L.push('| 指标 | 本期 | 环比上期 |', '| --- | --- | --- |',
      `| 总成本（等价口径） | ${fmtCny(cur.cny)} | ${fmtDelta(cur.cny, prev.cny, prevHasData)} |`,
      `| 请求数 | ${fmtInt(cur.requests)} | ${fmtDelta(cur.requests, prev.requests, prevHasData)} |`,
      `| token 总量 | ${fmtTok(cur.tokens)} | ${fmtDelta(cur.tokens, prev.tokens, prevHasData)} |`,
      '');

    // 工具榜：按成本降序，全部有记录的工具
    const toolRows = Object.entries(cur.tools).sort((a, b) => b[1].cny - a[1].cny || b[1].requests - a[1].requests);
    L.push('## 工具榜', '', '| 工具 | 请求 | 成本 | 环比 |', '| --- | --- | --- | --- |');
    for (const [tool, t] of toolRows) {
      const pt = prev.tools[tool];
      L.push(`| ${TOOL_LABELS[tool] || tool} | ${fmtInt(t.requests)} | ${fmtCny(t.cny)} | ${fmtDelta(t.cny, pt ? pt.cny : 0, !!pt)} |`);
    }
    L.push('');

    // 模型榜 Top 5
    L.push('## 模型榜 Top 5', '', '| 模型 | 工具 | 请求 | 成本 |', '| --- | --- | --- | --- |');
    for (const m of cur.models.slice(0, 5)) {
      L.push(`| ${m.model} | ${TOOL_LABELS[m.tool] || m.tool} | ${fmtInt(m.requests)} | ${fmtCny(m.cny)} |`);
    }
    L.push('');

    // 最贵的一天
    L.push('## 最贵的一天', '');
    if (topDay) {
      const share = cur.cny > 0 ? `（占本期 ${(topDay.cny / cur.cny * 100).toFixed(0)}%）` : '';
      L.push(`- **${topDay.date}** · ${fmtCny(topDay.cny)}${share}`, '');
    } else {
      L.push('- 本期无花费记录', '');
    }
  }

  // 预算达成率：配置了 dailyGoal 或任一工具 cnyPerMonth 才出
  if (goal > 0 || quotas.length) {
    L.push('## 预算达成率', '');
    if (goal > 0) {
      L.push(`- 日均成本 ${fmtCny(cur.cny / el)} / 当日目标 ${fmtCny(goal)}（${(cur.cny / el / goal * 100).toFixed(1)}%，按已过 ${el}/${periodLen} 天）`);
    }
    for (const q of quotas) {
      if (type === 'month') {
        L.push(`- ${q.label} ${fmtCny(q.spent)} / 月额度 ${fmtCny(q.limit)}（${(q.spent / q.limit * 100).toFixed(1)}%）`);
      } else {
        const wkBudget = q.limit / 30 * 7;
        L.push(`- ${q.label} 本期 ${fmtCny(q.spent)} / 月额度 ${fmtCny(q.limit)}（折合周预算 ${fmtCny(wkBudget)}，已用 ${(q.spent / wkBudget * 100).toFixed(1)}%）`);
      }
    }
    L.push('');
  }

  L.push('> 口径说明：订阅制工具与 GPT 系列成本为等价按量成本，非实际扣费；数据来自本机原始日志扫描 + 本地归档。');

  const pctOf = (c, p, recorded) => (recorded && p > 0 ? (c - p) / p * 100 : null);
  const toolRowsSorted = Object.entries(cur.tools).sort((a, b) => b[1].cny - a[1].cny || b[1].requests - a[1].requests);
  const data = {
    type, offset,
    start: range.start, end: range.end,
    prevStart: prevRange.start, prevEnd: prevRange.end,
    hasData, prevHasData,
    totals: {
      cny: cur.cny, requests: cur.requests, tokens: cur.tokens,
      prevCny: prev.cny, prevRequests: prev.requests, prevTokens: prev.tokens,
      cnyDeltaPct: pctOf(cur.cny, prev.cny, prevHasData),
      requestsDeltaPct: pctOf(cur.requests, prev.requests, prevHasData),
      tokensDeltaPct: pctOf(cur.tokens, prev.tokens, prevHasData),
    },
    tools: toolRowsSorted.map(([tool, t]) => ({
      tool, label: TOOL_LABELS[tool] || tool,
      requests: t.requests, cny: t.cny,
      prevCny: (prev.tools[tool] || {}).cny || 0,
      prevHasData: !!prev.tools[tool],
    })),
    models: cur.models.slice(0, 5).map(m => ({ tool: m.tool, label: TOOL_LABELS[m.tool] || m.tool, model: m.model, requests: m.requests, cny: m.cny })),
    topDay: topDay ? { date: topDay.date, cny: topDay.cny, sharePct: cur.cny > 0 ? topDay.cny / cur.cny * 100 : null } : null,
    budget: { dailyGoal: goal, elapsedDays: el, periodDays: periodLen, quotas },
  };

  return { title, markdown: L.join('\n'), data };
}

module.exports = { buildReport, weekStart };
