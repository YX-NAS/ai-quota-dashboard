'use strict';
// 在线单价源：拉取远端价格 JSON → 校验 → 差异预览 / 合并进 priceOverrides
// 纯函数（parsePriceFile / diffPrices / mergeRemoteOverrides）可单测；
// fetchPrices 只走 http(s)、不跟随重定向、10s 超时、256KB 上限（与 alerts webhook 同一套 SSRF 口径）
const http = require('node:http');
const https = require('node:https');

const PRICE_FIELDS = ['in', 'out', 'cacheRead', 'cacheWrite']; // in/out 必填，cache* 可选
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_LIMIT_BYTES = 256 * 1024;

// 解析远端价格文件（纯函数）。schema 见 config/prices.source.json：
// { schema?, updated?, source?, models: { 名称: { in, out, cacheRead?, cacheWrite? } } }
// 坏行跳过（不整体失败）；in/out 缺一不可。返回 { ok, models, names, skipped, meta } 或 { ok:false, error }；
// names = models 原始键名（含被跳过的坏行名，供「下线判定」防误报：坏行 ≠ 下线）、
// skipped = 被跳过的行名（价格没被应用，值得让检查方知道）
function parsePriceFile(text) {
  let j;
  try { j = JSON.parse(text); } catch { return { ok: false, error: 'JSON 解析失败' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, error: '顶层必须是 JSON 对象' };
  const ms = j.models;
  if (!ms || typeof ms !== 'object' || Array.isArray(ms)) return { ok: false, error: '缺少 models 对象' };
  const out = {}, skipped = [];
  for (const [name, p] of Object.entries(ms)) {
    if (!name || typeof name !== 'string' || !p || typeof p !== 'object') { skipped.push(String(name)); continue; }
    const e = {};
    for (const f of PRICE_FIELDS) {
      if (p[f] == null) continue;
      const n = Number(p[f]);
      if (Number.isFinite(n) && n >= 0) e[f] = n; // 非法数值按缺失处理
    }
    if (e.in != null && e.out != null) out[name] = e;
    else skipped.push(name);
  }
  const names = Object.keys(ms).filter(k => typeof k === 'string' && k);
  if (!Object.keys(out).length) {
    return { ok: false, error: '没有合法的模型单价（每个模型需含非负的 in / out）' };
  }
  return {
    ok: true,
    models: out,
    names,
    skipped,
    meta: {
      updated: typeof j.updated === 'string' ? j.updated.slice(0, 40) : '',
      source: typeof j.source === 'string' ? j.source.slice(0, 200) : '',
    },
  };
}

// 差异预览（纯函数）：远端价 vs 当前生效单价表（defaults ⊕ overrides 合成后的 pricer.table）
// from/to 为 null 表示「无价 / 按输入价」。
// prevSeen = 上次成功检查时价格源覆盖的模型名；remoteNames = 本次源里的原始键名（含坏行名）。
// 「下线」只认「上次见过、这次源里连键名都没有」——从未收录的本地模型（如 qwen 系）不误报，
// 源里临时出现坏行的模型也不误报（键名还在，只是价格没解析出来）。
// 返回 { changes, added, removed, unchanged }
function diffPrices(effectiveTable, remote, prevSeen, remoteNames) {
  const changes = [], added = [], removed = [];
  let unchanged = 0;
  for (const [m, rp] of Object.entries(remote)) {
    const cur = effectiveTable[m];
    if (!cur) { added.push(m); continue; }
    let diff = false;
    for (const f of PRICE_FIELDS) {
      const a = cur[f] ?? null, b = rp[f] ?? null;
      if (a !== b) { changes.push({ model: m, field: f, from: a, to: b }); diff = true; }
    }
    if (!diff) unchanged++;
  }
  if (Array.isArray(prevSeen)) {
    const names = Array.isArray(remoteNames) ? remoteNames : Object.keys(remote);
    for (const m of prevSeen) {
      if (typeof m === 'string' && m && !names.includes(m)) removed.push(m);
    }
  }
  return { changes, added, removed, unchanged };
}

// 合并（纯函数，不改入参）：远端价写入 priceOverrides——同名模型整组替换（以远端为准），
// 未提及的模型覆盖保持原样。priceSource 的检查记录由调用方（路由）在保存前补盖。
function mergeRemoteOverrides(currentPlans, remote) {
  const next = JSON.parse(JSON.stringify(currentPlans || {}));
  const po = next.priceOverrides || {};
  for (const [m, p] of Object.entries(remote)) po[m] = Object.assign({}, p);
  next.priceOverrides = po;
  return next;
}

// 拉取（有副作用）：GET 文本。协议白名单 http/https；3xx 显式拒绝（防开放重定向）；
// Content-Length 或累计流量超 maxBytes 拒绝（默认 256KB；公共价格目录 ~3MB 由
// price-catalog.fetchCatalog 放宽，同一套 SSRF 口径）；任何失败都以 { ok:false, error } 返回（不抛错）
function fetchPrices(url, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = FETCH_LIMIT_BYTES) {
  return new Promise(resolve => {
    let settled = false;
    const done = r => { if (!settled) { settled = true; resolve(r); } };
    let u;
    try { u = new URL(url); } catch { return done({ ok: false, error: 'URL 非法' }); }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) return done({ ok: false, error: `协议不支持: ${u.protocol}（仅允许 http/https）` });
    const req = mod.request(u, {
      method: 'GET',
      headers: { 'User-Agent': 'ai-quota-dashboard' },
      timeout: timeoutMs,
    }, res => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) { res.resume(); return done({ ok: false, error: `重定向被拒绝 (HTTP ${status})` }); }
      if (status < 200 || status >= 300) { res.resume(); return done({ ok: false, error: `HTTP ${status}` }); }
      const len = Number(res.headers['content-length'] || 0);
      if (len > maxBytes) { res.resume(); return done({ ok: false, error: '文件过大' }); }
      let buf = '', over = false;
      res.setEncoding('utf8');
      res.on('data', c => {
        if (over) return;
        buf += c;
        if (buf.length > maxBytes) { over = true; res.destroy(); done({ ok: false, error: '文件过大' }); }
      });
      res.on('end', () => { if (!over) done({ ok: true, text: buf }); });
      res.on('error', () => { if (!over) done({ ok: false, error: '响应中断' }); });
    });
    req.on('timeout', () => req.destroy(new Error(`超时 (${timeoutMs}ms)`))); // timeout 事件不自动断请求，需显式 destroy
    req.on('error', e => done({ ok: false, error: e.message }));
    req.end();
  });
}

module.exports = { parsePriceFile, diffPrices, mergeRemoteOverrides, fetchPrices, PRICE_FIELDS };
