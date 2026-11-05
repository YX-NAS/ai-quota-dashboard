'use strict';
// 每周自动刷新模型单价：独立 1h tick（不挂快照成功钩子 —— 应用后要 ensureFresh(true) 重算，
// 在快照钩子里做会自引用重入）。到点才动手：距上次成功检查 ≥7 天才拉价格源。
// 链路与 /api/prices/update?apply=true 同源（纯函数复用 price-source.js）：
// - 有差异（调价 / 新模型上线 / 旧模型下线）：合并进 priceOverrides → ensureFresh(true) 重算历史
//   → webhook 通知（复用 alerts 通道与文案形态）；
// - 无差异：静默更新检查记录（lastCheck / modelsSeen），不发通知；
// - 失败：不动 lastCheck（下轮 tick 再试，临时网络抖动不必等一周），lastResult 留给设置面板。
// 下线判定：modelsSeen = 每次成功检查时来源覆盖的模型名（含坏行名，见 price-source.parsePriceFile），
// 「上次见过、这次没了」才算下线 —— 从未收录进来源的本地模型（如 qwen 系）不误报。
// 安全继承：拉取协议/重定向/大小限制在 fetchPrices；webhook 错误只落 host（sanitizeError/hostOf）；
// 通知文案只含模型名与价格数字。
const alerts = require('./alerts');
const { makePricer } = require('./pricing');
const priceSource = require('./price-source');
const priceCatalog = require('./price-catalog');
const history = require('./history');
const notify = require('./notify');

const WEEK_MS = 7 * 24 * 3600e3;
const PRICE_FIELD_NAMES = { in: '输入', out: '输出', cacheRead: '缓存命中', cacheWrite: '缓存写入' };
const fmtP = v => (v == null ? '—' : String(v));

// 通知正文（纯函数）。changes/added/removed 为 diffPrices 输出；价格变化只截前 15 条防超长。
function buildNoticeBody(diff, meta) {
  const changes = (diff && diff.changes) || [];
  const added = (diff && diff.added) || [];
  const removed = (diff && diff.removed) || [];
  const lines = changes.slice(0, 15)
    .map(c => `· ${c.model} ${PRICE_FIELD_NAMES[c.field] || c.field} ${fmtP(c.from)} → ${fmtP(c.to)}`);
  if (changes.length > 15) lines.push(`· …等共 ${changes.length} 处变化`);
  if (added.length) lines.push(`上线模型：${added.join('、')}`);
  if (removed.length) lines.push(`下线模型：${removed.join('、')}`);
  if (meta && meta.skipped && meta.skipped.length) lines.push(`无效行跳过：${meta.skipped.join('、')}`);
  lines.push('已按新单价重算历史等价成本（单位：元/百万 token）');
  if (meta && meta.updated) lines.push(`价格源更新于 ${meta.updated}`);
  const parts = [];
  if (changes.length) parts.push(`${changes.length} 处价格变化`);
  if (added.length) parts.push(`上线 ${added.length}`);
  if (removed.length) parts.push(`下线 ${removed.length}`);
  return {
    title: `💰 模型单价自动更新：${parts.join(' · ')}`,
    message: lines.join('\n'),
    card: lines.join('\n'),
  };
}

// runPriceAuto(deps)：每个 tick 调用一次。deps：
//   loadPlans / savePlans（index.js 注入真实配置仓）、ensureFresh（应用后重算历史）；
//   now / fetchPrices / sender / store / log 可注入（测试）。
// 返回 { skipped: true, reason } / { ok: true, applied, diff, notified } / { ok: false, error }。
async function runPriceAuto(deps = {}) {
  try {
    const now = Number(deps.now) || Date.now();
    const loadPlans = deps.loadPlans, savePlans = deps.savePlans;
    const log = deps.log || console;
    if (typeof loadPlans !== 'function' || typeof savePlans !== 'function') {
      return { ok: false, error: '缺少 loadPlans/savePlans 依赖' };
    }
    const plans = loadPlans();
    const ps = plans.priceSource || {};
    if (!ps.url) return { skipped: true, reason: 'no-url' };
    if (ps.auto === false) return { skipped: true, reason: 'disabled' };
    const last = Date.parse(ps.lastCheck || '') || 0;
    if (now - last < WEEK_MS) return { skipped: true, reason: 'interval' };

    // 只动 priceSource / priceOverrides 两个块，其余配置原样保留
    const persist = (base, patch) => {
      const next = JSON.parse(JSON.stringify(base));
      next.priceSource = Object.assign({ url: ps.url }, next.priceSource, patch);
      savePlans(next);
      return next;
    };
    const recordFailure = error => {
      const reason = String(error || 'unknown').slice(0, 160);
      try { persist(plans, { lastResult: 'failed: ' + reason }); } catch { /* 尽力 */ }
      // 站内通知：检查失败入消息流（导航栏铃铛可见），webhook 通道不背这个锅（不推手机）
      try { (deps.notify || notify).add({ type: 'price-error', title: '模型价格源检查失败', body: reason }); } catch { /* 尽力 */ }
      log.error && log.error('[price-auto] 价格源拉取/校验失败: %s', reason);
      return { ok: false, error: reason };
    };

    const fr = await (deps.fetchPrices || priceSource.fetchPrices)(ps.url);
    if (!fr.ok) return recordFailure(fr.error);
    const parsed = priceSource.parsePriceFile(fr.text);
    if (!parsed.ok) return recordFailure(parsed.error);

    const diff = priceSource.diffPrices(makePricer(plans).table, parsed.models, ps.modelsSeen, parsed.names);
    const changed = diff.changes.length > 0 || diff.added.length > 0 || diff.removed.length > 0;
    const meta = {
      lastCheck: new Date(now).toISOString(),
      lastResult: 'ok',
      updated: parsed.meta.updated,
      models: Object.keys(parsed.models).length,
      modelsSeen: parsed.names, // 上线/下线判定基准：来源覆盖的模型名（含坏行名，防误报下线）
      skipped: parsed.skipped,
    };
    if (changed) {
      persist(priceSource.mergeRemoteOverrides(plans, parsed.models), meta);
      if (typeof deps.ensureFresh === 'function') await deps.ensureFresh(true);
    } else {
      persist(plans, meta);
    }

    // 通知：只在确实有差异时发。发送失败不回滚已应用的更新（lastCheck 已推进，不会重发重算）
    let notified = 'skipped';
    if (changed) {
      const ev = buildNoticeBody(diff, meta);
      // 站内通知：无论 webhook 是否配置都入站内消息流（导航栏铃铛 / 消息面板可见）
      try { (deps.notify || notify).add({
        type: 'price-update', title: ev.title, body: ev.message,
        meta: { changes: diff.changes.length, added: diff.added.length, removed: diff.removed.length, updated: meta.updated },
      }); } catch { /* 尽力 */ }
      const cfg = plans.alerts || {};
      if (cfg.enabled && cfg.webhookUrl) {
        const type = alerts.ADAPTERS[cfg.webhookType] ? cfg.webhookType : 'generic';
        const key = 'price-update|' + meta.lastCheck;
        try {
          await alerts.send(type, Object.assign({}, ev, {
            webhookUrl: String(cfg.webhookUrl), severity: 'info',
          }), { sender: deps.sender });
          notified = 'sent';
          try { (deps.store || alerts.defaultStore()).set(key, now, 'success'); } catch { /* 冷却库失败不影响 */ }
        } catch (e) {
          notified = 'failed';
          const reason = alerts.sanitizeError(e, cfg.webhookUrl);
          log.error && log.error('[price-auto] 通知推送失败 %s: %s', alerts.hostOf(cfg.webhookUrl), reason);
          try { (deps.store || alerts.defaultStore()).set(key, now, 'failed: ' + reason); } catch { /* 尽力 */ }
        }
      }
    }
    // 缺失单价自动补充：与周检查同节奏（走到这里必然 7 天一次，不会每小时拉 3MB 目录）。
    // 关闭开关 / 未配 URL 的周检路径不带动补充（手动路由可单独触发）。
    let supplement = null;
    if (deps.supplement !== false) {
      const s = await runPriceSupplement(deps);
      supplement = { ok: s.ok, matched: (s.matched || []).length, missed: (s.missed || []).length, skipped: s.skipped || null, error: s.error || null };
    }
    return { ok: true, applied: changed, diff, notified, supplement };
  } catch (e) {
    // catch-all：调度器不能让异常逃逸打断调用方（与 push.runScheduled 同口径）
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// runPriceSupplement(deps)：缺失单价自动补充。链路：全历史出现但单价表（默认+覆盖）查不到的
// 模型（history.daily_model 去重圈定）→ 公共价格目录精确裸名匹配 → 按 usdCnyRate 折算人民币
// 写入 priceOverrides（设置面板可见可改）→ ensureFresh(true) 重估历史 → 站内/webhook 通知。
// 原则：宁缺勿错 —— 只做精确裸名匹配，命不中的如实记录 plans.priceAuto.missed（面板呈报）。
// 全部未匹配也落 meta，不动覆盖表。deps 同 runPriceAuto，另可注入 distinctModels / fetchCatalog（测试）。
async function runPriceSupplement(deps = {}) {
  try {
    const now = Date.now();
    const loadPlans = deps.loadPlans, savePlans = deps.savePlans;
    const log = deps.log || console;
    if (typeof loadPlans !== 'function' || typeof savePlans !== 'function') {
      return { ok: false, error: '缺少 loadPlans/savePlans 依赖' };
    }
    const plans = loadPlans();
    const tableKeys = new Set(Object.keys(makePricer(plans).table).map(k => String(k).trim().toLowerCase()));
    let all = [];
    try { all = deps.distinctModels ? deps.distinctModels() : history.distinctModels(); } catch { all = []; }
    const missing = [...new Set(all.filter(m => typeof m === 'string' && m && !tableKeys.has(m.trim().toLowerCase())))];
    if (!missing.length) return { ok: true, matched: [], missed: [], skipped: 'no-missing' };

    const fr = await (deps.fetchCatalog || priceCatalog.fetchCatalog)();
    if (!fr.ok) return { ok: false, error: fr.error };
    const cat = priceCatalog.parseCatalog(fr.text);
    if (!cat.ok) return { ok: false, error: cat.error };
    const { matched, missed } = priceCatalog.matchCatalog(cat.byName, missing);

    const fx = Number(plans.usdCnyRate) || 7.2;
    const r4 = n => Math.round(n * 1e4) / 1e4; // 元/百万，4 位小数够精度且避免浮点尾噪
    const entries = {};
    for (const [model, p] of Object.entries(matched)) {
      const e = { in: r4(p.in * fx), out: r4(p.out * fx) };
      if (p.cacheRead != null) e.cacheRead = r4(p.cacheRead * fx);
      if (p.cacheWrite != null) e.cacheWrite = r4(p.cacheWrite * fx);
      entries[model] = e;
    }
    const meta = {
      lastAt: new Date(now).toISOString(),
      source: priceCatalog.DEFAULT_CATALOG_URL,
      matched: Object.keys(entries),
      missed: missed.slice(0, 50),
    };
    if (Object.keys(entries).length) {
      // 合并进覆盖表（同名整组替换，与单价源应用同一合并语义）；历史等价成本随重估自动修正
      const next = priceSource.mergeRemoteOverrides(plans, entries);
      next.priceAuto = meta;
      savePlans(next);
      if (typeof deps.ensureFresh === 'function') await deps.ensureFresh(true);
      const lines = Object.entries(entries)
        .map(([m, p]) => `· ${m}：输入 ¥${p.in} / 输出 ¥${p.out}${p.cacheRead != null ? ` / 缓存读 ¥${p.cacheRead}` : ''}`)
        .slice(0, 20);
      const tail = ['已按新单价重估历史等价成本（来源：公共价格目录）'];
      const ev = { title: `💰 自动补充 ${Object.keys(entries).length} 个缺失模型单价`, message: [...lines, ...tail].join('\n'), card: [...lines, ...tail].join('\n') };
      try { (deps.notify || notify).add({ type: 'price-update', title: ev.title, body: ev.message, meta: { matched: Object.keys(entries) } }); } catch { /* 尽力 */ }
      const cfg = plans.alerts || {};
      if (cfg.enabled && cfg.webhookUrl) {
        const type = alerts.ADAPTERS[cfg.webhookType] ? cfg.webhookType : 'generic';
        try {
          await alerts.send(type, Object.assign({}, ev, { webhookUrl: String(cfg.webhookUrl), severity: 'info' }), { sender: deps.sender });
        } catch (e) {
          log.error && log.error('[price-auto] 补充通知推送失败 %s: %s', alerts.hostOf(cfg.webhookUrl), alerts.sanitizeError(e, cfg.webhookUrl));
        }
      }
    } else {
      const next = JSON.parse(JSON.stringify(plans));
      next.priceAuto = meta;
      savePlans(next);
    }
    return { ok: true, matched: Object.keys(entries), missed, entries };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { runPriceAuto, runPriceSupplement, buildNoticeBody, WEEK_MS };
