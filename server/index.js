#!/usr/bin/env node
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

let cache = { builtAt: 0, payload: null };
let building = null; // in-flight 构建Promise：并发请求 await 同一次构建，避免首建竞态 500

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
    // 快照对外脱敏：quotaKeys 机密字段（accessToken 等）只出掩码形态，其余配置原样
    plans: plansStore.maskQuotaKeys(plans),
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
  if (building) return building; // 已在构建：并发调用等同一个 Promise
  building = buildSnapshot()
    .then(p => { cache.payload = p; cache.builtAt = p.builtAt; return p; })
    .finally(() => { building = null; });
  return building;
}

// Host 白名单：只信任本机主机名（带任意端口），防 DNS rebinding / 局域网直访
// 注：URL hostname 对 IPv6 保留方括号形态 [::1]
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function hostAllowed(host) {
  if (!host) return false;
  try { return ALLOWED_HOSTS.has(new URL('http://' + host).hostname); }
  catch { return false; }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '', over = false;
    req.on('data', c => {
      if (over) return;
      buf += c;
      if (buf.length > limit) {
        over = true;
        const e = new Error('request body too large'); e.statusCode = 413;
        reject(e);
        req.resume(); // 丢弃剩余数据，保持连接可回写 413（不直接断连）
      }
    });
    req.on('end', () => { if (!over) resolve(buf); });
    req.on('error', e => { if (!over) reject(e); });
  });
}

const server = http.createServer(async (req, res) => {
  // 非 本机 Host 一律 403
  if (!hostAllowed(req.headers.host)) { res.writeHead(403); return res.end(); }
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
      // CSRF 加固：写接口只接受 JSON 表单提交
      const ct = String(req.headers['content-type'] || '');
      if (!ct.includes('application/json')) return sendJson(res, 415, { error: 'Content-Type 必须为 application/json' });
      let raw, body;
      try { raw = await readBody(req); } catch { return sendJson(res, 413, { error: '请求体过大' }); }
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'JSON 必须为对象' });
      plansStore.save(plansStore.applyPlansUpdate(plansStore.load(), body));
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

// 端口发现契约：listen 成功后把实际端口写给菜单栏 / 桌面组件读取（config/.port，纯文本端口号）
function writePortFile(port) {
  try {
    fs.mkdirSync(plansStore.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(plansStore.CONFIG_DIR, '.port'), String(port));
  } catch (e) {
    console.error('[ai-quota] 写入端口文件失败:', e.message);
  }
}

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
  writePortFile(port);
  console.log(`[ai-quota] 看板已启动 → http://localhost:${port}`);
  console.log(`[ai-quota] 每 ${REFRESH_MS / 1000}s 自动重扫本地数据；首次构建中…`);
  ensureFresh(true).then(snap => {
    console.log(`[ai-quota] 首次构建完成：${snap.rowStats.zcode + snap.rowStats.ccswitch + snap.rowStats.workbuddy} 条请求`);
  }).catch(e => console.error('[ai-quota] 构建失败:', e.message));
  setInterval(() => ensureFresh().catch(() => {}), REFRESH_MS);
}

if (require.main === module) main();

module.exports = { buildSnapshot, ensureFresh, hostAllowed, writePortFile };
