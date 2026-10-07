'use strict';
// 历史归档库：config/history.sqlite（node:sqlite，零依赖）
// 动机：各工具原始日志会滚动清理，raw 扫描窗口（AI_QUOTA_MAX_DAYS）外的历史永久丢失；
//      这里把每日聚合沉淀下来，构建快照时对窗口外日期补缺。
// 约束：只写本归档库，绝不碰任何工具原始库；打开/读写任何失败都不得让 buildSnapshot 失败
//      （index.js 兜底记入 collectorErrors.history）。
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const plansStore = require('./plans');

const DB_PATH = path.join(plansStore.CONFIG_DIR, 'history.sqlite');
const SCHEMA_VERSION = '1';

// 进程内单例连接：buildSnapshot 每 60s 调一次，反复开关连接只会白耗 IO
let db = null;

// AI_QUOTA_HISTORY=0：完全不打开也不写库，纯内存路径回归 v1.4 行为
const enabled = () => process.env.AI_QUOTA_HISTORY !== '0';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS daily (
  date TEXT NOT NULL, tool TEXT NOT NULL,
  requests INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
  cost_usd REAL, cost_cny REAL, equivalent_cny REAL,
  sub_usd REAL, pay_usd REAL, sub_requests INTEGER, pay_requests INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (date, tool)
);
CREATE TABLE IF NOT EXISTS daily_model (
  date TEXT NOT NULL, tool TEXT NOT NULL, model TEXT NOT NULL,
  requests INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
  cost_usd REAL, cost_cny REAL, equivalent_cny REAL, updated_at INTEGER,
  PRIMARY KEY (date, tool, model)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

// 建表幂等（CREATE IF NOT EXISTS），顺带登记 schema 版本
function ensureSchema(conn) {
  conn.exec(SCHEMA_SQL);
  conn.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO NOTHING`)
    .run(SCHEMA_VERSION);
}

function setJournalMode(conn, mode) {
  // 云同步盘（config 常驻网盘）上 WAL 可能撕裂或不被支持：设置后回读校验，没生效视为失败
  try {
    conn.exec(`PRAGMA journal_mode=${mode}`);
    const cur = conn.prepare('PRAGMA journal_mode').get();
    return String(cur && cur.journal_mode).toLowerCase() === mode.toLowerCase();
  } catch { return false; }
}

// 打开归档库：WAL 优先，失败降级 journal DELETE，再失败返回 null（调用方降级为纯内存）
function open(dbPath = DB_PATH) {
  if (!enabled()) return null;
  if (db) return db;
  let conn = null;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    conn = new DatabaseSync(dbPath);
    if (!setJournalMode(conn, 'wal')) {
      try { conn.close(); } catch { /* 关不掉也无所谓，下面重开 */ }
      conn = new DatabaseSync(dbPath);
      if (!setJournalMode(conn, 'delete')) throw new Error('journal_mode 不可用');
    }
    conn.exec('PRAGMA busy_timeout=3000');
    ensureSchema(conn);
    db = conn;
    return db;
  } catch {
    try { if (conn) conn.close(); } catch { /* 尽力关闭 */ }
    return null;
  }
}

// 关闭并复位单例（优雅停机 / 测试隔离用）；下次调用 open 会重新打开。
// 指纹缓存一并清空：重开后库里内容可能已被外部改变（或换了库文件），首轮回退为全量写。
function close() {
  if (db) { try { db.close(); } catch { /* 已关闭 */ } }
  db = null;
  fpCache.clear();
}

// —— 脏行指纹缓存（docs/plans/v1.5-PLAN.md 性能专项：每 60s 全量 UPSERT 开销 → 脏行指纹跳过）——
// 60s 一次的全量 UPSERT 里绝大多数行内容未变（历史日早已定型，稳态下只有「今天」在长）：
// 内存记录上次成功写入的 (date,tool[/model]) → 内容 hash，指纹命中的行直接跳过写入。
// 一致性边界：本轮指纹先暂存 staged 表，事务 COMMIT 成功后才并入 fpCache——写入失败
// （ROLLBACK）不更新指纹，该行下一轮仍视为脏，宁可重写不可漏写。
const fpCache = new Map(); // 'd|date|tool' / 'm|date|tool|model' → 内容 hash
const fpStats = { rows: 0, written: 0, skipped: 0 }; // 最近一次 sync 的行统计（观测 / 单测用）

// 字段拼接 hash：两路 32 位（djb2 + FNV-1a，Math.imul 保 32 位语义）拼成 64 位。
// 非密码学强度——只需区分「内容变了没有」，同 key 前后两次撞出同 hash 的概率 ~2^-64，可忽略。
function fpHash(str) {
  let h1 = 5381, h2 = 2166136261;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = (Math.imul(h1, 33) + c) | 0;
    h2 = Math.imul(h2 ^ c, 16777619) | 0;
  }
  return (h1 >>> 0).toString(36) + '.' + (h2 >>> 0).toString(36);
}

// 快照聚合结果落库：全部日期的 per-tool 行 + per-model 行，单事务 UPSERT（幂等，约 2~4k 行/次）。
// 内容指纹未变的行跳过（见 fpCache），全脏首写不受影响。
// 只存 per-tool / per-model 行，不存 __total——合并时重算，避免双算
function syncFromAgg(agg) {
  if (!enabled()) return false; // 显式关闭：静默直通，回归 v1.4 纯内存路径
  const conn = open();
  // 坏库等打开失败：抛给调用方记 collectorErrors.history（用户可见），绝不静默丢归档
  if (!conn) throw new Error('history.sqlite 打开失败');
  if (!agg || !agg.daily) return false;
  const now = Date.now();
  const upDaily = conn.prepare(`
    INSERT INTO daily (date, tool, requests, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_creation_tokens, cost_usd, cost_cny, equivalent_cny,
      sub_usd, pay_usd, sub_requests, pay_requests, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, tool) DO UPDATE SET
      requests=excluded.requests, input_tokens=excluded.input_tokens,
      output_tokens=excluded.output_tokens, reasoning_tokens=excluded.reasoning_tokens,
      cache_read_tokens=excluded.cache_read_tokens, cache_creation_tokens=excluded.cache_creation_tokens,
      cost_usd=excluded.cost_usd, cost_cny=excluded.cost_cny, equivalent_cny=excluded.equivalent_cny,
      sub_usd=excluded.sub_usd, pay_usd=excluded.pay_usd,
      sub_requests=excluded.sub_requests, pay_requests=excluded.pay_requests,
      updated_at=excluded.updated_at`);
  const upModel = conn.prepare(`
    INSERT INTO daily_model (date, tool, model, requests, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, cost_usd, cost_cny, equivalent_cny, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, tool, model) DO UPDATE SET
      requests=excluded.requests, input_tokens=excluded.input_tokens,
      output_tokens=excluded.output_tokens, cache_read_tokens=excluded.cache_read_tokens,
      cache_creation_tokens=excluded.cache_creation_tokens, cost_usd=excluded.cost_usd,
      cost_cny=excluded.cost_cny, equivalent_cny=excluded.equivalent_cny,
      updated_at=excluded.updated_at`);
  conn.exec('BEGIN');
  const staged = new Map(); // 本轮新指纹：COMMIT 成功后才并入 fpCache
  let rows = 0, written = 0, skipped = 0;
  try {
    for (const [date, tools] of Object.entries(agg.daily)) {
      for (const [tool, a] of Object.entries(tools)) {
        // 日期桶本身是 newAgg 形状（自带 requests/inputTokens… 数值字段）：非对象键不是工具
        if (tool === '__total' || !a || typeof a !== 'object') continue;
        rows++;
        // vals 与 upDaily 绑定参数同序（updated_at 除外——每轮都变，不参与指纹）
        const vals = [
          a.requests || 0, a.inputTokens || 0, a.outputTokens || 0, a.reasoningTokens || 0,
          a.cacheReadTokens || 0, a.cacheCreationTokens || 0,
          a.costUsd || 0, a.costCny || 0, a.equivalentCny || 0,
          a.subUsd || 0, a.payUsd || 0, a.subRequests || 0, a.payRequests || 0,
        ];
        const dk = 'd|' + date + '|' + tool;
        const dh = fpHash(vals.join('\u0001'));
        if (fpCache.get(dk) === dh) { skipped++; }
        else {
          upDaily.run(date, tool, ...vals, now);
          staged.set(dk, dh);
          written++;
        }
        for (const [model, m] of Object.entries(a.models || {})) {
          rows++;
          const mv = [
            m.requests || 0, m.inputTokens || 0, m.outputTokens || 0,
            m.cacheReadTokens || 0, m.cacheCreationTokens || 0,
            m.costUsd || 0, m.costCny || 0, m.equivalentCny || 0,
          ];
          const mk = 'm|' + date + '|' + tool + '|' + model;
          const mh = fpHash(mv.join('\u0001'));
          if (fpCache.get(mk) === mh) { skipped++; continue; }
          upModel.run(date, tool, model, ...mv, now);
          staged.set(mk, mh);
          written++;
        }
      }
    }
    conn.exec('COMMIT');
    for (const [k, h] of staged) fpCache.set(k, h);
    fpStats.rows = rows; fpStats.written = written; fpStats.skipped = skipped;
    return true;
  } catch (e) {
    try { conn.exec('ROLLBACK'); } catch { /* 已回滚或连接已坏 */ }
    try { conn.close(); } catch { /* 尽力关闭 */ }
    if (db === conn) db = null; // 连接可能已坏：丢弃单例，下次重开
    throw e;
  }
}

// 最近一次 syncFromAgg 的行统计：{ rows, written, skipped }（只读快照）
function syncStats() { return Object.assign({}, fpStats); }

// 按当前单价表重估一组 token 的等价成本（纯计算，不触碰归档值）
// 缺单价的模型金额记 0、保留 token，与 raw 口径一致（页面本就标注「无单价」）
function reprice(pricer, model, t) {
  const p = pricer.price({
    model,
    inputTokens: t.inputTokens || 0,
    outputTokens: t.outputTokens || 0,
    cacheReadTokens: t.cacheReadTokens || 0,
    cacheCreationTokens: t.cacheCreationTokens || 0,
    costUsd: null, // 强制走单价表；实扣行本就不该重估
  });
  return { cny: p.noPrice ? 0 : p.cny, noPrice: !!p.noPrice };
}

// daily_model 归档行 → 当日 per-model 桶（形状与 store.aggregate 的日桶 models 子对象对齐）
function archModelBucket(m, pricer) {
  const rp = reprice(pricer, m.model, {
    inputTokens: m.input_tokens, outputTokens: m.output_tokens,
    cacheReadTokens: m.cache_read_tokens, cacheCreationTokens: m.cache_creation_tokens,
  });
  const out = {
    requests: m.requests || 0,
    inputTokens: m.input_tokens || 0,
    outputTokens: m.output_tokens || 0, // 含 reasoning（daily_model 无独立 reasoning 列，重估时按输出价计）
    cacheReadTokens: m.cache_read_tokens || 0,
    cacheCreationTokens: m.cache_creation_tokens || 0,
    costUsd: m.cost_usd || 0,
    costCny: (m.cost_usd || 0) * pricer.fx, // 实扣保留归档原值，人民币按当前汇率折算，与 raw 口径一致
    equivalentCny: rp.cny,
  };
  if (rp.noPrice) out.noPrice = true;
  return out;
}

// daily 归档行 + 同日模型行 → 补缺的 per-tool 桶（形状与 store.aggregate 的 tool 桶对齐）
function archToolAgg(d, mRows, pricer) {
  const a = {
    requests: d.requests || 0,
    inputTokens: d.input_tokens || 0,
    outputTokens: d.output_tokens || 0,
    reasoningTokens: d.reasoning_tokens || 0,
    cacheReadTokens: d.cache_read_tokens || 0,
    cacheCreationTokens: d.cache_creation_tokens || 0,
    // cost_usd（实扣，Codex）与 sub_usd/pay_usd 不重估，保留归档时点值
    costUsd: d.cost_usd || 0,
    costCny: (d.cost_usd || 0) * pricer.fx,
    equivalentCny: 0, // 下面逐模型按当前单价重估后汇总
    subUsd: d.sub_usd || 0,
    payUsd: d.pay_usd || 0,
    subRequests: d.sub_requests || 0,
    payRequests: d.pay_requests || 0,
    models: {},
  };
  for (const m of mRows) {
    const b = archModelBucket(m, pricer);
    a.equivalentCny += b.equivalentCny;
    a.models[m.model] = b;
  }
  return a;
}

// __total 一律由合并后的 per-tool 行重算，禁止直接采信任何一边存下的 total（防双算）
const TOTAL_FIELDS = ['requests', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens',
  'cacheCreationTokens', 'costUsd', 'costCny', 'equivalentCny', 'subUsd', 'payUsd', 'subRequests', 'payRequests'];
function recomputeTotal(day) {
  const tot = {};
  for (const f of TOTAL_FIELDS) tot[f] = 0;
  for (const [k, a] of Object.entries(day)) {
    // 日期桶自带的数值字段（newAgg 形状）不是工具，跳过
    if (k === '__total' || !a || typeof a !== 'object') continue;
    for (const f of TOTAL_FIELDS) tot[f] += a[f] || 0;
  }
  day.__total = tot;
}

// daily_model 全历史聚合 → models 全历史桶补缺行（该桶无日期维度，形状对齐 store.aggregate 的 models）
function archFullModelBucket(model, s, pricer) {
  const rp = reprice(pricer, model, s);
  const out = {
    requests: s.requests,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    reasoningTokens: 0, // daily_model 无 reasoning 列，补缺行记 0
    cacheReadTokens: s.cacheReadTokens,
    cacheCreationTokens: s.cacheCreationTokens,
    costUsd: 0,
    costCny: 0,
    equivalentCny: rp.cny,
  };
  if (rp.noPrice) out.noPrice = true;
  return out;
}

// 归档补缺合并（纯函数，不改入参），口径：raw 优先、archive 只补缺：
// 1. 同 (date, tool) raw 存在 → 原样保留（原始扫描为准）；不存在 → 归档行补入；
// 2. 补缺行按当前 pricer 从 daily_model token 重估等价成本——归档存的是写入时点价，
//    直接混编会污染趋势与环比；实扣 cost_usd 与 sub_usd/pay_usd 不重估；
// 3. __total 由合并后的 per-tool 行重算；
// 4. models 全历史桶缺的 (tool, model) 从 daily_model 按 tool+model 聚合补入。
// 返回 { daily, dailyKeys, models }；归档不可用 / 关闭时返回 null（调用方沿用 raw）。
// 注：monthly / total 维持 raw-only（无消费方），不在合并范围。
//
// 读路径取舍：daily / daily_model 的每一行都可能被消费——raw 日期的行用于补缺判断
// （raw 是否已有该工具必须读到行本身才能知道）、非 raw 日期整日补回——按日期
// WHERE ... IN 过滤省不掉任何行，反而引入超大参数列表问题（SQLite 变量数上限，
// 归档跨数年时日期数远超上限；按 (date,tool) 对反选则语句规模失控）。故维持全量读，
// 只做两处无损优化：全历史 (tool,model) 聚合下推为 SQL GROUP BY（省掉 JS 全表遍历）、
// 只 SELECT 消费列（不取 updated_at 等冗余列）。
function mergeArchived(daily, models, pricer) {
  const conn = open();
  if (!conn || !daily) return null;
  const dailyRows = conn.prepare(`
    SELECT date, tool, requests, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_creation_tokens, cost_usd, cost_cny, equivalent_cny,
      sub_usd, pay_usd, sub_requests, pay_requests FROM daily`).all();
  const modelRows = conn.prepare(`
    SELECT date, tool, model, requests, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, cost_usd, cost_cny, equivalent_cny FROM daily_model`).all();
  // models 全历史桶的聚合直接在库内完成（SUM 与 JS 累加同口径；COALESCE 防 NULL 行——
  // 手工修库可能写入 NULL，JS 侧 `r.x || 0` 的语义等价物）
  const modelAggRows = conn.prepare(`
    SELECT tool, model,
      SUM(COALESCE(requests, 0)) AS requests,
      SUM(COALESCE(input_tokens, 0)) AS input_tokens,
      SUM(COALESCE(output_tokens, 0)) AS output_tokens,
      SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
      SUM(COALESCE(cache_creation_tokens, 0)) AS cache_creation_tokens
    FROM daily_model GROUP BY tool, model`).all();

  const archTool = new Map();  // date -> Map(tool -> daily 行)
  const archModel = new Map(); // 'date|tool' -> Map(model -> daily_model 行)
  for (const r of dailyRows) {
    if (!archTool.has(r.date)) archTool.set(r.date, new Map());
    archTool.get(r.date).set(r.tool, r);
  }
  for (const r of modelRows) {
    const k = r.date + '|' + r.tool;
    if (!archModel.has(k)) archModel.set(k, new Map());
    archModel.get(k).set(r.model, r);
  }

  // 同 (date, tool) 的归档模型行（Map.values，避免把 entries 对当行用）
  const modelRowsOf = (date, tool) => {
    const mm = archModel.get(date + '|' + tool);
    return mm ? [...mm.values()] : [];
  };

  // 1) raw 日：只补缺缺的工具；无归档行的日原样引用（纯函数只需不改入参，不必深拷贝）
  const outDaily = {};
  for (const [date, rawDay] of Object.entries(daily)) {
    const arch = archTool.get(date);
    if (!arch) { outDaily[date] = rawDay; continue; }
    const day = Object.assign({}, rawDay);
    for (const [tool, dRow] of arch) {
      if (day[tool]) continue; // raw 优先
      day[tool] = archToolAgg(dRow, modelRowsOf(date, tool), pricer);
    }
    recomputeTotal(day); // 该日有补缺 → total 重算（纯 raw 日的 total 来自本次行级聚合，本就可信）
    outDaily[date] = day;
  }
  // 2) 纯归档日（raw 扫描窗口外、原始日志已被清理的日期）
  for (const [date, tools] of archTool) {
    if (outDaily[date]) continue;
    const day = {};
    for (const [tool, dRow] of tools) {
      day[tool] = archToolAgg(dRow, modelRowsOf(date, tool), pricer);
    }
    recomputeTotal(day);
    outDaily[date] = day;
  }

  // 3) models 全历史桶补缺：daily_model 按 tool+model 聚合（已在库内 GROUP BY 完成）；raw 已有的模型原样优先
  const outModels = Object.assign({}, models || {});
  const archAgg = new Map(); // tool -> Map(model -> token 累计)
  for (const r of modelAggRows) {
    let t0 = archAgg.get(r.tool);
    if (!t0) archAgg.set(r.tool, t0 = new Map());
    t0.set(r.model, {
      requests: r.requests,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheCreationTokens: r.cache_creation_tokens,
    });
  }
  for (const [tool, t0] of archAgg) {
    const rawTool = outModels[tool];
    if (!rawTool) {
      const fresh = {};
      for (const [model, s] of t0) fresh[model] = archFullModelBucket(model, s, pricer);
      outModels[tool] = fresh;
      continue;
    }
    const missing = [...t0.keys()].filter(mo => !rawTool[mo]);
    if (!missing.length) continue;
    const mergedTool = Object.assign({}, rawTool); // 复制后再加 key，避免改到 raw 的对象
    for (const mo of missing) mergedTool[mo] = archFullModelBucket(mo, t0.get(mo), pricer);
    outModels[tool] = mergedTool;
  }

  return { daily: outDaily, dailyKeys: Object.keys(outDaily).sort(), models: outModels };
}

module.exports = { open, close, ensureSchema, syncFromAgg, syncStats, mergeArchived, DB_PATH };
