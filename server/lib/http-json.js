'use strict';
// HTTP(S) GET + JSON 公共助手：原四份内联实现（collectors/api-billing.js、zhipu-quota.js、
// chatgpt-quota.js、minimax-quota.js）的统一替代。
//
// getJson 统一契约（resolve，永不 reject）：
//   成功               { ok: true,  status: 200, data }
//   非 200（含 3xx，不跟随重定向） { ok: false, status, reason: 'HTTP <code>[: 体片段]' }
//   URL/协议非法、请求错误、超时 { ok: false, status: -1, reason }
//   响应体超限          { ok: false, status: -2, reason: 'response too large' }
//
// 相对旧内联实现的三处行为修正：
//   1) [P1 悬挂] 旧实现响应体超限时只 req.destroy() 不 resolve——destroy 后 end/error 都
//      不再触发，promise 永不落定，外层 10s race 把整卡拖成 null。现在先 resolve 再 destroy。
//   2) [P2 泄密] 非 200 的响应体片段可能回显 API key 明文（401/403 错误体），reason 一律
//      过 sanitizeReason()（密钥形态替换 '[redacted]' + 120 字符截断）。
//   3) withTimeout 修 race 胜出后定时器拖尾（clearTimeout）+ unref。
//
// 协议只允许 http/https；重定向不跟随（与旧实现一致，3xx 按非 200 处理）。

const http = require('node:http');
const https = require('node:https');

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 262_144; // 256KB，与旧实现一致

// 密钥形态脱敏：sk-/rk-/ark- 前缀 token 与 Bearer 头值 → '[redacted]'；再截断 120 字符。
// 目的：401/403 等错误体与底层错误消息回显进快照/前端前，抹掉可识别的凭证明文。
const SECRET_LIKE = /(sk|rk|ark|Bearer)[-_A-Za-z0-9]{6,}/gi;

function sanitizeReason(s) {
  return String(s == null ? '' : s).replace(SECRET_LIKE, '[redacted]').slice(0, 120);
}

function getJson(url, { headers, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch {
      return resolve({ ok: false, status: -1, reason: sanitizeReason('invalid url: ' + url) });
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return resolve({ ok: false, status: -1, reason: 'unsupported protocol: ' + u.protocol });
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: 'GET',
      timeout: timeoutMs,
      headers,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        if (buf.length > maxBytes) {
          // 先 resolve 再 destroy：旧实现先 destroy，end/error 都不再触发，promise 悬挂
          resolve({ ok: false, status: -2, reason: 'response too large' });
          req.destroy();
        }
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          // 体片段截 90 字符（诊断够用），拼好后统一脱敏 + 120 截断（reason 总长受限）
          const body = buf ? ': ' + buf.slice(0, 90) : '';
          return resolve({ ok: false, status: res.statusCode, reason: sanitizeReason('HTTP ' + res.statusCode + body) });
        }
        try { resolve({ ok: true, status: 200, data: JSON.parse(buf) }); }
        catch { resolve({ ok: false, status: 200, reason: 'bad json' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: -1, reason: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, status: -1, reason: sanitizeReason(e && e.message) }));
    req.end();
  });
}

// Promise 超时兜底：超时 resolve null（不 reject，调用方按「采集超时」降级，形态与旧实现一致）。
// p 先落定 → clearTimeout，race 胜出后不再留定时器尾；unref 保证定时器不单独挂住进程退出。
// p 的拒绝仍会从 race 透传（与旧实现一致，调用方自行 try/catch）；p.finally 派生 promise
// 的拒绝在这里吸收掉，避免 unhandled rejection。
function withTimeout(p, ms) {
  let t;
  const guard = new Promise((r) => { t = setTimeout(() => r(null), ms); });
  if (t && typeof t.unref === 'function') t.unref();
  Promise.resolve(p).finally(() => clearTimeout(t)).catch(() => {});
  return Promise.race([p, guard]);
}

// 请求元信息（状态码 + 响应头）：订阅类数据（subscription-userinfo）全在头上，body 可能上百 KB。
// 默认 HEAD 零字节下载；服务端 HEAD 不回头部时调用方可退回 method:'GET'（body 读到 maxBytes 即弃）。
// 契约与 getJson 一致：resolve 永不 reject；协议白名单、不跟随重定向、reason 过脱敏。
function requestMeta(url, { method = 'HEAD', headers, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = 1_048_576 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch {
      return resolve({ ok: false, status: -1, reason: sanitizeReason('invalid url: ' + url) });
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return resolve({ ok: false, status: -1, reason: 'unsupported protocol: ' + u.protocol });
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method,
      timeout: timeoutMs,
      headers,
    }, (res) => {
      let size = 0;
      let over = false;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { over = true; req.destroy(); } // 只为拿头的 GET 兜底：体超限照常带已收头返回
      });
      res.on('end', () => resolve({
        ok: res.statusCode === 200,
        status: res.statusCode,
        headers: res.headers || {},
        reason: res.statusCode !== 200 ? sanitizeReason('HTTP ' + res.statusCode) : (over ? 'response too large' : undefined),
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: -1, reason: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, status: -1, reason: sanitizeReason(e && e.message) }));
    req.end();
  });
}

module.exports = { getJson, requestMeta, sanitizeReason, withTimeout };
