// 套餐性价比：套餐实付月费（真实成本）vs 等价 API 消耗（按实际用到的模型 × 官方单价折算）。
// 回答两个问题：这个套餐花得值不值（性价比倍数）、还要不要继续买（购买建议）。
// 套餐是独立实体（plans.subscriptions，按「模型名匹配」跨工具归集）：MiniMax Token Plan 的
// 消耗 = 所有工具里 MiniMax 模型的等价成本；ChatGPT Plus = Codex 工具的 GPT 系用量。
// 金额取自每日聚合的 models 明细：订阅行只落 costCny（cc-switch 旧行，等价美元折算）或
// equivalentCny（单价表核算行）二者之一，求和即等价口径；无单价行只计次数（noPrice 提示）。
// 无 subscriptions 配置时回退旧行为（按工具聚合：payCnyPerMonth/usdPerMonth + 工具等价）。
import { esc, fmtCny, fmt, monthKey } from './utils.js';
import { snap } from './state.js';
import { TOOLS } from './render-cards.js';

function daysInMonth(ym) {
  return new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
}
function prevMonthKey() {
  const n = new Date(Date.now() + 8 * 3600e3);
  n.setUTCDate(1);
  n.setUTCMonth(n.getUTCMonth() - 1);
  return n.toISOString().slice(0, 7);
}

// 某月（YYYY-MM）内按套餐规则归集等价消耗：daily × tool × models 明细逐桶匹配。
// el = 当月 dailyKeys 天数（日历日代理，线性外推分母）
function matchMonth(ym, sub) {
  let cny = 0, requests = 0, noPrice = 0, el = 0;
  const lower = (sub.modelMatch || []).map(s => s.toLowerCase());
  const tools = sub.tools && sub.tools.length ? new Set(sub.tools) : null;
  for (const d of snap.agg.dailyKeys) {
    if (!d.startsWith(ym)) continue;
    el++;
    for (const [tool, a] of Object.entries(snap.agg.daily[d] || {})) {
      if (tool === '__total' || !a || typeof a !== 'object') continue;
      if (tools && !tools.has(tool)) continue;
      for (const [model, mv] of Object.entries(a.models || {})) {
        if (!mv || typeof mv !== 'object') continue;
        if (lower.length && !lower.some(s => model.toLowerCase().includes(s))) continue;
        requests += mv.requests || 0;
        if (mv.noPrice) { noPrice += mv.requests || 0; continue; }
        cny += (mv.costCny || 0) + (mv.equivalentCny || 0);
      }
    }
  }
  return { cny, requests, noPrice, el };
}

function realPrice(p, fx) {
  if (p && p.payCnyPerMonth) return { cny: Number(p.payCnyPerMonth), src: `¥${p.payCnyPerMonth}/月` };
  if (p && p.usdPerMonth) return { cny: Number(p.usdPerMonth) * fx, src: `$${p.usdPerMonth}/月` };
  return null;
}

// 购买建议（预计全月口径）：>=1 已回本；0.6~1 接近回本；<0.6 结合上月看是否持续低利用
function advice(E, Eproj, P, Eprev, el) {
  // 月初 / 本月尚无消耗：不下结论（1 号刚过零点外推恒为 0，误报「利用率偏低」）；上月数据仅作参考
  if (el === 0 || (E === 0 && Eproj === 0)) {
    return { cls: 'mid', text: Eprev != null && Eprev > 0
      ? `本月暂无消耗记录。上月等价 ${fmtCny(Eprev)}${Eprev >= P ? '（超实付）' : `（实付的 ${Math.round(Eprev / P * 100)}%）`}，产生用量后自动给出结论`
      : '本月暂无消耗记录 —— 产生用量后自动给出性价比结论' };
  }
  const pct = Math.round(Eproj / P * 100);
  if (Eproj >= P) {
    return { cls: 'ok', text: `已回本：预计全月等价 ${fmtCny(Eproj)} ≥ 实付 ${fmtCny(P)}（${(Eproj / P).toFixed(1)} 倍）—— 套餐划算，续订` };
  }
  if (pct >= 60) {
    return { cls: 'mid', text: `接近回本：预计用到 ${pct}%（${fmtCny(Eproj)}）。改按量直付约省 ${fmtCny(P - Eproj)}/月，但套餐更省心，可续订` };
  }
  if (Eprev != null && Eprev >= P) {
    return { cls: 'mid', text: `本月使用回落：上月等价 ${fmtCny(Eprev)}（超实付），本月预计仅 ${pct}% —— 先观察节奏再决定续订` };
  }
  return { cls: 'warn', text: `利用率偏低：预计全月只用 ${pct}%（${fmtCny(Eproj)}），按量直付约省 ${fmtCny(P - Eproj)}/月 —— 若连续数月如此，建议降档或改按量` };
}

const toolLabel = k => (TOOLS.find(t => t.key === k) || {}).name || k;

function subCard(sub, m, pm, dim, fx) {
  const rp = realPrice(sub, fx);
  if (!rp || !(rp.cny > 0)) return '';
  const E = m.cny;
  const Eproj = m.el ? E / m.el * dim : 0;
  const Eprev = pm.el ? pm.cny : null;
  const usedPct = E / rp.cny * 100;
  const adv = advice(E, Eproj, rp.cny, Eprev, m.el);
  const barCls = usedPct > 100 ? 'over' : usedPct >= 60 ? 'warn' : '';
  const scope = (sub.tools && sub.tools.length)
    ? `工具：${sub.tools.map(toolLabel).join('、')}`
    : '全部工具';
  const matchTxt = (sub.modelMatch && sub.modelMatch.length)
    ? `模型含 ${sub.modelMatch.map(esc).join(' / ')} · ${scope}`
    : scope;
  const noPriceHint = m.noPrice > 0
    ? ` · 其中 ${fmt(m.noPrice)} 次未录单价未计费（补齐价格源后自动核算）` : '';
  return `<div class="card" data-key="pv-${esc(sub.name)}">
    <h3>${esc(sub.name)} <span class="tag cost" title="套餐真实月费（设置 → 订阅套餐 可改）">实付 ${esc(rp.src)}</span></h3>
    <div class="rows">
      <div><span class="k">本月等价</span><span>${fmtCny(E)} <span class="mut">（实付的 ${Math.min(usedPct, 999).toFixed(0)}% · ${fmt(m.requests)} 次）</span></span></div>
      <div><span class="k">预计全月</span><span>${fmtCny(Eproj)} <span class="mut">（线性外推）· 性价比 ${(Eproj / rp.cny).toFixed(2)} 倍</span></span></div>
      <div><span class="k">上月等价</span><span>${Eprev == null ? '<span class="mut">无数据</span>' : fmtCny(Eprev)}</span></div>
      <div><span class="k">回本线</span><span class="mut">${fmtCny(rp.cny / dim)}/天 × ${dim} 天</span></div>
    </div>
    <div class="bar"><i class="${barCls}" style="width:${Math.min(usedPct, 100)}%"></i></div>
    <div class="quota-line"><span>${matchTxt}</span><span class="mut">口径：等价按量成本（元 / 百万 token 官方单价）</span></div>
    <div class="fresh pv-advice ${adv.cls}">💡 ${esc(adv.text)}${esc(noPriceHint)}</div>
  </div>`;
}

// 旧口径回退（无 subscriptions 配置时）：按工具聚合（payCnyPerMonth / usdPerMonth 挂在工具字段上）
function legacyCard(tool, p, m, pm, dim, fx) {
  const rp = realPrice(p, fx);
  if (!rp || !(rp.cny > 0)) return '';
  const E = m.cny;
  const Eproj = m.el ? E / m.el * dim : 0;
  const Eprev = pm.el ? pm.cny : null;
  const usedPct = E / rp.cny * 100;
  const adv = advice(E, Eproj, rp.cny, Eprev, m.el);
  const barCls = usedPct > 100 ? 'over' : usedPct >= 60 ? 'warn' : '';
  return `<div class="card" data-key="pv-${tool.key}">
    <h3>${tool.name} <span class="tag cost" title="套餐真实月费（设置 → 套餐真实月费 可改）">实付 ${esc(rp.src)}</span></h3>
    <div class="rows">
      <div><span class="k">本月等价</span><span>${fmtCny(E)} <span class="mut">（实付的 ${Math.min(usedPct, 999).toFixed(0)}% · ${fmt(m.requests)} 次）</span></span></div>
      <div><span class="k">预计全月</span><span>${fmtCny(Eproj)} <span class="mut">（线性外推）· 性价比 ${(Eproj / rp.cny).toFixed(2)} 倍</span></span></div>
      <div><span class="k">上月等价</span><span>${Eprev == null ? '<span class="mut">无数据</span>' : fmtCny(Eprev)}</span></div>
      <div><span class="k">回本线</span><span class="mut">${fmtCny(rp.cny / dim)}/天 × ${dim} 天</span></div>
    </div>
    <div class="bar"><i class="${barCls}" style="width:${Math.min(usedPct, 100)}%"></i></div>
    <div class="quota-line"><span>${tool.name} 全部模型 · 等价消耗 / 实付月费</span><span class="mut">口径：等价按量成本（元 / 百万 token 官方单价）</span></div>
    <div class="fresh pv-advice ${adv.cls}">💡 ${esc(adv.text)}</div>
  </div>`;
}

// 工具月聚合（旧口径）：等价 = equivalentCny；codex 取 Plus 套餐内 subUsd × 汇率
function toolMonth(toolKey, ym, fx) {
  let equivCny = 0, subUsd = 0, requests = 0, el = 0;
  for (const d of snap.agg.dailyKeys) {
    if (!d.startsWith(ym)) continue;
    el++;
    const a = (snap.agg.daily[d] || {})[toolKey];
    if (!a) continue;
    equivCny += a.equivalentCny || 0;
    subUsd += a.subUsd || 0;
    requests += a.requests || 0;
  }
  return { cny: toolKey === 'codex' ? subUsd * fx : equivCny, requests, el };
}

export function renderPlanValue() {
  const fx = snap.plans.usdCnyRate || 7.2;
  const cur = monthKey(), prev = prevMonthKey();
  const dim = daysInMonth(cur);
  const items = [];

  const subs = Array.isArray(snap.plans.subscriptions) ? snap.plans.subscriptions : [];
  if (subs.length) {
    for (const sub of subs) {
      const m = matchMonth(cur, sub);
      const pm = matchMonth(prev, sub);
      const html = subCard(sub, m, pm, dim, fx);
      if (html) items.push(html);
    }
  } else {
    // 旧口径回退：套餐价挂在工具字段上，按工具的等价消耗对比
    for (const tool of TOOLS.filter(t => t.sub || t.key === 'codex')) {
      const p = (snap.plans.plans || {})[tool.key] || {};
      const m = toolMonth(tool.key, cur, fx);
      const pm = toolMonth(tool.key, prev, fx);
      const html = legacyCard(tool, p, m, pm, dim, fx);
      if (html) items.push(html);
    }
  }

  const sec = document.getElementById('planValueSec');
  if (!sec) return;
  sec.style.display = items.length ? '' : 'none';
  document.getElementById('planValueCards').innerHTML = items.join('');
}
