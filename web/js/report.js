// 周/月报（数据来自 GET /api/report?type=&offset=，服务端路由接线前先备好错误态）
// 自包含：状态、Markdown 渲染、加载、复制/下载与全部按钮绑定都在本模块
import { toast, ymd } from './utils.js';

const reportState = { type: 'week', offset: 0, data: null, error: false };

// 极简 Markdown 渲染：先整体转义 HTML 再套受控标签，其余行原样落 <pre>——内容永远不可能注入
// 支持：# ## ### 标题 / **加粗** / - 列表 / | 表格 | / > 引用
function mdToHtml(md) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const lines = String(md || '').split('\n');
  let html = '', pre = [], i = 0;
  const flushPre = () => { if (pre.length) { html += '<pre>' + esc(pre.join('\n')) + '</pre>'; pre = []; } };
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {          // 标题
      flushPre();
      html += '<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>';
      i++;
    } else if (/^>\s?/.test(line)) {                      // 引用（连续行合并为一段）
      flushPre();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trimEnd())) {
        buf.push(lines[i].trimEnd().replace(/^>\s?/, ''));
        i++;
      }
      html += '<blockquote>' + inline(buf.join('\n')).replace(/\n/g, '<br>') + '</blockquote>';
    } else if (/^[-*]\s+/.test(line)) {                   // 无序列表
      flushPre();
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trimEnd())) {
        items.push('<li>' + inline(lines[i].trimEnd().replace(/^[-*]\s+/, '')) + '</li>');
        i++;
      }
      html += '<ul>' + items.join('') + '</ul>';
    } else if (/^\|.*\|$/.test(line.trim())) {            // 表格（跳过 |---|---| 分隔行）
      flushPre();
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        if (!cells.every(c => /^:?-{3,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      if (rows.length) {
        html += '<table><tr>' + rows[0].map(c => '<th>' + inline(c) + '</th>').join('') + '</tr>';
        for (let r = 1; r < rows.length; r++) html += '<tr>' + rows[r].map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>';
        html += '</table>';
      }
    } else if (!line.trim()) {                            // 空行：断块
      flushPre();
      i++;
    } else {                                              // 其余语法不认识 → 原样 <pre>
      pre.push(line);
      i++;
    }
  }
  flushPre();
  return html;
}

function renderReport() {
  const box = document.getElementById('reportBody');
  const titleEl = document.getElementById('reportTitle');
  document.getElementById('reportNext').disabled = reportState.offset <= 0;
  if (reportState.error) {
    titleEl.textContent = '';
    // 与顶部错误横幅同款风格：占位文案 + 重试
    box.innerHTML = '<div class="err-banner"><span>报表暂不可用（/api/report 未响应或尚未接线）</span><button id="reportRetry" class="seg">重试</button></div>';
    const b = document.getElementById('reportRetry');
    if (b) b.onclick = loadReport;
    return;
  }
  const d = reportState.data;
  if (!d) { box.innerHTML = '<div class="skeleton-line">报表生成中…</div>'; return; }
  titleEl.textContent = d.title + (reportState.offset > 0 ? `（往回第 ${reportState.offset} 期）` : '（本期）');
  box.innerHTML = mdToHtml(d.markdown);
}

let reportSeq = 0; // 请求序号：快速切换周期/类型时并发多个 fetch，晚到的旧响应不得覆盖新状态
export async function loadReport() {
  const seq = ++reportSeq;
  const box = document.getElementById('reportBody');
  reportState.error = false;
  reportState.data = null;
  box.innerHTML = '<div class="skeleton-line">报表生成中…</div>';
  document.getElementById('reportTitle').textContent = '';
  document.getElementById('reportNext').disabled = reportState.offset <= 0;
  try {
    const r = await fetch('/api/report?type=' + reportState.type + '&offset=' + reportState.offset);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) throw new Error('HTTP ' + r.status);
    if (seq !== reportSeq) return; // 已有更新的请求在途：丢弃过期响应
    reportState.data = j;
  } catch {
    if (seq !== reportSeq) return;
    reportState.error = true;
  }
  renderReport();
}

// 复制 Markdown：优先 clipboard API，降级 execCommand；结果用 toast 给按钮反馈
async function copyReportMd() {
  if (!reportState.data) return;
  const md = reportState.data.markdown;
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(md); ok = true; }
  } catch { ok = false; }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = md;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  toast(ok ? 'Markdown 已复制' : '复制失败，请手动选择报表文本');
}

// 下载 .md：Blob + a[download]（不用 data URI，避免长文被 URL 编码放大）
function downloadReportMd() {
  if (!reportState.data) return;
  const blob = new Blob([reportState.data.markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ai-quota-${reportState.type}-report-${(reportState.data.data || {}).start || ymd()}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById('reportTypeSeg').addEventListener('click', e => {
  const t = e.target.dataset.t;
  if (!t || t === reportState.type) return;
  reportState.type = t;
  reportState.offset = 0;
  document.querySelectorAll('#reportTypeSeg button').forEach(b => b.classList.toggle('on', b === e.target));
  loadReport();
});
document.getElementById('reportPrev').addEventListener('click', () => { reportState.offset++; loadReport(); });
document.getElementById('reportNext').addEventListener('click', () => { if (reportState.offset > 0) { reportState.offset--; loadReport(); } });
document.getElementById('reportCopy').addEventListener('click', copyReportMd);
document.getElementById('reportDownload').addEventListener('click', downloadReportMd);
