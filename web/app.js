'use strict';
// 看板前端：渲染 /api/summary
const TOOLS = [
  { key: 'codex', name: 'ChatGPT · Codex', planName: 'ChatGPT 订阅' },
  { key: 'claudeDesktop', name: 'Claude Desktop' },
  { key: 'claudeCode', name: 'Claude Code', sub: true, planName: 'cc-switch 路由（按模型计价）' },
  { key: 'zcode', name: 'ZCode', sub: true, planName: '智谱 Coding Plan' },
  { key: 'workbuddy', name: 'WorkBuddy', sub: true, planName: '订阅套餐（自定义模型）' },
];
const fmt = n => n == null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
const fmtCny = n => n == null ? '—' : '¥' + n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
// 昨日同期对比：涨=绿（投入更多视为正向，与目标成本的预警只在横幅/菜单栏体现）
function cmpDelta(today, yesterday) {
  if (!yesterday || yesterday <= 0.005) return '';
  const d = (today - yesterday) / yesterday * 100;
  const arrow = d >= 0 ? '↑' : '↓';
  return `<span class="d ${d >= 0 ? 'up' : 'down'}">vs 昨日同期 ${fmtCny(yesterday)} ${arrow}${Math.abs(d).toFixed(0)}%</span>`;
}
const tok = n => n >= 1e8 ? (n / 1e8).toFixed(2) + ' 亿' : n >= 1e4 ? (n / 1e4).toFixed(1) + ' 万' : fmt(n);
// 后端 costCny 已含 USD 折算，人民币口径 = costCny + equivalentCny，勿再乘汇率
const cny = a => a ? a.costCny + a.equivalentCny : 0;

let days = 30;
let snap = null;
let everLoaded = false;

// 加载失败：顶部红色横幅 + 重试；首屏还没数据时先给加载骨架
function showError() { document.getElementById('errBanner').hidden = false; }
function hideError() { document.getElementById('errBanner').hidden = true; }
function renderSkeleton() {
  document.getElementById('kpis').innerHTML = '<div class="skeleton-line">数据构建中…</div>';
  document.getElementById('cards').innerHTML = '<div class="skeleton-line">首次构建要扫描全部本地历史，可能需要几十秒…</div>';
}

async function load() {
  try {
    const r = await fetch('/api/summary?days=' + days);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    snap = await r.json();
    everLoaded = true;
    hideError();
    render();
  } catch {
    if (!everLoaded) renderSkeleton();
    showError();
  }
}

function render() {
  document.getElementById('updatedAt').textContent = '更新于 ' + new Date(snap.builtAt).toLocaleTimeString('zh-CN');
  renderGoalBanner();
  renderKpis();
  renderCards();
  renderQuotaCards();
  renderModelCosts();
  renderChart();
  renderDetail();
}

// 套餐实时额度卡（5h / 周窗口）
function quotaBar(label, used, resetMs) {
  if (used == null) return `<div class="quota-line"><span>${label}</span><span class="mut">不可用</span></div>`;
  used = Math.round(used * 10) / 10; // 浮点取整，避免「剩 12.700000000000003%」
  const cls = used > 85 ? 'over' : used > 60 ? 'warn' : '';
  const reset = resetMs ? ` · 剩 ${Math.floor(resetMs / 3600e3)}h${Math.floor(resetMs % 3600e3 / 60e3)}m` : '';
  return `<div class="bar"><i class="${cls}" style="width:${Math.min(used, 100)}%"></i></div>
    <div class="quota-line"><span>${label} 已用 ${used}%</span><span class="mut">${used > 85 ? '⚠️ ' : ''}剩 ${Math.round((100 - used) * 10) / 10}%${reset}</span></div>`;
}
// 额度卡降级策略：未配置类原因（未找到/未配置/无凭证）且从未成功 → 整卡不渲染；
// 曾成功过之后失败 → 显示失败态；其他失败原因（超时/接口异常）→ 也提示失败
const quotaEverOk = {}; // key -> 曾成功过
const QUOTA_UNCONFIGURED_RE = /未找到|未配置|无凭证/;
function quotaCardMode(q, key) {
  if (q && q.available) { quotaEverOk[key] = true; return 'ok'; }
  if (quotaEverOk[key]) return 'error';
  if (q && QUOTA_UNCONFIGURED_RE.test(String(q.reason || ''))) return 'skip';
  return q ? 'error' : 'skip';
}
const quotaFailureHtml = reason =>
  '<div class="quota-line"><span>实时额度获取失败</span><span class="mut">' + (reason || '') + '</span></div>';

function renderQuotaCards() {
  const items = [];

  const cgq = snap.chatgptQuota;
  const cgMode = quotaCardMode(cgq, 'chatgpt');
  if (cgMode === 'ok') {
    items.push({
      name: cgq.provider || 'ChatGPT Plus',
      note: 'Codex · GPT 系列',
      body: quotaBar('5 小时窗口', cgq.fiveHour && cgq.fiveHour.usedPercent, cgq.fiveHour && cgq.fiveHour.resetMsLeft)
          + quotaBar('周窗口', cgq.weekly && cgq.weekly.usedPercent, cgq.weekly && cgq.weekly.resetMsLeft),
      fresh: '实时 · ' + new Date(cgq.fetchedAt).toLocaleTimeString('zh-CN'),
    });
  } else if (cgMode === 'error') {
    items.push({ name: 'ChatGPT Plus', note: 'Codex · GPT 系列', body: quotaFailureHtml(cgq && cgq.reason), fresh: '' });
  }

  const mmq = snap.minimaxQuota;
  const mmMode = quotaCardMode(mmq, 'minimax');
  if (mmMode === 'ok') {
    items.push({
      name: mmq.provider || 'MiniMax Token Plan',
      note: 'WorkBuddy / Codex 第三方',
      body: quotaBar('5 小时窗口', mmq.fiveHour && mmq.fiveHour.usedPercent, mmq.fiveHour && mmq.fiveHour.resetMsLeft)
          + quotaBar('周窗口', mmq.weekly && mmq.weekly.usedPercent, mmq.weekly && mmq.weekly.resetMsLeft),
      fresh: '实时 · ' + new Date(mmq.fetchedAt).toLocaleTimeString('zh-CN'),
    });
  } else if (mmMode === 'error') {
    items.push({ name: 'MiniMax Token Plan MAX', note: 'WorkBuddy / Codex 第三方', body: quotaFailureHtml(mmq && mmq.reason), fresh: '' });
  }

  // 智谱 Coding Plan（团队版）：实时 5h/周额度，失败时降级为套餐等价进度
  const zq = snap.zhipuQuota;
  const zp = snap.plans.plans.zcode || {};
  let zhipuBody = '', zhipuName = '智谱 Coding Plan 团队版', zhipuNote = 'ZCode / Claude Code / WorkBuddy', zhipuFresh = '';
  const zpMode = quotaCardMode(zq, 'zhipu');
  if (zpMode === 'ok') {
    zhipuBody = quotaBar('5 小时窗口', zq.fiveHour && zq.fiveHour.usedPercent, zq.fiveHour && zq.fiveHour.resetMsLeft)
        + quotaBar('周窗口', zq.weekly && zq.weekly.usedPercent, zq.weekly && zq.weekly.resetMsLeft);
    zhipuFresh = '实时 · ' + new Date(zq.fetchedAt).toLocaleTimeString('zh-CN')
        + (zq.team ? ' · ' + zq.team.organizationName + ' / ' + zq.team.projectName : '');
  } else if (zpMode === 'error') {
    zhipuBody = quotaFailureHtml(zq && zq.reason);
    zhipuFresh = '降级为等价成本口径';
  } else {
    renderQuotaItems(items); // 智谱卡被跳过：已收好的卡直接渲染出口
    return;
  }
  if (zp.cnyPerMonth) {
    let used = 0;
    const mon = monthKey();
    for (const d of snap.agg.dailyKeys) {
      if (!d.startsWith(mon)) continue;
      const a = toolDay(d, 'zcode');
      const b = toolDay(d, 'claudeCode');
      if (a) used += cny(a);
      if (b) used += cny(b);
    }
    const pct = used / zp.cnyPerMonth * 100;
    zhipuBody += quotaBar('本月等价用量', Math.round(pct * 10) / 10);
    zhipuFresh += ' · 套餐 ¥' + zp.cnyPerMonth + '/月';
  }
  items.push({ name: zhipuName, note: zhipuNote, body: zhipuBody, fresh: zhipuFresh });
  renderQuotaItems(items);
}

function renderQuotaItems(items) {
  document.getElementById('quotaCards').innerHTML = items.map(it => `
    <div class="card" data-key="${it.name}">
      <h3>${it.name} <span class="tag">实时</span></h3>
      <div class="rows"><div><span class="k">适用</span><span class="mut" style="font-size:12px">${it.note}</span></div></div>
      ${it.body}
      <div class="fresh">${it.fresh}</div>
    </div>`).join('');
  applyCardOrder('quotaCards');
}

function toolDay(day, key) { return (snap.agg.daily[day] || {})[key] || null; }

// ---------- 当日目标成本（预算横幅） ----------
// 进度分档提示语：随预算消耗升温，用完转超支预警
function goalTier(pct) {
  if (pct <= 0) return { msg: '新的一天，预算已就位，按需使用 🚀', cls: 'g0' };
  if (pct < 25) return { msg: '预算充裕，安心干活 💭', cls: 'g25' };
  if (pct < 50) return { msg: '消耗平稳，余量尚多 ✨', cls: 'g25' };
  if (pct < 75) return { msg: '已用过半，留意消耗节奏 🌀', cls: 'g50' };
  if (pct < 100) return { msg: '预算将尽，要紧的任务优先安排 ⚠️', cls: 'g75' };
  if (pct < 150) return { msg: '当日目标成本已用完 💸 再跑就要超支了', cls: 'g100' };
  return { msg: '已大幅超出当日目标成本 🚨 记得收敛或上调目标', cls: 'g100' };
}
// 按北京时间今日已过时长外推的预算耗尽预测
function goalEta(spent, target) {
  if (spent <= 0 || spent >= target) return '';
  const bjNow = Date.now() + 8 * 3600e3;
  const bjMsToday = bjNow % 86400e3;             // 北京时间今日已过毫秒
  if (bjMsToday < 20 * 60e3) return '';           // 刚过零点速率无意义
  const rate = spent / bjMsToday;                 // ¥/ms
  const etaMs = (target - spent) / rate;
  if (etaMs + bjMsToday > 86400e3) return '按当前节奏今天用不完预算 👍';
  const eta = new Date(Date.now() + etaMs + 8 * 3600e3).toISOString().slice(11, 16);
  return `按当前节奏预计 ${eta} 用完预算`;
}
function renderGoalBanner() {
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
        <span class="goal-title">🎯 当日目标成本</span>
        <span class="goal-msg">${tier.msg}</span>
        <span class="goal-num">${fmtCny(spent)} / ¥${goal}<span class="goal-pct">${pct >= 100 ? '💸' : pct.toFixed(0) + '%'}</span></span>
      </div>
      <div class="bar goalbar"><i style="width:${Math.min(pct, 100)}%"></i><em style="left:${Math.min(pct, 100)}%">${spent >= goal ? '🚨' : pct >= 75 ? '⚠️' : ''}</em></div>
      <div class="goal-foot"><span>${left}${cmpPart}${yFullPart}（等价成本口径 · 北京时间）</span><span>${eta}</span></div>
    </div>`;
}
function todayKey() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}
function monthKey() { return todayKey().slice(0, 7); }
function weekStartKey() {
  // 北京时间本周一（ISO 周，周一为一周开始）
  const n = new Date(Date.now() + 8 * 3600e3);
  n.setUTCDate(n.getUTCDate() - (n.getUTCDay() + 6) % 7);
  return n.toISOString().slice(0, 10);
}

function sumTool(fn) {
  // fn(day) -> agg；对每日求和
  let req = 0, inT = 0, outT = 0, usd = 0, cny = 0, eq = 0;
  for (const d of snap.agg.dailyKeys) {
    const a = fn(d);
    if (!a) continue;
    req += a.requests; inT += a.inputTokens; outT += a.outputTokens;
    usd += a.costUsd; cny += a.costCny; eq += a.equivalentCny;
  }
  return { req, inT, outT, usd, cny, eq, totalCny: cny + eq };
}

function renderKpis() {
  const today = todayKey();
  // __total 桶 = 当日全部工具聚合
  const dayTotal = day => {
    const t = snap.agg.daily[day];
    if (!t) return null;
    if (t.__total) return t.__total;
    return Object.values(t).reduce((s, a) => {
      if (!a || typeof a !== 'object' || a.models) return s;
      s.requests += a.requests; s.inputTokens += a.inputTokens; s.outputTokens += a.outputTokens;
      s.costUsd += a.costUsd; s.costCny += a.costCny; s.equivalentCny += a.equivalentCny;
      return s;
    }, { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costCny: 0, equivalentCny: 0 });
  };
  const todayAgg = dayTotal(today) || { requests: 0, inputTokens: 0, outputTokens: 0, costCny: 0, equivalentCny: 0 };
  const todayCny = cny(todayAgg);
  let monthCny = 0, weekCny = 0;
  const wk = weekStartKey();
  for (const d of snap.agg.dailyKeys) {
    if (d.startsWith(monthKey())) monthCny += cny(dayTotal(d) || 0);
    if (d >= wk) weekCny += cny(dayTotal(d) || 0);
  }

  const ySame = (snap.cmp && snap.cmp.yesterdaySameTime.total) || null;
  const yFull = (snap.cmp && snap.cmp.yesterdayFull.total) || null;
  document.getElementById('kpis').innerHTML = `
    <div class="kpi"><div class="l">今日请求</div><div class="v">${fmt(todayAgg.requests)}${ySame ? ` <span class="d ${todayAgg.requests >= ySame.requests ? 'up' : 'down'}">${todayAgg.requests >= ySame.requests ? '↑' : '↓'}${Math.abs(todayAgg.requests - ySame.requests)}</span>` : ''}</div></div>
    <div class="kpi"><div class="l">今日 tokens</div><div class="v">${tok(todayAgg.inputTokens + todayAgg.outputTokens)}</div></div>
    <div class="kpi"><div class="l">今日成本（含等价）</div><div class="v">${fmtCny(todayCny)}</div>${cmpDelta(todayCny, ySame && ySame.cny)}</div>
    <div class="kpi"><div class="l">本周累计（含等价）</div><div class="v">${fmtCny(weekCny)}</div></div>
    <div class="kpi"><div class="l">本月累计（含等价）</div><div class="v">${fmtCny(monthCny)}</div></div>`;
}

function forecast(toolKey) {
  // 线性外推本月
  const mon = monthKey();
  const now = new Date(Date.now() + 8 * 3600e3);
  const dim = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  let spent = 0, el = 0;
  for (const d of snap.agg.dailyKeys) {
    if (!d.startsWith(mon)) continue;
    el++;
    const a = toolDay(d, toolKey);
    if (a) spent += cny(a);
  }
  return el ? spent / el * dim : 0;
}

// 数据源行数：codex / claudeDesktop 都来自 cc-switch，共用一个计数
function rowStatOf(toolKey) {
  return snap.rowStats[(toolKey === 'codex' || toolKey === 'claudeDesktop') ? 'ccswitch' : toolKey] || 0;
}

function renderCards() {
  const fx = snap.plans.usdCnyRate || 7.2; // 仅用于 USD 原值展示
  const buildCard = t => {
    const p = snap.plans.plans[t.key] || {};
    const today = toolDay(todayKey(), t.key) || { requests: 0, inputTokens: 0, outputTokens: 0, costCny: 0, costUsd: 0, equivalentCny: 0 };
    let month = { requests: 0, inputTokens: 0, outputTokens: 0, costCny: 0, costUsd: 0, equivalentCny: 0, subUsd: 0, payUsd: 0, subRequests: 0, payRequests: 0 };
    for (const d of snap.agg.dailyKeys) {
      if (!d.startsWith(monthKey())) continue;
      const a = toolDay(d, t.key);
      if (!a) continue;
      month.requests += a.requests; month.inputTokens += a.inputTokens; month.outputTokens += a.outputTokens;
      month.costCny += a.costCny; month.costUsd += a.costUsd; month.equivalentCny += a.equivalentCny;
      month.subUsd += a.subUsd || 0; month.payUsd += a.payUsd || 0;
      month.subRequests += a.subRequests || 0; month.payRequests += a.payRequests || 0;
    }
    const monthCny = cny(month);
    const fc = forecast(t.key);
    // 本周费用（北京 ISO 周，周一起）
    let weekToolCny = 0;
    const wk = weekStartKey();
    for (const d of snap.agg.dailyKeys) {
      if (d < wk) continue;
      const a = toolDay(d, t.key);
      if (a) weekToolCny += cny(a);
    }

    // 额度：套餐配置 vs 实测
    let quotaHtml = '';
    if (t.sub) {
      const limit = p.cnyPerMonth;
      if (limit) {
        const pct = Math.min(monthCny / limit * 100, 999);
        const cls = pct > 100 ? 'over' : pct > 80 ? 'warn' : '';
        quotaHtml = `<div class="bar"><i class="${cls}" style="width:${Math.min(pct, 100)}%"></i></div>
          <div class="quota-line"><span>月额度 ${fmtCny(limit)}（等价）</span><span>${pct.toFixed(0)}%</span></div>`;
      } else {
        quotaHtml = `<div class="quota-line"><span>月额度未配置（设置里可填）</span></div>`;
      }
    } else {
      const q = snap.chatgptQuota;
      if (t.key === 'codex' && q && q.available) {
        quotaHtml = `<div class="quota-line"><span>ChatGPT 实时额度已获取</span><span class="mut">${new Date(q.fetchedAt).toLocaleTimeString('zh-CN')}</span></div>`;
      } else {
        quotaHtml = `<div class="quota-line"><span>额度未配置 · 按量计费</span></div>`;
      }
    }

    let costLine;
    if (t.key === 'codex') {
      // 两段计费：GPT 系列 = Plus 套餐等价；第三方 = 真实按量
      const subUsd = month.subUsd || 0, payUsd = month.payUsd || 0;
      const subReq = month.subRequests || 0, payReq = month.payRequests || 0;
      costLine = `${fmtCny(month.costCny)}<br>
        <span style="font-size:12px"><span class="tag sub-pay" title="Plus 套餐内等价折算，不额外扣费">Plus 套餐</span> ${subReq} 次 · $${subUsd.toFixed(2)}</span><br>
        <span style="font-size:12px"><span class="tag">第三方实扣</span> ${payReq} 次 · <b>$${payUsd.toFixed(2)}</b> ≈ ${fmtCny(payUsd * fx)}</span>`;
    } else if (t.key === 'claudeDesktop') {
      costLine = `${fmtCny(month.costCny)} <span class="mut">($${month.costUsd.toFixed(2)} × ${fx})</span>`;
    } else {
      costLine = `${fmtCny(month.equivalentCny)} <span class="tag sub-pay" title="订阅制 · 等价按量成本，非实际扣费">订阅制 · 非扣费</span>`;
    }

    const planLine = (p.plan || t.planName)
      ? `<div><span class="k">套餐</span><span class="mut" style="font-size:12px">${p.plan || t.planName || ''}</span></div>`
      : '';
    // 昨日同期（昨日此刻之前）该工具的请求与费用
    const yTool = snap.cmp && snap.cmp.yesterdaySameTime.tools && snap.cmp.yesterdaySameTime.tools[t.key];
    const yToolPart = yTool && yTool.requests
      ? ` <span class="mut" style="font-size:11px;display:inline-block">· 昨同 ${fmt(yTool.requests)} 次 / ${fmtCny(yTool.cny)}</span>` : '';

    return `<div class="card" data-key="${t.key}">
      <h3>${t.name} ${t.sub ? '<span class="tag sub-pay">套餐</span>' : '<span class="tag">按量</span>'}</h3>
      <div class="rows">
        ${planLine}
        <div><span class="k">今日</span><span>${fmt(today.requests)} 次 · ${tok(today.inputTokens + today.outputTokens)} tk${yToolPart}</span></div>
        <div><span class="k">本月请求</span><span>${fmt(month.requests)} 次 · ${tok(month.inputTokens + month.outputTokens)} tk</span></div>
        <div><span class="k">本月费用</span><span>${costLine}</span></div>
        <div><span class="k">本周费用</span><span>${fmtCny(weekToolCny)} <span class="mut">（周一起）</span></span></div>
        <div><span class="k">本月预估</span><span>${fmtCny(fc)} <span class="mut">（线性外推）</span></span></div>
      </div>
      ${quotaHtml}
      <div class="fresh">数据源 ${rowStatOf(t.key)} 条${snap.collectorErrors[(t.key === 'claudeDesktop' || t.key === 'codex') ? 'ccswitch' : t.key] ? ' · <span class="err">' + snap.collectorErrors[(t.key === 'claudeDesktop' || t.key === 'codex') ? 'ccswitch' : t.key] + '</span>' : ''}</div>
    </div>`;
  };
  // 未启用（rowStats=0）的工具卡折叠成一行，可展开；展开态记忆在 localStorage
  const idleToolsKey = 'aqd:idleToolsExpanded';
  let idleExpanded = false;
  try { idleExpanded = localStorage.getItem(idleToolsKey) === '1'; } catch { /* localStorage 不可用 */ }
  const idleTools = TOOLS.filter(t => !rowStatOf(t.key));
  let idleHtml = '';
  if (idleTools.length) {
    idleHtml = `<div class="card idle-toggle" id="idleToggle">另有 ${idleTools.length} 个未启用的工具 <span class="arr">${idleExpanded ? '▾' : '▸'}</span></div>`
      + (idleExpanded ? idleTools.map(buildCard).join('') : '');
  }
  document.getElementById('cards').innerHTML =
    TOOLS.filter(t => rowStatOf(t.key)).map(buildCard).join('') + idleHtml;
  const tg = document.getElementById('idleToggle');
  if (tg) tg.addEventListener('click', () => {
    try { localStorage.setItem(idleToolsKey, idleExpanded ? '0' : '1'); } catch { /* 忽略 */ }
    renderCards();
  });
  applyCardOrder('cards');
}

// 模型分类费用：按工具聚合行 + 可展开的模型明细
const modelExpanded = {}; // toolKey -> bool，刷新后保持展开状态

function renderModelCosts() {
  const models = snap.agg.models || {};
  let rows = '';
  for (const t of TOOLS) {
    const ms = models[t.key];
    if (!ms) continue;
    const list = Object.entries(ms).sort((a, b) => (b[1].costCny + b[1].equivalentCny) - (a[1].costCny + a[1].equivalentCny));
    // 工具聚合行
    const agg = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costCny: 0, costUsd: 0, equivalentCny: 0 };
    for (const [, m] of list) {
      agg.requests += m.requests; agg.inputTokens += m.inputTokens; agg.outputTokens += m.outputTokens;
      agg.cacheReadTokens += m.cacheReadTokens;
      agg.costCny += m.costCny; agg.costUsd += m.costUsd; agg.equivalentCny += m.equivalentCny;
    }
    const open = !!modelExpanded[t.key];
    const arrow = open ? '▾' : '▸';
    const toolCny = cny(agg);
    const usdTag = agg.costUsd > 0 ? `<span class="mut">实际 $${agg.costUsd.toFixed(2)}</span>` : '<span class="tag sub-pay">等价</span>';
    rows += `<tr class="tool-row" data-tool="${t.key}">
      <td class="mut">${arrow}</td>
      <td><b>${t.name}</b> <span class="mut" style="font-size:11px">(${list.length} 个模型)</span></td>
      <td>${fmt(agg.requests)}</td>
      <td>${tok(agg.inputTokens)}</td>
      <td>${tok(agg.outputTokens)}</td>
      <td>${tok(agg.cacheReadTokens)}</td>
      <td>${fmtCny(toolCny)} ${usdTag}</td>
    </tr>`;
    if (open) {
      for (const [model, m] of list) {
        const tag = m.costUsd > 0
          ? `<span class="mut">实际 $${m.costUsd.toFixed(2)}</span>`
          : (m.noPrice ? '<span class="tag sub-pay">无单价</span>' : '<span class="tag sub-pay">等价</span>');
        rows += `<tr class="model-row" data-tool="${t.key}">
          <td></td>
          <td class="mut">└ ${model}</td>
          <td>${fmt(m.requests)}</td>
          <td>${tok(m.inputTokens)}</td>
          <td>${tok(m.outputTokens)}</td>
          <td>${tok(m.cacheReadTokens)}</td>
          <td>${fmtCny(cny(m))} ${tag}</td>
        </tr>`;
      }
    }
  }
  document.getElementById('modelTable').innerHTML =
    `<tr><th></th><th>工具 / 模型</th><th>请求</th><th>输入 tk</th><th>输出 tk</th><th>缓存命中</th><th>费用</th></tr>` +
    (rows || '<tr><td colspan="7" class="mut">暂无数据</td></tr>');

  document.querySelectorAll('#modelTable .tool-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const k = tr.dataset.tool;
      modelExpanded[k] = !modelExpanded[k];
      renderModelCosts();
    });
  });
}

function renderChart() {
  const daysList = snap.agg.dailyKeys.slice(-30);
  const W = 1100, H = 220, P = { l: 50, r: 12, t: 12, b: 24 };
  const rawMax = Math.max(1, ...daysList.map(d => {
    const t = snap.agg.daily[d];
    if (!t) return 0;
    return t.__total ? cny(t.__total) : 0;
  }));
  // Y 轴取整刻度：向上取到半个数量级的整数倍（¥127 → ¥150，¥253 → ¥300）
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const maxV = Math.ceil(rawMax / (mag / 2)) * (mag / 2);
  const bw = (W - P.l - P.r) / Math.max(daysList.length, 1);
  const colors = { codex: '#2dd6f5', claudeDesktop: '#a78bfa', claudeCode: '#f472b6', zcode: '#34d399', workbuddy: '#fbbf24' };
  let bars = '';
  daysList.forEach((d, i) => {
    let y = H - P.b;
    for (const t of TOOLS) {
      const a = toolDay(d, t.key);
      if (!a) continue;
      const v = cny(a);
      if (!v) continue;
      const h = v / maxV * (H - P.t - P.b);
      y -= h;
      bars += `<rect x="${P.l + i * bw + 1}" y="${y}" width="${Math.max(bw - 2, 1)}" height="${h}" fill="${colors[t.key]}"><title>${d} ${t.name}: ¥${v.toFixed(2)}</title></rect>`;
    }
    if (i % 5 === 0 || i === daysList.length - 1)
      bars += `<text x="${P.l + i * bw + bw / 2}" y="${H - 6}" font-size="10" fill="var(--muted)" text-anchor="middle">${d.slice(5)}</text>`;
  });
  [0, .5, 1].forEach(f => {
    const y = H - P.b - f * (H - P.t - P.b);
    bars += `<line x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}" stroke="var(--border)" stroke-width="1"/>
      <text x="${P.l - 6}" y="${y + 3}" font-size="10" fill="var(--muted)" text-anchor="end">¥${(maxV * f).toFixed(0)}</text>`;
  });
  const legend = TOOLS.map(t => `<span style="margin-right:14px;font-size:12px"><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colors[t.key]};margin-right:4px"></i>${t.name}</span>`).join('');
  document.getElementById('chartBox').innerHTML =
    `<svg viewBox="0 0 ${W} ${H}">${bars}</svg><div style="margin-top:8px">${legend}</div>`;
}

function renderDetail() {
  const today = todayKey();
  let html = `<tr><th>日期</th>${TOOLS.map(t => `<th>${t.name}<br><span style="font-weight:400">次数 / tokens / ¥</span></th>`).join('')}</tr>`;
  const list = [...snap.agg.dailyKeys].reverse();
  for (const d of list) {
    html += `<tr${d === today ? ' class="today"' : ''}><td>${d}${d === today ? ' ·今' : ''}</td>`;
    for (const t of TOOLS) {
      const a = toolDay(d, t.key);
      html += a
        ? `<td>${fmt(a.requests)} / ${tok(a.inputTokens + a.outputTokens)} / ${fmtCny(cny(a))}</td>`
        : '<td class="mut">—</td>';
    }
    html += '</tr>';
  }
  document.getElementById('detail').innerHTML = html;
}

// 模型单价编辑器：默认表 + 实际用到但无单价的模型；空 = 用默认，填 = 覆盖，全清 = 恢复默认
function renderPriceEditor(p) {
  const defaults = p.pricingDefaults || {};
  const overrides = p.priceOverrides || {};
  // 展示顺序：按已产生的费用降序，未用的内置模型垫底
  const costOf = m => {
    let c = 0;
    for (const t of Object.values(snap.agg.models || {})) {
      const a = t[m];
      if (a) c += a.costCny + a.equivalentCny;
    }
    return c;
  };
  const models = [...new Set([...Object.keys(defaults), ...Object.keys(overrides), ...Object.keys(snap.agg.models || {})])];
  models.sort((a, b) => (costOf(b) - costOf(a)) || a.localeCompare(b));
  const fmt0 = v => v == null ? '' : String(v);
  const rows = models.map(m => {
    const d = defaults[m] || {};
    const o = overrides[m] || {};
    const ph = f => d[f] != null ? `默认 ${d[f]}` : '无单价';
    const tag = o && Object.keys(o).length ? '<span class="tag sub-pay">已覆盖</span>' : (d.in != null ? '' : '<span class="tag">未收录</span>');
    return `<div class="price-row">
      <span class="pm" title="${m}">${m} ${tag}</span>
      <input data-price="${m}" data-pf="in" type="number" step="0.01" min="0" value="${fmt0(o.in)}" placeholder="${ph('in')}">
      <input data-price="${m}" data-pf="out" type="number" step="0.01" min="0" value="${fmt0(o.out)}" placeholder="${ph('out')}">
      <input data-price="${m}" data-pf="cacheRead" type="number" step="0.01" min="0" value="${fmt0(o.cacheRead)}" placeholder="${d.cacheRead != null ? '默认 ' + d.cacheRead : '按输入价'}">
    </div>`;
  }).join('');
  return `<hr><div class="qk-hint">模型单价（元 / 百万 token，等价成本口径）—— 输入/输出/缓存命中三列；<b>留空 = 用默认价，填数字 = 覆盖</b>；覆盖后各端立即按新单价重算历史成本。价格调整后在这里改即可，不用动代码。</div>
    <div class="price-head"><span>模型</span><span>输入</span><span>输出</span><span>缓存命中</span></div>
    ${rows}
    <button type="button" id="priceReset" class="seg">全部恢复默认价</button>`;
}

// 设置面板
const dlg = document.getElementById('settingsDlg');
const QUOTA_KEY_FIELDS = [
  ['zhipu', 'token', '智谱 · API Key（id.secret 形态；留空 = 自动发现 ZCode / WorkBuddy 凭证）'],
  ['zhipu', 'organizationId', '智谱 · Organization ID（org-xxx，与 Project ID 成对填；留空 = 自动定位团队项目）'],
  ['zhipu', 'projectId', '智谱 · Project ID（proj-xxx）'],
  ['minimax', 'apiKey', 'MiniMax · API Key（留空 = 从 WorkBuddy models.json 读取）'],
  ['chatgpt', 'accessToken', 'ChatGPT · Access Token（一般留空，自动读 codex 登录；手动填的过期需自行更新）'],
];
document.getElementById('settingsBtn').onclick = async () => {
  document.getElementById('settingsErr').hidden = true; // 打开时清掉上次错误
  const r = await fetch('/api/plans'); const p = await r.json();
  const qk = p.quotaKeys || {};
  document.getElementById('settingsBody').innerHTML =
    `<label>USD → CNY 汇率</label><input id="sFx" type="number" step="0.01" value="${p.usdCnyRate}">` +
    `<label>🎯 当日目标成本（等价 ¥/天）</label><input id="sGoal" type="number" step="10" min="0" value="${(p.dailyGoal || {}).cny ?? 200}">` +
    Object.entries(p.plans).map(([k, v]) =>
      `<label>${v.label} · 月额度（等价 ¥，留空 = 未配置）</label>
       <input data-plan="${k}" type="number" step="0.01" value="${v.cnyPerMonth ?? ''}" placeholder="未配置">`
    ).join('') +
    `<hr><div class="qk-hint">套餐实时额度 Key —— 已配置的显示为脱敏（如 <code>88b9…GXlN</code>），不改即保留；清空 = 回退自动发现；输入新值 = 覆盖</div>` +
    QUOTA_KEY_FIELDS.map(([t, f, label]) =>
      `<label>${label}</label>
       <input data-qk-tool="${t}" data-qk-field="${f}" type="text" value="${(qk[t] || {})[f] || ''}" placeholder="未配置 · 自动发现" spellcheck="false">`
    ).join('') +
    renderPriceEditor(p);
  dlg.showModal();
  document.getElementById('priceReset').onclick = () => {
    document.querySelectorAll('[data-price]').forEach(el => { el.value = ''; });
  };
};
document.getElementById('settingsCancel').onclick = () => dlg.close();
document.getElementById('settingsX').onclick = () => dlg.close();
document.getElementById('settingsSave').onclick = async () => {
  const errBox = document.getElementById('settingsErr');
  errBox.hidden = true;
  const plans = {};
  document.querySelectorAll('[data-plan]').forEach(el => {
    plans[el.dataset.plan] = { cnyPerMonth: el.value === '' ? null : Number(el.value) };
  });
  const quotaKeys = {};
  document.querySelectorAll('[data-qk-tool]').forEach(el => {
    const t = el.dataset.qkTool, f = el.dataset.qkField;
    (quotaKeys[t] = quotaKeys[t] || {})[f] = el.value;
  });
  // 模型单价覆盖：全空 = 不覆盖（用默认/清除），填了任意一列即生效
  const priceOverrides = {};
  document.querySelectorAll('[data-price]').forEach(el => {
    const m = el.dataset.price, f = el.dataset.pf;
    if (el.value !== '') (priceOverrides[m] = priceOverrides[m] || {})[f] = Number(el.value);
  });
  try {
    const r = await fetch('/api/plans', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usdCnyRate: Number(document.getElementById('sFx').value), dailyGoal: { cny: Number(document.getElementById('sGoal').value) || 0 }, plans, quotaKeys, priceOverrides }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || 'HTTP ' + r.status);
    }
    dlg.close();   // 成功才关弹窗
    toast('已保存');
    load();
  } catch (e) {
    // 失败留在弹窗，就地显示错误
    errBox.textContent = '保存失败：' + e.message;
    errBox.hidden = false;
  }
};

// 轻提示：底部浮出，2.2s 后淡出
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

document.getElementById('daySeg').addEventListener('click', e => {
  if (e.target.dataset.d) {
    days = Number(e.target.dataset.d);
    document.querySelectorAll('#daySeg button').forEach(b => b.classList.toggle('on', b === e.target));
    load();
  }
});

// ---------- 数据导出（CSV 带 \uFEFF BOM，保 Excel 打开中文不乱码；data URI 下载） ----------
function download(name, content, mime) {
  const a = document.createElement('a');
  a.href = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent('\uFEFF' + content);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = cells => cells.map(csvCell).join(',');
const ymd = () => todayKey().replace(/-/g, '');

function exportDetailCsv() {
  const head = ['日期'];
  for (const t of TOOLS) head.push(t.name + ' 次数', t.name + ' tokens', t.name + ' 费用(¥)');
  const lines = [csvRow(head)];
  for (const d of [...snap.agg.dailyKeys].reverse()) {
    const row = [d];
    for (const t of TOOLS) {
      const a = toolDay(d, t.key);
      row.push(a ? a.requests : '', a ? a.inputTokens + a.outputTokens : '', a ? cny(a).toFixed(2) : '');
    }
    lines.push(csvRow(row));
  }
  download(`ai-quota-export-${ymd()}.csv`, lines.join('\r\n'), 'text/csv');
}

function exportModelsCsv() {
  const models = snap.agg.models || {};
  const lines = [csvRow(['工具', '模型', '请求', '输入 tokens', '输出 tokens', '缓存命中 tokens', '费用(¥，含等价)', '实际费用($)'])];
  for (const t of TOOLS) {
    const ms = models[t.key];
    if (!ms) continue;
    for (const [m, v] of Object.entries(ms)) {
      lines.push(csvRow([t.name, m, v.requests, v.inputTokens, v.outputTokens, v.cacheReadTokens,
        cny(v).toFixed(2), v.costUsd != null ? v.costUsd.toFixed(2) : '']));
    }
  }
  download(`ai-quota-export-${ymd()}-models.csv`, lines.join('\r\n'), 'text/csv');
}

function exportJson() {
  download(`ai-quota-export-${ymd()}.json`, JSON.stringify(snap, null, 2), 'application/json');
}

document.getElementById('exportDetailCsv').addEventListener('click', () => { if (snap) exportDetailCsv(); });
document.getElementById('exportModelsCsv').addEventListener('click', () => { if (snap) exportModelsCsv(); });
document.getElementById('exportJson').addEventListener('click', () => { if (snap) exportJson(); });
document.getElementById('retryBtn').addEventListener('click', () => load());

// ---------- 卡片拖拽排序（Pointer Events 实现 + localStorage 持久化） ----------
// 不用 HTML5 DnD：合成事件无法触发原生 dragstart，且 Pointer 方案支持触控笔、动效完全可控
const dragGhost = document.getElementById('dragGhost');
let drag = null; // { card, container, id, startX, startY, active }

function cardOrderKey(id) { return 'aqd:order:' + id; }
// 渲染后按已保存顺序重排（新出现的卡片追加在末尾）
function applyCardOrder(id) {
  const c = document.getElementById(id);
  let saved;
  try { saved = JSON.parse(localStorage.getItem(cardOrderKey(id)) || 'null'); } catch { saved = null; }
  if (!Array.isArray(saved) || !saved.length) return;
  const byKey = {};
  for (const el of [...c.children]) if (el.dataset.key) byKey[el.dataset.key] = el;
  for (const k of saved) if (byKey[k]) { c.appendChild(byKey[k]); delete byKey[k]; }
}
function persistCardOrder(id) {
  localStorage.setItem(cardOrderKey(id),
    JSON.stringify([...document.getElementById(id).children].map(el => el.dataset.key)));
}
// 网格布局下找坐标最近的卡片作为插入参照
function nearestCard(c, x, y) {
  let best = null, bestD = Infinity;
  for (const el of c.querySelectorAll('.card')) {
    if (el === drag.card) continue;
    const r = el.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = el; }
  }
  return best;
}
function enableCardDnD(id) {
  const c = document.getElementById(id);
  c.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.pointerType === 'touch') return; // 触摸留给页面滚动
    const card = e.target.closest('.card');
    if (!card || !c.contains(card)) return;
    drag = { card, container: c, id, startX: e.clientX, startY: e.clientY, active: false };
  });
}
document.addEventListener('pointermove', e => {
  if (!drag) return;
  if (!drag.active) {
    // 位移超过 6px 才算拖拽，避免误伤点击
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
    drag.active = true;
    drag.card.classList.add('dragging');
    document.body.classList.add('dragging-any');
    const h3 = drag.card.querySelector('h3');
    dragGhost.textContent = '⟪ ' + (h3 ? h3.textContent.trim() : '') + ' ⟫';
    dragGhost.style.display = 'block';
  }
  e.preventDefault();
  dragGhost.style.left = e.clientX + 18 + 'px';
  dragGhost.style.top = e.clientY - 34 + 'px';
  const target = nearestCard(drag.container, e.clientX, e.clientY);
  if (!target) { drag.container.appendChild(drag.card); return; }
  const r = target.getBoundingClientRect();
  const before = e.clientX < r.left + r.width / 2;
  drag.container.insertBefore(drag.card, before ? target : target.nextSibling);
}, { passive: false });
document.addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.active) {
    drag.card.classList.remove('dragging');
    document.body.classList.remove('dragging-any');
    dragGhost.style.display = 'none';
    persistCardOrder(drag.id);
  }
  drag = null;
});
document.addEventListener('pointercancel', () => {
  if (drag) {
    drag.card.classList.remove('dragging');
    document.body.classList.remove('dragging-any');
    dragGhost.style.display = 'none';
  }
  drag = null;
});
enableCardDnD('cards');
enableCardDnD('quotaCards');

// ---------- 星野背景（canvas，低调闪烁） ----------
(function starfield() {
  const cv = document.getElementById('fx');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  let W, H, stars = [];
  function resize() {
    W = cv.width = innerWidth; H = cv.height = innerHeight;
    const n = Math.min(170, Math.floor(W * H / 11000));
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.2 + 0.3, p: Math.random() * Math.PI * 2,
      s: 0.3 + Math.random() * 1.1, blue: Math.random() < 0.18,
    }));
  }
  resize();
  addEventListener('resize', resize);
  (function draw(t) {
    ctx.clearRect(0, 0, W, H);
    for (const st of stars) {
      ctx.globalAlpha = 0.16 + 0.5 * (0.5 + 0.5 * Math.sin(st.p + t / 1000 * st.s));
      ctx.fillStyle = st.blue ? '#9fd8ff' : '#e8eeff';
      ctx.beginPath(); ctx.arc(st.x, st.y, st.r, 0, 7); ctx.fill();
    }
    requestAnimationFrame(draw);
  })(0);
})();

// 入场动效只播一次：1.6s 后摘除标记，避免 60s 自动刷新时整页闪动
setTimeout(() => document.body.classList.remove('anim-once'), 1600);

load();
setInterval(load, 60_000);
