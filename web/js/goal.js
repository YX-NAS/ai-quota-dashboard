// 当日目标成本（预算横幅）与本月预估
import { fmtCny, todayKey, cny } from './utils.js';
import { snap, toolDay } from './state.js';

// 昨日同期对比：涨=绿（投入更多视为正向，与目标成本的预警只在横幅/菜单栏体现）
export function cmpDelta(today, yesterday) {
  if (!yesterday || yesterday <= 0.005) return '';
  const d = (today - yesterday) / yesterday * 100;
  const arrow = d >= 0 ? '↑' : '↓';
  return `<span class="d ${d >= 0 ? 'up' : 'down'}">vs 昨日同期 ${fmtCny(yesterday)} ${arrow}${Math.abs(d).toFixed(0)}%</span>`;
}

// ---------- 当日目标成本（预算横幅） ----------
// 进度分档提示语：随预算消耗升温，用完转超支预警
function goalTier(pct) {
  if (pct <= 0) return { msg: '新的一天，预算已就位', cls: 'g0' };
  if (pct < 25) return { msg: '预算充裕，安心使用', cls: 'g25' };
  if (pct < 50) return { msg: '消耗平稳，余量尚多', cls: 'g25' };
  if (pct < 75) return { msg: '已用过半，留意消耗节奏', cls: 'g50' };
  if (pct < 100) return { msg: '预算将尽，优先安排要紧任务', cls: 'g75' };
  if (pct < 150) return { msg: '当日目标成本已用完，再跑就要超支了', cls: 'g100' };
  return { msg: '已大幅超出当日目标成本，建议收敛或上调目标', cls: 'g100' };
}
// 按北京时间今日已过时长外推的预算耗尽预测
function goalEta(spent, target) {
  if (spent <= 0 || spent >= target) return '';
  const bjNow = Date.now() + 8 * 3600e3;
  const bjMsToday = bjNow % 86400e3;             // 北京时间今日已过毫秒
  if (bjMsToday < 20 * 60e3) return '';           // 刚过零点速率无意义
  const rate = spent / bjMsToday;                 // ¥/ms
  const etaMs = (target - spent) / rate;
  if (etaMs + bjMsToday > 86400e3) return '按当前节奏今天用不完预算';
  const eta = new Date(Date.now() + etaMs + 8 * 3600e3).toISOString().slice(11, 16);
  return `按当前节奏预计 ${eta} 用完预算`;
}
export function renderGoalBanner() {
  const goal = (snap.plans.dailyGoal || {}).cny || 0;
  const box = document.getElementById('goalBanner');
  if (!goal) { box.innerHTML = ''; return; }
  const today = todayKey();
  const t = (snap.agg.daily[today] || {}).__total;
  const spent = t ? cny(t) : 0;
  const pct = Math.min(spent / goal * 100, 999);
  const tier = goalTier(pct);
  const eta = goalEta(spent, goal);
  const left = spent >= goal ? `超出目标 ¥${(spent - goal).toFixed(0)}` : `剩余预算 ¥${(goal - spent).toFixed(0)}`;
  const ySame = snap.cmp && snap.cmp.yesterdaySameTime.total;
  const yFull = snap.cmp && snap.cmp.yesterdayFull.total;
  let cmpPart = '';
  if (ySame && ySame.cny > 0.005) {
    const d = (spent - ySame.cny) / ySame.cny * 100;
    cmpPart = ` · 昨日同期 ${fmtCny(ySame.cny)} <b class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '↑' : '↓'}${Math.abs(d).toFixed(0)}%</b>`;
  }
  const yFullPart = yFull && yFull.cny > 0.005 ? ` · 昨日全天 ${fmtCny(yFull.cny)}` : '';
  box.innerHTML = `
    <div class="goal ${tier.cls}">
      <div class="goal-head">
        <span class="goal-title">当日目标成本</span>
        <span class="goal-msg">${tier.msg}</span>
        <span class="goal-num">${fmtCny(spent)} / ¥${goal}<span class="goal-pct">${pct >= 100 ? '已超支' : pct.toFixed(0) + '%'}</span></span>
      </div>
      <div class="bar goalbar"><i style="width:${Math.min(pct, 100)}%"></i></div>
      <div class="goal-foot"><span>${left}${cmpPart}${yFullPart}（等价成本口径 · 北京时间）</span><span>${eta}</span></div>
    </div>`;
}

export function forecast(toolKey) {
  // 月度预估（v1.8）：口径统一在服务端 server/lib/forecast.js，前端不再自己算。
  // 旧实现的分母是「有数据的天数」——跳过的周末不在分母里，日均被抬高，月底预估虚高；
  // 且新装首日半天被当整天，预估被压低一半。改为日历天 + 当日进度（服务端唯一实现）。
  const f = snap.forecast && snap.forecast.month && snap.forecast.month.tools
    ? snap.forecast.month.tools[toolKey] : null;
  if (!f) return { ok: false, cny: null };
  return { ok: !!f.ok, cny: f.ok ? f.projectedCny : null };
}
