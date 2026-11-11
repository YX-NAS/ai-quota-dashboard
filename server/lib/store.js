'use strict';
// 聚合存储：采集 → 归一 → 日/月汇总 → 缓存
const { monthForecast } = require('./forecast');
const { vendorForRow, vendorOf } = require('./pricing');
// 北京时间工具为单一事实源（server/lib/bjtime.js）；这里 re-export 保持
// `require('../server/lib/store')` 上的 bjDate/bjMonth 兼容（既有消费方/测试从 store 引）
const { bjDate, bjMonth } = require('./bjtime');

// 历史扫描下界：默认回看 365 天（日聚合 / 本月统计 / 90 天明细都在此范围内），
// 全历史的 models 表接受此截断；需要更久可设环境变量 AI_QUOTA_MAX_DAYS 覆盖
function maxDays() {
  const n = Number(process.env.AI_QUOTA_MAX_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 365;
}
function historyCutoffMs(now = Date.now()) {
  return now - maxDays() * 86400e3;
}

// —— 四聚合（vendor/api/model/project）内部共用的小工具（去重：行为与拆分前逐字段一致）——

// 两种费用口径（显式化，聚合按需选用）：
// - merge 口径（vendor / api）：只认人民币。p.cny != null → costCny；否则 noPriceRequests。
//   实扣行（costUsd）经 pricer.price 折算后同样是 p.cny，无需再拆分。
// - split 口径（model / project）：实扣与等价分列。p.usd != null → costCny（实扣）；
//   仅 p.cny != null（单价表等价计价）→ equivalentCny；无价 → noPriceRequests。
const costMerge = (a, r, p) => { if (p.cny != null) a.costCny += p.cny; else a.noPriceRequests++; };
const costSplit = (a, r, p) => {
  if (p.usd != null) a.costCny += p.cny;
  else if (p.cny != null) a.equivalentCny += p.cny;
  else a.noPriceRequests++;
};

// 请求计数 + token 累计（费用归属由 classify = costMerge | costSplit 决定）
const tally = (a, r, p, classify) => {
  a.requests++;
  a.inputTokens += r.inputTokens;
  a.outputTokens += r.outputTokens;
  classify(a, r, p);
};

// 桶内模型子桶（api / project 用）：models[model] 缺则建（形状由 newBucket 决定，
// 各聚合保持原快照形状——api 子桶无 equivalentCny，project 子桶有），逐字段累加
const tallyModels = (models, r, p, classify, newBucket) => {
  const m = (models[r.model] ||= newBucket());
  m.requests++;
  m.inputTokens += r.inputTokens;
  m.outputTokens += r.outputTokens;
  classify(m, r, p);
};

// 统一「今日/本月」双窗口判定：行只入命中的窗口（窗口外不建桶，避免出现全 0 桶）。
// windows = ['today','month']；cb(row, hit) 仅对至少命中一个窗口的行回调，
// hit 为命中的窗口名数组（vendor / api / model 三聚合同构消费）
const forEachWindow = (rows, now, windows, cb) => {
  const todayKey = bjDate(now), monKey = bjMonth(now);
  for (const r of rows) {
    const d = bjDate(r.ts), mon = bjMonth(r.ts);
    const hit = [];
    if (windows.includes('today') && d === todayKey) hit.push('today');
    if (windows.includes('month') && mon === monKey) hit.push('month');
    if (!hit.length) continue; // 窗口外行不建桶
    cb(r, hit);
  }
};

function aggregate(rows, pricer) {
  const daily = {};    // date -> { [tool]: agg, __total: agg }
  // monthly 当前无对外消费方（/api/summary 只出 daily，归档合并也不覆盖 monthly），
  // 为兼容 v1.x 快照形状保留；需要消费时注意它的口径与 daily 相同（全窗口行都进）
  const monthly = {};  // month -> { [tool]: agg, __total: agg }
  const models = {};   // tool -> model -> agg（不混入日/月桶）

  const newAgg = () => ({
    requests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, costCny: 0, equivalentCny: 0,
  });
  const touch = (obj, k) => (obj[k] ||= newAgg());

  // 订阅/实扣拆分桶：row.subscription===true 的 costUsd 记入 subUsd（套餐等价），
  // 否则记入 payUsd（真实按量）。仅 Codex 目前有此区分。
  // 行级归一契约：rows.outputTokens 已含思考 token（采集器负责折叠），
  // reasoningTokens 仅作其中的思考占比明细——聚合时不得再加一遍，否则双计
  const applyCost = (a, r, p) => {
    a.requests++;
    a.inputTokens += r.inputTokens;
    a.outputTokens += r.outputTokens;
    a.reasoningTokens += r.reasoningTokens || 0;
    a.cacheReadTokens += r.cacheReadTokens;
    a.cacheCreationTokens += r.cacheCreationTokens || 0; // 计价金额已含进 costCny，token 字段供展示/对账
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
    } else {
      // 无单价行：不计钱但请求仍归套餐/按量桶（否则 Codex 全月 noPrice 时「Plus 套餐 0 次」误导）
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
      dmK.outputTokens += r.outputTokens;
      dmK.cacheReadTokens += r.cacheReadTokens;
      dmK.cacheCreationTokens += r.cacheCreationTokens || 0; // 归档 daily_model 需要它做成本重估
      if (p.usd != null) { dmK.costUsd += p.usd; dmK.costCny += p.cny; if (r.subscription) dmK.subscription = true; }
      else if (p.cny != null) { dmK.equivalentCny += p.cny; if (r.subscription) dmK.subscription = true; }
      else dmK.noPrice = true;
    }

    const m0 = (models[r.tool] ||= {});
    const m = touch(m0, r.model);
    m.requests++;
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
    m.cacheReadTokens += r.cacheReadTokens;
    m.cacheCreationTokens += r.cacheCreationTokens || 0;
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
      outputTokens: rows.reduce((s, r) => s + r.outputTokens, 0),
    },
  };
}

// API 按量计费：按服务商聚合今日/本月用量与费用。
// 归因走 vendorForRow（provider_id 优先、模型名回退）——订阅制 provider 的行返回 null 不计，
// 保证「按量费用」只含真实扣费线路。独立于 aggregate()/历史归档 —— agg 结构不动。
// 无单价的行也计 requests/tokens（noPriceRequests 单列），只有费用不计——否则未录价模型
// （如新上的 kimi-k3.1-pro）会从用量桶里整行消失，卡片显示「0 次」误导。
// 费用口径：merge（人民币单列 costCny，见顶部 costMerge 注释）。
function vendorAggregate(rows, pricer, now = Date.now()) {
  const out = {};
  const touch = v => (out[v] ||= {
    today: { requests: 0, inputTokens: 0, outputTokens: 0, costCny: 0, noPriceRequests: 0 },
    month: { requests: 0, inputTokens: 0, outputTokens: 0, costCny: 0, noPriceRequests: 0 },
  });
  forEachWindow(rows, now, ['today', 'month'], (r, hit) => {
    const v = vendorForRow(r);
    if (!v) return; // 订阅 provider 的行不计
    const b = touch(v);
    const p = pricer.price(r);
    for (const w of hit) tally(b[w], r, p, costMerge);
  });
  return out;
}

// API 维度聚合：比 vendorAggregate 细一层 —— 每把 API（ZCode provider_id）单独一桶，
// 桶内再按调用模型拆明细（models[model]），供「API 维度费用」表逐 Key × 逐模型展示费用。
// 无 provider 标记的行（cc-switch / Claude Code 等只能按模型名归因）落「model:服务商」来源桶，
// 保证 每服务商各桶合计 == vendorAggregate 同口径数字（对账一致）。
// 订阅 provider（account:* / coding-plan 等）vendorForRow 返回 null，与按量口径一致地剔除。
// 费用口径：merge（与 vendorAggregate 对账必须同口径，见顶部 costMerge 注释）。
function apiAggregate(rows, pricer, now = Date.now()) {
  const out = {};
  const newModel = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, costCny: 0, noPriceRequests: 0 });
  const newBucket = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, costCny: 0, noPriceRequests: 0, models: {} });
  const touch = k => (out[k] ||= { vendor: null, today: newBucket(), month: newBucket() });
  forEachWindow(rows, now, ['today', 'month'], (r, hit) => {
    const v = vendorForRow(r);
    if (!v) return; // 订阅 provider 的行不计
    // 有 provider 标记 = 精确到该把 API；否则按模型归因到服务商级来源桶
    const key = String(r.providerId || '').trim() || 'model:' + v;
    const b = touch(key);
    b.vendor = v;
    const p = pricer.price(r);
    for (const w of hit) {
      const a = b[w];
      tally(a, r, p, costMerge);
      tallyModels(a.models, r, p, costMerge, newModel);
    }
  });
  return out;
}

// 当日模型排行聚合：跨工具按模型归集今日/本月用量与费用（独立于 agg.models 的工具×模型全历史，
// 本聚合只有今日/本月两窗口，供「今日模型排行」卡直接渲染）。
// 订阅工具的等价成本一并计入——排行看的是「用量」；真实扣费/等价分列 costCny/equivalentCny，
// 前端合计展示，与全局口径（costCny + equivalentCny）一致。
// 无单价的行照常计 requests/tokens，noPriceRequests 单列（同 vendorAggregate 教训：整行丢弃会显示 0 次）。
// 费用口径：split（实扣/等价分列，见顶部 costSplit 注释）。
function modelAggregate(rows, pricer, now = Date.now()) {
  const out = {};
  const newBucket = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, costCny: 0, equivalentCny: 0, noPriceRequests: 0 });
  forEachWindow(rows, now, ['today', 'month'], (r, hit) => {
    const b = (out[r.model] ||= { vendor: vendorOf(r.model), today: newBucket(), month: newBucket() });
    const p = pricer.price(r);
    for (const w of hit) tally(b[w], r, p, costSplit);
  });
  return out;
}

// 项目维度聚合：今日占比/费用 + 全窗口累计总量（「项目使用总量」）。
// 归因键 r.project：ZCode = 会话表 project_id（精确）；Claude Code = 会话 cwd（近似）。
// 无项目标记的行（cc-switch / WorkBuddy 无项目概念）不建桶——混入会把「项目占比」稀释失真。
// label 用采集器给的展示名（目录 basename），聚合键不直接展示（title 里留原始键）。
// 窗口结构与上面三个聚合不同（today + 全窗口 total，无 month），不套 forEachWindow；
// 费用口径：split（实扣/等价分列，见顶部 costSplit 注释）。
function projectAggregate(rows, pricer, now = Date.now()) {
  const todayKey = bjDate(now);
  const out = {};
  const newModel = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, costCny: 0, equivalentCny: 0, noPriceRequests: 0 });
  const newBucket = () => ({ requests: 0, inputTokens: 0, outputTokens: 0, costCny: 0, equivalentCny: 0, noPriceRequests: 0, models: {} });
  const add = (b, r, p) => {
    tally(b, r, p, costSplit);
    tallyModels(b.models, r, p, costSplit, newModel);
  };
  for (const r of rows) {
    const key = String(r.project || '').trim();
    if (!key) continue;
    const b = (out[key] ||= { label: r.projectLabel || key, today: newBucket(), total: newBucket() });
    if (b.label === key && r.projectLabel) b.label = r.projectLabel; // 首行缺 label 时由后续行补
    const p = pricer.price(r);
    add(b.total, r, p);
    if (bjDate(r.ts) === todayKey) add(b.today, r, p);
  }
  return out;
}

// 月底线性预估：委托 lib/forecast.js（v1.8 起口径唯一实现，分母为日历天而非有数据的天数）。
// 保留此导出仅供单测与后续「月度预估」卡片使用；前端走快照里的 snap.forecast。
// 修正点：工具当天无数据时不再回退到 __total（那会把别的工具的钱算进本工具预估）。
function monthlyForecast(daily, tool, now = Date.now()) {
  const mon = bjMonth(now);
  const dailyKeys = Object.keys(daily).sort();
  let spent = 0;
  for (const d of dailyKeys) {
    if (!d.startsWith(mon)) continue;
    const a = (daily[d] || {})[tool];
    if (a) spent += (a.costCny || 0) + (a.equivalentCny || 0);
  }
  const f = monthForecast({ dailyKeys, spendCny: spent, now });
  return {
    forecastCny: f.ok ? f.projectedCny : 0,
    daysInMonth: f.daysInMonth,
    elapsed: f.elapsedDays,
    ok: f.ok,
    spendCny: spent,
  };
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
      const tokens = r.inputTokens + r.outputTokens;
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

module.exports = { aggregate, vendorAggregate, apiAggregate, modelAggregate, projectAggregate, monthlyForecast, compareYesterday, bjDate, bjMonth, maxDays, historyCutoffMs };
