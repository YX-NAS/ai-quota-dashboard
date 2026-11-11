// 数据健康（v1.8）：把「数据准不准、哪个源出问题」从卡片底部的小字提升为可查的一张表。
// 动机：看板的价值全部建立在采集结果上，但错误原本散落在 6 张卡的 foot 里，
// 用户看不到「本轮扫了多少行、哪个源慢、归档库有没有合并成功」，出问题只能靠猜。
// 纯展示，不做任何采集；字段全部来自快照（server/lib/snapshot.js 的 collectorStatus / historyStatus）。
import { fmt } from './utils.js';
import { snap } from './state.js';

// 本机采集器：key → 展示名（与快照 collectorStatus 的 key 对齐）
const COLLECTORS = [
  ['zcode', 'ZCode', '~/.zcode'],
  ['ccswitch', 'cc-switch', '~/.cc-switch'],
  ['codexSessions', 'Codex 会话', '~/.codex/sessions'],
  ['claudeCode', 'Claude Code', '~/.claude'],
  ['workbuddy', 'WorkBuddy', '~/.workbuddy-ai'],
  ['deepseekHarness', 'DeepSeek Harness', '~/.dsh'],
];

// 额度 / 计费 / 网络源：只有成/败，没有行数概念
const REMOTE = [
  ['chatgptQuota', 'ChatGPT 额度'],
  ['zhipuQuota', '智谱 Coding Plan 额度'],
  ['minimaxQuota', 'MiniMax 额度'],
  ['apiBilling', '各服务商余额'],
  ['vpnQuota', 'VPN 流量包'],
  ['networkTraffic', '网络流量'],
];

const okMark = ok => ok ? '<span class="h-ok">正常</span>' : '<span class="h-bad">失败</span>';

export function renderHealth() {
  const box = document.getElementById('healthBox');
  if (!box || !snap) return;
  const st = snap.collectorStatus || null;
  const hs = snap.historyStatus || null;
  const errs = snap.collectorErrors || {};

  // 没有任何状态字段（旧版服务端 / 极简快照）：整块不渲染，不硬凑
  if (!st && !hs) { box.innerHTML = ''; return; }

  const prev = box.querySelector('details');
  const wasOpen = prev ? prev.open : null;

  const rows = [];
  let okCount = 0, total = 0;
  // 只读展示端（云端）：本机采集器不在这台机器上跑，数据来自主端同步的归档库——
  // 服务端在 readonly 模式下已不返回 collectorStatus，这里补一句说明，避免「怎么没有本机源」的疑惑。
  if (snap.readonly) {
    rows.push(`<tr><td>数据来源<div class="h-src">主端同步 · 只读展示端</div></td>
      <td><span class="h-ok">正常</span></td>
      <td class="h-num">归档库 + 脱敏快照</td>
      <td class="h-num">—</td>
      <td class="h-err"></td></tr>`);
    total++;
    okCount++;
  }
  if (st) {
    for (const [key, name, src] of COLLECTORS) {
      const s = st[key];
      if (!s) continue;
      total++;
      if (s.ok) okCount++;
      // 切换点过滤：行数与原始行数不同是正常的（codex 双源防双计），标注而不是报错
      const extra = s.rawRows != null && s.rawRows !== s.rows
        ? ` <span class="h-dim">（原始 ${fmt(s.rawRows)}，按切换点取 ${fmt(s.rows)}）</span>` : '';
      rows.push(`<tr>
        <td>${name}<div class="h-src">${src}</div></td>
        <td>${okMark(s.ok)}</td>
        <td class="h-num">${fmt(s.rows)} 行${extra}</td>
        <td class="h-num">${s.ms >= 1000 ? (s.ms / 1000).toFixed(1) + 's' : Math.round(s.ms) + 'ms'}</td>
        <td class="h-err">${errs[key] ? escText(errs[key]) : ''}</td>
      </tr>`);
    }
  }
  if (hs) {
    total++;
    if (hs.ok) okCount++;
    rows.push(`<tr>
      <td>历史归档<div class="h-src">config/history.sqlite</div></td>
      <td>${okMark(hs.ok)}</td>
      <td class="h-num">合并 ${fmt(hs.days)} 天${hs.covered !== hs.days ? ` / 窗口 ${fmt(hs.covered)} 天` : ''}</td>
      <td class="h-num">${hs.ms >= 1000 ? (hs.ms / 1000).toFixed(1) + 's' : Math.round(hs.ms) + 'ms'}</td>
      <td class="h-err">${errs.history ? escText(errs.history) : ''}</td>
    </tr>`);
  }
  for (const [key, name] of REMOTE) {
    // 远程源只有在「本轮有记录」时才列出：既没成功也没报错 = 未配置，列出来只是噪音
    const hasErr = !!errs[key];
    if (!hasErr && !(snap[key] && snap[key].available)) continue;
    total++;
    if (!hasErr) okCount++;
    rows.push(`<tr>
      <td>${name}</td>
      <td>${okMark(!hasErr)}</td>
      <td class="h-num">${snap[key] && snap[key].available ? '已获取' : '—'}</td>
      <td class="h-num">—</td>
      <td class="h-err">${hasErr ? escText(errs[key]) : ''}</td>
    </tr>`);
  }

  // 云同步（只读展示端）：本机模式下 syncStale 恒 null，不显示这一行
  const ss = snap.syncStale;
  if (ss) {
    total++;
    if (!ss.active) okCount++;
    rows.push(`<tr>
      <td>云端同步</td>
      <td>${ss.active ? '<span class="h-bad">断供</span>' : '<span class="h-ok">正常</span>'}</td>
      <td class="h-num">${ss.ageHours} 小时前</td>
      <td class="h-num">—</td>
      <td class="h-err">${ss.active ? '主端超过 12 小时未成功同步' : ''}</td>
    </tr>`);
  }

  const builtAt = new Date(snap.builtAt).toLocaleString('zh-CN');
  const bad = total - okCount;
  box.innerHTML = `
    <details class="health glass"${wasOpen === null ? (bad > 0 ? ' open' : '') : (wasOpen ? ' open' : '')}>
      <summary>
        <b>数据健康</b>
        <span class="h-sum ${bad ? 'h-bad' : 'h-ok'}">${bad ? bad + ' 个数据源异常' : '全部正常'}</span>
        <span class="h-dim">· 本轮构建于 ${builtAt}</span>
      </summary>
      <div class="table-wrap"><table class="h-table">
        <thead><tr><th>数据源</th><th>状态</th><th>本轮读取</th><th>耗时</th><th>错误</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table></div>
      <div class="h-tip">行数是本轮扫描到的原始记录数；额度类来源只有成/败，没有行数。某个源失败只会让对应卡片降级，其他源照常统计。</div>
    </details>`;
}

function escText(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}