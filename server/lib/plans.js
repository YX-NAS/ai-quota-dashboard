'use strict';
// plans.json 读写：用户配置的额度 / 汇率 / 单价覆盖
const fs = require('node:fs');
const path = require('node:path');

// 可用环境变量重定向配置目录（测试 / 便携安装用），默认仓库根 config/
const CONFIG_DIR = process.env.AI_QUOTA_CONFIG_DIR || path.join(__dirname, '..', '..', 'config');
const PLANS_FILE = path.join(CONFIG_DIR, 'plans.json');

const TEMPLATE = {
  usdCnyRate: 7.2,
  // 每个工具的套餐配置：plan = 套餐名（设置面板可改）；cnyPerMonth = 等价月额度（null = 未配置）；
  // usdPerMonth = 订阅真实月费（美元，美元计价的套餐用，如 ChatGPT Plus $19.9；展示时按汇率折算 ¥）；
  // payCnyPerMonth = 套餐真实月费（人民币计价的套餐用，如 MiniMax Token Plan ¥119；套餐性价比对比的实付口径）
  plans: {
    codex:         { label: 'ChatGPT · Codex', plan: null, cnyPerDay: null, cnyPerMonth: null, usdPerMonth: null, payCnyPerMonth: null },
    claudeDesktop: { label: 'Claude Desktop',  plan: null, cnyPerDay: null, cnyPerMonth: null, usdPerMonth: null, payCnyPerMonth: null },
    claudeCode:    { label: 'Claude Code',     plan: null, cnyPerDay: null, cnyPerMonth: null, usdPerMonth: null, payCnyPerMonth: null },
    zcode:         { label: 'ZCode',           plan: null, cnyPerDay: null, cnyPerMonth: null, usdPerMonth: null, payCnyPerMonth: null },
    workbuddy:     { label: 'WorkBuddy',       plan: null, cnyPerDay: null, cnyPerMonth: null, usdPerMonth: null, payCnyPerMonth: null },
  },
  // 订阅套餐（性价比对比实体）：套餐 ≠ 工具 —— 一个套餐（如 MiniMax Token Plan）可覆盖多个
  // 工具跑的模型，故独立配置、按「模型名匹配」归集等价消耗：
  //   name         套餐名（卡片标题）
  //   payCnyPerMonth 人民币实付月费（与 usdPerMonth 二选一，¥ 优先）
  //   usdPerMonth  美元实付月费（展示按汇率折算 ¥）
  //   modelMatch   模型名子串（大小写不敏感，命中任一即计入该套餐的等价消耗）
  //   tools        限定工具 key（空 = 全部工具；如 ['codex'] 只算 Codex 的 GPT 用量）
  subscriptions: [],
  priceOverrides: {},
  // 工具卡片区显隐（网页设置面板「卡片显示」勾选；仅影响卡片渲染，表格/趋势图/明细数据不变）
  hiddenCards: [],
  // 在线单价源：url 用户可改（仅 http/https）；lastCheck/lastResult/updated/models 为服务端记录的最近一次检查结果
  // 在线单价源：url 可改；auto = 每周自动检查开关（布尔）；
  // modelsSeen / lastCheck / lastResult / updated / models 由服务端（price-auto / prices 路由）维护，不接受外部提交
  priceSource: { url: '', auto: true, modelsSeen: [], lastCheck: null, lastResult: '', updated: '', models: 0 },
  // 当日目标成本（等价成本 ¥）：网页横幅 / 菜单栏 / 桌面卡片的预算进度条（0 = 关闭目标）；
  // networkGB = 每日流量目标（GB/天，上下行合计，网络流量卡进度条，0 = 不显示）
  dailyGoal: { cny: 200, networkGB: 0 },
  // 套餐实时额度 / API 按量计费余额的手动 key 配置：非空优先，留空回退各采集器的自动发现
  quotaKeys: {
    // zhipu.extraKeys：其他智谱 Key（数组，每项 {label, apiKey}）——独立于自己账户的主 Key 监控；
    // 智谱标准 Key 无余额查询接口（getCustomerInfo 仅认 OAuth），看板对它们只做健康检测
    zhipu:   { token: '', organizationId: '', projectId: '', extraKeys: [] },
    minimax: { apiKey: '' },
    chatgpt: { accessToken: '' },
    deepseek: { apiKey: '' },
    moonshot: { apiKey: '' },
    volcengine: { apiKey: '' },
    bailian: { accessKeyId: '', accessKeySecret: '' },
    // vpnPanel.url：VPN 面板「订阅地址」（token 在路径内，属机密）——vpn-quota 采集器
    // 只读其响应头 subscription-userinfo 拿流量包计量，不下载订阅配置体
    vpnPanel: { url: '' },
  },
  // 额度预警 webhook 推送：默认关闭（webhookUrl 即推送密钥，接口只出掩码形态）
  alerts: {
    enabled: false,
    webhookType: 'ntfy',   // ntfy | bark | serverchan | wecom | generic
    webhookUrl: '',
    thresholds: { fiveHour: 85, weekly: 85, dailyGoalPct: 100, vpnUsed: 90 }, // 触发阈值（百分比 ≥ 即推送；vpnUsed = VPN 流量包已用%）
    cooldownMinutes: 60,   // 同一事件的冷却窗（分钟）
    // 定时推送（与预警共用通道，默认全关）：digest = 每日摘要（北京时间 hour 点后当天首推）；
    // reportPush = 周报（仅周一）/ 月报（仅 1 号）推上一期，错过不跨天补
    digest: { enabled: false, hour: 21 },
    reportPush: { week: { enabled: false, hour: 9 }, month: { enabled: false, hour: 9 } },
  },
};

// 各工具 key 字段里属于机密的（接口返回需脱敏，保存时区分「未改动回显」与「新值」）
const QUOTA_KEY_FIELDS = {
  zhipu:   { secrets: ['token'], plain: ['organizationId', 'projectId'] },
  minimax: { secrets: ['apiKey'], plain: [] },
  chatgpt: { secrets: ['accessToken'], plain: [] },
  deepseek: { secrets: ['apiKey'], plain: [] },
  moonshot: { secrets: ['apiKey'], plain: [] },
  volcengine: { secrets: ['apiKey'], plain: [] }, // 火山方舟：模型清单 + Key 探活用
  bailian: { secrets: ['accessKeySecret'], plain: ['accessKeyId'] }, // 阿里云 BSS 查账户余额用（可选）
  vpnPanel: { secrets: ['url'], plain: [] }, // 订阅地址路径含 token，按机密脱敏（掩码回显未改动 = 保留原值）
};

function maskSecret(s) {
  const v = String(s || '');
  if (!v) return '';
  // JWT（eyJ 开头）不保留头部特征：掩码本身不得含明文片段（接口响应 grep 不到 eyJ）
  if (v.startsWith('eyJ')) return '••••…' + v.slice(-4);
  return v.length > 12 ? v.slice(0, 4) + '…' + v.slice(-4) : '••••';
}

// webhookUrl 合法性：必须是可解析的 http(s) URL（file:/data: 等一律拒绝）
function isHttpUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

// alerts.webhookUrl 掩码（单一实现放 alerts.js，这里惰性 require 避免顶层循环依赖：
// alerts → history → plans，若 plans 顶层再 require alerts 会拿到半初始化模块）
function maskWebhookUrl(url) {
  return require('./alerts').maskWebhookUrl(url);
}

// GET 用：返回配置副本，机密字段脱敏（org/project 等非机密保持原值）；
// alerts.webhookUrl 同属机密（path 即推送密钥），一并出掩码形态
function maskQuotaKeys(cfg) {
  const out = JSON.parse(JSON.stringify(cfg || {}));
  const qk = out.quotaKeys || {};
  for (const [tool, spec] of Object.entries(QUOTA_KEY_FIELDS)) {
    qk[tool] = qk[tool] || {};
    for (const f of spec.secrets) qk[tool][f] = maskSecret(qk[tool][f]);
  }
  // zhipu.extraKeys 数组：逐项脱敏 apiKey（label 非机密原样保留）
  if (qk.zhipu) {
    qk.zhipu.extraKeys = (Array.isArray(qk.zhipu.extraKeys) ? qk.zhipu.extraKeys : [])
      .map(x => ({ label: String((x && x.label) || ''), apiKey: maskSecret(String((x && x.apiKey) || '')) }));
  }
  out.quotaKeys = qk;
  if (out.alerts && out.alerts.webhookUrl != null) {
    out.alerts = Object.assign({}, out.alerts, { webhookUrl: maskWebhookUrl(out.alerts.webhookUrl) });
  }
  return out;
}

// zhipu.extraKeys 数组合并：apiKey 为空 → 丢弃该项；apiKey 等于任一现有项的脱敏形态 → 未改动保留原值；
// 同 key 去重；label 空则按序号补默认名。数组语义与标量一致（未提交 = 整体清除）
function applyZhipuExtraKeysUpdate(curArr, incArr) {
  const masks = new Map(); // 掩码 → 原明文
  for (const x of Array.isArray(curArr) ? curArr : []) {
    const k = String((x && x.apiKey) || '');
    if (k) masks.set(maskSecret(k), k);
  }
  const out = [];
  for (const x of Array.isArray(incArr) ? incArr : []) {
    let key = String((x && x.apiKey) || '').trim();
    if (!key) continue;
    if (masks.has(key)) key = masks.get(key); // 掩码回显未改动 → 还原原值
    if (out.some(y => y.apiKey === key)) continue;
    const label = String((x && x.label) || '').trim() || ('智谱 Key ' + (out.length + 1));
    out.push({ label, apiKey: key });
  }
  return out;
}

// POST 用：把表单提交的 quotaKeys 合并进现有配置（纯函数，不改入参）
// 语义：空串 = 清除（回退自动发现）；机密字段值等于已存值的脱敏形态 = 未改动，保留原值；其余 = 新值
function applyQuotaKeysUpdate(current, incoming) {
  const cur = (current && current.quotaKeys) || {};
  const inc = incoming || {};
  const out = {};
  for (const [tool, spec] of Object.entries(QUOTA_KEY_FIELDS)) {
    const t = out[tool] = {};
    for (const f of [...spec.secrets, ...spec.plain]) {
      const v = String((inc[tool] || {})[f] ?? '').trim();
      const prev = String((cur[tool] || {})[f] ?? '');
      if (v === '') t[f] = '';
      else if (spec.secrets.includes(f) && v === maskSecret(prev)) t[f] = prev;
      else t[f] = v;
    }
  }
  out.zhipu.extraKeys = applyZhipuExtraKeysUpdate((cur.zhipu || {}).extraKeys, ((inc.zhipu) || {}).extraKeys);
  return out;
}

// POST /api/plans 用：按白名单合并表单更新，非法值剔除该字段（保留原值）。纯函数，不改入参
function applyPlansUpdate(current, body) {
  const next = JSON.parse(JSON.stringify(current || {}));
  const num = v => Number(v);

  // 汇率：必须有限正数
  if (body && body.usdCnyRate != null) {
    const n = num(body.usdCnyRate);
    if (Number.isFinite(n) && n > 0) next.usdCnyRate = n;
  }
  // 套餐额度/月费：允许 null（未配置）或有限非负数
  if (body && body.plans) for (const [k, v] of Object.entries(body.plans)) {
    if (!next.plans[k] || !v || typeof v !== 'object') continue;
    for (const f of ['cnyPerDay', 'cnyPerMonth', 'usdPerMonth', 'payCnyPerMonth']) {
      if (!(f in v)) continue;
      const n = v[f] === null || v[f] === '' ? null : num(v[f]);
      if (n === null || (Number.isFinite(n) && n >= 0)) next.plans[k][f] = n;
    }
  }
  // 模型单价覆盖：in/out/cacheRead/cacheWrite 必须有限非负数，非法剔除该字段；全空 = 清除该模型覆盖
  if (body && body.priceOverrides && typeof body.priceOverrides === 'object') {
    const po = {};
    for (const [m, o] of Object.entries(body.priceOverrides)) {
      if (!o || typeof o !== 'object') continue;
      const e = {};
      for (const f of ['in', 'out', 'cacheRead', 'cacheWrite']) {
        const n = num(o[f]);
        if (o[f] != null && o[f] !== '' && Number.isFinite(n) && n >= 0) e[f] = n;
      }
      if (Object.keys(e).length) po[m] = e;
    }
    next.priceOverrides = po;
  }
  // 卡片显隐：合法工具 key 白名单 + 去重；非数组整体忽略（保留原值）
  if (body && Array.isArray(body.hiddenCards)) {
    const valid = new Set(Object.keys(TEMPLATE.plans));
    next.hiddenCards = [...new Set(body.hiddenCards.filter(k => valid.has(k)))];
  }
  // 在线单价源：只接受 url / auto 字段（空串 = 清除 url；url 必须 http/https）；
  // modelsSeen / lastCheck 等检查结果字段由服务端（price-auto / prices 路由）维护
  if (body && body.priceSource && typeof body.priceSource === 'object') {
    const v = String(body.priceSource.url ?? '').trim();
    const cur = next.priceSource || JSON.parse(JSON.stringify(TEMPLATE.priceSource));
    if (v === '') cur.url = '';
    else if (isHttpUrl(v)) cur.url = v;
    if (typeof body.priceSource.auto === 'boolean') cur.auto = body.priceSource.auto;
    next.priceSource = cur;
  }
  // 实时额度 keys：沿用既有合并语义。quotaKeys 必须是普通对象——
  // 字符串/数组 truthy 放行会让 applyQuotaKeysUpdate 把已存机密整体清空（非对象 = 整体忽略保留原值）
  if (body && body.quotaKeys && typeof body.quotaKeys === 'object' && !Array.isArray(body.quotaKeys)) {
    next.quotaKeys = applyQuotaKeysUpdate(next, body.quotaKeys);
  }
  // 订阅套餐（性价比实体）：数组整体校验——非数组忽略（保留原值）；逐项白名单清洗：
  // name 必填非空；payCnyPerMonth/usdPerMonth 有限非负或 null；modelMatch/tools 为字符串数组
  //（tools 限工具 key 白名单，防脏 key 造成永远匹配不上的哑配置）
  if (body && Array.isArray(body.subscriptions)) {
    const validTools = new Set(Object.keys(TEMPLATE.plans));
    const subs = [];
    for (const s of body.subscriptions) {
      if (!s || typeof s !== 'object') continue;
      const name = String(s.name ?? '').trim().slice(0, 60);
      if (!name) continue;
      const e = { name };
      for (const f of ['payCnyPerMonth', 'usdPerMonth']) {
        const n = Number(s[f]);
        e[f] = s[f] == null || s[f] === '' ? null : (Number.isFinite(n) && n >= 0 ? n : null);
      }
      e.modelMatch = Array.isArray(s.modelMatch)
        ? [...new Set(s.modelMatch.map(x => String(x ?? '').trim().toLowerCase()).filter(Boolean))].slice(0, 20)
        : [];
      e.tools = Array.isArray(s.tools)
        ? [...new Set(s.tools.map(x => String(x ?? '').trim()).filter(k => validTools.has(k)))]
        : [];
      subs.push(e);
    }
    next.subscriptions = subs;
  }
  // 当日目标：0 = 关闭目标；负数/非法保留原值
  if (body && body.dailyGoal && typeof body.dailyGoal === 'object') {
    const cur = next.dailyGoal || JSON.parse(JSON.stringify(TEMPLATE.dailyGoal));
    const n = num(body.dailyGoal.cny);
    if (Number.isFinite(n) && n >= 0) next.dailyGoal = { cny: n, networkGB: cur.networkGB ?? 0 };
    const g = num(body.dailyGoal.networkGB);
    if (Number.isFinite(g) && g >= 0) {
      const base = next.dailyGoal || { cny: cur.cny ?? 200 };
      next.dailyGoal = { cny: base.cny ?? 200, networkGB: g };
    }
  }
  // 额度预警：白名单合并（enabled 布尔 / webhookType 枚举 / 阈值 0~100 / cooldown 正整数 /
  // webhookUrl 仅 http(s)）。webhookUrl 合并语义与 quotaKeys secrets 一致：
  // 提交值 === 掩码回显 → 未改动保留原值；空串 → 清除；其余合法新值 → 覆盖；非法 → 剔除保留原值
  if (body && body.alerts && typeof body.alerts === 'object') {
    const cur = next.alerts || JSON.parse(JSON.stringify(TEMPLATE.alerts)); // 老配置无 alerts 块时以模板打底
    const inc = body.alerts;
    const out = Object.assign({}, cur);
    if (typeof inc.enabled === 'boolean') out.enabled = inc.enabled;
    if (typeof inc.webhookType === 'string' && ['ntfy', 'bark', 'serverchan', 'wecom', 'generic'].includes(inc.webhookType)) {
      out.webhookType = inc.webhookType;
    }
    if (inc.thresholds && typeof inc.thresholds === 'object') {
      const t = Object.assign({}, out.thresholds);
      for (const f of ['fiveHour', 'weekly', 'dailyGoalPct', 'vpnUsed']) {
        const n = num(inc.thresholds[f]);
        if (inc.thresholds[f] != null && inc.thresholds[f] !== '' && Number.isFinite(n) && n >= 0 && n <= 100) t[f] = n;
      }
      out.thresholds = t;
    }
    if (inc.cooldownMinutes != null && inc.cooldownMinutes !== '') {
      const n = num(inc.cooldownMinutes);
      if (Number.isInteger(n) && n > 0) out.cooldownMinutes = n;
    }
    if ('webhookUrl' in inc) {
      const v = String(inc.webhookUrl ?? '').trim();
      if (v === '') out.webhookUrl = '';
      else if (v === maskWebhookUrl(cur.webhookUrl)) out.webhookUrl = cur.webhookUrl;
      else if (isHttpUrl(v)) out.webhookUrl = v;
    }
    // 定时推送（digest / reportPush）：enabled 布尔 + hour 整数 0~23，非法保留原值
    if (inc.digest && typeof inc.digest === 'object') {
      const d = Object.assign({}, cur.digest || TEMPLATE.alerts.digest);
      if (typeof inc.digest.enabled === 'boolean') d.enabled = inc.digest.enabled;
      const h = Number(inc.digest.hour);
      if (inc.digest.hour != null && inc.digest.hour !== '' && Number.isInteger(h) && h >= 0 && h <= 23) d.hour = h;
      out.digest = d;
    }
    if (inc.reportPush && typeof inc.reportPush === 'object') {
      const rp = JSON.parse(JSON.stringify(cur.reportPush || TEMPLATE.alerts.reportPush));
      for (const f of ['week', 'month']) {
        const src = inc.reportPush[f];
        if (!src || typeof src !== 'object') continue;
        if (typeof src.enabled === 'boolean') rp[f].enabled = src.enabled;
        const h = Number(src.hour);
        if (src.hour != null && src.hour !== '' && Number.isInteger(h) && h >= 0 && h <= 23) rp[f].hour = h;
      }
      out.reportPush = rp;
    }
    next.alerts = out;
  }
  return next;
}

let cache = null;
let cacheMtimeMs = 0; // 缓存对应文件的 mtime，外部改动后自动失效

function load() {
  let st = null;
  try { st = fs.statSync(PLANS_FILE); } catch { /* 首次运行尚未生成 */ }
  if (cache && st && st.mtimeMs === cacheMtimeMs) return cache;
  if (cache && !st) return cache; // 文件暂时不可见（如网络盘抖动）：继续用内存缓存，不回模板
  try {
    cache = JSON.parse(fs.readFileSync(PLANS_FILE, 'utf8'));
    // 根必须是普通对象：null / 标量 / 数组虽然能 parse 成功，但后续字段访问会崩
    // （且不补模板会让 load() 每次都拿到残缺配置）——视同损坏走备份/模板分支
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
      throw new Error('plans.json 根必须是 JSON 对象');
    }
    cacheMtimeMs = st ? st.mtimeMs : 0;
  } catch {
    if (st) {
      // JSON 损坏：先把坏文件备份为 .bak，再落模板，不直接吞掉
      try { fs.copyFileSync(PLANS_FILE, PLANS_FILE + '.bak'); } catch { /* 备份失败继续 */ }
    }
    cache = JSON.parse(JSON.stringify(TEMPLATE));
    save(cache); // 首次生成模板
    return cache;
  }
  // 补齐新增 key（保留已有自定义值）
  for (const [k, v] of Object.entries(TEMPLATE)) {
    if (cache[k] === undefined) cache[k] = v;
  }
  for (const [k, v] of Object.entries(TEMPLATE.plans)) {
    if (!cache.plans[k]) cache.plans[k] = v;
    else if (v.plan !== undefined && cache.plans[k].plan === undefined) cache.plans[k].plan = v.plan;
  }
  // alerts 块内部新增 key（v1.7 digest/reportPush）同样补齐：顶层补齐够不到嵌套层，
  // 不补的话老配置的 GET /api/plans 形状不稳定（时有时无），消费方兜底逻辑也要写两套
  if (cache.alerts && typeof cache.alerts === 'object') {
    for (const [k, v] of Object.entries(TEMPLATE.alerts)) {
      if (cache.alerts[k] === undefined) cache.alerts[k] = v;
    }
  }
  // priceSource 块内部新增 key（v1.7 auto/modelsSeen，周自动检查）同理补齐
  if (cache.priceSource && typeof cache.priceSource === 'object') {
    for (const [k, v] of Object.entries(TEMPLATE.priceSource)) {
      if (cache.priceSource[k] === undefined) cache.priceSource[k] = v;
    }
  }
  // dailyGoal 块内部新增 key（networkGB 每日流量目标）同理补齐
  if (cache.dailyGoal && typeof cache.dailyGoal === 'object') {
    for (const [k, v] of Object.entries(TEMPLATE.dailyGoal)) {
      if (cache.dailyGoal[k] === undefined) cache.dailyGoal[k] = v;
    }
  }
  return cache;
}

function save(next) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // 原子写：同目录临时文件 + rename，避免半截 JSON；含实时额度密钥，权限收紧 0600
  const tmp = PLANS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, PLANS_FILE);
  cache = next;
  try { cacheMtimeMs = fs.statSync(PLANS_FILE).mtimeMs; } catch { cacheMtimeMs = 0; }
}

module.exports = {
  load, save, maskQuotaKeys, applyQuotaKeysUpdate, applyPlansUpdate,
  maskSecret, maskWebhookUrl, QUOTA_KEY_FIELDS, CONFIG_DIR, PLANS_FILE,
};
