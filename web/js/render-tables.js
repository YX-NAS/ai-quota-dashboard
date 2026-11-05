// 数据表渲染：KPI / 今日模型排行 / 项目统计 / API 维度费用 / 模型分类费用 / 趋势图 / 每日明细 + CSV/JSON 导出
import { esc, fmt, fmtCny, tok, cny, todayKey, monthKey, weekStartKey, download, csvRow, ymd } from './utils.js';
import { snap, toolDay } from './state.js';
import { cmpDelta } from './goal.js';
import { TOOLS, BILLING_META, modelChipsHtml } from './render-cards.js';
import { applyCardOrder, foldModelChips } from './ui.js';
import { safeGet, safeSet, MODEL_RANK_OPEN_KEY, PROJECT_OPEN_KEY } from './storage.js';

// ---------- 今日模型排行（跨工具按模型归集，快照 modelUsage，store.modelAggregate） ----------
// 排行看「用量」：订阅工具计等价成本、按量工具计真实扣费，前端合计 = costCny + equivalentCny（全局口径）
const VENDOR_COLORS = {
  zhipu: '#a6da95', deepseek: '#8aadf4', bailian: '#f5a97f', moonshot: '#c6a0f6',
  minimax: '#eed49f', volcengine: '#ee99a0', openai: '#8bd5ca', anthropic: '#ed8796',
};
const VENDOR_NAMES = {
  zhipu: '智谱', deepseek: 'DeepSeek', bailian: '百炼', moonshot: 'Kimi',
  minimax: 'MiniMax', volcengine: '火山方舟', openai: 'OpenAI', anthropic: 'Anthropic',
};
const vendorColorOf = v => VENDOR_COLORS[v] || '#99a1b2';
const MODEL_RANK_TOP = 5;

export function renderModelRank() {
  const mu = snap.modelUsage || {};
  const box = document.getElementById('modelRankCards');
  const np = n => n ? ` <span class="mut">（${fmt(n)} 次未计价）</span>` : '';
  const entries = Object.entries(mu)
    .map(([model, b]) => ({
      model, b,
      cnyV: cny(b.today),
      tk: (b.today.inputTokens || 0) + (b.today.outputTokens || 0),
    }))
    .filter(e => e.cnyV > 0.0001 || e.tk > 0)
    .sort((x, y) => (y.cnyV - x.cnyV) || (y.tk - x.tk) || x.model.localeCompare(y.model));
  box.closest('section').style.display = entries.length ? '' : 'none';
  if (!entries.length) { box.innerHTML = ''; return; }
  const open = safeGet(MODEL_RANK_OPEN_KEY) === '1';
  const shown = open ? entries : entries.slice(0, MODEL_RANK_TOP);
  const totalCny = entries.reduce((s, e) => s + e.cnyV, 0);
  const rows = shown.map((e, i) => {
    const pct = totalCny > 0 ? Math.max(e.cnyV / totalCny * 100, 0) : 0;
    const vn = VENDOR_NAMES[e.b.vendor] || e.b.vendor || '未知来源';
    const cost = e.cnyV > 0 ? fmtCny(e.cnyV) : '<span class="mut">—</span>';
    return `<div class="rank-row">
      <span class="rank-no">${i + 1}</span>
      <span class="tool-dot" style="background:${vendorColorOf(e.b.vendor)}" title="${esc(vn)}"></span>
      <div class="rank-main">
        <div class="rank-line1">
          <span class="rank-name" title="${esc(e.model)} · ${esc(vn)}">${esc(e.model)}</span>
          <span class="rank-meta">${fmt(e.b.today.requests)} 次 · ${tok(e.tk)} tk${np(e.b.today.noPriceRequests)}</span>
          <span class="rank-cost">${cost}</span>
        </div>
        <div class="bar rank-bar"><i style="width:${Math.min(pct, 100)}%"></i></div>
      </div>
    </div>`;
  }).join('');
  const toggle = entries.length > MODEL_RANK_TOP
    ? `<button type="button" id="rankToggle" class="rank-toggle">${open ? '收起 ▴' : `展开全部 ${entries.length} 个模型 ▾`}</button>`
    : '';
  box.innerHTML = `<div class="card">
    <h3><span class="tool-dot" style="background:var(--accent)"></span>今日模型排行 <span class="tag">TOP ${Math.min(MODEL_RANK_TOP, entries.length)}</span></h3>
    <div class="rank-list">${rows}</div>
    ${toggle}
    <div class="fresh">今日 ${entries.length} 个模型 · 合计 ${fmtCny(totalCny)}（订阅工具计等价成本 · 按量工具为真实费用）</div>
  </div>`;
  const tg = document.getElementById('rankToggle');
  if (tg) tg.addEventListener('click', () => {
    safeSet(MODEL_RANK_OPEN_KEY, open ? '0' : '1');
    renderModelRank();
  });
}

// ---------- 项目统计（今日占比/费用 + 累计总量，快照 projectUsage，store.projectAggregate） ----------
// 项目维度只有 ZCode（会话 project_id 精确）与 Claude Code（会话 cwd 近似）有数据；
// cc-switch / WorkBuddy 无项目概念不参与，避免占比失真。展开态与折叠条沿用卡片区 idle-toggle 模式
const PROJECT_TOP = 6;

export function renderProjectStats() {
  const pu = snap.projectUsage || {};
  const box = document.getElementById('projectCards');
  const entries = Object.entries(pu).map(([key, b]) => ({
    key, label: b.label || key, today: b.today || {}, total: b.total || {},
    todayCny: cny(b.today), totalCny: cny(b.total),
  })).filter(p => p.todayCny > 0.0001 || p.totalCny > 0.0001);
  box.closest('section').style.display = entries.length ? '' : 'none';
  if (!entries.length) { box.innerHTML = ''; return; }
  entries.sort((x, y) => (y.todayCny - x.todayCny) || (y.totalCny - x.totalCny) || x.key.localeCompare(y.key));
  const todayTotal = entries.reduce((s, p) => s + p.todayCny, 0);
  const open = safeGet(PROJECT_OPEN_KEY) === '1';
  const shown = open ? entries : entries.slice(0, PROJECT_TOP);
  const restCount = entries.length - shown.length;
  box.innerHTML = shown.map(p => projectCardHtml(p, todayTotal)).join('')
    + (entries.length > PROJECT_TOP
      ? `<div class="card idle-toggle" id="projToggle">${open ? `收起 · 共 ${entries.length} 个项目 <span class="arr">▴</span>` : `另有 ${restCount} 个项目 <span class="arr">▸</span>`}</div>`
      : '');
  applyCardOrder('projectCards');
  foldModelChips();
  const tg = document.getElementById('projToggle');
  if (tg) tg.addEventListener('click', () => {
    safeSet(PROJECT_OPEN_KEY, open ? '0' : '1');
    renderProjectStats();
  });
}

function projectCardHtml(p, todayTotal) {
  const t = p.today, tot = p.total;
  const np = n => n ? ` <span class="mut">（${fmt(n)} 次未计价）</span>` : '';
  const pct = todayTotal > 0 ? Math.max(p.todayCny / todayTotal * 100, 0) : 0;
  // 今日用过的模型 chips：名称 + 今日费用（title 带次数/tokens 明细），费用大头在前——
  // 复用 modelChipsHtml/foldModelChips 的自动折叠（模型过多时收成一行，卡片高度与其他卡对齐）
  const models = Object.entries(t.models || {})
    .map(([m, mm]) => ({ m, c: (mm.costCny || 0) + (mm.equivalentCny || 0), r: mm.requests || 0, tk: (mm.inputTokens || 0) + (mm.outputTokens || 0) }))
    .sort((x, y) => (y.c - x.c) || (y.tk - x.tk));
  const chips = models.map(x =>
    `<span class="mm" title="${esc(x.m)} · ${fmt(x.r)} 次 · ${tok(x.tk)} tk">${esc(x.m)}${x.c > 0 ? ' ' + fmtCny(x.c) : ''}</span>`).join('');
  const src = p.key.startsWith('/') ? 'Claude Code（会话 cwd 近似）' : 'ZCode（会话精确归因）';
  return `<div class="card" data-key="proj-${esc(p.key)}">
    <h3><span class="tool-dot" style="background:var(--accent)"></span><span class="proj-name" title="${esc(p.key)}">${esc(p.label)}</span></h3>
    <div class="proj-cost">${fmtCny(p.todayCny)}<span class="mut">今日费用${np(t.noPriceRequests)}</span></div>
    <div class="rows">
      <div><span class="k">今日用量</span><span>${fmt(t.requests || 0)} 次 · ${tok((t.inputTokens || 0) + (t.outputTokens || 0))} tk</span></div>
      <div><span class="k">累计用量</span><span>${fmt(tot.requests || 0)} 次 · ${tok((tot.inputTokens || 0) + (tot.outputTokens || 0))} tk</span></div>
      <div><span class="k">累计费用</span><span>${fmtCny(p.totalCny)}${np(tot.noPriceRequests)}</span></div>
    </div>
    <div class="bar"><i style="width:${Math.min(pct, 100)}%"></i></div>
    <div class="quota-line"><span>占今日项目总费用</span><span>${pct.toFixed(1)}%</span></div>
    ${modelChipsHtml('proj:' + p.key, chips)}
    <div class="fresh">项目维度来源：${src}</div>
  </div>`;
}

// ---------- API 维度费用（每把 API 的今日/本月费用 + 调用模型明细） ----------
// 数据来自快照 apiUsage（store.apiAggregate）：ZCode provider 精确到每把 Key，
// 无 provider 标记的行（cc-switch / Claude Code 等按模型名归因）落「model:服务商」桶；
// 订阅制 provider（如 MiniMax Token Plan）与按量卡同口径剔除，不出现在本表
const apiExpanded = {}; // apiKey -> bool 展开态（会话内保持，60s 刷新不丢）
function apiUsageEntries() {
  const au = snap.apiUsage || {};
  const provs = Array.isArray(snap.apiBilling && snap.apiBilling.providers) ? snap.apiBilling.providers : [];
  const subKeys = new Set(provs.filter(p => p.billingKind === 'subscription').map(p => p.providerId));
  return Object.entries(au)
    // 与按量卡同口径：订阅制 provider（如 MiniMax Token Plan）与按量区不认识的厂商
    //（openai/anthropic 等 = Codex/Claude 套餐等价成本，非真按量扣费）都不进本表
    .filter(([k, b]) => !subKeys.has(k) && BILLING_META[b.vendor])
    .sort((a, b) => ((b[1].month || {}).costCny || 0) - ((a[1].month || {}).costCny || 0));
}
export function renderApiCosts() {
  const entries = apiUsageEntries();
  const sec = document.getElementById('apiCosts');
  if (!entries.length) { sec.style.display = 'none'; return; }
  sec.style.display = '';
  const provs = Array.isArray(snap.apiBilling && snap.apiBilling.providers) ? snap.apiBilling.providers : [];
  const provOf = Object.fromEntries(provs.map(p => [p.providerId, p]));
  const np = n => n ? ` <span class="mut">（${fmt(n)} 次未计价）</span>` : '';
  let rows = '';
  for (const [key, b] of entries) {
    const today = b.today || {}, month = b.month || {}; // 老快照兼容：缺失的今日/本月桶按空对象处理，不抛异常
    const meta = BILLING_META[b.vendor] || {};
    const prov = provOf[key];
    const isAttr = key.startsWith('model:');
    const label = isAttr
      ? `按模型归因 · ${meta.name || b.vendor}`
      : (prov && prov.label) || meta.name || key;
    const tip = isAttr
      ? 'cc-switch / Claude Code 等来源无 provider 标记，按模型名归到该服务商（与按量卡同口径）'
      : `服务商：${meta.name || b.vendor} · API Key：${key}`;
    const open = !!apiExpanded[key];
    const models = Object.entries(month.models || {}).sort((a, c) => (c[1].costCny || 0) - (a[1].costCny || 0));
    rows += `<tr class="tool-row" data-api="${esc(key)}">
      <td class="mut">${open ? '▾' : '▸'}</td>
      <td title="${esc(tip)}"><b>${esc(label)}</b> <span class="tag sub-pay">${esc(meta.name || b.vendor)}</span> <span class="mut" style="font-size:11px">(${models.length} 个模型)</span></td>
      <td>${fmtCny(today.costCny)}${np(today.noPriceRequests)}</td>
      <td>${fmtCny(month.costCny)}${np(month.noPriceRequests)}</td>
      <td>${fmt(today.requests)}</td>
      <td>${fmt(month.requests)}</td>
      <td>${tok(today.inputTokens + today.outputTokens)}</td>
      <td>${tok(month.inputTokens + month.outputTokens)}</td>
    </tr>`;
    if (open) {
      for (const [m, mm] of models) {
        // 今日 ⊆ 本月窗口：本月模型表必含今日用过的模型，缺的补零
        const tm = (today.models || {})[m] || { requests: 0, inputTokens: 0, outputTokens: 0, costCny: 0, noPriceRequests: 0 };
        rows += `<tr class="model-row">
          <td></td>
          <td class="mut">└ ${esc(m)}</td>
          <td>${fmtCny(tm.costCny)}${np(tm.noPriceRequests)}</td>
          <td>${fmtCny(mm.costCny)}${np(mm.noPriceRequests)}</td>
          <td>${fmt(tm.requests)}</td>
          <td>${fmt(mm.requests)}</td>
          <td>${tok(tm.inputTokens + tm.outputTokens)}</td>
          <td>${tok(mm.inputTokens + mm.outputTokens)}</td>
        </tr>`;
      }
    }
  }
  document.getElementById('apiTable').innerHTML =
    `<tr><th></th><th>API / 模型</th><th>今日费用</th><th>本月费用</th><th>今日请求</th><th>本月请求</th><th>今日 tokens</th><th>本月 tokens</th></tr>` + rows;
  document.querySelectorAll('#apiTable .tool-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const k = tr.dataset.api;
      apiExpanded[k] = !apiExpanded[k];
      renderApiCosts();
    });
  });
}
export function exportApiCsv() {
  const provs = Array.isArray(snap.apiBilling && snap.apiBilling.providers) ? snap.apiBilling.providers : [];
  const provOf = Object.fromEntries(provs.map(p => [p.providerId, p]));
  const lines = [csvRow(['API', '服务商', '模型', '今日费用(¥)', '本月费用(¥)', '今日请求', '本月请求', '今日 tokens', '本月 tokens'])];
  for (const [key, b] of apiUsageEntries()) {
    const meta = BILLING_META[b.vendor] || {};
    const prov = provOf[key];
    const label = key.startsWith('model:') ? '按模型归因' : (prov && prov.label) || key;
    const today = b.today || {}, month = b.month || {}; // 老快照兼容
    const tks = x => (x.inputTokens || 0) + (x.outputTokens || 0);
    lines.push(csvRow([label, meta.name || b.vendor, '（合计）',
      (today.costCny || 0).toFixed(2), (month.costCny || 0).toFixed(2),
      today.requests, month.requests, tks(today), tks(month)]));
    for (const [m, mm] of Object.entries(month.models || {})) {
      const tm = (today.models || {})[m] || {};
      lines.push(csvRow([label, meta.name || b.vendor, m,
        (tm.costCny || 0).toFixed(2), (mm.costCny || 0).toFixed(2),
        tm.requests || 0, mm.requests, tks(tm), tks(mm)]));
    }
  }
  download(`ai-quota-export-${ymd()}-api.csv`, lines.join('\r\n'), 'text/csv');
}

// 模型分类费用：按工具聚合行 + 可展开的模型明细
const modelExpanded = {}; // toolKey -> bool，刷新后保持展开状态

export function renderModelCosts() {
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
          <td class="mut">└ ${esc(model)}</td>
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

export function renderChart() {
  const daysList = snap.agg.dailyKeys.slice(-30);
  const hasAnyData = daysList.some(d => { const t = snap.agg.daily[d]; return t && t.__total && cny(t.__total) > 0; });
  if (!hasAnyData) {
    document.getElementById('chartBox').innerHTML = '<div class="mut" style="padding:28px 0;text-align:center">暂无成本数据 —— 开始使用 AI 工具后，这里会出现每日成本趋势</div>';
    return;
  }
  const W = 1100, H = 220, P = { l: 50, r: 12, t: 12, b: 24 };
  const rawMax = Math.max(1, ...daysList.map(d => {
    const t = snap.agg.daily[d];
    if (!t) return 0;
    return t.__total ? cny(t.__total) : 0;
  }));
  // Y 轴取整刻度：向上取到半个数量级的整数倍（¥127 → ¥150，¥253 → ¥300）
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const maxV = Math.ceil(rawMax / (mag / 2)) * (mag / 2);
  const slot = (W - P.l - P.r) / Math.max(daysList.length, 1);
  const bw = Math.min(slot, 48); // 数据天数少时柱宽封顶（居中于各自槽位），避免整图被一根全宽色块铺满
  const colors = Object.fromEntries(TOOLS.map(t => [t.key, t.color]));
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
      bars += `<rect x="${P.l + i * slot + (slot - bw) / 2 + 1}" y="${y}" width="${Math.max(bw - 2, 1)}" height="${h}" fill="${colors[t.key]}"><title>${d} ${t.name}: ¥${v.toFixed(2)}</title></rect>`;
    }
    if (i % 5 === 0 || i === daysList.length - 1)
      bars += `<text x="${P.l + i * slot + slot / 2}" y="${H - 6}" font-size="10" fill="var(--muted)" text-anchor="middle">${d.slice(5)}</text>`;
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

export function renderDetail() {
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

export function renderKpis() {
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
    <div class="kpi hero"><div class="l">今日成本（含等价）</div><div class="v">${fmtCny(todayCny)}</div>${cmpDelta(todayCny, ySame && ySame.cny)}</div>
    <div class="kpi"><div class="l">本周累计（含等价）</div><div class="v">${fmtCny(weekCny)}</div></div>
    <div class="kpi"><div class="l">本月累计（含等价）</div><div class="v">${fmtCny(monthCny)}</div></div>`;
}

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

export { exportDetailCsv, exportModelsCsv, exportJson };
