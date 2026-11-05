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
const priceSource = require('./lib/price-source');
const { buildReport } = require('./lib/report');
const alerts = require('./lib/alerts');
const push = require('./lib/push');
const priceAuto = require('./lib/price-auto');
const notify = require('./lib/notify'); // 站内通知中心（price-auto / alerts 写入，铃铛面板读取）
const auth = require('./lib/auth'); // v1.7 登录鉴权（可选启用：配置了凭据即生效，本地默认无感）
const { buildSnapshot } = require('./lib/snapshot'); // 快照构建单一事实源（mcp.js 同源复用）

const WEB_DIR = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT || 7788);
// 绑定地址：默认回环（本地优先原则不破）；云端部署通常放 nginx/Caddy 反代之后仍保持默认，
// 仅直连公网场景才显式 AQD_BIND=0.0.0.0（务必同时配好凭据 + HTTPS 反代或证书）
const BIND = process.env.AQD_BIND || '127.0.0.1';
const REFRESH_MS = 60_000;
const PRICE_AUTO_TICK_MS = 3600_000; // 周自动查价 tick 周期：1h（到点即距上次成功检查 ≥7 天才真正拉取）

let cache = { builtAt: 0, payload: null };
let building = null; // in-flight 构建Promise：并发请求 await 同一次构建，避免首建竞态 500

async function ensureFresh(force = false) {
  const age = Date.now() - cache.builtAt;
  if (!force && cache.payload && age < REFRESH_MS) return cache.payload;
  if (building) return building; // 已在构建：并发调用等同一个 Promise
  building = buildSnapshot()
    .then(p => {
      cache.payload = p; cache.builtAt = p.builtAt;
      // 额度预警 + 定时推送（每日摘要/周月报）：构建成功后异步评估（内部整体 try/catch，不 await、不影响 API 响应）
      const plans = plansStore.load();
      alerts.run(p, plans).catch(() => {});
      push.runScheduled(p, plans).catch(() => {});
      return p;
    })
    .finally(() => { building = null; });
  return building;
}

// Host 白名单：本机主机名（带任意端口）+ AQD_HOSTS 逗号分隔的部署域名（v1.7，云端访问用）。
// 防 DNS rebinding / 局域网直访：域名不配进 AQD_HOSTS 就 403；读取生效，改配置无需改代码。
// 注：URL hostname 对 IPv6 保留方括号形态 [::1]
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function hostAllowed(host) {
  if (!host) return false;
  let hostname;
  try { hostname = new URL('http://' + host).hostname; }
  catch { return false; }
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  return String(process.env.AQD_HOSTS || '').split(',')
    .map(s => s.trim().toLowerCase()).includes(hostname);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// 读取并解析 JSON 请求体（三个 POST 路由共用）：Buffer 累积后一次性 toString('utf8')，
// 避免逐块 string 拼接（buf += c）把跨 chunk 的多字节字符（如中文）劈坏。
// 返回 { ok, body } 或 { ok:false, code, error }；415/413/400 语义与拆分前一致：
//   415 Content-Type 非 application/json（含拒绝后丢弃请求体）
//   413 请求体超限（Buffer.byteLength 口径）或读取失败
//   400 JSON 解析失败
const BODY_LIMIT = 256 * 1024;
function readJsonBody(req) {
  return new Promise(resolve => {
    const ct = String(req.headers['content-type'] || '');
    if (!ct.includes('application/json')) {
      req.resume(); // 丢弃请求体，保持连接可回写 415
      return resolve({ ok: false, code: 415, error: 'Content-Type 必须为 application/json' });
    }
    const chunks = [];
    let size = 0, over = false;
    req.on('data', c => {
      if (over) return;
      chunks.push(c);
      size += c.length;
      if (size > BODY_LIMIT) {
        over = true;
        req.resume(); // 丢弃剩余数据，保持连接可回写 413（不直接断连）
        resolve({ ok: false, code: 413, error: '请求体过大' });
      }
    });
    req.on('end', () => {
      if (over) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch { return resolve({ ok: false, code: 400, error: 'JSON 解析失败' }); }
      resolve({ ok: true, body });
    });
    req.on('error', () => { if (!over) resolve({ ok: false, code: 413, error: '请求体过大' }); });
  });
}

const requestHandler = async (req, res) => {
  // 非白名单 Host 一律 403（回环 + AQD_HOSTS 部署域名）
  if (!hostAllowed(req.headers.host)) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  try {
    // 探活：不触发 ensureFresh（绝不引发全量快照构建），启动脚本用它判断服务是否就绪，
    // 避免冷启动期打 /api/summary 造成 2s 探活超时 → 误判未运行 → 拉起双实例
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, builtAt: cache.builtAt || null });
    }

    // —— v1.7 登录门禁：配置了凭据即启用；未启用时下面整段旁路，行为与 v1.6 一致 ——
    if (auth.isEnabled()) {
      const publicPath = url.pathname === '/login' || url.pathname === '/login.html' || url.pathname === '/api/login';
      if (!publicPath && !auth.isLocalExempt(req) && !auth.checkSession(req)) {
        // API 请求回 401 JSON（前端 main.js 据此跳登录页）；页面请求 302 到 /login
        if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: '未登录', login: true });
        res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
        return res.end();
      }
    }

    // 登录：POST {user, pass}。凭据校验在 lib/auth（scrypt + timingSafe + IP 限流）。
    // 会话 cookie：HttpOnly + SameSite=Lax（与现有 CSRF 口径一致：写接口 JSON + Host 白名单）
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return sendJson(res, parsedBody.code, { error: parsedBody.error });
      const b = parsedBody.body || {};
      const r = auth.login(String(b.user == null ? '' : b.user), String(b.pass == null ? '' : b.pass),
        req.socket.remoteAddress || '?');
      if (!r.ok) return sendJson(res, r.code, { error: r.error });
      auth.sweepSessions();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': auth.sessionCookie(r.token, { secure: process.env.AQD_COOKIE_SECURE === '1' }),
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      auth.destroySession(req);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': auth.sessionCookie('', { secure: process.env.AQD_COOKIE_SECURE === '1', maxAge: 0 }),
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (url.pathname === '/api/summary') {
      const days = Math.max(1, Math.min(Number(url.searchParams.get('days')) || 30, 3650)); // 归档后历史可远超 raw 扫描窗口
      const snap = await ensureFresh();
      // 只回最近 N 天的 daily
      const cutoff = new Date(Date.now() - days * 86400e3 + 8 * 3600e3).toISOString().slice(0, 10);
      const daily = Object.fromEntries(Object.entries(snap.agg.daily).filter(([d]) => d >= cutoff));
      return sendJson(res, 200, { ...snap, agg: { ...snap.agg, daily, dailyKeys: Object.keys(daily).sort() } });
    }
    if (url.pathname === '/api/refresh') {
      // POST-only（与前端刷新按钮契约一致）：强制重建有副作用，GET 形式可被预取/跨站驱动
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed：/api/refresh 仅接受 POST' });
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
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return sendJson(res, parsedBody.code, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'JSON 必须为对象' });
      plansStore.save(plansStore.applyPlansUpdate(plansStore.load(), body));
      await ensureFresh(true); // 立即按新配置重算
      return sendJson(res, 200, { ok: true });
    }

    // 推送测试：POST { webhookType?, webhookUrl? } —— 优先用面板当前输入值（未传则用已保存配置）
    // 立即发一条测试消息，把通道真实判定结果（含企业微信 errcode 的 errmsg）带回前端。
    // 不落盘、不占冷却窗；错误消息经 sanitizeError 消毒（绝不回显完整 webhookUrl，只可能带掩码形态）。
    if (url.pathname === '/api/alerts/test' && req.method === 'POST') {
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return sendJson(res, parsedBody.code, { error: parsedBody.error });
      const body = parsedBody.body;
      const cfg = plansStore.load().alerts || {};
      const type = (body && typeof body.webhookType === 'string' && alerts.ADAPTERS[body.webhookType])
        ? body.webhookType : (cfg.webhookType || 'ntfy');
      // URL 三态与保存语义一致：提交明文新值 > 掩码回显（= 未改动用已存值）> 已存配置
      let webhookUrl = String((body && body.webhookUrl) || cfg.webhookUrl || '').trim();
      if (webhookUrl === alerts.maskWebhookUrl(cfg.webhookUrl)) webhookUrl = cfg.webhookUrl;
      if (!webhookUrl) return sendJson(res, 400, { error: '未配置推送地址' });
      try {
        await alerts.send(type, {
          title: '✅ 流量看板推送测试',
          message: '配置成功，额度预警与定时摘要将通过此通道送达',
          severity: 'info',
          webhookUrl,
        });
        return sendJson(res, 200, { ok: true, type });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: alerts.sanitizeError(e, webhookUrl) });
      }
    }

    // 站内通知中心：列表 / 标记已读 / 清空。内容只有模型名/金额/文案（无密钥）；
    // Host 白名单已拦非本机请求，GET 无副作用
    if (url.pathname === '/api/notifications' && req.method === 'GET') {
      return sendJson(res, 200, Object.assign({ ok: true }, notify.list()));
    }
    if (url.pathname === '/api/notifications/read' && req.method === 'POST') {
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return sendJson(res, parsedBody.code, { error: parsedBody.error });
      const id = parsedBody.body && parsedBody.body.id != null ? String(parsedBody.body.id) : null;
      const marked = notify.markRead(id);
      return sendJson(res, 200, Object.assign({ ok: true, marked }, notify.list()));
    }
    if (url.pathname === '/api/notifications/clear' && req.method === 'POST') {
      notify.clear();
      return sendJson(res, 200, { ok: true, items: [], unread: 0 });
    }

    // 在线单价更新：POST { url, apply }。apply=false 只拉取+校验+返回差异预览（不落盘）；
    // apply=true 把远端价合并进 priceOverrides、记录 priceSource 检查结果并立即重算。
    // URL 取请求体，缺省回退已存配置；协议/大小/重定向限制在 price-source.fetchPrices
    if (url.pathname === '/api/prices/update' && req.method === 'POST') {
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return sendJson(res, parsedBody.code, { error: parsedBody.error });
      const body = parsedBody.body;
      const stored = (plansStore.load().priceSource || {}).url || '';
      const srcUrl = String((body && body.url) || stored || '').trim();
      if (!srcUrl) return sendJson(res, 400, { error: '未提供单价源 URL' });
      const fr = await priceSource.fetchPrices(srcUrl);
      if (!fr.ok) return sendJson(res, 502, { error: '拉取失败：' + fr.error });
      const parsed = priceSource.parsePriceFile(fr.text);
      if (!parsed.ok) return sendJson(res, 422, { error: '文件校验失败：' + parsed.error });
      const plans = plansStore.load();
      const ps = plans.priceSource || {};
      const diff = priceSource.diffPrices(makePricer(plans).table, parsed.models, ps.modelsSeen, parsed.names);
      if (body && body.apply) {
        const next = priceSource.mergeRemoteOverrides(plans, parsed.models);
        next.priceSource = Object.assign({}, ps, {
          url: srcUrl,
          lastCheck: new Date().toISOString(),
          lastResult: 'ok',
          updated: parsed.meta.updated,
          models: Object.keys(parsed.models).length,
          modelsSeen: parsed.names, // 上线/下线判定基准：来源覆盖的模型名（含坏行名，防误报下线）
        });
        plansStore.save(next);
        await ensureFresh(true); // 立即按新单价重算历史等价成本
        return sendJson(res, 200, { ok: true, applied: true, url: srcUrl, meta: parsed.meta, diff });
      }
      return sendJson(res, 200, { ok: true, applied: false, url: srcUrl, meta: parsed.meta, diff });
    }

    // 缺失单价自动补充：POST /api/prices/supplement。圈定全历史出现但单价表查不到的模型，
    // 从公共价格目录精确匹配补价（折算人民币进覆盖表）并立即重估历史；手动按钮 / 周检查共用。
    if (url.pathname === '/api/prices/supplement' && req.method === 'POST') {
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return sendJson(res, parsedBody.code, { error: parsedBody.error });
      const r = await priceAuto.runPriceSupplement({
        loadPlans: () => plansStore.load(),
        savePlans: next => plansStore.save(next),
        ensureFresh,
      });
      return sendJson(res, r.ok ? 200 : 502, r);
    }

    // 静态文件（/login 映射到自包含的 login.html，供门禁 302 落地）
    let p = url.pathname === '/' ? '/index.html' : (url.pathname === '/login' ? '/login.html' : url.pathname);
    p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(WEB_DIR, p);
    if (!file.startsWith(WEB_DIR)) { res.writeHead(403); return res.end(); }
    let data;
    try { data = fs.readFileSync(file); } catch { res.writeHead(404); return res.end('not found'); }
    // no-store：此前不发任何缓存头，浏览器走启发式缓存——前端 JS 迭代后用户刷新仍拿旧模块
    //（子模块 import 不带 query 版本号，光给 main.js bump ?v= 治标不治本）。本地回环服务
    // 每次都回源代价可忽略，从根上消灭「改了但看不到」这一类问题。
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (e) {
    // 固定文案：内部错误细节（可能含路径/配置片段）不回显给客户端，只落服务端日志
    console.error('[ai-quota] 请求处理失败:', e);
    sendJson(res, 500, { error: '服务器内部错误' });
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
        s.listen(port, BIND, () => resolve());
      });
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  if (!server.listening) {
    console.error(`[ai-quota] ${PORT}~${PORT + 19} 端口全部被占用，无法启动。可用环境变量 PORT=xxxx 指定其他起始端口。`);
    console.error(`[ai-quota] 或绑定地址 ${BIND} 不可用（AQD_BIND 默认 127.0.0.1；云端直连公网用 AQD_BIND=0.0.0.0）。`);
    process.exit(1);
  }
  writePortFile(port);
  // IPv6 回环尽力绑定：macOS 上只绑 127.0.0.1 时，把 localhost 解析成 ::1 的浏览器会
  // ERR_CONNECTION_REFUSED；单独绑 ::1 又不管 IPv4（实测），所以两个回环各挂一份同一 handler。
  // 仅默认回环模式下追加（AQD_BIND=0.0.0.0 时 IPv4 通配已含全部接口，不重复监听）。
  // 失败（如系统禁用 IPv6）不影响主服务。
  if (BIND === '127.0.0.1') {
    try {
      const v6 = http.createServer(requestHandler);
      await new Promise((resolve, reject) => {
        v6.once('error', reject);
        v6.listen(port, '::1', () => resolve());
      });
      console.log('[ai-quota] IPv6 回环已监听（localhost 双栈可达）');
    } catch { /* 无 IPv6 时忽略 */ }
  }
  console.log(`[ai-quota] 看板已启动 → http://localhost:${port}（监听 ${BIND}:${port}）`);
  if (auth.isEnabled()) {
    console.log('[ai-quota] 🔒 登录鉴权已启用（本机 localhost 访问免登录直通；外部域名访问需登录）');
    console.log('[ai-quota]    部署域名请加入白名单：AQD_HOSTS=quota.example.com；反代 TLS 建议 AQD_COOKIE_SECURE=1');
  }
  console.log(`[ai-quota] 每 ${REFRESH_MS / 1000}s 自动重扫本地数据；首次构建中…`);
  ensureFresh(true).then(snap => {
    const rs = snap.rowStats;
    console.log(`[ai-quota] 首次构建完成：${rs.zcode + rs.ccswitch + rs.codexSessions + rs.workbuddy + rs.claudeCode} 条请求`);
  }).catch(e => console.error('[ai-quota] 构建失败:', e.message));
  setInterval(() => ensureFresh().catch(() => {}), REFRESH_MS);

  // 每周自动刷新模型单价（price-auto）：独立于快照循环 —— 应用后要 ensureFresh(true) 重算，
  // 挂在快照成功钩子里会自引用重入。1h tick 到点评估；启动后 45s 先评估一轮（超 7 天未查才真正拉取）。
  // 有差异自动应用 + webhook 通知；失败不动 lastCheck，下一轮 tick 再试。
  const runPriceAuto = () => priceAuto.runPriceAuto({
    loadPlans: () => plansStore.load(),
    savePlans: next => plansStore.save(next),
    ensureFresh,
  }).catch(e => console.error('[price-auto] 异常:', e && e.message));
  setTimeout(runPriceAuto, 45_000);
  setInterval(runPriceAuto, PRICE_AUTO_TICK_MS);
}

if (require.main === module) main();

// requestHandler 一并导出：集成测试在临时端口上直接挂它起服务，不必走 main() 监听；
// buildSnapshot re-export（实现在 lib/snapshot.js）：既有消费方（含测试）从 index 引
module.exports = { buildSnapshot, ensureFresh, requestHandler, hostAllowed, writePortFile };
