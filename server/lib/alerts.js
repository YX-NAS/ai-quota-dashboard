'use strict';
// 额度预警引擎：评估快照 → 冷却去重 → webhook 推送（零 npm 依赖）
// 约束（docs/plans/v1.5-PLAN.md F2，含 P0 修订）：
// - 推送文案只含百分比/金额/倒计时，绝不含 token/密钥明细，控制泄露面；
// - 日志与 alert_log 绝不落完整 webhookUrl（path 即推送密钥），只允许出现 host；
// - 仅允许 http/https 协议，file:/data: 等显式抛错拒绝而非静默；不跟随重定向；
// - 10s 超时；失败不重试（下个评估周期受冷却约束自然再评估）；
// - run 入口整体 try/catch，任何异常不得逃逸成 unhandledRejection 拖垮主进程；
// - 冷却 key 用 resetAt 做窗口身份；resetAt 缺失用 fetchedAt+resetMsLeft 兜底时必须
//   5 分钟桶量化（否则倒计时每轮漂移几百毫秒、key 每轮不同，冷却永不命中）。
const http = require('node:http');
const https = require('node:https');
const { DatabaseSync } = require('node:sqlite');
const history = require('./history');

// 阈值 / 冷却缺省值（老 plans.json 可能只有部分字段，逐字段兜底）
const DEFAULTS = { fiveHour: 85, weekly: 85, dailyGoalPct: 100, cooldownMinutes: 60 };
const WINDOW_LABELS = { fiveHour: '5h', weekly: '周' };
// 三家实时额度在快照里的字段名 → 冷却 key 用的稳定 provider id
const PROVIDERS = [
  { id: 'zhipu', field: 'zhipuQuota' },
  { id: 'chatgpt', field: 'chatgptQuota' },
  { id: 'minimax', field: 'minimaxQuota' },
];
const BUCKET_MS = 300e3; // 5 分钟桶：resetMsLeft 兜底 key 的量化粒度
const SEND_TIMEOUT_MS = 10_000;

// 北京时间日期串 YYYY-MM-DD（与 store.js 的口径一致：UTC+8 后取 ISO 前 10 位）
const bjDate = ts => new Date(ts + 8 * 3600e3).toISOString().slice(0, 10);

// 有限数才采信，否则取默认（容忍手写配置里的字符串数字，剔除 NaN/空串）
function num(v, dft) {
  if (v == null || v === '') return dft;
  const n = Number(v);
  return Number.isFinite(n) ? n : dft;
}

// resetAt 归一为绝对毫秒：智谱给 epoch ms（Number），ChatGPT 给 ISO 字符串；其余视为缺失
function toResetAtMs(v) {
  if (Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const p = Date.parse(v);
    if (Number.isFinite(p)) return p;
  }
  return null;
}

// 掩码：保留 scheme://host/，path+query 一律整段 ••••（短 path 也不留任何明文片段）
function maskWebhookUrl(url) {
  const s = String(url || '');
  if (!s) return '';
  try {
    const u = new URL(s);
    const tail = u.pathname.replace(/\/+$/, '') + u.search; // 根路径 '/' 视为无敏感信息
    return u.origin + '/' + (tail ? '••••' : '');
  } catch { return '••••'; }
}

// 只取 host 用于日志（拿不到时也不回退原串，防密钥路径外泄）
function hostOf(url) {
  try { return new URL(url).host; } catch { return '(非法 URL)'; }
}

// 错误消息消毒：把完整 URL / path 片段替换为掩码形态，截断防超长串塞爆 alert_log
function sanitizeError(e, webhookUrl) {
  let msg = String((e && e.message) || e || '未知错误');
  const url = String(webhookUrl || '');
  if (url) {
    msg = msg.split(url).join(maskWebhookUrl(url));
    try {
      const u = new URL(url);
      const tail = u.pathname.replace(/\/+$/, '') + u.search;
      if (tail) msg = msg.split(tail).join('••••'); // path 单独出现也掩掉
    } catch { /* 已尽力 */ }
  }
  return msg.slice(0, 300);
}

// 倒计时文案：分钟级粒度足够（推送场景不做秒级精确）
function resetMessage(resetMs, now) {
  const mins = Math.round((resetMs - now) / 60e3);
  if (mins <= 0) return '窗口即将重置';
  if (mins < 60) return `约 ${mins} 分钟后重置`;
  const h = Math.floor(mins / 60);
  return `约 ${h} 小时${mins % 60 ? ` ${mins % 60} 分` : ''}后重置`;
}

// 评估（纯函数，不改入参）→ firing 事件列表，最多 3 provider × 2 窗口 + 当日目标 = 7 条
function evaluate(snapshot, plans, now = Date.now()) {
  const snap = snapshot || {};
  const alertsCfg = (plans && plans.alerts) || {};
  const th = alertsCfg.thresholds || {};
  const thresholds = {
    fiveHour: num(th.fiveHour, DEFAULTS.fiveHour),
    weekly: num(th.weekly, DEFAULTS.weekly),
    dailyGoalPct: num(th.dailyGoalPct, DEFAULTS.dailyGoalPct),
  };
  const events = [];

  // 1) 三家 provider × {5h, 周窗口}：available 且 usedPercent ≥ 阈值才触发
  for (const p of PROVIDERS) {
    const q = snap[p.field];
    if (!q || !q.available) continue;
    const provider = String(q.provider || p.id);
    for (const winId of ['fiveHour', 'weekly']) {
      const win = q[winId] || {};
      const pct = Number(win.usedPercent);
      if (!Number.isFinite(pct) || pct < thresholds[winId]) continue;
      const resetAtMs = toResetAtMs(win.resetAt);
      let resetGuess = resetAtMs; // 文案倒计时用的近似重置时刻
      let identity;               // 冷却身份（窗口身份）
      if (resetAtMs != null) {
        identity = String(Math.round(resetAtMs)); // 绝对时刻天然稳定，直接入 key
      } else {
        // Number(null) === 0 是有限数：必须先挡 null/undefined，否则会造出伪身份
        const rawLeft = win.resetMsLeft;
        const msLeft = rawLeft == null ? null : Number(rawLeft);
        const rawFetched = q.fetchedAt;
        const fetchedAt = rawFetched == null ? null : Number(rawFetched);
        // P0 修订：无 resetAt 且无 resetMsLeft（或已过期/非法）→ 无稳定冷却身份，
        // 宁可不发也不能裸发（会每轮重复推送）
        if (msLeft == null || !Number.isFinite(msLeft) || msLeft <= 0
          || fetchedAt == null || !Number.isFinite(fetchedAt)) continue;
        const v = fetchedAt + msLeft;
        // P0 修订：fetchedAt+resetMsLeft 每轮采集漂移几百毫秒，直接入 key 冷却永不命中；
        // 必须 5 分钟桶量化后再入 key（~ 前缀标记兜底身份，便于排查）
        identity = '~' + Math.round(v / BUCKET_MS);
        resetGuess = v;
      }
      events.push({
        kind: 'quota',
        key: `${p.id}|${winId}|${identity}`,
        provider,
        window: winId,
        percent: Math.round(pct),
        resetAt: resetAtMs, // 兜底场景如实给 null（generic data 不造假）
        severity: pct >= 95 ? 'critical' : 'warning',
        title: `⚠️ ${provider} ${WINDOW_LABELS[winId]}窗口已用 ${Math.round(pct)}%`,
        message: resetGuess != null ? resetMessage(resetGuess, now) : '',
      });
    }
  }

  // 2) 当日目标：今日 __total 人民币口径（costCny + equivalentCny，与网页横幅一致）
  //    / dailyGoal.cny ≥ dailyGoalPct；仅 goal > 0 时启用
  const goal = num((plans && plans.dailyGoal || {}).cny, 0);
  if (goal > 0) {
    const today = bjDate(now);
    const tot = ((snap.agg && snap.agg.daily && snap.agg.daily[today]) || {}).__total;
    if (tot) {
      const spent = (tot.costCny || 0) + (tot.equivalentCny || 0);
      const pctRaw = spent / goal * 100;
      if (pctRaw >= thresholds.dailyGoalPct) { // 用未取整比值比较，避免 99.6% 被 round 成 100 提前触发
        events.push({
          kind: 'goal',
          key: `goal|${today}`, // 目标事件以「北京时间日期」为冷却身份，一天一冷却窗
          provider: '当日目标',
          window: 'daily',
          percent: Math.round(pctRaw),
          resetAt: null,
          severity: pctRaw >= 100 ? 'critical' : 'warning',
          title: `💸 今日 AI 成本 ¥${Math.round(spent)} / 目标 ¥${Math.round(goal)}（${Math.round(pctRaw)}%）`,
          message: spent >= goal ? '已超支' : '接近目标',
        });
      }
    }
  }
  return events;
}

// —— 冷却存储：依赖注入式接口 { get(key) → last_fired_at|null, set(key, firedAt, status) } ——

// 进程内存兜底实现（AI_QUOTA_HISTORY=0 或库不可用时；重启冷却清零会重推一次，手册注明）
function createMemoryStore() {
  const map = new Map();
  return {
    backend: 'memory',
    get(key) { const v = map.get(key); return v ? v.firedAt : null; },
    set(key, firedAt, status) { map.set(key, { firedAt, status }); },
  };
}

// history.sqlite 的 alert_log 表实现：可传入已打开的 DatabaseSync，或传 path 惰性打开。
// 任何 SQL 失败（坏库/锁死/磁盘满）自动退化为内存实现——冷却库坏了预警不能跟着哑掉。
function createSqliteStore(opts = {}) {
  const ALERT_LOG_SQL = `
    CREATE TABLE IF NOT EXISTS alert_log (
      rule_key TEXT PRIMARY KEY,
      last_fired_at INTEGER,
      status TEXT
    );`;
  let conn = null;     // 惰性持有连接
  let impl = null;     // SQL 实现（成功初始化后缓存）
  let mem = null;      // 退化标记：非 null 即已切内存
  const sql = () => {
    if (!conn) {
      conn = opts.db || new DatabaseSync(opts.path); // 二选一：注入连接或按路径打开
      try { conn.exec('PRAGMA busy_timeout=3000'); } catch { /* 只影响并发等待 */ }
    }
    conn.exec(ALERT_LOG_SQL);
    return {
      get: key => {
        const r = conn.prepare('SELECT last_fired_at AS at FROM alert_log WHERE rule_key = ?').get(String(key));
        return r ? r.at : null;
      },
      set: (key, firedAt, status) => conn.prepare(`
        INSERT INTO alert_log (rule_key, last_fired_at, status) VALUES (?, ?, ?)
        ON CONFLICT(rule_key) DO UPDATE SET last_fired_at = excluded.last_fired_at, status = excluded.status
      `).run(String(key), Number(firedAt), String(status || 'success')),
    };
  };
  const cur = () => {
    if (mem) return mem;
    if (!impl) {
      try { impl = sql(); } catch { mem = createMemoryStore(); return mem; }
    }
    return impl;
  };
  return {
    backend: 'sqlite',
    get(key) { try { return cur().get(key); } catch { mem = createMemoryStore(); return mem.get(key); } },
    set(key, firedAt, status) { try { cur().set(key, firedAt, status); } catch { mem = createMemoryStore(); mem.set(key, firedAt, status); } },
  };
}

// run 的默认冷却库：与历史归档共用 history.sqlite 连接（单例）；
// AI_QUOTA_HISTORY=0 或库不可用（open 返回 null）→ 进程内存兜底
function defaultStore() {
  if (process.env.AI_QUOTA_HISTORY === '0') return createMemoryStore();
  try {
    const conn = history.open();
    if (!conn) return createMemoryStore();
    return createSqliteStore({ db: conn });
  } catch { return createMemoryStore(); }
}

// —— 适配器：buildPayload(webhookUrl, title, message[, extra]) → { url, headers, body } ——

const ADAPTERS = {
  // ntfy：从 webhookUrl 提取 topic（path 去首尾斜杠，支持逗号分隔多 topic），POST 到站点根。
  // P0 修订：中文标题只走 JSON body，绝不进 HTTP header——Node 对非 latin1 header 值
  // 会同步抛 ERR_INVALID_CHAR，未捕获可崩服务。
  ntfy: {
    buildPayload(webhookUrl, title, message) {
      const u = new URL(webhookUrl);
      const topic = u.pathname.replace(/^\/+|\/+$/g, '');
      if (!topic) throw new Error('ntfy topic 缺失：webhookUrl 需形如 https://ntfy.sh/<topic>');
      return {
        url: u.origin + '/' + u.search, // 站点根（保留 query 以兼容 ?auth= 等鉴权参数）
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ topic, title, message, priority: 'default', tags: ['warning'] }),
      };
    },
  },
  // bark：POST 原 URL（https://api.day.app/<key>）
  bark: {
    buildPayload(webhookUrl, title, message) {
      return {
        url: webhookUrl,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ title, body: message, group: 'ai-quota' }),
      };
    },
  },
  // serverchan：POST 原 URL，form 编码；title/desp 含中文与 Markdown，必须 URLSearchParams 编码，禁手拼
  serverchan: {
    buildPayload(webhookUrl, title, message) {
      return {
        url: webhookUrl,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title, desp: message }).toString(),
      };
    },
  },
  // generic：任意 URL，结构化 JSON（severity 供接收方分级路由）
  generic: {
    buildPayload(webhookUrl, title, message, extra = {}) {
      return {
        url: webhookUrl,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          title,
          message,
          severity: extra.severity === 'critical' ? 'critical' : 'warning',
          source: 'ai-quota-dashboard',
          data: { percent: extra.percent ?? null, resetAt: extra.resetAt ?? null },
        }),
      };
    },
  },
};

// 默认 sender：node:http/https 按协议选择；绝不 reject（失败以 { ok:false, error } 返回），
// 不跟随重定向（3xx 一律按失败处理，防把含密钥的 payload 送到 Location 目标）
function httpRequest(url, { method = 'POST', headers = {}, body = '' } = {}, timeoutMs = SEND_TIMEOUT_MS) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, status: 0, error: 'URL 非法' }); }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) return resolve({ ok: false, status: 0, error: `协议不支持: ${u.protocol}` });
    const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const req = mod.request(u, {
      method,
      headers: Object.assign({ 'Content-Length': data.length }, headers),
      timeout: timeoutMs,
    }, res => {
      const status = res.statusCode || 0;
      res.resume(); // 响应体不消费，只关心状态码
      if (status >= 300 && status < 400) return resolve({ ok: false, status, error: `重定向被拒绝 (HTTP ${status})` });
      resolve(status >= 200 && status < 300
        ? { ok: true, status }
        : { ok: false, status, error: `HTTP ${status}` });
    });
    req.on('timeout', () => req.destroy(new Error(`超时 (${timeoutMs}ms)`))); // timeout 事件不自动断请求，需显式 destroy
    req.on('error', e => resolve({ ok: false, status: 0, error: e.message }));
    req.end(data);
  });
}

// 发送：协议校验同步抛错（显式拒绝而非静默），IO 部分返回 Promise（fire-and-forget 由调用方掌握）。
// sender 可注入（测试传 fake sender，不发真请求）。
function send(adapter, event, deps = {}) {
  const a = typeof adapter === 'string' ? (ADAPTERS[adapter] || ADAPTERS.generic) : adapter;
  const ev = event || {};
  const url = String(ev.webhookUrl || '');
  let u;
  try { u = new URL(url); } catch { throw new Error('webhookUrl 非法'); }
  // 协议白名单：仅 http/https；file:/data: 等显式抛错（防 SSRF 触达本机文件与伪协议）
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`webhook 协议被拒绝: ${u.protocol}（仅允许 http/https）`);
  }
  const payload = a.buildPayload(url, ev.title, ev.message, {
    severity: ev.severity, percent: ev.percent, resetAt: ev.resetAt ?? null,
  });
  // 适配器可能改写目标 URL（ntfy 走站点根）：复核协议白名单
  let u2;
  try { u2 = new URL(payload.url); } catch { throw new Error('适配器目标 URL 非法'); }
  if (u2.protocol !== 'https:' && u2.protocol !== 'http:') {
    throw new Error(`目标协议被拒绝: ${u2.protocol}（仅允许 http/https）`);
  }
  const sender = deps.sender || httpRequest;
  return Promise.resolve()
    .then(() => sender(payload.url, { method: 'POST', headers: payload.headers, body: payload.body }, SEND_TIMEOUT_MS))
    .then(res => {
      if (!res || res.ok !== true) throw new Error((res && res.error) || `HTTP ${(res && res.status) || 0}`);
      return res;
    });
}

// 入口：评估 → 冷却去重 → 逐条发送。enabled=false 或 webhookUrl 空 → 直接返回不发请求。
// 单条 send 失败只记 alert_log 状态不抛，不影响其余发送与主流程。
async function run(snapshot, plans, deps = {}) {
  const out = { sent: 0, suppressed: 0, events: 0 };
  try {
    const cfg = (plans && plans.alerts) || {};
    if (!cfg.enabled || !cfg.webhookUrl) return out;
    const type = ADAPTERS[cfg.webhookType] ? cfg.webhookType : 'generic'; // 未知类型兜底 generic
    const cooldownMs = num(cfg.cooldownMinutes, DEFAULTS.cooldownMinutes) * 60e3;
    const store = deps.store || defaultStore();
    const sender = deps.sender;
    const now = deps.now || Date.now();
    const events = evaluate(snapshot, plans, now);
    out.events = events.length;
    for (const ev of events) {
      let last = null;
      try { last = store.get(ev.key); } catch { last = null; }
      if (Number.isFinite(last) && now - last < cooldownMs) { out.suppressed++; continue; } // 冷却窗内抑制
      try {
        await send(type, Object.assign({}, ev, { webhookUrl: String(cfg.webhookUrl) }), { sender });
        try { store.set(ev.key, now, 'success'); } catch { /* 冷却库写失败不影响主流程 */ }
        out.sent++;
      } catch (e) {
        // 失败也占用冷却窗（失败不重试，下个评估周期受冷却约束自然再评估）；
        // 只记失败原因，绝不落完整 webhookUrl（path 即密钥）；console 同样只允许 host
        const reason = sanitizeError(e, cfg.webhookUrl);
        try { store.set(ev.key, now, 'failed: ' + reason); } catch { /* 尽力 */ }
        console.error('[alerts] 推送失败 %s: %s', hostOf(cfg.webhookUrl), reason);
      }
    }
    return out;
  } catch (e) {
    // 整体兜底：任何异常（快照形状异常等）都不得逃逸成 unhandledRejection
    console.error('[alerts] 评估异常:', e && e.message);
    return Object.assign(out, { error: String((e && e.message) || e) });
  }
}

module.exports = {
  evaluate, send, run, httpRequest,
  maskWebhookUrl, hostOf, sanitizeError,
  createMemoryStore, createSqliteStore, defaultStore,
  ADAPTERS, DEFAULTS,
};
