#!/usr/bin/env node
'use strict';
// AI 工具额度看板 · 本地服务（零 npm 依赖）

// Node 版本门槛：node:sqlite 需 22.13+（更早版本要 --experimental-sqlite 旗标）。
// 必须在 require 采集器之前拦截，否则新用户只会看到晦涩的 "Cannot find module 'node:sqlite'"。
(() => {
  const m = /^v?(\d+)\.(\d+)/.exec(process.versions.node || '');
  const maj = m ? Number(m[1]) : 0, min = m ? Number(m[2]) : 0;
  if (maj < 22 || (maj === 22 && min < 13)) {
    console.error(`[ai-quota] 需要 Node.js ≥ 22.13（当前 ${process.versions.node || '未知'}）。`);
    console.error('[ai-quota] 内置 node:sqlite 在更早版本需要实验旗标，无法直接运行。');
    console.error('[ai-quota] 安装新版后重试：https://nodejs.org');
    process.exit(1);
  }
})();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const plansStore = require('./lib/plans');
const { makePricer, DEFAULT_PRICING } = require('./lib/pricing');
const { aggregate, compareYesterday } = require('./lib/store');
const history = require('./lib/history');
const alerts = require('./lib/alerts');
const { buildReport } = require('./lib/report');
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

  // 历史归档：聚合结果落库 + 归档补缺合并（raw 优先、archive 只补缺）。
  // 容错：归档库打开/读写任何失败只记 collectorErrors.history，绝不阻塞快照主流程
  try {
    if (history.syncFromAgg(agg)) {
      const merged = history.mergeArchived(agg.daily, agg.models, pricer);
      if (merged) {
        agg.daily = merged.daily;
        agg.dailyKeys = merged.dailyKeys;
        agg.models = merged.models;
      }
    }
  } catch (e) {
    errors.history = e.message;
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
    .then(p => {
      cache.payload = p; cache.builtAt = p.builtAt;
      // 额度预警：构建成功后异步评估推送（内部整体 try/catch，不 await、不影响 API 响应）
      alerts.run(p, plansStore.load()).catch(() => {});
      return p;
    })
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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png' };

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

const requestHandler = async (req, res) => {
  // 非 本机 Host 一律 403
  if (!hostAllowed(req.headers.host)) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/summary') {
      const days = Math.min(Number(url.searchParams.get('days')) || 30, 3650); // 归档后历史可远超 raw 扫描窗口
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
    if (url.pathname === '/api/report') {
      const type = url.searchParams.get('type') === 'month' ? 'month' : 'week';
      const offsetRaw = Number(url.searchParams.get('offset'));
      // 上限按周期区分：周 ≤520（十年）、月 ≤120（十年）；非法值一律钳回本期
      const maxOffset = type === 'month' ? 120 : 520;
      const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 && offsetRaw <= maxOffset
        ? Math.floor(offsetRaw) : 0;
      const snap = await ensureFresh();
      const r = buildReport(snap.agg, snap.plans, { type, offset });
      return sendJson(res, 200, { ok: true, title: r.title, markdown: r.markdown, data: r.data });
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
};

const server = http.createServer(requestHandler);

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
  if (!server.listening) {
    console.error(`[ai-quota] ${PORT}~${PORT + 19} 端口全部被占用，无法启动。可用环境变量 PORT=xxxx 指定其他起始端口。`);
    process.exit(1);
  }
  writePortFile(port);
  // IPv6 回环尽力绑定：macOS 上只绑 127.0.0.1 时，把 localhost 解析成 ::1 的浏览器会
  // ERR_CONNECTION_REFUSED；单独绑 ::1 又不管 IPv4（实测），所以两个回环各挂一份同一 handler。
  // 失败（如系统禁用 IPv6）不影响主服务。
  try {
    const v6 = http.createServer(requestHandler);
    await new Promise((resolve, reject) => {
      v6.once('error', reject);
      v6.listen(port, '::1', () => resolve());
    });
    console.log('[ai-quota] IPv6 回环已监听（localhost 双栈可达）');
  } catch { /* 无 IPv6 时忽略 */ }
  console.log(`[ai-quota] 看板已启动 → http://localhost:${port}`);
  console.log(`[ai-quota] 每 ${REFRESH_MS / 1000}s 自动重扫本地数据；首次构建中…`);
  ensureFresh(true).then(snap => {
    console.log(`[ai-quota] 首次构建完成：${snap.rowStats.zcode + snap.rowStats.ccswitch + snap.rowStats.workbuddy + snap.rowStats.claudeCode} 条请求`);
  }).catch(e => console.error('[ai-quota] 构建失败:', e.message));
  setInterval(() => ensureFresh().catch(() => {}), REFRESH_MS);
}

if (require.main === module) main();

// requestHandler 一并导出：集成测试在临时端口上直接挂它起服务，不必走 main() 监听
module.exports = { buildSnapshot, ensureFresh, requestHandler, hostAllowed, writePortFile };
