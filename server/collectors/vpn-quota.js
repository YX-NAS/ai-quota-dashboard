'use strict';
// VPN 流量包额度采集器：从面板「订阅地址」的响应头 subscription-userinfo 读取服务端计量
// （upload/download/total/expire），与面板页面数字同源同账单——不依赖登录 Cookie（订阅 token 长期有效），
// 也不依赖本地网卡（Clash 系统代理分流模式下 utun 计数器测不到隧道流量）。
// 配置：plans.quotaKeys.vpnPanel.url（面板「快速配置」里的专属订阅地址，token 在路径内 = 机密字段）。
// 状态：config/vpn-state.json 持久上次累计已用字节 → 每次采集差分 = 今日用量增量（归档 daily_vpn）。
// 契约：collect() 永不 reject；返回 { available, provider, usedBytes, totalBytes, remainingBytes,
//        usedPercent, expireAt, deltaBytes, fetchedAt, source } 或 { available:false, notConfigured?, reason }。
const fs = require('node:fs');
const path = require('node:path');
const plansStore = require('../lib/plans');
const { requestMeta, sanitizeReason } = require('../lib/http-json');

const STATE_FILE = () => path.join(plansStore.CONFIG_DIR, 'vpn-state.json');
const CACHE_TTL = 60_000; // 快照 60s 一建，同一快照周期内多个消费方（index/mcp/refresh）只打一次外网
let cache = { at: 0, value: null };

// subscription-userinfo: "upload=132626456142; download=731315190778; total=2684354560000; expire=1814201408"
// 纯解析（导出供测试）：缺 upload/download/total 任一或 total<=0（不限流量包无从算占比）→ null。
// expire 秒级时间戳 → 毫秒；0/缺失按 null（面板显示"永久"类）。
function parseSubscriptionUserinfo(headerValue) {
  const s = String(headerValue || '');
  const g = (k) => {
    const m = s.match(new RegExp(k + '\\s*=\\s*(\\d+)', 'i'));
    return m ? Number(m[1]) : null;
  };
  const upload = g('upload'); const download = g('download'); const total = g('total'); const expire = g('expire');
  if (upload == null || download == null || total == null || total <= 0) return null;
  return { upload, download, total, expire: expire > 0 ? expire * 1000 : null };
}

// 累计已用 → 本轮增量：无基线（首采）或负差（续订/套餐重置计数器归零）都记 0，由调用方重建基线。纯函数
function nextDelta(prevUsed, curUsed) {
  if (prevUsed == null || !Number.isFinite(prevUsed) || !(curUsed >= prevUsed)) return 0;
  return curUsed - prevUsed;
}

// 订阅 URL 的 reason 掩码：token 在 path/query 里，任何回显 URL 的错误文本必须先过一遍
function maskSubUrl(url) {
  try { const u = new URL(url); return u.protocol + '//' + u.host + '/***'; } catch { return '***'; }
}

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

function saveState(state) {
  try {
    fs.mkdirSync(plansStore.CONFIG_DIR, { recursive: true });
    const tmp = STATE_FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE());
  } catch { /* 状态写失败只丢增量基线（下轮记 0），不阻塞采集 */ }
}

function readSubHeader(headers) {
  return headers && (headers['subscription-userinfo'] || headers['Subscription-Userinfo'] || null);
}

// 网络层错误汉化：Node TLS/连接类原始英文对用户不可读（Cloudflare 边缘偶发 reset 是主因）
const NET_REASON_CN = [
  [/before secure TLS|ECONNRESET|socket hang up|disconnected|ECONNREFUSED/i, '与面板的连接瞬断（TLS 被重置，常见于 VPN 隧道或 CDN 抖动，已自动重试）'],
  [/timeout/i, '采集超时（网络缓慢，已自动重试）'],
  [/ENOTFOUND|EAI_FAIL|EAI_AGAIN/i, '订阅域名解析失败（本地 DNS 或网络不通）'],
];
function friendlyReason(reason) {
  for (const [re, cn] of NET_REASON_CN) if (re.test(reason)) return cn;
  return reason;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function collect(now = Date.now()) {
  try {
    const plans = plansStore.load();
    const url = String(((plans.quotaKeys || {}).vpnPanel || {}).url || '').trim();
    if (!url) return { available: false, notConfigured: true, reason: '未配置订阅地址', fetchedAt: now };
    if (cache.value && now - cache.at < CACHE_TTL) return Object.assign({}, cache.value);

    // 全程硬预算 8.5s —— 必须整体落进快照层 collectQuota 的 10s race 内，
    // 否则超时被外层剪掉连内层 reason 都拿不到（只报「采集超时（10s）」丢诊断）
    const deadline = Date.now() + 8500;
    const left = () => deadline - Date.now();

    // HEAD 拿头优先（订阅配置体可能上百 KB）；个别服务端 HEAD 不回头部 → 退回 GET（体限 2MB 即弃）。
    // 网络层失败（TLS 瞬断/超时）自动重试一次：Cloudflare 边缘偶发 reset 约 1/3 概率，
    // 单次尝试会频繁把可用卡片打进 60s 失败态，一次快速重试基本抹平
    let meta = await requestMeta(url, { timeoutMs: Math.max(500, Math.min(3000, left())) });
    if (!meta.ok && left() > 1200) {
      await sleep(600);
      if (left() > 800) meta = await requestMeta(url, { timeoutMs: Math.max(500, Math.min(3000, left())) });
    }
    let info = meta.ok ? parseSubscriptionUserinfo(readSubHeader(meta.headers)) : null;
    if (meta.ok && !info && left() > 800) {
      meta = await requestMeta(url, { method: 'GET', timeoutMs: Math.max(500, Math.min(3500, left())), maxBytes: 2_097_152 });
      info = meta.ok ? parseSubscriptionUserinfo(readSubHeader(meta.headers)) : null;
    }
    if (!meta.ok) {
      // reason 不得回显含 token 的 URL（http-json 层已脱敏密钥形态，这里再兜底整串替换）
      const reason = String(meta.reason || 'HTTP ' + meta.status).split(url).join(maskSubUrl(url));
      return { available: false, reason: friendlyReason(sanitizeReason(reason)), fetchedAt: now };
    }
    if (!info) return { available: false, reason: '响应头缺少流量计量（订阅令牌失效或面板不支持计量头）', fetchedAt: now };

    const usedBytes = info.upload + info.download;
    const st = loadState();
    const deltaBytes = nextDelta(st.used, usedBytes);
    saveState({ used: usedBytes, at: now }); // 成功才推进基线（失败轮不吞流量）

    const value = {
      available: true,
      provider: (() => { try { return new URL(url).hostname; } catch { return 'VPN'; } })(),
      usedBytes,
      totalBytes: info.total,
      remainingBytes: Math.max(info.total - usedBytes, 0),
      usedPercent: usedBytes / info.total * 100,
      expireAt: info.expire,
      deltaBytes,
      fetchedAt: now,
      source: 'subscription-userinfo',
    };
    cache = { at: now, value };
    return Object.assign({}, value);
  } catch (e) {
    return { available: false, reason: '采集异常: ' + (e && e.message ? e.message : String(e)), fetchedAt: now };
  }
}

module.exports = { collect, parseSubscriptionUserinfo, nextDelta, maskSubUrl, friendlyReason, STATE_FILE };
