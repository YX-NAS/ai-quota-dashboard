'use strict';
// AI 工具额度看板 · 本地服务（零 npm 依赖）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const plansStore = require('./lib/plans');
const { makePricer, DEFAULT_PRICING } = require('./lib/pricing');
const { aggregate, compareYesterday } = require('./lib/store');
const zcode = require('./collectors/zcode');
const ccswitch = require('./collectors/ccswitch');
const workbuddy = require('./collectors/workbuddy');
const claudecode = require('./collectors/claudecode');
const chatgptQuota = require('./collectors/chatgpt-quota');
const minimaxQuota = require('./collectors/minimax-quota');
const zhipuQuota = require('./collectors/zhipu-quota');

const WEB_DIR = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT || 7788);
const REFRESH_MS = 60_000;

let cache = { builtAt: 0, payload: null, building: false };

async function buildSnapshot() {
  const plans = plansStore.load();
  const pricer = makePricer(plans);

  const [zc, cc, wb, clc] = [zcode.collect(), ccswitch.collect(), workbuddy.collect(), claudecode.collect()];
  const rows = [...zc.rows, ...cc.rows, ...wb.rows, ...clc.rows].sort((a, b) => a.ts - b.ts);
  const agg = aggregate(rows, pricer);
  const cmp = compareYesterday(rows, pricer);

  const errors = {};
  for (const [k, v] of Object.entries({ zcode: zc, ccswitch: cc, workbuddy: wb, claudeCode: clc })) {
    if (v.error) errors[k] = v.error;
  }

  // ChatGPT / MiniMax / 智谱 实时额度（尽力而为，失败不阻塞快照）
  const quotaTimeout = p => Promise.race([p, new Promise(r => setTimeout(() => r(null), 10_000))]);
  let chatgptQuotaData = null, minimaxQuotaData = null, zhipuQuotaData = null;
  try { chatgptQuotaData = await quotaTimeout(chatgptQuota.collect()); } catch { /* 降级 */ }
  try { minimaxQuotaData = await quotaTimeout(minimaxQuota.collect()); } catch { /* 降级 */ }
  try { zhipuQuotaData = await quotaTimeout(zhipuQuota.collect()); } catch { /* 降级 */ }

  return {
    builtAt: Date.now(),
    plans,
    agg,
    cmp,
    chatgptQuota: chatgptQuotaData,
    minimaxQuota: minimaxQuotaData,
    zhipuQuota: zhipuQuotaData,
    collectorErrors: errors,
    rowStats: { zcode: zc.rows.length, ccswitch: cc.rows.length, workbuddy: wb.rows.length, claudeCode: clc.rows.length },
  };
}

async function ensureFresh(force = false) {
  const age = Date.now() - cache.builtAt;
  if (!force && cache.payload && age < REFRESH_MS) return cache.payload;
  if (cache.building) return cache.payload; // 已在重建，先回旧值
  cache.building = true;
  try {
    const p = await buildSnapshot();
    cache.payload = p;
    cache.builtAt = p.builtAt;
    return p;
  } finally {
    cache.building = false;
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/summary') {
      const days = Math.min(Number(url.searchParams.get('days')) || 30, 365);
      const snap = await ensureFresh();
      // 只回最近 N 天的 daily
      const cutoff = new Date(Date.now() - days * 86400e3 + 8 * 3600e3).toISOString().slice(0, 10);
      const daily = Object.fromEntries(Object.entries(snap.agg.daily).filter(([d]) => d >= cutoff));
      return sendJson(res, 200, { ...snap, agg: { ...snap.agg, daily, dailyKeys: Object.keys(daily).sort() } });
    }
    if (url.pathname === '/api/refresh') {
      const snap = await ensureFresh(true);
      return sendJson(res, 200, { ok: true, builtAt: snap.builtAt });
    }
    if (url.pathname === '/api/plans' && req.method === 'GET') {
      const out = plansStore.maskQuotaKeys(plansStore.load());
      out.pricingDefaults = DEFAULT_PRICING; // 内置默认单价表，供设置面板展示占位与恢复默认
      return sendJson(res, 200, out);
    }
    if (url.pathname === '/api/plans' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const next = plansStore.load();
      if (body.usdCnyRate != null) next.usdCnyRate = Number(body.usdCnyRate) || next.usdCnyRate;
      if (body.plans) for (const [k, v] of Object.entries(body.plans)) {
        if (!next.plans[k]) continue;
        for (const f of ['cnyPerDay', 'cnyPerMonth']) {
          if (f in v) next.plans[k][f] = v[f] === null || v[f] === '' ? null : Number(v[f]);
        }
      }
      if (body.priceOverrides) next.priceOverrides = body.priceOverrides;
      if (body.quotaKeys) next.quotaKeys = plansStore.applyQuotaKeysUpdate(next, body.quotaKeys);
      if (body.dailyGoal && Number(body.dailyGoal.cny) > 0) next.dailyGoal = { cny: Number(body.dailyGoal.cny) };
      plansStore.save(next);
      await ensureFresh(true); // 立即按新配置重算
      return sendJson(res, 200, { ok: true });
    }

    // 静态文件
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(WEB_DIR, p);
    if (!file.startsWith(WEB_DIR)) { res.writeHead(403); return res.end(); }
    let data;
    try { data = fs.readFileSync(file); } catch { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

async function main() {
  let port = PORT;
  for (; port < PORT + 20; port++) {
    try {
      await new Promise((resolve, reject) => {
        const s = server;
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => resolve());
      });
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  console.log(`[ai-quota] 看板已启动 → http://localhost:${port}`);
  console.log(`[ai-quota] 每 ${REFRESH_MS / 1000}s 自动重扫本地数据；首次构建中…`);
  ensureFresh(true).then(snap => {
    console.log(`[ai-quota] 首次构建完成：${snap.rowStats.zcode + snap.rowStats.ccswitch + snap.rowStats.workbuddy} 条请求`);
  }).catch(e => console.error('[ai-quota] 构建失败:', e.message));
  setInterval(() => ensureFresh().catch(() => {}), REFRESH_MS);
}

main();
