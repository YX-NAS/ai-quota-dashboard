// 设置面板：额度 Key / 预警推送 / 单价编辑与在线更新，保存与加载逻辑（含全部按钮绑定）
import { esc, toast, hourOptions } from './utils.js';
import { snap } from './state.js';
import { TOOLS } from './render-cards.js';

// 保存 / 单价在线应用后要重拉快照并重渲染：load 归 main.js 所有（loadSeq 守卫在 load 内），
// 由 main 启动时注入，避免 settings → main 的循环依赖
let loadFn = () => {};
export function initSettings(fn) { loadFn = fn; }

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
      <span class="pm" title="${esc(m)}">${esc(m)} ${tag}</span>
      <input data-price="${esc(m)}" data-pf="in" type="number" step="0.01" min="0" value="${esc(fmt0(o.in))}" placeholder="${esc(ph('in'))}">
      <input data-price="${esc(m)}" data-pf="out" type="number" step="0.01" min="0" value="${esc(fmt0(o.out))}" placeholder="${esc(ph('out'))}">
      <input data-price="${esc(m)}" data-pf="cacheRead" type="number" step="0.01" min="0" value="${esc(fmt0(o.cacheRead))}" placeholder="${d.cacheRead != null ? '默认 ' + esc(d.cacheRead) : '按输入价'}">
    </div>`;
  }).join('');
  return `<hr><div class="qk-hint">模型单价（元 / 百万 token，等价成本口径）—— 输入/输出/缓存命中三列；<b>留空 = 用默认价，填数字 = 覆盖</b>；覆盖后各端立即按新单价重算历史成本。价格调整后在这里改即可，不用动代码。</div>
    <div class="price-head"><span>模型</span><span>输入</span><span>输出</span><span>缓存命中</span></div>
    ${rows}
    <button type="button" id="priceReset" class="seg">全部恢复默认价</button>`;
}

// 预警推送编辑器：webhookUrl 与额度 Key 同一套三态语义（脱敏回显不改 = 保留；清空 = 关闭推送配置；新值 = 覆盖）
const ALERT_WEBHOOK_HINTS = {
  wecom: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…（企业微信群里「添加群机器人」复制的 Webhook 地址，免费无条数限制）',
  serverchan: 'https://sctapi.ftqq.com/你的SendKey.send（Server酱·微信服务号推送，免费版每天 5 条）',
  ntfy: 'https://ntfy.sh/你的主题名（手机装 ntfy App 订阅同名主题即收推送）',
  bark: 'https://api.day.app/你的Key（iOS Bark App 里复制）',
  generic: '任意接收 JSON POST 的 webhook 地址（body 含 title/message/severity/source）',
};
const ALERT_CHANNEL_NAMES = {
  wecom: '企业微信（群机器人 · 推荐）', serverchan: 'Server酱（微信）',
  ntfy: 'ntfy（iPhone / Android / 桌面）', bark: 'Bark（iOS）', generic: '通用 Webhook（JSON）',
};
function renderAlertsEditor(p) {
  const a = p.alerts || {};
  const th = a.thresholds || {};
  const dg = a.digest || {};
  const rp = a.reportPush || {};
  const type = ALERT_WEBHOOK_HINTS[a.webhookType] ? a.webhookType : 'ntfy';
  return `<hr><div class="qk-hint">🔔 额度预警推送 —— 阈值触发后推送到手机（企业微信 / Server酱 / ntfy / Bark / 自定义 webhook）。推送内容只含百分比与金额，不含任何密钥；默认关闭</div>
    <label class="ck"><input id="sAlertOn" type="checkbox" ${a.enabled ? 'checked' : ''}> 启用预警推送</label>
    <label>推送通道</label>
    <select id="sAlertType">${Object.keys(ALERT_WEBHOOK_HINTS).map(k =>
      `<option value="${k}" ${k === type ? 'selected' : ''}>${ALERT_CHANNEL_NAMES[k]}</option>`).join('')}</select>
    <label>推送地址（已配置显示为脱敏，不改即保留；清空 = 停用推送）</label>
    <div class="alert-url-row">
      <input id="sAlertUrl" type="text" value="${esc(a.webhookUrl || '')}" placeholder="${ALERT_WEBHOOK_HINTS[type]}" spellcheck="false">
      <button type="button" id="sAlertTest">发送测试</button>
    </div>
    <div class="qk-hint" id="sAlertHint">${ALERT_WEBHOOK_HINTS[type]}</div>
    <div class="qk-hint" id="sAlertTestMsg" hidden></div>
    <label>触发阈值（百分比 ≥ 即推送，0~100）</label>
    <div class="th-row">
      <span>5h 窗口 <input id="sTh5h" type="number" min="0" max="100" value="${th.fiveHour ?? 85}">%</span>
      <span>周窗口 <input id="sThWk" type="number" min="0" max="100" value="${th.weekly ?? 85}">%</span>
      <span>当日目标 <input id="sThGoal" type="number" min="0" max="100" value="${th.dailyGoalPct ?? 100}">%</span>
      <span>VPN 已用 <input id="sThVpn" type="number" min="0" max="100" value="${th.vpnUsed ?? 90}">%</span>
    </div>
    <label>同一事件冷却（分钟，间隔内不重复推送）</label>
    <input id="sAlertCd" type="number" min="1" step="1" value="${a.cooldownMinutes ?? 60}">
    <hr><div class="qk-hint">⏰ 定时推送 —— 与预警共用上面的通道。每日摘要 = 当天到点后推一次今日消耗；周报（仅周一）/ 月报（仅 1 号）推上一期报告。到点时服务未运行则当天内开机补推，跨天不补</div>
    <label class="ck"><input id="sDgOn" type="checkbox" ${dg.enabled ? 'checked' : ''}> 每日摘要（今日消耗 + 工具 Top3 + 窗口用量）</label>
    <label>每日摘要时刻（北京时间）</label>
    <select id="sDgHour">${hourOptions(dg.hour ?? 21)}</select>
    <label class="ck"><input id="sRwOn" type="checkbox" ${(rp.week || {}).enabled ? 'checked' : ''}> 周报推送（每周一发上周报告）</label>
    <label>周报时刻（北京时间）</label>
    <select id="sRwHour">${hourOptions((rp.week || {}).hour ?? 9)}</select>
    <label class="ck"><input id="sRmOn" type="checkbox" ${(rp.month || {}).enabled ? 'checked' : ''}> 月报推送（每月 1 号发上月报告）</label>
    <label>月报时刻（北京时间）</label>
    <select id="sRmHour">${hourOptions((rp.month || {}).hour ?? 9)}</select>`;
}

// 在线单价更新：默认指向本仓库价格源的 jsDelivr 镜像（GitHub 直连不稳时可换任意 JSON 地址）
const DEFAULT_PRICE_URL = 'https://cdn.jsdelivr.net/gh/YX-NAS/ai-quota-dashboard@main/config/prices.source.json';
const PRICE_FIELD_NAMES = { in: '输入', out: '输出', cacheRead: '缓存命中', cacheWrite: '缓存写入' };

function renderPriceOnlineEditor(p) {
  const ps = p.priceSource || {};
  const last = ps.lastCheck
    ? `上次检查 ${new Date(ps.lastCheck).toLocaleString('zh-CN')}${ps.updated ? ' · 源更新于 ' + esc(ps.updated) : ''}（${ps.models || 0} 个模型）`
    : '尚未检查过';
  const failed = ps.lastResult && ps.lastResult !== 'ok'
    ? ` · <span class="price-src-failed">${esc(ps.lastResult)}</span>` : '';
  return `<hr><div class="qk-hint">在线更新单价 —— 从价格源 JSON 拉取最新模型价（元/百万 token）：先「检查更新」预览差异，确认后「应用更新」写入下方覆盖表（应用后立即按新价重算历史，可随时手改或恢复默认）。开启自动检查后每周拉取一次，有调价 / 模型上线 / 下线就自动应用并推送通知。</div>
    <label>价格源 URL</label>
    <input id="sPriceUrl" type="text" value="${esc(ps.url || DEFAULT_PRICE_URL)}" placeholder="${DEFAULT_PRICE_URL}" spellcheck="false">
    <label class="ck"><input id="sPriceAuto" type="checkbox" ${ps.auto !== false ? 'checked' : ''}> 每周自动检查（有变化自动应用并推送通知）</label>
    <div class="price-src-row">
      <button type="button" id="priceCheck">检查更新</button>
      <button type="button" id="priceApply" disabled>应用更新</button>
      <button type="button" id="priceSupplement" title="把全历史用到、但单价表还没有的模型，从公共价格目录自动补价并重估历史">补充缺失单价</button>
      <span class="mut" style="font-size:12px" id="priceLastCheck">${last}${failed}</span>
    </div>
    <div id="priceCheckResult"></div>`;
}

// 差异结果渲染：价格变化逐行列出（模型 / 字段 / 旧 → 新），新增/下线模型各一区
function renderPriceDiff(j, applied) {
  const box = document.getElementById('priceCheckResult');
  const d = j.diff || { changes: [], added: [], removed: [], unchanged: 0 };
  const removed = d.removed || [];
  const fmtP = v => v == null ? '—' : esc(String(v));
  if (!d.changes.length && !d.added.length && !removed.length) {
    box.innerHTML = `<div class="price-diff-ok">已是最新：${d.unchanged} 个模型与价格源一致${j.meta && j.meta.updated ? '（源更新于 ' + esc(j.meta.updated) + '）' : ''}</div>`;
    return;
  }
  const rows = d.changes.map(c => `
    <div class="price-diff">
      <span class="pm" title="${esc(c.model)}">${esc(c.model)}</span>
      <span class="mut">${PRICE_FIELD_NAMES[c.field] || esc(c.field)}</span>
      <span class="mut">${fmtP(c.from)} → <b class="price-new">${fmtP(c.to)}</b></span>
    </div>`).join('');
  const addedHtml = d.added.length ? `
    <div class="price-diff">
      <span class="pm">新增模型</span>
      <span class="mut" style="grid-column: span 2">${d.added.map(esc).join('、')}</span>
    </div>` : '';
  const removedHtml = removed.length ? `
    <div class="price-diff">
      <span class="pm">下线模型</span>
      <span class="mut" style="grid-column: span 2">${removed.map(esc).join('、')}</span>
    </div>` : '';
  box.innerHTML = `
    ${applied ? '<div class="price-diff-ok">已应用，等价成本正按新单价重算</div>' : ''}
    <div class="price-diff-head">${d.changes.length} 处价格变化 · ${d.added.length} 个新增 · ${removed.length} 个下线 · ${d.unchanged} 个一致</div>
    ${rows}${addedHtml}${removedHtml}`;
}

// 检查 / 应用：apply=false 只预览不落盘；apply=true 落盘 + 立即重算 + 刷新设置面板
async function runPriceUpdate(apply) {
  const checkBtn = document.getElementById('priceCheck');
  const applyBtn = document.getElementById('priceApply');
  const box = document.getElementById('priceCheckResult');
  const srcUrl = (document.getElementById('sPriceUrl') || {}).value || '';
  checkBtn.disabled = true; applyBtn.disabled = true;
  box.innerHTML = '<span class="mut" style="font-size:12px">拉取中…</span>';
  try {
    const r = await fetch('/api/prices/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: srcUrl.trim(), apply }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
    if (apply) {
      toast('单价已更新，正在重算');
      loadFn();
      const pr = await fetch('/api/plans');       // 覆盖表 / 检查记录已变：整体重渲染设置面板
      renderSettingsBody(await pr.json());
    } else {
      renderPriceDiff(j, false);
      applyBtn.disabled = false;                  // 预览成功才允许应用
    }
  } catch (e) {
    box.innerHTML = `<div class="settings-err">更新失败：${e.message}</div>`;
  } finally {
    checkBtn.disabled = false;
  }
}

// 缺失单价自动补充：全历史用到但单价表查不到的模型 → 公共价格目录精确匹配 → 折算人民币
// 写入覆盖表 → 重估历史。命不中的如实列出（不瞎补）。
async function runPriceSupplement() {
  const btn = document.getElementById('priceSupplement');
  const box = document.getElementById('priceCheckResult');
  btn.disabled = true;
  box.innerHTML = '<span class="mut" style="font-size:12px">拉取公共价格目录（约 3MB）并匹配缺失模型…</span>';
  try {
    const r = await fetch('/api/prices/supplement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
    const matched = j.matched || [], missed = j.missed || [];
    if (j.skipped === 'no-missing') {
      box.innerHTML = '<div class="price-diff-ok">没有缺失单价 —— 全历史模型都在单价表里</div>';
      return;
    }
    const okHtml = matched.length
      ? `<div class="price-diff-ok">已补充 ${matched.length} 个模型单价（按汇率折算写入覆盖表），等价成本正按新价重估历史</div>`
      : '<div class="settings-err">公共目录里没有命中任何缺失模型</div>';
    const rows = matched.map(m => `<div class="price-diff"><span class="pm">${esc(m)}</span><span class="mut" style="grid-column: span 2">已从公共目录补价</span></div>`).join('');
    const missedHtml = missed.length
      ? `<div class="price-diff"><span class="pm">未匹配</span><span class="mut" style="grid-column: span 2">${missed.map(esc).join('、')}（目录里没有，保持无价不计费）</span></div>`
      : '';
    box.innerHTML = `${okHtml}${rows}${missedHtml}`;
    if (matched.length) {
      toast(`已补充 ${matched.length} 个模型单价`);
      loadFn();
      const pr = await fetch('/api/plans');       // 覆盖表已变：整体重渲染设置面板
      renderSettingsBody(await pr.json());
    }
  } catch (e) {
    box.innerHTML = `<div class="settings-err">补充失败：${e.message}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// 设置面板
const dlg = document.getElementById('settingsDlg');
const QUOTA_KEY_FIELDS = [
  ['zhipu', 'token', '智谱 · API Key（id.secret 形态；留空 = 自动发现 ZCode / WorkBuddy 凭证）'],
  ['zhipu', 'organizationId', '智谱 · Organization ID（org-xxx，与 Project ID 成对填；留空 = 自动定位团队项目）'],
  ['zhipu', 'projectId', '智谱 · Project ID（proj-xxx）'],
  ['minimax', 'apiKey', 'MiniMax · API Key（留空 = 从 WorkBuddy models.json 读取）'],
  ['chatgpt', 'accessToken', 'ChatGPT · Access Token（一般留空，自动读 codex 登录；手动填的过期需自行更新）'],
  ['deepseek', 'apiKey', 'DeepSeek · API Key（sk-...；留空 = 从 ZCode 自定义模型 / cc-switch 配置读取）'],
  ['moonshot', 'apiKey', 'Kimi · API Key（sk-...；留空 = 从 ZCode 自定义模型 / cc-switch 配置读取）'],
  ['volcengine', 'apiKey', '火山方舟 · API Key（ark-...；留空 = 从 ZCode 自定义模型读取；卡片展示在售模型清单）'],
  ['bailian', 'accessKeyId', '阿里云百炼 · AccessKey ID（可选，用于查询阿里云账户余额；百炼无按量余额接口）'],
  ['bailian', 'accessKeySecret', '阿里云 · AccessKey Secret（留空 = 不查余额，卡片仍显示用量费用）'],
  ['vpnPanel', 'url', 'VPN · 订阅地址（面板「快速配置」整串复制，含专属 token；看板只读流量计量响应头，不下载订阅体）'],
];
// 订阅套餐编辑器（性价比实体）：套餐独立于工具，按「模型名匹配」跨工具归集等价消耗
function renderSubsEditor(subs) {
  const toolKeys = TOOLS.map(t => t.key).join(' / ');
  const rows = (Array.isArray(subs) ? subs : []).map(s => `
    <div class="sub-row">
      <input data-sub="name" type="text" value="${esc(s.name || '')}" placeholder="套餐名（如 MiniMax Token Plan）" spellcheck="false">
      <input data-sub="cny" type="number" step="0.01" value="${s.payCnyPerMonth ?? ''}" placeholder="¥/月">
      <input data-sub="usd" type="number" step="0.1" value="${s.usdPerMonth ?? ''}" placeholder="$/月">
      <input data-sub="match" type="text" value="${esc((s.modelMatch || []).join(', '))}" placeholder="模型名含（逗号分隔，如 minimax）" spellcheck="false">
      <input data-sub="tools" type="text" value="${esc((s.tools || []).join(', '))}" placeholder="限定工具（${toolKeys}，留空=全部）" spellcheck="false">
      <button type="button" class="sub-del" title="删除该套餐">✕</button>
    </div>`).join('');
  return `<hr><div class="qk-hint">订阅套餐（套餐性价比的对比实体）—— 一个套餐可覆盖多个工具跑的模型：按「模型名含」跨工具归集等价消耗，与真实月费对比给出续订建议。未配置时回退按上方「套餐真实月费」的工具口径。</div>
    <div id="subsList">${rows}</div>
    <button type="button" id="subAdd" class="seg" style="margin-top:6px">＋ 添加套餐</button>`;
}

function bindSubsEditor() {
  const list = document.getElementById('subsList');
  if (!list) return;
  document.getElementById('subAdd').addEventListener('click', () => {
    const div = document.createElement('div');
    div.className = 'sub-row';
    div.innerHTML = `
      <input data-sub="name" type="text" value="" placeholder="套餐名（如 MiniMax Token Plan）" spellcheck="false">
      <input data-sub="cny" type="number" step="0.01" value="" placeholder="¥/月">
      <input data-sub="usd" type="number" step="0.1" value="" placeholder="$/月">
      <input data-sub="match" type="text" value="" placeholder="模型名含（逗号分隔，如 minimax）" spellcheck="false">
      <input data-sub="tools" type="text" value="" placeholder="限定工具（留空=全部）" spellcheck="false">
      <button type="button" class="sub-del" title="删除该套餐">✕</button>`;
    list.appendChild(div);
  });
  list.addEventListener('click', e => {
    const del = e.target.closest('.sub-del');
    if (del) del.closest('.sub-row').remove();
  });
}

// 面板渲染与事件绑定合并成一个函数：单价在线应用后要整体重渲染（覆盖表已变）
function renderSettingsBody(p) {
  const qk = p.quotaKeys || {};
  // 智谱「其他 Key」回显：脱敏数组 → 每行「名称 | 掩码」（label 空则只出 key）
  const extraKeysText = (Array.isArray((qk.zhipu || {}).extraKeys) ? qk.zhipu.extraKeys : [])
    .map(x => (x.label ? x.label + ' | ' : '') + (x.apiKey || '')).join('\n');
  document.getElementById('settingsBody').innerHTML =
    `<label>USD → CNY 汇率</label><input id="sFx" type="number" step="0.01" value="${p.usdCnyRate}">` +
    `<label>🎯 当日目标成本（等价 ¥/天）</label><input id="sGoal" type="number" step="10" min="0" value="${(p.dailyGoal || {}).cny ?? 200}">` +
    `<label>📶 每日流量目标（GB/天，上下行合计，0 = 不显示进度条）</label><input id="sNetGoal" type="number" step="1" min="0" value="${(p.dailyGoal || {}).networkGB ?? 0}">` +
    Object.entries(p.plans).map(([k, v]) =>
      `<label>${esc(v.label)} · 月额度（等价 ¥，留空 = 未配置）</label>
       <input data-plan="cny:${k}" type="number" step="0.01" value="${v.cnyPerMonth ?? ''}" placeholder="未配置">
       <label>${esc(v.label)} · 套餐真实月费（¥，人民币套餐填这里，用于性价比对比）</label>
       <input data-plan="pay:${k}" type="number" step="0.01" value="${v.payCnyPerMonth ?? ''}" placeholder="未配置">
       <label>${esc(v.label)} · 订阅月费（USD，美元套餐填这里，如 ChatGPT 19.9）</label>
       <input data-plan="usd:${k}" type="number" step="0.1" value="${v.usdPerMonth ?? ''}" placeholder="未配置">`
    ).join('') +
    `<hr><div class="qk-hint">卡片显示 —— 取消勾选的工具有卡片区整卡隐藏（表格 / 趋势图 / 每日明细仍保留全部数据）</div>
     <div class="hide-grid">` +
    TOOLS.map(t => `<label class="ck"><input data-hide="${t.key}" type="checkbox" ${(p.hiddenCards || []).includes(t.key) ? '' : 'checked'}> ${t.name}</label>`).join('') +
    `</div>` +
    renderSubsEditor(p.subscriptions) +
    `<hr><div class="qk-hint">额度 / 余额 Key —— 已配置的显示为脱敏（如 <code>88b9…GXlN</code>），不改即保留；清空 = 回退自动发现；输入新值 = 覆盖</div>` +
    QUOTA_KEY_FIELDS.map(([t, f, label]) =>
      `<label>${label}</label>
       <input data-qk-tool="${t}" data-qk-field="${f}" type="text" value="${esc((qk[t] || {})[f] || '')}" placeholder="未配置 · 自动发现" spellcheck="false">`
    ).join('') +
    `<label>智谱 · 其他 Key（每行「名称 | API Key」；独立于自己账户主 Key 监控，标准 Key 无余额接口仅做健康检测）</label>
     <textarea data-qk-extra="zhipu" rows="2" spellcheck="false" placeholder="可用api | 20a4...">${esc(extraKeysText)}</textarea>` +
    renderAlertsEditor(p) +
    renderPriceOnlineEditor(p) +
    renderPriceEditor(p);
  bindSubsEditor();
  document.getElementById('priceReset').onclick = () => {
    document.querySelectorAll('[data-price]').forEach(el => { el.value = ''; });
  };
  document.getElementById('sAlertType').onchange = e => {
    document.getElementById('sAlertHint').textContent = ALERT_WEBHOOK_HINTS[e.target.value] || '';
  };
  // 发送测试：用面板当前的通道 + 地址立即推一条测试消息（地址是脱敏回显时后端自动换回已存值）
  document.getElementById('sAlertTest').onclick = async () => {
    const btn = document.getElementById('sAlertTest');
    const msg = document.getElementById('sAlertTestMsg');
    btn.disabled = true;
    msg.hidden = false;
    msg.className = 'qk-hint';
    msg.textContent = '⏳ 发送中…';
    try {
      const r = await fetch('/api/alerts/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookType: document.getElementById('sAlertType').value,
          webhookUrl: document.getElementById('sAlertUrl').value.trim(),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.ok) {
        msg.className = 'qk-hint ok';
        msg.textContent = '✅ 测试消息已发送，到手机上确认（微信收不到 = 地址不对或通道选错）';
        toast('测试消息已发送');
      } else {
        msg.className = 'qk-hint bad';
        msg.textContent = '❌ 发送失败：' + (j.error || '未知错误');
      }
    } catch (e) {
      msg.className = 'qk-hint bad';
      msg.textContent = '❌ 请求失败：' + e.message;
    } finally {
      btn.disabled = false;
    }
  };
  document.getElementById('priceCheck').onclick = () => runPriceUpdate(false);
  document.getElementById('priceApply').onclick = () => runPriceUpdate(true);
  document.getElementById('priceSupplement').onclick = () => runPriceSupplement();
}
document.getElementById('settingsBtn').onclick = async () => {
  document.getElementById('settingsErr').hidden = true; // 打开时清掉上次错误
  try {
    const r = await fetch('/api/plans'); const p = await r.json();
    renderSettingsBody(p);
    dlg.showModal();
  } catch (e) {
    toast('设置加载失败：' + e.message); // 加载失败不弹窗（面板会是空表单），就地提示即可
  }
};
document.getElementById('settingsCancel').onclick = () => dlg.close();
document.getElementById('settingsX').onclick = () => dlg.close();
document.getElementById('settingsSave').onclick = async () => {
  const errBox = document.getElementById('settingsErr');
  errBox.hidden = true;
  const plans = {};
  document.querySelectorAll('[data-plan]').forEach(el => {
    const [cur, k] = el.dataset.plan.split(':');
    const field = cur === 'usd' ? 'usdPerMonth' : cur === 'pay' ? 'payCnyPerMonth' : 'cnyPerMonth';
    (plans[k] = plans[k] || {})[field] = el.value === '' ? null : Number(el.value);
  });
  const quotaKeys = {};
  document.querySelectorAll('[data-qk-tool]').forEach(el => {
    const t = el.dataset.qkTool, f = el.dataset.qkField;
    (quotaKeys[t] = quotaKeys[t] || {})[f] = el.value;
  });
  // 智谱「其他 Key」textarea：每行「名称 | API Key」（名称可空；掩码回显原样提交，后端识别为未改动）
  const extraTa = document.querySelector('[data-qk-extra="zhipu"]');
  if (extraTa) {
    (quotaKeys.zhipu = quotaKeys.zhipu || {}).extraKeys = extraTa.value
      .split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const i = l.indexOf('|');
        return i < 0 ? { label: '', apiKey: l } : { label: l.slice(0, i).trim(), apiKey: l.slice(i + 1).trim() };
      });
  }
  // 模型单价覆盖：全空 = 不覆盖（用默认/清除），填了任意一列即生效
  const priceOverrides = {};
  document.querySelectorAll('[data-price]').forEach(el => {
    const m = el.dataset.price, f = el.dataset.pf;
    if (el.value !== '') (priceOverrides[m] = priceOverrides[m] || {})[f] = Number(el.value);
  });
  // 预警推送：webhookUrl 原样提交（脱敏回显后端识别为「未改动」，空串 = 清除）
  const alerts = {
    enabled: document.getElementById('sAlertOn').checked,
    webhookType: document.getElementById('sAlertType').value,
    webhookUrl: document.getElementById('sAlertUrl').value.trim(),
    thresholds: {
      fiveHour: Number(document.getElementById('sTh5h').value),
      weekly: Number(document.getElementById('sThWk').value),
      dailyGoalPct: Number(document.getElementById('sThGoal').value),
      vpnUsed: Number(document.getElementById('sThVpn').value),
    },
    cooldownMinutes: Number(document.getElementById('sAlertCd').value),
    // 定时推送（与预警共用通道）：时刻用 select 值（0~23）
    digest: {
      enabled: document.getElementById('sDgOn').checked,
      hour: Number(document.getElementById('sDgHour').value),
    },
    reportPush: {
      week: { enabled: document.getElementById('sRwOn').checked, hour: Number(document.getElementById('sRwHour').value) },
      month: { enabled: document.getElementById('sRmOn').checked, hour: Number(document.getElementById('sRmHour').value) },
    },
  };
  // 卡片显隐：未勾选的工具进 hiddenCards
  const hiddenCards = [];
  document.querySelectorAll('[data-hide]').forEach(el => { if (!el.checked) hiddenCards.push(el.dataset.hide); });
  // 订阅套餐：逐行收集（名称必填才收；模型匹配/限定工具按中英文逗号拆分）
  const subscriptions = [];
  document.querySelectorAll('.sub-row').forEach(row => {
    const get = k => ((row.querySelector(`[data-sub="${k}"]`) || {}).value ?? '');
    const name = get('name').trim();
    if (!name) return;
    subscriptions.push({
      name,
      payCnyPerMonth: get('cny') === '' ? null : Number(get('cny')),
      usdPerMonth: get('usd') === '' ? null : Number(get('usd')),
      modelMatch: get('match').split(/[,，]/).map(s => s.trim()).filter(Boolean),
      tools: get('tools').split(/[,，]/).map(s => s.trim()).filter(Boolean),
    });
  });
  try {
    const r = await fetch('/api/plans', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usdCnyRate: Number(document.getElementById('sFx').value),
        dailyGoal: {
          cny: Number(document.getElementById('sGoal').value) || 0,
          networkGB: Number((document.getElementById('sNetGoal') || {}).value) || 0,
        },
        plans, quotaKeys, priceOverrides, alerts, hiddenCards, subscriptions,
        priceSource: {
          url: (document.getElementById('sPriceUrl') || {}).value?.trim() || '',
          auto: (document.getElementById('sPriceAuto') || {}).checked === true,
        },
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || 'HTTP ' + r.status);
    }
    dlg.close();   // 成功才关弹窗
    toast('已保存');
    loadFn();
  } catch (e) {
    // 失败留在弹窗，就地显示错误
    errBox.textContent = '保存失败：' + e.message;
    errBox.hidden = false;
  }
};
