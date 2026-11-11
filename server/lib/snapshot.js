'use strict';
// 快照构建（单一事实源）：index.js 的 HTTP 服务与 mcp/mcp.js 共用同一实现，
// 消除两份手抄导致的口径漂移（归档合并、额度采集、脱敏行为完全一致）。
// 约束：本文件只负责「构建一次」；缓存/60s 周期由调用方自理
// （index.js 的 ensureFresh、mcp.js 的 snapshotCache）。
const plansStore = require('./plans');
const fs = require('node:fs'); // 云端 VPN 归档回退读 vpn-state.json / 额度展示快照 quota-snapshot.json
const path = require('node:path');
const { makePricer } = require('./pricing');
const { aggregate, vendorAggregate, apiAggregate, modelAggregate, projectAggregate, compareYesterday, bjDate } = require('./store');
const { monthForecast, dayForecast } = require('./forecast');
const history = require('./history');
const zcode = require('../collectors/zcode');
const ccswitch = require('../collectors/ccswitch');
const codexSessions = require('../collectors/codex-sessions');
const workbuddy = require('../collectors/workbuddy');
const claudecode = require('../collectors/claudecode');
const deepseekHarness = require('../collectors/deepseek-harness'); // v1.7.4：dsh 会话（zstd JSONL）
const chatgptQuota = require('../collectors/chatgpt-quota');
const minimaxQuota = require('../collectors/minimax-quota');
const zhipuQuota = require('../collectors/zhipu-quota');
const apiBilling = require('../collectors/api-billing');
const networkTraffic = require('../collectors/network-traffic');
const vpnQuota = require('../collectors/vpn-quota');

// 云端只读展示端（见 docs/DEPLOY.md）。每次构建时读 env（而非 require 时固化），
// 集成测试才能在同一进程里模拟「主端/展示端」两种角色。
const isReadonly = () => process.env.AI_QUOTA_HISTORY === 'readonly';
const QUOTA_SNAPSHOT_KEYS = ['chatgptQuota', 'minimaxQuota', 'zhipuQuota'];
// 与 web/js/render-cards.js TOOLS 的 key 对齐（月度预估按工具给）
const FORECAST_TOOLS = ['zcode', 'codex', 'claudeDesktop', 'claudeCode', 'workbuddy', 'dsh'];
// 云端数据陈旧判定（纯函数，导出供测试）：唯一依据是主端「最后一轮 pack+rsync 全部成功送达」
// 的 sync-marker 时间戳（失败轮不刷新）——主端脚本挂没挂、网络断没断都诚实反映在 age 上。
// 阈值 12h：同步周期 10 分钟，但要容忍笔记本整夜合盖（8~10h 无同步属正常），醒来下一轮即恢复，
// 低于 24h 又能做到"用户白天打开就看到提醒"。无 marker（旧版 pack）返回 null：不猜、不吵。
const STALE_AFTER_HOURS = 12;
function calcSyncStale(markerJson, now = Date.now()) {
  const syncedAt = markerJson && Number(markerJson.syncedAt);
  if (!Number.isFinite(syncedAt) || syncedAt > now) return null;
  const ageHours = (now - syncedAt) / 3600e3;
  return { syncedAt, ageHours: Math.round(ageHours * 10) / 10, active: ageHours > STALE_AFTER_HOURS };
}
// 云端额度回退（纯函数，导出供测试）：展示端密钥不落云 → 实时额度采集必失败；
// 用主端 cloud-sync 推来的 quota-snapshot.json（deploy-pack 已剥 raw 的百分比/倒计时数据）顶位渲染。
// 仅 30 分钟新鲜窗内生效（超时视为未同步，卡片保持隐藏而非挂过期数字）；只替换失败的源，
// live 可用结果永远优先。archived:true 标记 → 前端显示「主端同步」，预警引擎跳过（主端已推，防双发）。
const QUOTA_SNAPSHOT_FRESH_MS = 30 * 60e3;
function applyQuotaSnapshotFallback(quotaData, snapshotJson, now = Date.now()) {
  if (!snapshotJson || !Number.isFinite(snapshotJson.generatedAt)) return quotaData;
  if (now - snapshotJson.generatedAt > QUOTA_SNAPSHOT_FRESH_MS) return quotaData;
  for (const key of QUOTA_SNAPSHOT_KEYS) {
    const cur = quotaData[key];
    if (cur && cur.available) continue;
    const q = snapshotJson[key];
    if (q && q.available) quotaData[key] = Object.assign({}, q, { archived: true, archivedAt: snapshotJson.generatedAt });
  }
  return quotaData;
}

async function buildSnapshot() {
  const plans = plansStore.load();
  const pricer = makePricer(plans);

  // 采集计时（v1.8 数据健康）：回答「哪个源慢 / 挂了 / 这次读了多少行」，
  // 单源异常只记状态，绝不阻塞其他源。
  const clock = fn => { const s = process.hrtime.bigint(); const v = fn(); return [v, Number(process.hrtime.bigint() - s) / 1e6]; };
  const [zc, zcMs] = clock(() => zcode.collect());
  const [cc, ccMs] = clock(() => ccswitch.collect());
  const [wb, wbMs] = clock(() => workbuddy.collect());
  const [clc, clcMs] = clock(() => claudecode.collect());
  const [cs, csMs] = clock(() => codexSessions.collect());
  const [dh, dhMs] = clock(() => deepseekHarness.collect());
  const round1 = n => Math.round(n * 10) / 10;
  // Codex 双源切换点：cc-switch（2026-10-15 起停更）与 ~/.codex/sessions 的重叠期只认前者，
  // 会话行仅取 cc-switch 末条之后 —— 防止两源对同一请求双计；cc-switch 恢复记录时自动跟随。
  let csRows = cs.rows;
  let ccCodexMax = 0;
  for (const r of cc.rows) if (r.tool === 'codex' && r.ts > ccCodexMax) ccCodexMax = r.ts;
  if (ccCodexMax > 0) csRows = csRows.filter(r => r.ts > ccCodexMax);
  const rows = [...zc.rows, ...cc.rows, ...csRows, ...wb.rows, ...clc.rows, ...dh.rows].sort((a, b) => a.ts - b.ts);
  const agg = aggregate(rows, pricer);
  const cmp = compareYesterday(rows, pricer);
  const vendors = vendorAggregate(rows, pricer); // API 按量计费：按服务商的今日/本月用量与费用（纯计算，恒有）
  const apiUsage = apiAggregate(rows, pricer);   // API 维度：每把 API（provider）一桶 + 模型明细（今日/本月）
  const modelUsage = modelAggregate(rows, pricer);     // 今日模型排行：跨工具按模型归集（今日/本月）
  const projectUsage = projectAggregate(rows, pricer); // 项目统计：今日占比/费用 + 全窗口累计总量（纯计算，恒有）

  const errors = {};
  for (const [k, v] of Object.entries({ zcode: zc, ccswitch: cc, codexSessions: cs, workbuddy: wb, claudeCode: clc, deepseekHarness: dh })) {
    if (v.error) errors[k] = v.error;
  }
  // 数据健康（v1.8）：每个本机源的耗时/行数/成败。codexSessions 单列 rawRows（切换点过滤前），
  // 两者不一致是正常的——它说明双源切换点在生效，不是丢数据。
  let collectorStatus = {
    zcode: { rows: zc.rows.length, ms: round1(zcMs), ok: !zc.error },
    ccswitch: { rows: cc.rows.length, ms: round1(ccMs), ok: !cc.error },
    codexSessions: { rows: csRows.length, rawRows: cs.rows.length, ms: round1(csMs), ok: !cs.error },
    workbuddy: { rows: wb.rows.length, ms: round1(wbMs), ok: !wb.error },
    claudeCode: { rows: clc.rows.length, ms: round1(clcMs), ok: !clc.error },
    deepseekHarness: { rows: dh.rows.length, ms: round1(dhMs), ok: !dh.error },
  };

  // 只读展示端（云端，AI_QUOTA_HISTORY=readonly）：本机采集器在这里必然打不开源库
  // （~/.zcode、~/.cc-switch 等不在服务器上），报错是环境事实而非故障。
  // 若照实上报，前端「数据健康」会天天显示「2 个数据源异常」并自动展开——真出问题时就没人看了。
  // 因此展示端一律不报本机采集器状态：数据来自主端同步的归档库与脱敏快照，健康面板只留归档与远程源。
  if (isReadonly()) {
    collectorStatus = {};
    for (const k of ['zcode', 'ccswitch', 'codexSessions', 'workbuddy', 'claudeCode', 'deepseekHarness']) delete errors[k];
  }

  // 历史归档：聚合结果落库 + 归档补缺合并（raw 优先、archive 只补缺）。
  // 两者解耦：syncFromAgg 返回 false 有两种语义——库不可用（merge 也会自行降级 null）
  // 与 readonly 云端模式跳过写入（merge 必须照常，否则云端归档数据整体不可见）。
  // 容错：归档库打开/读写任何失败只记 collectorErrors.history，绝不阻塞快照主流程
  const hStart = process.hrtime.bigint();
  let historyMerged = 0;
  try {
    history.syncFromAgg(agg);
    const merged = history.mergeArchived(agg.daily, agg.models, pricer);
    if (merged) {
      agg.daily = merged.daily;
      agg.dailyKeys = merged.dailyKeys;
      agg.models = merged.models;
      historyMerged = merged.dailyKeys.length;
    }
  } catch (e) {
    errors.history = e.message;
  }
  const historyStatus = {
    ok: !errors.history,
    ms: round1(Number(process.hrtime.bigint() - hStart) / 1e6),
    days: historyMerged,
    covered: agg.dailyKeys.length,
  };

  // ChatGPT / MiniMax / 智谱 实时额度 + 各服务商 API 余额：四路并行采集（互不阻塞，
  // 总耗时 ≈ 最慢一路，而非四路之和）。每路带 10s race 超时；失败/超时降级 null，
  // 并在 collectorErrors 记 string（值必须为 string，前端与集成断言按 string 处理）
  const quotaTimeout = p => {
    let t;
    return Promise.race([
      p.then(v => ({ ok: true, v })),
      new Promise(r => { t = setTimeout(() => r({ ok: false }), 10_000); }),
    ]).finally(() => clearTimeout(t));
  };
  const collectQuota = async p => {
    try {
      const r = await quotaTimeout(p);
      return r.ok ? [null, r.v] : ['采集超时（10s）', null]; // ok:false = 10s 超时
    } catch (e) {
      // collect 自身 reject 同样降级 null；错误消息带进 collectorErrors（否则回归只能黑盒排查）
      return ['采集异常: ' + (e && e.message ? e.message : String(e)), null];
    }
  };
  const QUOTA_SOURCES = [
    ['chatgptQuota', chatgptQuota],
    ['minimaxQuota', minimaxQuota],
    ['zhipuQuota', zhipuQuota],
    ['apiBilling', apiBilling],
    ['vpnQuota', vpnQuota],
  ];
  const quotaData = {};
  const quotaResults = await Promise.all(QUOTA_SOURCES.map(([, mod]) => collectQuota(mod.collect())));
  quotaResults.forEach(([err, data], i) => {
    const key = QUOTA_SOURCES[i][0];
    if (err) errors[key] = err;
    quotaData[key] = data;
  });

  // 云端额度回退：只读展示模式才启用（本机的 live 采集永远优先，绝不拿旧快照盖新数据）。
  // 同一份 quota-snapshot.json 还携带主端 network 展示字段（下方网络卡回退复用）。
  let qsJson = null;
  if (isReadonly()) {
    try {
      qsJson = JSON.parse(fs.readFileSync(path.join(plansStore.CONFIG_DIR, 'quota-snapshot.json'), 'utf8'));
      applyQuotaSnapshotFallback(quotaData, qsJson);
    } catch { /* 无同步文件：保持采集器原降级 */ }
  }

  // VPN 流量包：本轮累计差值落库（daily_vpn 增量归档），今日用量一律从库回读（单一事实源，
  // 多进程/重启不双计——差值基线在 vpn-state.json）。归档失败只记 errors.vpnHistory，不阻塞。
  if (quotaData.vpnQuota && quotaData.vpnQuota.available) {
    try {
      history.syncVpnDaily({
        date: bjDate(Date.now()),
        deltaBytes: quotaData.vpnQuota.deltaBytes,
        totalBytes: quotaData.vpnQuota.totalBytes,
        expireAt: quotaData.vpnQuota.expireAt,
      });
      const todayStr = bjDate(Date.now());
      const rows = history.vpnDaily(31);
      quotaData.vpnQuota.todayBytes = (rows.find(r => r.date === todayStr) || {}).used_bytes || 0;
      quotaData.vpnQuota.history = rows.map(r => ({ date: r.date, usedBytes: r.used_bytes }));
    } catch (e) {
      errors.vpnHistory = e.message;
    }
  } else if (!quotaData.vpnQuota || !quotaData.vpnQuota.available) {
    // 云端只读部署回退：采集器密钥不落云（零密钥原则，docs/DEPLOY.md）→ live 采集必然不可用；
    // 用同步过去的 daily_vpn 归档行 + vpn-state.json 累计基线兜底渲染流量包卡（archived:true
    // 标记数据截至上次同步点）。无归档/无基线时保持原不可用形态（卡 hidden，不报错）。
    try {
      const latest = history.vpnLatest();
      let st = null;
      try { st = JSON.parse(fs.readFileSync(vpnQuota.STATE_FILE(), 'utf8')); } catch { /* 无基线 */ }
      if (latest && latest.total_bytes > 0 && st && Number.isFinite(st.used)) {
        const rows = history.vpnDaily(31);
        const todayStr = bjDate(Date.now());
        const used = Math.max(st.used, 0);
        quotaData.vpnQuota = {
          available: true,
          archived: true,
          provider: '归档同步',
          usedBytes: used,
          totalBytes: latest.total_bytes,
          remainingBytes: Math.max(latest.total_bytes - used, 0),
          usedPercent: used / latest.total_bytes * 100,
          expireAt: latest.expire_at || null,
          todayBytes: (rows.find(r => r.date === todayStr) || {}).used_bytes || 0,
          history: rows.map(r => ({ date: r.date, usedBytes: r.used_bytes })),
          fetchedAt: Date.now(),
          source: 'daily_vpn archive',
        };
      }
    } catch { /* 回退自身失败不影响主快照 */ }
  }

  // 网络流量（macOS 专属采集器，其他平台返回 error 不抛）：差分落库 + 近 31 天序列回读
  // （31 天覆盖完整自然月，月合计不缺首日）。归档/回读任何失败只记 errors.networkTraffic（string），
  // 绝不阻塞快照主流程。
  const [netErr, netData] = await collectQuota(networkTraffic.collect());
  if (netErr) errors.networkTraffic = netErr;
  let network = null;
  if (netData) {
    try {
      if (netData.entries && netData.entries.length) history.syncNetworkDaily(netData.entries);
      const netRows = history.networkDaily(31);
      const byDay = new Map();
      const monthKey = bjDate(Date.now()).slice(0, 7);
      const month = { rx: 0, tx: 0 };
      for (const r of netRows) {
        let day = byDay.get(r.date);
        if (!day) { day = { date: r.date, networks: [], total: { rx: 0, tx: 0 } }; byDay.set(r.date, day); }
        day.networks.push({ key: r.network, label: r.label, rx: r.rx, tx: r.tx });
        day.total.rx += r.rx;
        day.total.tx += r.tx;
        if (r.date.slice(0, 7) === monthKey) { month.rx += r.rx; month.tx += r.tx; }
      }
      const todayRow = byDay.get(bjDate(Date.now()));
      network = {
        error: netData.error || null,
        current: netData.current || null,
        today: todayRow ? { rx: todayRow.total.rx, tx: todayRow.total.tx } : { rx: 0, tx: 0 },
        month,
        series: [...byDay.values()],
      };
    } catch (e) {
      errors.networkTraffic = errors.networkTraffic || e.message;
      network = { error: e.message, current: netData.current || null, today: null, month: null, series: [] };
    }
  }

  // 云端陈旧感知（仅 readonly 展示端）：sync-marker 距上次成功同步的时长 → 前端陈旧横幅。
  // 主端本机模式永不显示（数据就在本机产生，无「同步断供」概念）。
  let syncStale = null;
  if (isReadonly()) {
    try {
      syncStale = calcSyncStale(JSON.parse(fs.readFileSync(path.join(plansStore.CONFIG_DIR, 'sync-marker.json'), 'utf8')));
    } catch { /* 旧版 pack 无 marker：不猜不吵 */ }
  }

  // 云端网络卡回退：live netstat 采集是 macOS 专属（云端 Linux 必失败 → current 空、实时卡隐藏、
  // 目标进度条空转）。用主端快照里的 network 展示字段顶位（同 30 分钟新鲜窗 + archived 标记，
  // live 永远优先）；today/month 本身来自同步归档无需回退，仅 current（网络名+速率）走快照。
  if (isReadonly() && network && !network.current
    && qsJson && Number.isFinite(qsJson.generatedAt) && Date.now() - qsJson.generatedAt < QUOTA_SNAPSHOT_FRESH_MS
    && qsJson.network && qsJson.network.current) {
    network = Object.assign({}, network, {
      current: Object.assign({}, qsJson.network.current, { archived: true }),
      error: null,
    });
  }

  // 线性外推（v1.8，口径唯一实现见 lib/forecast.js）：分母是日历天而非有数据的天数
  const todayK = bjDate(Date.now());
  const monK = todayK.slice(0, 7);
  const cnyOf = a => (a ? (a.costCny || 0) + (a.equivalentCny || 0) : 0);
  const monthSpend = tool => {
    let sum = 0;
    for (const d of agg.dailyKeys) {
      if (!d.startsWith(monK)) continue;
      const day = agg.daily[d] || {};
      sum += cnyOf(tool ? day[tool] : day.__total);
    }
    return sum;
  };
  const forecast = {
    today: dayForecast({ spendCny: cnyOf((agg.daily[todayK] || {}).__total) }),
    month: {
      total: monthForecast({ dailyKeys: agg.dailyKeys, spendCny: monthSpend(null) }),
      tools: Object.fromEntries(FORECAST_TOOLS.map(k => [k, monthForecast({ dailyKeys: agg.dailyKeys, spendCny: monthSpend(k) })])),
    },
  };

  const readonly = isReadonly();
  return {
    builtAt: Date.now(),
    readonly, // 前端据此说明「只读展示端，本机采集器不在此运行」
    // 快照对外脱敏：quotaKeys 机密字段（accessToken 等）只出掩码形态，其余配置原样
    plans: plansStore.maskQuotaKeys(plans),
    agg,
    cmp,
    vendors,
    apiUsage,
    modelUsage,
    projectUsage,
    chatgptQuota: quotaData.chatgptQuota,
    minimaxQuota: quotaData.minimaxQuota,
    zhipuQuota: quotaData.zhipuQuota,
    apiBilling: quotaData.apiBilling,
    vpnQuota: quotaData.vpnQuota,
    network,
    syncStale,
    collectorErrors: errors,
    collectorStatus,
    historyStatus,
    forecast,
    rowStats: { zcode: zc.rows.length, ccswitch: cc.rows.length, codexSessions: csRows.length, workbuddy: wb.rows.length, claudeCode: clc.rows.length, dsh: dh.rows.length },
  };
}

module.exports = { buildSnapshot, applyQuotaSnapshotFallback, calcSyncStale, QUOTA_SNAPSHOT_FRESH_MS, STALE_AFTER_HOURS };
