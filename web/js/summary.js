// 今日速览（v1.8）：首屏一句话结论，替用户把「今天什么情况」先算出来
// 设计原则：只做「看完这行就知道要不要点进去」的判断，不重复 KPI 的原始数字；
// 单个维度缺数据就整条不显示，绝不用 0 占位（0 会被读成「今天没花钱」）。
import { fmtCny, cny, todayKey } from './utils.js';
import { snap, toolDay } from './state.js';
import { TOOLS } from './render-cards.js';

const nameOf = key => (TOOLS.find(t => t.key === key) || {}).name || key;

// 近 N 天（不含今天）该工具日均，用于「今天是否异常」判断
function recentAvg(toolKey, n = 7) {
  const today = todayKey();
  const keys = snap.agg.dailyKeys.filter(d => d < today).slice(-n);
  if (!keys.length) return null;
  let sum = 0;
  for (const d of keys) { const a = toolDay(d, toolKey); if (a) sum += cny(a); }
  return sum / keys.length;
}

// 额度最紧的一条：三家实时额度里已用%最高的；都不可用返回 null
function tightestQuota() {
  const cands = [
    ['ChatGPT', snap.chatgptQuota],
    ['智谱 Coding Plan', snap.zhipuQuota],
    ['MiniMax', snap.minimaxQuota],
  ];
  let best = null;
  for (const [name, q] of cands) {
    if (!q || !q.available) continue;
    // 取 5h 与周窗口里更紧的那个
    for (const w of [q.fiveHour, q.weekly]) {
      if (!w || w.usedPercent == null) continue;
      if (!best || w.usedPercent > best.usedPercent) best = { name, usedPercent: w.usedPercent, window: w === q.fiveHour ? '5h' : '周' };
    }
  }
  return best;
}

export function renderTodaySummary() {
  const box = document.getElementById('todaySummary');
  if (!box || !snap) return;
  const today = todayKey();
  const t = (snap.agg.daily[today] || {}).__total;
  const spent = t ? cny(t) : 0;
  // 没有任何用量也没有任何额度数据：不渲染，避免新装用户看到一排「—」
  const hasUsage = spent > 0 || (t && t.requests > 0);
  if (!hasUsage) { box.innerHTML = ''; return; }

  const chips = [];

  // 1) vs 昨日同期
  const y = snap.cmp && snap.cmp.yesterdaySameTime && snap.cmp.yesterdaySameTime.total;
  if (y && y.cny > 0.005) {
    const d = (spent - y.cny) / y.cny * 100;
    const cls = d >= 0 ? 'up' : 'down';
    chips.push(`<span class="chip">昨日同期 <b class="${cls}">${d >= 0 ? '↑' : '↓'}${Math.abs(d).toFixed(0)}%</b></span>`);
  }

  // 2) 全天预计（当日外推，不足 6 小时不显示——见 server/lib/forecast.js）
  const fToday = snap.forecast && snap.forecast.today;
  if (fToday && fToday.ok) {
    const goal = (snap.plans.dailyGoal || {}).cny || 0;
    const over = goal > 0 && fToday.projectedCny > goal;
    chips.push(`<span class="chip">预计全天 <b>${fmtCny(fToday.projectedCny)}</b>${over ? ' <span class="warn-txt">将超目标</span>' : ''}</span>`);
  }

  // 3) 最烧钱的工具（今日占比）
  let top = null;
  for (const tool of TOOLS) {
    const a = toolDay(today, tool.key);
    if (!a) continue;
    const v = cny(a);
    if (v > 0 && (!top || v > top.v)) top = { key: tool.key, v };
  }
  if (top && spent > 0) {
    const pct = Math.round(top.v / spent * 100);
    chips.push(`<span class="chip">今日主要花钱：<b>${nameOf(top.key)}</b> ${fmtCny(top.v)}（${pct}%）</span>`);
  }

  // 4) 额度最紧
  const q = tightestQuota();
  if (q) {
    const left = Math.round((100 - q.usedPercent) * 10) / 10;
    const cls = q.usedPercent > 85 ? 'warn-txt' : '';
    chips.push(`<span class="chip">额度最紧：<b>${q.name}</b> ${q.window} 剩 <b class="${cls}">${left}%</b></span>`);
  }

  // 5) 异常提示：今日消耗显著高于近 7 天日均（需已花过 ¥1 才判断，避免极小值放大）
  if (top && spent >= 1) {
    const avg = recentAvg(top.key);
    if (avg != null && avg > 0.5 && top.v > avg * 1.8) {
      chips.push(`<span class="chip alert">⚠ ${nameOf(top.key)} 今日 ${fmtCny(top.v)}，是近 7 天日均的 ${(top.v / avg).toFixed(1)} 倍</span>`);
    }
  }

  box.innerHTML = chips.length ? `<div class="today-summary"><span class="ts-lead">今日速览</span>${chips.join('')}</div>` : '';
}