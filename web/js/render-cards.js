// 套餐卡（实时额度）与按量计费卡（各服务商余额 + 用量费用 + Key 健康）的渲染
import { esc, fmt, fmtCny, fmtBytes, tok, cny, fmtMoney, todayKey, monthKey, weekStartKey } from './utils.js';
import { snap, toolDay } from './state.js';
import { forecast } from './goal.js';
import { applyCardOrder, foldModelChips } from './ui.js';
import { safeGet, safeSet, idleToolsKey, mmOpenKeyOf } from './storage.js';

// 工具识别色（与趋势图堆叠色一致，卡片头部圆点同源）
export const TOOLS = [
  { key: 'codex', name: 'ChatGPT · Codex', planName: 'ChatGPT 订阅', color: '#8aadf4' },
  { key: 'claudeDesktop', name: 'Claude Desktop', color: '#c6a0f6' },
  { key: 'claudeCode', name: 'Claude Code', sub: true, planName: 'cc-switch 路由（按模型计价）', color: '#ed8796' },
  { key: 'zcode', name: 'ZCode', sub: true, planName: '智谱 API 按量计费', color: '#a6da95' },
  { key: 'workbuddy', name: 'WorkBuddy', sub: true, planName: '订阅套餐（自定义模型）', color: '#eed49f' },
  { key: 'dsh', name: 'DeepSeek Harness', planName: 'DeepSeek API 直连（充值按量）', color: '#4d6bfe' },
];

// 套餐实时额度卡（5h / 周窗口）
function quotaBar(label, used, resetMs) {
  if (used == null) return `<div class="quota-line"><span>${label}</span><span class="mut">不可用</span></div>`;
  used = Math.round(used * 10) / 10; // 浮点取整，避免「剩 12.700000000000003%」
  const cls = used > 85 ? 'over' : used > 60 ? 'warn' : '';
  const reset = resetMs ? ` · 剩 ${Math.floor(resetMs / 3600e3)}h${Math.floor(resetMs % 3600e3 / 60e3)}m` : '';
  return `<div class="bar"><i class="${cls}" style="width:${Math.min(used, 100)}%"></i></div>
    <div class="quota-line"><span>${label} 已用 ${used}%</span><span class="mut">剩 ${Math.round((100 - used) * 10) / 10}%${reset}</span></div>`;
}
// 额度卡降级策略：未配置类原因（未找到/未配置/无凭证）且从未成功 → 整卡不渲染；
// 曾成功过之后失败 → 显示失败态；其他失败原因（超时/接口异常）→ 也提示失败
const quotaEverOk = {}; // key -> 曾成功过
const QUOTA_UNCONFIGURED_RE = /未找到|未配置|无凭证/;
function quotaCardMode(q, key) {
  if (q && q.available) { quotaEverOk[key] = true; return 'ok'; }
  if (quotaEverOk[key]) return 'error';
  if (q && (q.notConfigured || QUOTA_UNCONFIGURED_RE.test(String(q.reason || '')))) return 'skip';
  return q ? 'error' : 'skip';
}
const quotaFailureHtml = reason =>
  '<div class="quota-line"><span>实时额度获取失败</span><span class="mut">' + esc(reason || '') + '</span></div>';

// VPN 流量包卡（订阅头计量，服务端账单口径）：已用占比进度条（档位配色同额度条）+ 剩余/到期 + 今日/累计
function vpnQuotaBody(v) {
  const usedPct = Math.round((v.usedPercent || 0) * 10) / 10;
  const cls = usedPct > 85 ? 'over' : usedPct > 60 ? 'warn' : '';
  const daysLeft = v.expireAt ? Math.max(0, Math.floor((v.expireAt - Date.now()) / 86400e3)) : null; // 向下取整，与面板「N 天后到期」同口径
  return `<div class="bar"><i class="${cls}" style="width:${Math.min(usedPct, 100)}%"></i></div>
    <div class="quota-line"><span>流量包已用 ${usedPct}%</span>
      <span class="mut">剩 ${fmtBytes(v.remainingBytes)}${daysLeft != null ? ' · ' + daysLeft + ' 天后到期' : ''}</span></div>
    <div class="quota-line"><span>今日 ${fmtBytes(v.todayBytes || 0)} · 累计 ${fmtBytes(v.usedBytes)} / ${fmtBytes(v.totalBytes)}</span>
      <span class="mut"></span></div>`;
}

// 套餐月费徽章：usdPerMonth（真实美元订阅价，附折算 ¥）优先，其次 cnyPerMonth
function planCostBadge(toolKey) {
  const p = (snap.plans.plans || {})[toolKey] || {};
  const rate = snap.plans.usdCnyRate || 7.2;
  if (p.usdPerMonth) return { cost: '$' + p.usdPerMonth + '/月', tip: '≈¥' + (p.usdPerMonth * rate).toFixed(2) + '/月（汇率 ' + rate + '）' };
  if (p.cnyPerMonth) return { cost: '¥' + p.cnyPerMonth + '/月', tip: '' };
  return { cost: '', tip: '' };
}

export function renderQuotaCards() {
  const items = [];

  const cgq = snap.chatgptQuota;
  const cgMode = quotaCardMode(cgq, 'chatgpt');
  if (cgMode === 'ok') {
    items.push({
      name: cgq.provider || 'ChatGPT Plus',
      note: 'Codex · GPT 系列',
      ...planCostBadge('codex'),
      body: quotaBar('5 小时窗口', cgq.fiveHour && cgq.fiveHour.usedPercent, cgq.fiveHour && cgq.fiveHour.resetMsLeft)
          + quotaBar('周窗口', cgq.weekly && cgq.weekly.usedPercent, cgq.weekly && cgq.weekly.resetMsLeft),
      fresh: (cgq.archived ? '主端同步 · ' : '实时 · ') + new Date(cgq.fetchedAt).toLocaleTimeString('zh-CN'),
    });
  } else if (cgMode === 'error') {
    items.push({ name: 'ChatGPT Plus', note: 'Codex · GPT 系列', ...planCostBadge('codex'), body: quotaFailureHtml(cgq && cgq.reason), fresh: '' });
  }

  const mmq = snap.minimaxQuota;
  const mmMode = quotaCardMode(mmq, 'minimax');
  if (mmMode === 'ok') {
    items.push({
      name: mmq.provider || 'MiniMax Token Plan',
      note: 'ZCode / WorkBuddy / Codex · MiniMax 模型',
      ...planCostBadge('workbuddy'),
      body: quotaBar('5 小时窗口', mmq.fiveHour && mmq.fiveHour.usedPercent, mmq.fiveHour && mmq.fiveHour.resetMsLeft)
          + quotaBar('周窗口', mmq.weekly && mmq.weekly.usedPercent, mmq.weekly && mmq.weekly.resetMsLeft),
      fresh: (mmq.archived ? '主端同步 · ' : '实时 · ') + new Date(mmq.fetchedAt).toLocaleTimeString('zh-CN'),
    });
  } else if (mmMode === 'error') {
    items.push({ name: 'MiniMax Token Plan MAX', note: 'ZCode / WorkBuddy / Codex · MiniMax 模型', ...planCostBadge('workbuddy'), body: quotaFailureHtml(mmq && mmq.reason), fresh: '' });
  }

  // VPN 流量包卡（订阅计量，独立于 AI 额度体系）：未配置订阅地址时 quotaCardMode 回退 skip 不渲染
  const vq = snap.vpnQuota;
  const vMode = quotaCardMode(vq, 'vpn');
  if (vMode === 'ok') {
    items.push({
      name: 'VPN 流量包',
      note: '套餐配额 · ' + (vq.provider || '订阅面板'),
      body: vpnQuotaBody(vq),
      fresh: '实时 · ' + new Date(vq.fetchedAt).toLocaleTimeString('zh-CN'),
    });
  } else if (vMode === 'error') {
    items.push({ name: 'VPN 流量包', note: '套餐配额', body: quotaFailureHtml(vq && vq.reason), fresh: '' });
  }

  // 智谱团队套餐已停用（2026-10-30 起转 API 按量计费），额度卡不渲染；
  // 智谱账户余额与按量费用见下方「按量统计」区块
  renderQuotaItems(items);
}

function renderQuotaItems(items) {
  // 全部额度卡都隐藏时，连区块标题一起收起，避免留一截空标题
  document.getElementById('quotaCards').closest('section').style.display = items.length ? '' : 'none';
  document.getElementById('quotaCards').innerHTML = items.map(it => `
    <div class="card" data-key="${esc(it.name)}">
      <h3>${esc(it.name)} <span class="tag">实时</span>${it.cost ? `<span class="tag cost" title="${esc(it.tip || '')}">${it.cost}</span>` : ''}</h3>
      <div class="rows"><div><span class="k">适用</span><span class="mut" style="font-size:12px">${it.note}</span></div></div>
      ${it.body}
      <div class="fresh">${it.fresh}${it.tip ? ' · ' + esc(it.tip) : ''}</div>
    </div>`).join('');
  applyCardOrder('quotaCards');
}

// ---------- API 按量计费（各服务商余额 + 今日/本月用量费用 + Key 健康） ----------
// 2026-10-30 起用户停用 GLM 团队套餐，转为各服务商按 token 计费。
// 优先按 ZCode 自定义模型服务商动态渲染（snap.apiBilling.providers，每次快照从 provider_config.json 发现，
// 用户增删服务商 ≤60s 自动跟上）；未检测到配置时回退静态基线卡。
export const BILLING_META = {
  zhipu:    { name: '智谱 API',       note: 'ZCode / Claude Code · GLM 系列按量线路', src: 'open.bigmodel.cn' },
  deepseek: { name: 'DeepSeek API',   note: 'ZCode / cc-switch 路由 · deepseek 系列', src: 'api.deepseek.com' },
  bailian:  { name: '阿里云百炼 API', note: 'ZCode 自定义模型 · Qwen 及百炼托管模型', src: 'business.aliyuncs.com' },
  moonshot: { name: 'Kimi API',       note: 'ZCode 自定义模型 · kimi 系列', src: 'api.moonshot.cn' },
  minimax:  { name: 'MiniMax API',    note: 'ZCode 自定义模型 · MiniMax 系列', src: 'api.minimaxi.com' },
  volcengine: { name: '火山方舟 API', note: '豆包 doubao-seed 系列 · DeepSeek / GLM / Kimi / Qwen 方舟托管', src: 'ark.cn-beijing.volces.com' },
};
// 独立运行（无 ZCode 自定义配置）时的回退服务商列表
const BILLING_PROVIDERS = ['zhipu', 'deepseek', 'bailian', 'moonshot', 'volcengine'];

// 通用「适用」行 + 三行用量费用（今日/本月费用 + 今日用量；未录单价的请求在费用行单列提示，不误显示为 0）
function billingCostLines(v) {
  const t = v.today || {}, m = v.month || {};
  const np = n => n ? ` <span class="mut">（${fmt(n)} 次未计价）</span>` : '';
  return `<div class="quota-line"><span>今日费用</span><span>${fmtCny(t.costCny ?? 0)}${np(t.noPriceRequests)}</span></div>
    <div class="quota-line"><span>本月费用</span><span>${fmtCny(m.costCny ?? 0)}${np(m.noPriceRequests)}</span></div>
    <div class="quota-line"><span>今日用量</span><span class="mut">${fmt(t.requests || 0)} 次 · ${tok((t.inputTokens || 0) + (t.outputTokens || 0))} tokens</span></div>`;
}
// Key 健康徽标（provider_config 里该服务商自身 key 的 /models 探活结果）
function billingKeyChip(kc) {
  if (!kc || !kc.checked) return '<span class="keychip mut">Key 未检测</span>';
  if (kc.ok) return '<span class="keychip ok">Key 有效</span>';
  return `<span class="keychip bad" title="${esc(kc.reason)}">Key 失效</span>`;
}
// 并卡后的多 Key 徽标：口径同上，前缀 Key 名称以区分各把 Key
function labeledKeyChip(label, kc) {
  if (!kc || !kc.checked) return `<span class="keychip mut">${esc(label)} Key 未检测</span>`;
  if (kc.ok) return `<span class="keychip ok">${esc(label)} Key 有效</span>`;
  return `<span class="keychip bad" title="${esc(kc.reason)}">${esc(label)} Key 失效</span>`;
}
// 金额余额区（仅按量服务商）：zhipu 用 account 字段，其余用 balance；未充值/失败降级
function billingBalanceHtml(vendor, q, mmKey) {
  if (vendor === 'volcengine') return volcengineModelsHtml(q, null, mmKey);
  if (vendor === 'bailian' && (!q || !q.available)) {
    return '<div class="billing-balance"><span class="bal-na">余额需配 AccessKey</span></div>'
      + (q && q.reason ? `<div class="quota-line"><span class="mut">${esc(q.reason)}</span></div>` : '');
  }
  if (vendor === 'zhipu' && q && q.available) {
    const ac = q.account || {};
    const b = ac.availableBalance != null ? ac.availableBalance : ac.balance;
    if (b != null) return `<div class="billing-balance">${fmtMoney(b)}<span class="mut">可用余额</span></div>`;
    return '<div class="billing-balance"><span class="bal-na">未充值</span></div><div class="billing-sub">充值后余额自动展示</div>';
  }
  if (q && q.available && q.balance && q.balance.total != null) {
    const parts = [];
    if (q.balance.toppedUp != null) parts.push('充值 ' + fmtMoney(q.balance.toppedUp));
    if (q.balance.granted) parts.push('赠金 ' + fmtMoney(q.balance.granted));
    if (q.balance.credit) parts.push('代金券 ' + fmtMoney(q.balance.credit));
    return `<div class="billing-balance">${fmtMoney(q.balance.total)}<span class="mut">可用余额</span></div>`
      + (parts.length ? `<div class="billing-sub">${parts.join(' · ')}</div>` : '');
  }
  return '<div class="billing-balance"><span class="bal-na">余额不可用</span></div>'
    + (q && q.reason ? `<div class="quota-line"><span class="mut">${esc(q.reason)}</span></div>` : '');
}

// 模型 chips 容器：chips 全量渲染，尾部带折叠钮（初始隐藏）。
// 模型过多时由 foldModelChips()（ui.js）自动收成一行 +「+N 个 ▾」，卡片高度与其他卡对齐；展开态按卡记忆在 localStorage
export function modelChipsHtml(mmKey, chipsHtml) {
  if (!chipsHtml) return '';
  const open = safeGet(mmOpenKeyOf(mmKey)) === '1';
  return `<div class="billing-models${open ? ' open' : ''}" data-mm="${esc(mmKey)}">${chipsHtml}<button type="button" class="mm mm-toggle" hidden></button></div>`;
}

// 火山方舟主位区：无余额接口（实测 404，计费在火山引擎账户侧），以 /api/v3/models 在售模型清单代替
// configuredModels：该 provider 实际配置的模型（personalModelIds），chips 里排最前并高亮
function volcengineModelsHtml(q, configuredModels, mmKey) {
  if (!q || !q.available || !q.models) {
    return '<div class="billing-balance"><span class="bal-na">模型清单不可用</span></div>'
      + (q && q.reason ? `<div class="quota-line"><span class="mut">${esc(q.reason)}</span></div>` : '');
  }
  const m = q.models;
  const conf = (configuredModels || []).filter(x => (m.active || []).includes(x));
  const rest = (m.active || []).filter(x => !conf.includes(x));
  const chips = [...conf, ...rest].map(x => `<span class="mm${conf.includes(x) ? ' mm-on' : ''}">${esc(x)}</span>`).join('');
  return `<div class="billing-balance">${m.activeCount}<span class="mut">在售模型</span></div>`
    + `<div class="billing-sub">共 ${m.totalCount} 款 · 退役中 ${m.retiringCount} · 已下线 ${m.shutdownCount} · Key ${esc(q.keyMasked || '')}</div>`
    + modelChipsHtml(mmKey || 'billing-volcengine', chips);
}

// 火山方舟独立卡：设置面板 quotaKeys.volcengine 配置的 Key（未接入 ZCode 自定义模型时；
// 同 key 已是 provider 的话 linkedProvider 非空，由 provider 卡展示，不重复出卡）
function volcengineCard(q, vendors) {
  const kc = { checked: q.checked, ok: q.ok, reason: q.reason };
  return `<div class="card" data-key="billing-volcengine">
    <h3>火山方舟 API <span class="tag sub-pay">按量</span> ${billingKeyChip(kc)}</h3>
    <div class="rows"><div><span class="k">适用</span><span class="mut" style="font-size:12px">豆包 doubao-seed 系列 · DeepSeek / GLM / Kimi / Qwen 方舟托管</span></div></div>
    ${volcengineModelsHtml(q, null, 'billing-volcengine')}
    ${billingCostLines((vendors || {}).volcengine || {})}
    <div class="fresh">${q.available ? '实时 · ' + new Date(q.fetchedAt).toLocaleTimeString('zh-CN') + ' · ark.cn-beijing.volces.com' : '费用 = 按量线路用量 × 官方单价（无单价模型不计费）'}</div>
  </div>`;
}

// 智谱「其他 Key」卡：设置面板配置的第二把及以后智谱 Key（独立于自己账户的主 Key 监控）。
// 智谱标准 Key 无余额查询接口（余额仅 OAuth 登录态可查，见主账户卡），本卡展示 Key 健康检测
function zhipuExtraCard(it) {
  const kc = { checked: it.checked, ok: it.ok, reason: it.reason };
  return `<div class="card" data-key="billing-zhipu-extra-${esc(it.label)}">
    <h3>智谱 · ${esc(it.label)} <span class="tag sub-pay">按量</span> ${billingKeyChip(kc)}</h3>
    <div class="rows"><div><span class="k">适用</span><span class="mut" style="font-size:12px">独立智谱标准 Key · 与主账户分开监控</span></div></div>
    <div class="billing-balance"><span class="bal-na">标准 Key 无余额接口</span></div>
    <div class="billing-sub">智谱余额查询仅支持 OAuth 登录态（主账户卡已展示）；本卡按探活结果报告 Key 健康</div>
    <div class="quota-line"><span>Key</span><span class="mut">${esc(it.keyMasked)}</span></div>
    <div class="fresh">${it.checked ? '探活 · ' + new Date(it.checkedAt).toLocaleTimeString('zh-CN') + ' · open.bigmodel.cn' : '未检测'}</div>
  </div>`;
}

// 动态卡：一个服务商一张（同服务商多个 ZCode provider 并卡；Key 检测 + 按量余额/费用 / 订阅说明）
// 余额按服务商账户、费用按服务商聚合——同服务商拆多卡只是同一口径数字重复，
// 故并为主卡一张：副 Key 的探活徽标带名称并入卡头，模型清单取并集，副 Key 名在卡内注明
function billingProviderCard(group, ab, vendors) {
  const [p, ...rest] = group;
  const meta = BILLING_META[p.vendor] || {};
  // 并卡后标题用服务商名（主 Key 名会盖住其余 Key）；单 Key 仍用用户自定义 label
  const name = rest.length ? (meta.name || p.label || p.providerId) : (p.label || meta.name || p.providerId);
  const q = ab[p.vendor] || null;
  const kc = (ab.keyChecks || {})[p.providerId] || {};
  const sub = p.billingKind === 'subscription';
  const badge = sub ? '<span class="tag">订阅</span>' : '<span class="tag sub-pay">按量</span>';
  // 模型清单取并集（同服务商多 Key 共用模型，Set 去重防重复 chip）
  const modelSet = new Set();
  for (const x of group) for (const m of (x.models || [])) modelSet.add(m);
  const models = [...modelSet];
  // 火山方舟：主位 volcengineModelsHtml 已展示 /api/v3/models 实拉清单，personalModelIds 不再重复出 chips
  const modelChips = p.vendor === 'volcengine' ? '' : modelChipsHtml('billing-' + p.providerId,
    models.map(m => `<span class="mm">${esc(m)}</span>`).join(''));
  const noteHtml = sub
    ? '订阅套餐 · 额度见上方套餐区'
    : (meta.note || '按 token 计费');
  // Key 健康徽标：并卡时每把都带名称（否则分不清哪个圆点对应哪把 Key）
  const keyChips = rest.length
    ? [labeledKeyChip(p.label || p.providerId, kc),
       ...rest.map(x => labeledKeyChip(x.label || x.providerId, (ab.keyChecks || {})[x.providerId] || {}))].join(' ')
    : billingKeyChip(kc);
  let mid, costHtml;
  if (sub) {
    mid = '<div class="billing-balance"><span class="bal-na">订阅制 · 不按量扣费</span></div>';
    costHtml = '';
  } else if (p.vendor === 'volcengine') {
    mid = volcengineModelsHtml(q, models, 'billing-' + p.providerId); // 配置的模型优先展示（billingBalanceHtml 的 volcengine 分支无配置信息）
    costHtml = billingCostLines(vendors[p.vendor] || {});
  } else {
    mid = billingBalanceHtml(p.vendor, q);
    costHtml = billingCostLines(vendors[p.vendor] || {});
  }
  const mergeNote = rest.length
    ? `<div class="billing-sub">同服务商 ${group.length} 把 Key 已并卡：${esc(rest.map(x => x.label || x.providerId).join('、'))} · 余额与用量费用按服务商口径统计</div>`
    : '';
  const fresh = (q && q.available && q.fetchedAt)
    ? '实时 · ' + new Date(q.fetchedAt).toLocaleTimeString('zh-CN') + ' · ' + (meta.src || '')
    : (p.hasProbe ? '费用 = 按量线路用量 × 官方单价（无单价模型不计费）' : '无探测端点 · 费用 = 按量线路用量 × 官方单价（无单价模型不计费）');
  return `<div class="card" data-key="billing-${esc(p.providerId)}">
    <h3>${esc(name)} ${badge} ${keyChips}</h3>
    <div class="rows"><div><span class="k">适用</span><span class="mut" style="font-size:12px">${esc(noteHtml)}</span></div></div>
    ${mid}${mergeNote}
    ${modelChips}
    ${costHtml}
    <div class="fresh">${esc(fresh)}</div>
  </div>`;
}

export function renderBillingCards() {
  const ab = snap.apiBilling || {};
  const vendors = snap.vendors || {};
  // 按量统计只收 payg 服务商；订阅服务商（如 MiniMax Token Plan）归「套餐统计」区
  const providers = (Array.isArray(ab.providers) ? ab.providers : []).filter(p => p.billingKind !== 'subscription');
  // 智谱「其他 Key」：linkedProvider 非空 = 同 key 已是 ZCode 自定义模型（已有独立 provider 卡），跳过避免重复
  const zhipuExtras = (Array.isArray(ab.zhipuExtraKeys) ? ab.zhipuExtraKeys : []).filter(x => !x.linkedProvider);
  let items;
  if (providers.length) {
    // 同服务商多个按量 provider 并成一组出一张卡（余额/费用本就是服务商口径，拆卡只是重复同组数字）；
    // 未知服务商（vendor null）无从聚合，仍各自独立成卡
    const groups = [];
    const byVendor = new Map();
    for (const p of providers) {
      if (!p.vendor) { groups.push([p]); continue; }
      let g = byVendor.get(p.vendor);
      if (!g) { g = []; byVendor.set(p.vendor, g); groups.push(g); }
      g.push(p);
    }
    items = groups.map(g => billingProviderCard(g, ab, vendors));
    // 附加卡紧跟智谱主卡之后（无智谱 provider 时排在末尾）
    if (zhipuExtras.length) {
      const zi = groups.findIndex(g => g[0].vendor === 'zhipu');
      items.splice(zi >= 0 ? zi + 1 : items.length, 0, ...zhipuExtras.map(zhipuExtraCard));
    }
    // 火山方舟独立卡：Key 来自设置面板且未接入 ZCode 自定义模型（linkedProvider 非空 = provider 卡已展示）
    const vol = ab.volcengine;
    if (vol && !vol.linkedProvider && !vol.notConfigured) items.push(volcengineCard(vol, vendors));
  } else {
    // 回退：无 ZCode 自定义配置时按基线服务商渲染
    items = [];
    for (const vendor of BILLING_PROVIDERS) {
      const q = ab[vendor] || null;
      const v = vendors[vendor] || {};
      const mode = quotaCardMode(q, 'billing-' + vendor);
      if (mode === 'skip' && !v.today && !v.month) continue;
      const meta = BILLING_META[vendor];
      items.push(`<div class="card" data-key="billing-${vendor}">
        <h3>${meta.name} <span class="tag sub-pay">按量</span></h3>
        <div class="rows"><div><span class="k">适用</span><span class="mut" style="font-size:12px">${meta.note}</span></div></div>
        ${billingBalanceHtml(vendor, q, 'billing-' + vendor)}
        ${billingCostLines(v)}
        <div class="fresh">${q && q.available ? '实时 · ' + new Date(q.fetchedAt).toLocaleTimeString('zh-CN') + ' · ' + meta.src : '费用 = 按量线路用量 × 官方单价（无单价模型不计费）'}</div>
      </div>`);
    }
    if (zhipuExtras.length) {
      const zi = items.findIndex(s => s.includes('data-key="billing-zhipu"'));
      items.splice(zi >= 0 ? zi + 1 : 0, 0, ...zhipuExtras.map(zhipuExtraCard));
    }
  }
  document.getElementById('billingCards').closest('section').style.display = items.length ? '' : 'none';
  document.getElementById('billingCards').innerHTML = items.join('');
  applyCardOrder('billingCards');
  foldModelChips();
}

// 数据源行数：codex / claudeDesktop 都来自 cc-switch（codex 另计 ~/.codex/sessions 会话行，
// 2026-10-15 起 cc-switch 停更由其接续），共用一个计数
function rowStatOf(toolKey) {
  if (toolKey === 'codex' || toolKey === 'claudeDesktop') {
    return (snap.rowStats.ccswitch || 0) + (toolKey === 'codex' ? (snap.rowStats.codexSessions || 0) : 0);
  }
  return snap.rowStats[toolKey] || 0;
}

export function renderCards() {
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
      // 两段计费：GPT 系列 = Plus 套餐等价；第三方 = 真实按量。
      // 主金额 = costCny（cc-switch 实扣口径，含旧订阅等价）+ equivalentCny（会话源按单价表核算的等价）
      const subUsd = month.subUsd || 0, payUsd = month.payUsd || 0;
      const subReq = month.subRequests || 0, payReq = month.payRequests || 0;
      costLine = `${fmtCny(month.costCny + month.equivalentCny)}<br>
        <span style="font-size:12px"><span class="tag sub-pay" title="Plus 套餐内等价折算，不额外扣费">Plus 套餐</span> ${subReq} 次 · $${subUsd.toFixed(2)}</span><br>
        <span style="font-size:12px"><span class="tag">第三方实扣</span> ${payReq} 次 · <b>$${payUsd.toFixed(2)}</b> ≈ ${fmtCny(payUsd * fx)}</span>`;
    } else if (t.key === 'claudeDesktop') {
      costLine = `${fmtCny(month.costCny)} <span class="mut">($${month.costUsd.toFixed(2)} × ${fx})</span>`;
    } else {
      costLine = `${fmtCny(month.equivalentCny)} <span class="tag sub-pay" title="订阅制 · 等价按量成本，非实际扣费">订阅制 · 非扣费</span>`;
    }

    const planLine = (p.plan || t.planName)
      ? `<div><span class="k">套餐</span><span class="mut" style="font-size:12px">${esc(p.plan || t.planName || '')}</span></div>`
      : '';
    // 昨日同期（昨日此刻之前）该工具的请求与费用
    const yTool = snap.cmp && snap.cmp.yesterdaySameTime.tools && snap.cmp.yesterdaySameTime.tools[t.key];
    const yToolPart = yTool && yTool.requests
      ? ` <span class="mut" style="font-size:11px;display:inline-block">· 昨同 ${fmt(yTool.requests)} 次 / ${fmtCny(yTool.cny)}</span>` : '';
    // 采集器报错文案（来自上游错误信息，直插前转义）
    const cErr = snap.collectorErrors[(t.key === 'claudeDesktop' || t.key === 'codex') ? 'ccswitch' : t.key];

    return `<div class="card" data-key="${t.key}">
      <h3><span class="tool-dot" style="background:${t.color}"></span>${t.name} ${t.sub ? '<span class="tag sub-pay">套餐</span>' : '<span class="tag">按量</span>'}</h3>
      <div class="rows">
        ${planLine}
        <div><span class="k">今日</span><span>${fmt(today.requests)} 次 · ${tok(today.inputTokens + today.outputTokens)} tk${yToolPart}</span></div>
        <div><span class="k">本月请求</span><span>${fmt(month.requests)} 次 · ${tok(month.inputTokens + month.outputTokens)} tk</span></div>
        <div><span class="k">本月费用</span><span>${costLine}</span></div>
        <div><span class="k">本周费用</span><span>${fmtCny(weekToolCny)} <span class="mut">（周一起）</span></span></div>
        <div><span class="k">本月预估</span><span>${fmtCny(fc)} <span class="mut">（线性外推）</span></span></div>
      </div>
      ${quotaHtml}
      <div class="fresh">数据源 ${rowStatOf(t.key)} 条${cErr ? ' · <span class="err">' + esc(cErr) + '</span>' : ''}</div>
    </div>`;
  };
  // 未启用（rowStats=0）的工具卡折叠成一行，可展开；展开态记忆在 localStorage
  const idleExpanded = safeGet(idleToolsKey) === '1';
  // 卡片显隐：hiddenCards 里的工具整卡不渲染（含未启用折叠区）；数据表/趋势图不受影响
  const hiddenSet = new Set(snap.plans.hiddenCards || []);
  const idleTools = TOOLS.filter(t => !rowStatOf(t.key) && !hiddenSet.has(t.key));
  const hiddenHint = hiddenSet.size
    ? `<div class="cards-hidden-hint">已隐藏 ${hiddenSet.size} 个工具卡片 · 设置 → 卡片显示 可恢复</div>` : '';
  // 卡片网格里只放真正的卡片（auto-fit 才能折叠空轨道、让剩余卡片拉伸铺满）；
  // 折叠条/提示条放独立容器 #cardsAux，整行显示
  document.getElementById('cards').innerHTML =
    TOOLS.filter(t => rowStatOf(t.key) && !hiddenSet.has(t.key)).map(buildCard).join('')
    + (idleExpanded ? idleTools.map(buildCard).join('') : '');
  document.getElementById('cardsAux').innerHTML =
    (idleTools.length ? `<div class="card idle-toggle" id="idleToggle">另有 ${idleTools.length} 个未启用的工具 <span class="arr">${idleExpanded ? '▾' : '▸'}</span></div>` : '')
    + hiddenHint;
  const tg = document.getElementById('idleToggle');
  if (tg) tg.addEventListener('click', () => {
    safeSet(idleToolsKey, idleExpanded ? '0' : '1');
    renderCards();
  });
  applyCardOrder('cards');
}
