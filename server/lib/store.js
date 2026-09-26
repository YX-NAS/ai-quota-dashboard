'use strict';
// 聚合存储：采集 → 归一 → 日/月汇总 → 缓存
const bjDate = ts => {
  // 北京时间日期串 YYYY-MM-DD
  const d = new Date(ts + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};
const bjMonth = ts => bjDate(ts).slice(0, 7);

// 历史扫描下界：默认回看 365 天（日聚合 / 本月统计 / 90 天明细都在此范围内），
// 全历史的 models 表接受此截断；需要更久可设环境变量 AI_QUOTA_MAX_DAYS 覆盖
function maxDays() {
  const n = Number(process.env.AI_QUOTA_MAX_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 365;
}
function historyCutoffMs(now = Date.now()) {
  return now - maxDays() * 86400e3;
}

function aggregate(rows, pricer) {
  const daily = {};    // date -> { [tool]: agg, __total: agg }
  const monthly = {};  // month -> { [tool]: agg, __total: agg }
  const models = {};   // tool -> model -> agg（不混入日/月桶）

  const newAgg = () => ({
    requests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheReadTokens: 0, costUsd: 0, costCny: 0, equivalentCny: 0,
  });
  const touch = (obj, k) => (obj[k] ||= newAgg());

  // 订阅/实扣拆分桶：row.subscription===true 的 costUsd 记入 subUsd（套餐等价），
  // 否则记入 payUsd（真实按量）。仅 Codex 目前有此区分。
  const applyCost = (a, r, p) => {
    a.requests++;
    a.inputTokens += r.inputTokens;
    a.outputTokens += r.outputTokens + (r.reasoningTokens || 0);
    a.reasoningTokens += r.reasoningTokens || 0;
    a.cacheReadTokens += r.cacheReadTokens;
    a.subRequests = a.subRequests || 0;
    a.payRequests = a.payRequests || 0;
    a.subUsd = a.subUsd || 0;
    a.payUsd = a.payUsd || 0;
    if (p.usd != null) {
      a.costUsd += p.usd;
      a.costCny += p.cny;
      if (r.subscription) { a.subUsd += p.usd; a.subRequests++; }
      else { a.payUsd += p.usd; a.payRequests++; }
    } else if (p.cny != null) {
      a.equivalentCny += p.cny;
      if (r.subscription) a.subRequests++;
      else a.payRequests++;
    }
  };

  for (const r of rows) {
    pricer.classifyRow(r);
    const p = pricer.price(r);
    const day = bjDate(r.ts), mon = bjMonth(r.ts);

    for (const [bucket, key] of [[daily, day], [monthly, mon]]) {
      const t = touch(bucket, key);
      const a = touch(t, r.tool);
      const tot = touch(t, '__total');
      for (const aggObj of [a, tot]) applyCost(aggObj, r, p);
      // 模型维度也进日/月桶（同天/同月内可按模型对比）
      // 注意：容器必须是纯对象，不能带数值字段，否则字段名会被当成模型 key
      const dm = (a.models ||= {});
      const dmK = touch(dm, r.model);
      dmK.requests++;
      dmK.inputTokens += r.inputTokens;
      dmK.outputTokens += r.outputTokens + (r.reasoningTokens || 0);
      dmK.cacheReadTokens += r.cacheReadTokens;
      if (p.usd != null) { dmK.costUsd += p.usd; dmK.costCny += p.cny; if (r.subscription) dmK.subscription = true; }
      else if (p.cny != null) { dmK.equivalentCny += p.cny; if (r.subscription) dmK.subscription = true; }
      else dmK.noPrice = true;
    }

    const m0 = (models[r.tool] ||= {});
    const m = touch(m0, r.model);
    m.requests++;
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens + (r.reasoningTokens || 0);
    m.cacheReadTokens += r.cacheReadTokens;
    if (p.usd != null) { m.costUsd += p.usd; m.costCny += p.cny; if (r.subscription) m.subscription = true; }
    else if (p.cny != null) { m.equivalentCny += p.cny; if (r.subscription) m.subscription = true; }
    else m.noPrice = true;
  }

  // 排序 keys
  const sortKeys = o => Object.keys(o).sort();
  return {
    dailyKeys: sortKeys(daily),
    monthlyKeys: sortKeys(monthly),
    daily, monthly, models,
    total: {
      requests: rows.length,
      inputTokens: rows.reduce((s, r) => s + r.inputTokens, 0),
      outputTokens: rows.reduce((s, r) => s + r.outputTokens + (r.reasoningTokens || 0), 0),
    },
  };
}

// 月底线性预估：本月已用等价成本 / 已过天数 * 当月天数
function monthlyForecast(daily, tool, now = Date.now()) {
  const mon = bjMonth(now);
  const daysInMonth = new Date(Date.UTC(
    Number(mon.slice(0, 4)), Number(mon.slice(5, 7)), 0)).getUTCDate();
  let spent = 0, elapsed = 0;
  for (const [date, tools] of Object.entries(daily)) {
    if (!date.startsWith(mon)) continue;
    elapsed++;
    const a = tools[tool] || tools.__total;
    if (a) spent += a.costCny + a.equivalentCny;
  }
  if (!elapsed) return { forecastCny: 0, daysInMonth, elapsed };
  return { forecastCny: spent / elapsed * daysInMonth, daysInMonth, elapsed, spentCny: spent };
}

// 昨日对比：昨日同期（昨天北京时间 0 点 ~ 昨天此刻）与昨日全天，按工具分桶
function compareYesterday(rows, pricer, now = Date.now()) {
  const BJ = 8 * 3600e3;
  const bjElapsed = (now + BJ) % 86400e3;          // 今日（=昨日）已过毫秒
  const yStart = now - bjElapsed - 86400e3;         // 昨日北京 0 点
  const ySameEnd = yStart + bjElapsed;              // 昨日此刻
  const yDayEnd = yStart + 86400e3;                 // 昨日 24 点

  const bucket = (from, to) => {
    const total = { requests: 0, tokens: 0, cny: 0 };
    const tools = {};
    for (const r of rows) {
      if (r.ts < from || r.ts >= to) continue;
      const p = pricer.price(r);
      const cny = p.cny || 0;
      const tokens = r.inputTokens + r.outputTokens + (r.reasoningTokens || 0);
      total.requests++;
      total.tokens += tokens;
      total.cny += cny;
      const t = (tools[r.tool] ||= { requests: 0, tokens: 0, cny: 0 });
      t.requests++; t.tokens += tokens; t.cny += cny;
    }
    return { total, tools };
  };

  return { yesterdaySameTime: bucket(yStart, ySameEnd), yesterdayFull: bucket(yStart, yDayEnd) };
}

module.exports = { aggregate, monthlyForecast, compareYesterday, bjDate, bjMonth, maxDays, historyCutoffMs };
