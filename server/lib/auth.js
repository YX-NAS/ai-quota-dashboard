'use strict';
// 登录鉴权（v1.7，云端部署用）：本地默认模式完全不启用，行为与 v1.6 逐位一致。
//
// 零密钥上云（设计约束，见 docs/DEPLOY.md）：
// - 凭据只来自 ① 环境变量 AQD_AUTH_USER + AQD_AUTH_PASS_HASH（优先）② config/auth.json（0600，gitignored）；
// - 明文密码不入库、不进 git；auth.json 只存 scrypt 哈希（不可逆），云端同样只放哈希；
// - 校验用 timingSafeEqual，登录尝试按来源 IP 限流（5 分钟 10 次失败 → 429），配合 HTTPS 反代即可公网部署。
//
// 会话：进程内存 token 表（7 天 TTL + 滑动续期；重启需重新登录——纯展示看板可接受，文档注明）。
// Cookie：aqd_session HttpOnly + SameSite=Lax（阻断跨站 POST 驱动，与现有 CSRF 口径一致）；
// 反代 TLS 场景设 AQD_COOKIE_SECURE=1 追加 Secure 标记。
// 本机豁免：来源地址为回环 且 Host 为 localhost 系 → 跳过鉴权（菜单栏/桌面组件/MCP 零改动）。
// 反代转发时 Host=域名（即便 socket 是 127.0.0.1）不豁免，鉴权照常生效——豁免判据以 Host 为准。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const plansStore = require('./plans');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const SESSION_TTL_MS = 7 * 86400e3;
const RATE_WINDOW_MS = 5 * 60e3;
const RATE_MAX_FAILS = 10;
const COOKIE_NAME = 'aqd_session';

// —— 凭据读取（auth.json 10s mtime 缓存：文件覆盖后自动感知，测试无需重启） ——
const AUTH_FILE = () => path.join(plansStore.CONFIG_DIR, 'auth.json');
let credCache = { key: '', cred: null };
function getCredentials() {
  if (process.env.AQD_AUTH_DISABLED === '1') return null;
  const eu = process.env.AQD_AUTH_USER;
  const eh = process.env.AQD_AUTH_PASS_HASH;
  if (eu && eh) return { user: String(eu), passHash: String(eh) };
  const ep = process.env.AQD_AUTH_PASS; // 明文 env 便利通道（部署首启可用，之后建议换 hash）
  if (eu && ep) return { user: String(eu), passPlain: String(ep) };
  let st = null;
  try { st = fs.statSync(AUTH_FILE()); } catch { return null; }
  const key = st.mtimeMs + '|' + st.size + '|' + AUTH_FILE();
  if (credCache.key === key) return credCache.cred;
  let cred = null;
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE(), 'utf8'));
    if (j && typeof j.user === 'string' && typeof j.passHash === 'string' && j.user && j.passHash) {
      cred = { user: j.user, passHash: j.passHash };
    }
  } catch { cred = null; }
  credCache = { key, cred };
  return cred;
}

function isEnabled() { return getCredentials() != null; }

// 本机豁免判据：来源地址是回环 且 Host 是本机主机名 —— 菜单栏/桌面组件/MCP/运维 curl 免登录继续可用。
// 经反代（nginx/Caddy）的公网流量 Host=部署域名（反代需 proxy_set_header Host $host，见 docs/DEPLOY.md），
// 不满足本机豁免 → 强制登录。反代若未转发 Host（Node 看到 127.0.0.1:port）会命中豁免 —— 属部署错误，
// DEPLOY 清单第 3 条明确要求核对；AQD_TRUST_PROXY=0 时连本机豁免也一并关闭（全部要登录）。
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function isLocalExempt(req) {
  if (process.env.AQD_TRUST_PROXY === '0') return false;
  const ra = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!LOOPBACK_ADDRS.has(ra) && ra !== '127.0.0.1') return false;
  let hostname = '';
  try { hostname = new URL('http://' + (req.headers.host || '')).hostname; } catch { return false; }
  return LOCAL_HOSTS.has(hostname);
}

// scrypt 哈希格式：scrypt$N$r$p$<saltB64>$<hashB64>
function hashPassword(pass) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pass), salt, 32, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(pass, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (![N, r, p].every(Number.isInteger) || N <= 0 || r <= 0 || p <= 0) return false;
  try {
    const salt = Buffer.from(parts[4], 'base64');
    const want = Buffer.from(parts[5], 'base64');
    const got = crypto.scryptSync(String(pass), salt, want.length, { N, r, p });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch { return false; } // 非法 base64 / 参数越界（DoS 面：N 来自文件仍受格式约束）
}

function checkCredential(pass, cred) {
  if (cred.passPlain != null) {
    const a = Buffer.from(String(pass)), b = Buffer.from(String(cred.passPlain));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return verifyPassword(pass, cred.passHash);
}

// —— 会话表（进程内存） ——
const sessions = new Map(); // token → { user, exp }
function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, exp: Date.now() + SESSION_TTL_MS });
  return token;
}
function parseCookies(header) {
  const out = {};
  for (const kv of String(header || '').split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  }
  return out;
}
function checkSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (s.exp <= now) { sessions.delete(token); return null; }
  s.exp = now + SESSION_TTL_MS; // 滑动续期
  return s.user;
}
function destroySession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) sessions.delete(token);
  return token || null;
}
// 登出同时清内存里已过期的条目，防长跑进程无界增长
function sweepSessions() {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp <= now) sessions.delete(t);
}

// —— 登录限流（来源 IP 维度；反代后所有来源同 IP 属已知限制，文档注明） ——
const rate = new Map(); // ip → { fails, resetAt }
function rateLimited(ip, now = Date.now()) {
  const r = rate.get(ip);
  if (!r || now >= r.resetAt) return false;
  return r.fails >= RATE_MAX_FAILS;
}
function rateRecord(ip, ok, now = Date.now()) {
  if (ok) { rate.delete(ip); return; }
  const r = rate.get(ip);
  if (!r || now >= r.resetAt) rate.set(ip, { fails: 1, resetAt: now + RATE_WINDOW_MS });
  else r.fails++;
}

function login(user, pass, ip, now = Date.now()) {
  const cred = getCredentials();
  if (!cred) return { ok: false, code: 503, error: '鉴权未配置' };
  if (rateLimited(ip, now)) return { ok: false, code: 429, error: '尝试过多，请 5 分钟后再试' };
  const userOk = Buffer.from(String(user)).length === Buffer.from(cred.user).length
    && crypto.timingSafeEqual(Buffer.from(String(user)), Buffer.from(cred.user));
  const passOk = checkCredential(pass, cred);
  if (!userOk || !passOk) {
    rateRecord(ip, false, now);
    return { ok: false, code: 401, error: '用户名或密码错误' };
  }
  rateRecord(ip, true, now);
  return { ok: true, token: createSession(cred.user), user: cred.user };
}

// 组 Set-Cookie 头值（登录成功）；logout 用清空形态
function sessionCookie(token, { secure, maxAge = SESSION_TTL_MS / 1000 } = {}) {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAge)}`
    + (secure ? '; Secure' : '');
}

module.exports = {
  isEnabled, getCredentials, isLocalExempt, hashPassword, verifyPassword,
  login, checkSession, destroySession, sweepSessions,
  parseCookies, sessionCookie, COOKIE_NAME,
  SESSION_TTL_MS, RATE_MAX_FAILS, RATE_WINDOW_MS, AUTH_FILE,
};
