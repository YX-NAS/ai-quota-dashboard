'use strict';
// 快照构建（单一事实源）：index.js 的 HTTP 服务与 mcp/mcp.js 共用同一实现，
// 消除两份手抄导致的口径漂移（归档合并、额度采集、脱敏行为完全一致）。
// 约束：本文件只负责「构建一次」；缓存/60s 周期由调用方自理
// （index.js 的 ensureFresh、mcp.js 的 snapshotCache）。
const plansStore = require('./plans');
const fs = require('node:fs'); // 云端 VPN 归档回退读 vpn-state.json 基线用
const { makePricer } = require('./pricing');
const { aggregate, vendorAggregate, apiAggregate, modelAggregate, projectAggregate, compareYesterday, bjDate } = require('./store');
const history = require('./history');
const zcode = require('../collectors/zcode');
const ccswitch = require('../collectors/ccswitch');
const codexSessions = require('../collectors/codex-sessions');
const workbuddy = require('../collectors/workbuddy');
const claudecode = require('../collectors/claudecode');
const chatgptQuota = require('../collectors/chatgpt-quota');
const minimaxQuota = require('../collectors/minimax-quota');
const zhipuQuota = require('../collectors/zhipu-quota');
const apiBilling = require('../collectors/api-billing');
const networkTraffic = require('../collectors/network-traffic');
const vpnQuota = require('../collectors/vpn-quota');

async function buildSnapshot() {
  const plans = plansStore.load();
  const pricer = makePricer(plans);

  const [zc, cc, wb, clc, cs] = [zcode.collect(), ccswitch.collect(), workbuddy.collect(), claudecode.collect(), codexSessions.collect()];
  // Codex 双源切换点：cc-switch（2026-10-15 起停更）与 ~/.codex/sessions 的重叠期只认前者，
  // 会话行仅取 cc-switch 末条之后 —— 防止两源对同一请求双计；cc-switch 恢复记录时自动跟随。
  let csRows = cs.rows;
  let ccCodexMax = 0;
  for (const r of cc.rows) if (r.tool === 'codex' && r.ts > ccCodexMax) ccCodexMax = r.ts;
  if (ccCodexMax > 0) csRows = csRows.filter(r => r.ts > ccCodexMax);
  const rows = [...zc.rows, ...cc.rows, ...csRows, ...wb.rows, ...clc.rows].sort((a, b) => a.ts - b.ts);
  const agg = aggregate(rows, pricer);
  const cmp = compareYesterday(rows, pricer);
  const vendors = vendorAggregate(rows, pricer); // API 按量计费：按服务商的今日/本月用量与费用（纯计算，恒有）
  const apiUsage = apiAggregate(rows, pricer);   // API 维度：每把 API（provider）一桶 + 模型明细（今日/本月）
  const modelUsage = modelAggregate(rows, pricer);     // 今日模型排行：跨工具按模型归集（今日/本月）
  const projectUsage = projectAggregate(rows, pricer); // 项目统计：今日占比/费用 + 全窗口累计总量（纯计算，恒有）

  const errors = {};
  for (const [k, v] of Object.entries({ zcode: zc, ccswitch: cc, codexSessions: cs, workbuddy: wb, claudeCode: clc })) {
    if (v.error) errors[k] = v.error;
  }

  // 历史归档：聚合结果落库 + 归档补缺合并（raw 优先、archive 只补缺）。
  // 容错：归档库打开/读写任何失败只记 collectorErrors.history，绝不阻塞快照主流程
  try {
    if (history.syncFromAgg(agg)) {
      const merged = history.mergeArchived(agg.daily, agg.models, pricer);
      if (merged) {
        agg.daily = merged.daily;
        agg.dailyKeys = merged.dailyKeys;
        agg.models = merged.models;
      }
    }
  } catch (e) {
    errors.history = e.message;
  }

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

  return {
    builtAt: Date.now(),
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
    collectorErrors: errors,
    rowStats: { zcode: zc.rows.length, ccswitch: cc.rows.length, codexSessions: csRows.length, workbuddy: wb.rows.length, claudeCode: clc.rows.length },
  };
}

module.exports = { buildSnapshot };
