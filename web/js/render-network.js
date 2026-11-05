// 网络流量：① 实时卡区（紧跟套餐额度进度条之后）——当前网络 + 每日流量目标进度条；
// ② 趋势区（成本趋势图旁）——近 30 天按网络堆叠柱状图。
// 数据源 snap.network（服务端聚合 + 归档回读）；两区各自无数据时独立隐藏（含标题）。
// SVG 拼法与 render-tables.js 的 renderChart 同款；网络配色独立于 TOOLS 工具色。
import { snap } from './state.js';
import { esc, fmtBytes } from './utils.js';

// 网络条目配色（按 30 天总量降序取色，循环取用）
const PALETTE = ['#5b8def', '#34c77b', '#f5a524', '#e5484d', '#b18cff', '#22b8cf', '#ff8fab', '#94a3b8'];

// SSID 需要定位服务授权（macOS Sonoma+ 全命令行路径打码）：按接口归桶时给授权提示
const ssidHint = cur =>
  cur && cur.key && cur.key.startsWith('iface:') && /wi-fi/i.test(cur.label || '')
    ? ' · SSID 未授权（系统设置 → 隐私与安全性 → 定位服务，允许终端/看板 App 后按 WiFi 名分账）'
    : '';

// 每日流量目标进度条（plans.dailyGoal.networkGB，GB/天，上下行合计；0/未配置 = 不显示）。
// 档位配色与套餐额度条一致：>85% 红（over）、>60% 黄（warn）
function goalBarHtml(today) {
  const goalGB = Number((snap.plans && snap.plans.dailyGoal && snap.plans.dailyGoal.networkGB) || 0);
  if (!(goalGB > 0)) return '';
  const goalBytes = goalGB * 1024 * 1024 * 1024;
  const used = (today.rx || 0) + (today.tx || 0);
  const pct = used / goalBytes * 100;
  const cls = pct > 85 ? 'over' : pct > 60 ? 'warn' : '';
  const remain = Math.max(goalBytes - used, 0);
  return `<div class="bar"><i class="${cls}" style="width:${Math.min(pct, 100).toFixed(1)}%"></i></div>
    <div class="quota-line"><span>每日流量目标（${esc(goalGB)} GB）已用 ${pct.toFixed(pct < 10 ? 1 : 0)}%</span>
      <span class="mut">已用 ${fmtBytes(used)} · 剩 ${fmtBytes(remain)}</span></div>`;
}

export function renderNetwork() {
  const nowBox = document.getElementById('networkNow');
  const chartBox = document.getElementById('networkChartBox');
  if (!nowBox || !chartBox) return;
  const net = snap.network;
  const cur = net && net.current;
  const series = (net && net.series) || [];

  // —— 实时卡区（套餐额度进度条下方；无当前网络时整区隐藏） ——
  const nowSec = nowBox.closest('section');
  if (!cur) {
    nowSec.style.display = 'none';
    nowBox.innerHTML = '';
  } else {
    nowSec.style.display = '';
    const today = (net && net.today) || { rx: 0, tx: 0 };
    const month = (net && net.month) || { rx: 0, tx: 0 };
    nowBox.innerHTML = `
      <div class="card">
        <h3><span class="tool-dot" style="background:var(--accent)"></span>${esc(cur.label)}
          <span class="tag">实时</span></h3>
        ${goalBarHtml(today)}
        <div class="quota-line"><span>今日流量</span><span>↓ ${fmtBytes(today.rx)} · ↑ ${fmtBytes(today.tx)}</span></div>
        <div class="quota-line"><span>本月流量</span><span>↓ ${fmtBytes(month.rx)} · ↑ ${fmtBytes(month.tx)}</span></div>
        <div class="quota-line"><span>实时速率</span><span class="mut">↓ ${fmtBytes(cur.rxRate)}/s · ↑ ${fmtBytes(cur.txRate)}/s</span></div>
        <div class="fresh">netstat -ib · ${new Date(snap.builtAt || Date.now()).toLocaleTimeString('zh-CN')}${ssidHint(cur)}${net.error ? ' · <span class="err">' + esc(net.error) + '</span>' : ''}</div>
      </div>`;
  }

  // —— 趋势区（成本趋势图旁；无序列数据时整区隐藏） ——
  const trendSec = chartBox.closest('section');
  const days = series.slice(-30);
  if (!days.length) {
    trendSec.style.display = 'none';
    chartBox.innerHTML = '';
    return;
  }
  trendSec.style.display = '';
  // 网络清单：按 30 天总量降序（图例顺序 = 取色顺序 = 堆叠顺序，保持视觉一致）
  const totals = new Map(); // key -> { label, rx, tx }
  for (const d of days) {
    for (const n of d.networks) {
      const t = totals.get(n.key) || { label: n.label, rx: 0, tx: 0 };
      t.rx += n.rx; t.tx += n.tx;
      totals.set(n.key, t);
    }
  }
  const order = [...totals.entries()].sort((a, b) => (b[1].rx + b[1].tx) - (a[1].rx + a[1].tx));
  const color = Object.fromEntries(order.map(([k], i) => [k, PALETTE[i % PALETTE.length]]));

  const W = 1100, H = 220, P = { l: 62, r: 12, t: 12, b: 24 };
  const rawMax = Math.max(1, ...days.map(d => d.total.rx + d.total.tx));
  // Y 轴取整刻度（字节域）：向上取到半个数量级的整数倍
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const maxV = Math.ceil(rawMax / (mag / 2)) * (mag / 2);
  const slot = (W - P.l - P.r) / Math.max(days.length, 1);
  const bw = Math.min(slot, 48); // 数据天数少时柱宽封顶（居中于各自槽位），避免整图被一根全宽色块铺满
  let bars = '';
  days.forEach((d, i) => {
    let y = H - P.b;
    for (const [key] of order) { // 堆叠顺序与图例一致
      const n = d.networks.find(x => x.key === key);
      if (!n) continue;
      const v = n.rx + n.tx;
      if (!v) continue;
      const h = v / maxV * (H - P.t - P.b);
      y -= h;
      bars += `<rect x="${P.l + i * slot + (slot - bw) / 2 + 1}" y="${y}" width="${Math.max(bw - 2, 1)}" height="${h}" fill="${color[key]}"><title>${d.date} ${esc(n.label)}：↓${fmtBytes(n.rx)} ↑${fmtBytes(n.tx)}</title></rect>`;
    }
    if (i % 5 === 0 || i === days.length - 1)
      bars += `<text x="${P.l + i * slot + slot / 2}" y="${H - 6}" font-size="10" fill="var(--muted)" text-anchor="middle">${d.date.slice(5)}</text>`;
  });
  [0, .5, 1].forEach(f => {
    const y = H - P.b - f * (H - P.t - P.b);
    bars += `<line x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}" stroke="var(--border)" stroke-width="1"/>
      <text x="${P.l - 6}" y="${y + 3}" font-size="10" fill="var(--muted)" text-anchor="end">${fmtBytes(maxV * f)}</text>`;
  });
  const legend = order.map(([key, t]) =>
    `<span style="margin-right:14px;font-size:12px"><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color[key]};margin-right:4px"></i>${esc(t.label)} · 30天 ↓${fmtBytes(t.rx)} ↑${fmtBytes(t.tx)}</span>`).join('');

  chartBox.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${bars}</svg><div style="margin-top:8px">${legend}</div>`;
}
