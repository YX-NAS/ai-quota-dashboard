// 工具函数：格式化 / HTML 转义 / 时间键 / 下拉选项 / 轻提示 / CSV 与下载（无状态）
const fmt = n => n == null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
const fmtCny = n => n == null ? '—' : '¥' + n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const tok = n => n >= 1e8 ? (n / 1e8).toFixed(2) + ' 亿' : n >= 1e4 ? (n / 1e4).toFixed(1) + ' 万' : fmt(n);
// 字节流量格式化（1024 进制）：网络流量口径，与 token 的 tok() 区分开
const fmtBytes = n => {
  if (n == null) return '—';
  let v = Number(n) || 0, i = 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  while (Math.abs(v) >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v.toFixed(0) : v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
};
// 后端 costCny 已含 USD 折算，人民币口径 = costCny + equivalentCny，勿再乘汇率
const cny = a => a ? a.costCny + a.equivalentCny : 0;
// 单引号一并转义（&#39; 渲染回 '）：所有属性均双引号包裹，防属性逃逸的安全增强
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = n => n == null ? null : '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function todayKey() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}
function monthKey() { return todayKey().slice(0, 7); }
function weekStartKey() {
  // 北京时间本周一（ISO 周，周一为一周开始）
  // 注意：周/月报的周期切分在后端 server/lib/report.js 的 weekStart() 里另有一份同口径实现，改口径需两处同步
  const n = new Date(Date.now() + 8 * 3600e3);
  n.setUTCDate(n.getUTCDate() - (n.getUTCDay() + 6) % 7);
  return n.toISOString().slice(0, 10);
}

// 24 小时下拉（定时推送时刻，北京时间）
function hourOptions(sel) {
  return Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}" ${h === sel ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
}

// 轻提示：底部浮出，2.2s 后淡出
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- 数据导出（CSV 带 \uFEFF BOM，保 Excel 打开中文不乱码；data URI 下载） ----------
function download(name, content, mime) {
  const a = document.createElement('a');
  a.href = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent('\uFEFF' + content);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = cells => cells.map(csvCell).join(',');
const ymd = () => todayKey().replace(/-/g, '');

export { fmt, fmtCny, tok, cny, esc, fmtMoney, fmtBytes, todayKey, monthKey, weekStartKey, hourOptions, toast, download, csvRow, ymd };
