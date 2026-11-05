'use strict';
// 网络流量采集器（macOS 专属）：跟随 60s 快照周期对 netstat -ib 的每接口累计字节数做差分，
// 把区间流量归因到「当前接入的网络」（WiFi SSID / 有线硬件端口名），产出日粒度 entries 供归档。
// 口径：只统计 en* 物理网卡 —— VPN(utun)/回环/桥接等虚拟接口的流量都经物理网卡收发，
//       归到底层物理网卡所在网络即可，不重复计算也不漏计。
// SSID 隐私：macOS Sonoma 起所有命令行路径读 SSID 都要求「定位服务」授权宿主 App；
//       未授权时 ipconfig/system_profiler 返回 <redacted>，此时按接口名归桶（label=Wi-Fi），
//       授权后自动开始按真实 SSID 分账。UI 侧提示授权方法（见 render-network.js）。
// 契约：collect() 永不抛异常，返回 { error, entries, current, sampledAt, source }（错误进 error 字段）；
//       差分基于累计计数器 → 并发/重复构建不会双计。
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const plansStore = require('../lib/plans');
const { bjDate } = require('../lib/bjtime');

const execFileP = promisify(execFile);
const STATE_FILE = () => path.join(plansStore.CONFIG_DIR, 'network-state.json');

// 硬件端口映射（设备名 → "Wi-Fi"/"Ethernet"/"USB 10/100/1000 LAN"）缓存：networksetup 启动慢，10min TTL
let portCache = { at: 0, map: null };
const PORT_TTL = 10 * 60_000;

async function run(cmd, args, timeoutMs) {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true });
    return stdout || '';
  } catch {
    return null; // 命令失败/超时：返回 null，由调用方降级
  }
}

// netstat -ib 解析：只取 Link 行（tokens[2] 以 <Link#N> 标记；地址列可能为空），
// 字节计数固定在末 7 列布局 [Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll] 的 Ibytes/Obytes 位。
// 仅保留 en* 物理网卡。纯函数，导出供单测。
function parseNetstatIb(text) {
  const out = [];
  if (!text) return out;
  for (const line of String(text).split('\n')) {
    const tk = line.trim().split(/\s+/);
    if (tk.length < 10 || !tk[2] || !tk[2].startsWith('<Link')) continue;
    const name = tk[0];
    if (!/^en\d+$/.test(name)) continue;
    const ibytes = Number(tk[tk.length - 5]);
    const obytes = Number(tk[tk.length - 2]);
    if (!Number.isFinite(ibytes) || !Number.isFinite(obytes)) continue;
    out.push({ name, ibytes, obytes });
  }
  return out;
}

// ipconfig getsummary 的 SSID 行（兼容 ' SSID: x' / ' SSID : x' 两种排版；BSSID 行不会被误配）。
// <redacted>（定位未授权）按未取到处理。纯函数，导出供单测。
function parseSsid(text) {
  if (!text) return null;
  const m = String(text).match(/^\s*SSID\s*:\s*(.+)$/m);
  if (!m) return null;
  const v = m[1].trim();
  return v && v !== '<redacted>' ? v : null;
}

// networksetup -getairportnetwork 的 "Current Wi-Fi Network: xxx" 回退解析。纯函数。
function parseAirportNetwork(text) {
  const m = String(text || '').match(/Current Wi-Fi Network:\s*(.+)/);
  const v = m ? m[1].trim() : '';
  return v || null;
}

// 差分 + 计数器回绕保护：new < prev（重启/唤醒后计数器清零）按 0 计。
// 首次观测的接口无基准，本轮不计增量（下轮起正常差分）。纯函数，导出供单测。
function computeDeltas(rows, prev) {
  const deltas = {}, counters = {};
  for (const r of rows) {
    counters[r.name] = { ib: r.ibytes, ob: r.obytes };
    const p = prev && prev[r.name];
    deltas[r.name] = p
      ? { rx: r.ibytes >= p.ib ? r.ibytes - p.ib : 0, tx: r.obytes >= p.ob ? r.obytes - p.ob : 0 }
      : { rx: 0, tx: 0 };
  }
  return { deltas, counters };
}

// 差分 → 归档条目（按北京时间切日；无流量的接口不产条目）。纯函数，导出供单测。
function buildEntries(deltas, identities, ts) {
  const date = bjDate(ts);
  const entries = [];
  for (const [name, d] of Object.entries(deltas || {})) {
    if (!d || (d.rx <= 0 && d.tx <= 0)) continue;
    const id = (identities && identities[name]) || { key: 'iface:' + name, label: name };
    entries.push({ date, network: id.key, label: id.label, rxBytes: d.rx, txBytes: d.tx });
  }
  return entries;
}

// 当前网络 = 本轮流量最大的接口；全部无流量时沿用上次记录。纯函数，导出供单测。
function pickCurrent(deltas, identities, prevCurrent) {
  let best = null, bestTotal = 0;
  for (const [name, d] of Object.entries(deltas || {})) {
    const total = (d.rx || 0) + (d.tx || 0);
    if (total > bestTotal) { bestTotal = total; best = name; }
  }
  const name = best || (prevCurrent && prevCurrent.iface);
  if (!name) return null;
  const id = (identities && identities[name])
    || (prevCurrent && prevCurrent.iface === name ? prevCurrent : null)
    || { key: 'iface:' + name, label: name };
  const d = (deltas && deltas[name]) || { rx: 0, tx: 0 };
  return { key: id.key, label: id.label, iface: name, rx: d.rx || 0, tx: d.tx || 0 };
}

async function hardwarePorts() {
  const now = Date.now();
  if (portCache.map && now - portCache.at < PORT_TTL) return portCache.map;
  const text = await run('networksetup', ['-listallhardwareports'], 5000);
  const map = {};
  if (text) {
    let port = null;
    for (const ln of text.split('\n')) {
      const pm = ln.match(/^Hardware Port:\s*(.+)$/);
      if (pm) { port = pm[1].trim(); continue; }
      const dm = ln.match(/^Device:\s*(.+)$/);
      if (dm && port) { map[dm[1].trim()] = port; port = null; }
    }
  }
  portCache = { at: now, map };
  return map;
}

// SSID 探测链：ipconfig getsummary（快）→ networksetup -getairportnetwork（部分版本可用）
async function ssidOf(dev) {
  const a = await run('ipconfig', ['getsummary', dev], 4000);
  const s = parseSsid(a);
  if (s) return s;
  const b = await run('networksetup', ['-getairportnetwork', dev], 4000);
  return parseAirportNetwork(b);
}

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; } // 首次运行/文件损坏：按无状态处理
}

function saveState(state) {
  try {
    fs.mkdirSync(plansStore.CONFIG_DIR, { recursive: true });
    const tmp = STATE_FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE()); // 原子写，防半截 JSON
  } catch { /* 状态文件写失败只影响重启后的差分基线，不阻塞采集 */ }
}

async function collect(now = Date.now()) {
  if (process.platform !== 'darwin') {
    return { error: '网络流量采集仅支持 macOS', entries: [], current: null, sampledAt: now, source: 'netstat -ib' };
  }
  try {
    const text = await run('netstat', ['-ib'], 5000);
    if (text == null) return { error: 'netstat 采集失败', entries: [], current: null, sampledAt: now, source: 'netstat -ib' };
    const rows = parseNetstatIb(text);
    const st = loadState();
    const prevAt = Number(st.at) || 0;
    const { deltas, counters } = computeDeltas(rows, st.counters);

    // 身份解析只对「本轮有流量」的接口做（SSID 探测要 spawn 子进程，按需付出）
    const portMap = await hardwarePorts();
    const identities = {};
    for (const [name, d] of Object.entries(deltas)) {
      if (d.rx <= 0 && d.tx <= 0) continue;
      if (portMap[name] === 'Wi-Fi') {
        const ssid = await ssidOf(name);
        identities[name] = ssid
          ? { key: 'wifi:' + ssid, label: ssid }
          : { key: 'iface:' + name, label: portMap[name] || name }; // SSID 未授权：按接口归桶
      } else {
        identities[name] = { key: 'iface:' + name, label: portMap[name] || name };
      }
    }
    const entries = buildEntries(deltas, identities, now);

    const durationSec = prevAt > 0 ? Math.min(Math.max((now - prevAt) / 1000, 1), 3600) : 0;
    const current = pickCurrent(deltas, identities, st.current || null);
    if (current) {
      current.rxRate = durationSec > 0 ? current.rx / durationSec : 0; // 字节/秒（基于本轮差值）
      current.txRate = durationSec > 0 ? current.tx / durationSec : 0;
    }

    // 状态落盘：计数器基线（缺席接口保留旧基线，重现时继续差分）+ 当前网络记忆
    // （服务重启后的宕机期流量归到重启时的当前网络，近似可接受）
    const mergedCounters = Object.assign({}, st.counters || {}, counters);
    saveState({
      version: 1, at: now, counters: mergedCounters,
      current: current ? { key: current.key, label: current.label, iface: current.iface } : (st.current || null),
    });

    return { error: null, entries, current, sampledAt: now, source: 'netstat -ib' };
  } catch (e) {
    return { error: '网络流量采集异常: ' + (e && e.message ? e.message : String(e)), entries: [], current: null, sampledAt: now, source: 'netstat -ib' };
  }
}

module.exports = { collect, parseNetstatIb, parseSsid, parseAirportNetwork, computeDeltas, buildEntries, pickCurrent, hardwarePorts, ssidOf, STATE_FILE };
