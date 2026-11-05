'use strict';
// 定时推送调度器：每日摘要 + 周报/月报（零 npm 依赖）。
// 设计约束（与 alerts.js 同源的安全哲学）：
// - 无 cron：挂在快照构建成功后（60s 周期）逐轮检查「到点未发」；
// - 去重复用 history.sqlite 的 alert_log（rule_key 带 digest|/report| 前缀，与预警键空间天然不冲突）；
// - 错过补发仅限当天/当期自然日内：21:00 的摘要 23:00 开机会补推，周二开机不补周一周报；
// - 失败也写 store（失败不重试，本期不再补试 —— 与 alerts.run「失败占冷却窗」一致）；
// - 通道完全复用 alerts 的 webhookType/webhookUrl + ADAPTERS + send
//   （协议白名单 / 拒重定向 / 企业微信 errcode 校验 / 错误消毒全部继承）；
// - 推送文案只含百分比/金额/次数，绝不含 token/密钥；日志只允许出现 host。
// 北京时间日期/月份取自 server/lib/bjtime.js（单一事实源，与 store/alerts/report 同口径），
// 本文件只保留调度特有的 bjHour/bjDay。
const alerts = require('./alerts');
const { buildReport, weekStart, TOOL_LABELS } = require('./report');
const { bjDate, bjMonth } = require('./bjtime');

const BJ = 8 * 3600e3; // 北京时区偏移

// 北京时间小时（0~23）/ 日（1~31）
const bjHour = ts => new Date(ts + BJ).getUTCHours();
const bjDay = ts => Number(bjDate(ts).slice(8, 10));

// 有限数才采信，否则取默认（容忍手写配置里的字符串数字）
function num(v, dft) {
  if (v == null || v === '') return dft;
  const n = Number(v);
  return Number.isFinite(n) ? n : dft;
}

const fmtCny = n => '¥' + (n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const fmtInt = n => (n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
const fmtTok = n => n >= 1e8 ? (n / 1e8).toFixed(2) + '亿' : n >= 1e4 ? (n / 1e4).toFixed(1) + '万' : fmtInt(n);

const WINDOW_LABELS = { fiveHour: '5h', weekly: '周' };
const PROVIDERS = [
  { id: 'zhipu', field: 'zhipuQuota' },
  { id: 'chatgpt', field: 'chatgptQuota' },
  { id: 'minimax', field: 'minimaxQuota' },
];

// ---------- 每日摘要（纯函数，不改入参） ----------

// buildDigest(snapshot, plans, now) → { title, message, card }，供 send 直接消费。
// card 为多行 Markdown：总量行 / 目标进度 / 工具 Top3 / 三家实时窗口快照（available 才列）。
function buildDigest(snapshot, plans, now = Date.now()) {
  const snap = snapshot || {};
  const today = bjDate(now);
  const day = (snap.agg && snap.agg.daily && snap.agg.daily[today]) || {};
  const tot = day.__total || {};
  const spent = (tot.costCny || 0) + (tot.equivalentCny || 0);
  const tokens = (tot.inputTokens || 0) + (tot.outputTokens || 0);
  const goal = num((plans && plans.dailyGoal || {}).cny, 0);
  const goalPct = goal > 0 ? Math.round(spent / goal * 100) : null;

  const title = goal > 0
    ? `📊 今日 AI 消耗 ${fmtCny(spent)}（目标 ${goalPct}%）`
    : `📊 今日 AI 消耗 ${fmtCny(spent)}`;

  const lines = [`今日 ${fmtInt(tot.requests || 0)} 次请求 · ${fmtTok(tokens)} tokens`];
  if (goal > 0) lines.push(`当日目标 ${fmtCny(goal)} · 已用 ${goalPct}%`);

  const tools = Object.entries(day)
    .filter(([k, a]) => k !== '__total' && a && typeof a === 'object')
    .map(([k, a]) => ({ tool: k, cny: (a.costCny || 0) + (a.equivalentCny || 0), req: a.requests || 0 }))
    .sort((a, b) => b.cny - a.cny)
    .slice(0, 3);
  if (tools.length) {
    lines.push('', '工具 Top3');
    for (const t of tools) lines.push(`· ${TOOL_LABELS[t.tool] || t.tool} ${fmtCny(t.cny)}（${fmtInt(t.req)} 次）`);
  }

  const quota = [];
  for (const p of PROVIDERS) {
    const q = snap[p.field];
    if (!q || !q.available) continue;
    const parts = [];
    for (const w of ['fiveHour', 'weekly']) {
      const pct = Number((q[w] || {}).usedPercent);
      if (Number.isFinite(pct)) parts.push(`${WINDOW_LABELS[w]} ${Math.round(pct)}%`);
    }
    if (parts.length) quota.push(`· ${q.provider || p.id}：${parts.join(' / ')}`);
  }
  if (quota.length) lines.push('', '窗口用量', ...quota);

  return { title, message: lines.join('\n'), card: lines.join('\n') };
}

// ---------- 调度入口 ----------

// runScheduled(snapshot, plans, deps)：每次快照构建成功后调用（fire-and-forget）。
// deps = { store（默认 alert_log）, sender（测试注入）, now }。
// 返回 { sent, held, empty, failed } 计数，任何异常不逃逸（catch-all 与 alerts.run 一致）。
async function runScheduled(snapshot, plans, deps = {}) {
  const out = { sent: 0, held: 0, empty: 0, failed: 0 };
  try {
    const cfg = (plans && plans.alerts) || {};
    if (!cfg.enabled || !cfg.webhookUrl) return out;
    const type = alerts.ADAPTERS[cfg.webhookType] ? cfg.webhookType : 'generic'; // 未知类型兜底 generic
    const store = deps.store || alerts.defaultStore();
    const sender = deps.sender;
    const now = deps.now || Date.now();
    const agg = (snapshot || {}).agg;

    // 单任务：本期已发（含已尝试失败）→ held；构建结果为空 → empty（不记录，本期晚些有数据再推）；
    // 推送成功/失败都写 store，本期不再重试。
    const fire = async (key, build) => {
      let last = null;
      try { last = store.get(key); } catch { last = null; }
      if (Number.isFinite(last)) return 'held';
      const ev = build();
      if (!ev) return 'empty';
      try {
        await alerts.send(type, Object.assign({}, ev, {
          webhookUrl: String(cfg.webhookUrl), severity: ev.severity || 'info',
        }), { sender });
        try { store.set(key, now, 'success'); } catch { /* 冷却库写失败不影响主流程 */ }
        return 'sent';
      } catch (e) {
        // 失败也占本期（不重试）；错误消息消毒后只记 host，绝不落完整 webhookUrl
        const reason = alerts.sanitizeError(e, cfg.webhookUrl);
        try { store.set(key, now, 'failed: ' + reason); } catch { /* 尽力 */ }
        console.error('[push] 推送失败 %s: %s', alerts.hostOf(cfg.webhookUrl), reason);
        return 'failed';
      }
    };
    const tally = st => { if (out[st] != null) out[st]++; };

    // 1) 每日摘要：北京时间当天 hour 点后且当天未发（当天内开机补推）
    const dg = cfg.digest || {};
    if (dg.enabled && bjHour(now) >= num(dg.hour, 21)) {
      tally(await fire('digest|' + bjDate(now), () => buildDigest(snapshot, plans, now)));
    }
    // 2) 周报：仅北京时间周一（weekStart(now)===今天），推上一期（offset=1）；键以本周一日期为身份。
    //    报告正文去掉首行 H1（wecom 适配器会用彩色加粗标题，避免重复）。
    const rw = ((cfg.reportPush || {}).week) || {};
    if (rw.enabled && weekStart(now) === bjDate(now) && bjHour(now) >= num(rw.hour, 9)) {
      tally(await fire('report|week|' + weekStart(now), () => {
        const r = buildReport(agg, plans, { type: 'week', offset: 1, format: 'list' }, now);
        if (!r.data.hasData) return null; // 上周无数据不推；当天晚些归档出数据会再评估
        return { title: r.title, message: r.markdown, card: r.markdown.split('\n').slice(1).join('\n').trim() };
      }));
    }
    // 3) 月报：仅北京时间每月 1 号，推上一月；键以本月为身份
    const rm = ((cfg.reportPush || {}).month) || {};
    if (rm.enabled && bjDay(now) === 1 && bjHour(now) >= num(rm.hour, 9)) {
      tally(await fire('report|month|' + bjMonth(now), () => {
        const r = buildReport(agg, plans, { type: 'month', offset: 1, format: 'list' }, now);
        if (!r.data.hasData) return null;
        return { title: r.title, message: r.markdown, card: r.markdown.split('\n').slice(1).join('\n').trim() };
      }));
    }
    return out;
  } catch (e) {
    console.error('[push] 调度异常:', e && e.message);
    return Object.assign(out, { error: String((e && e.message) || e) });
  }
}

module.exports = { buildDigest, runScheduled, bjDate, bjHour, bjDay, bjMonth };
