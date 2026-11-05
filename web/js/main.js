// 看板前端：渲染 /api/summary（入口模块：加载守卫、渲染调度、静态元素绑定、轮询）
import { toast } from './utils.js';
import { snap, setSnap } from './state.js';
import { safeGet, safeSet, ONBOARD_KEY } from './storage.js';
import { renderGoalBanner } from './goal.js';
import { renderCards, renderQuotaCards, renderBillingCards } from './render-cards.js';
import {
  renderKpis, renderModelRank, renderProjectStats, renderApiCosts,
  renderModelCosts, renderChart, renderDetail,
  exportApiCsv, exportDetailCsv, exportModelsCsv, exportJson,
} from './render-tables.js';
import { renderNetwork } from './render-network.js';
import { loadReport } from './report.js';
import { initSettings } from './settings.js';
import { renderPlanValue } from './plan-value.js';
import { initNotify, refreshNotify } from './notify.js';

let days = 30;
let everLoaded = false;
let loadSeq = 0; // 加载序号：days 切换 / 60s 轮询 / 手动刷新并发时，晚到的旧响应不得覆盖新快照

// 加载失败：顶部红色横幅 + 重试；首屏还没数据时先给加载骨架
function showError() { document.getElementById('errBanner').hidden = false; }
function hideError() { document.getElementById('errBanner').hidden = true; }
function renderSkeleton() {
  document.getElementById('kpis').innerHTML = '<div class="skeleton-line">数据构建中…</div>';
  document.getElementById('cards').innerHTML = '<div class="skeleton-line">首次构建要扫描全部本地历史，可能需要几十秒…</div>';
}

// 返回本次加载是否成功（刷新按钮据此区分「已刷新」与「快照已重建但重载失败」）
async function load() {
  const seq = ++loadSeq;
  try {
    const r = await fetch('/api/summary?days=' + days);
    // v1.7 云端部署：会话过期/未登录 → 跳登录页（本地无鉴权模式永远不会走到这）
    if (r.status === 401) { location.replace('/login'); return false; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (seq !== loadSeq) return false; // 已有更新的加载在途/完成：过期响应静默丢弃（不覆盖 snap，不触发 everLoaded / 错误横幅）
    setSnap(j);
    everLoaded = true;
    hideError();
    render();
    return true;
  } catch {
    if (seq !== loadSeq) return false; // 过期请求的失败同样静默，避免旧错误盖掉新状态
    if (!everLoaded) renderSkeleton();
    showError();
    return false;
  }
}

function render() {
  document.getElementById('updatedAt').textContent = '更新于 ' + new Date(snap.builtAt).toLocaleTimeString('zh-CN');
  renderOnboard();
  renderGoalBanner();
  renderKpis();
  renderCards();
  renderPlanValue();
  renderQuotaCards();
  renderBillingCards();
  renderModelRank();
  renderProjectStats();
  renderApiCosts();
  renderModelCosts();
  renderChart();
  renderNetwork();
  renderDetail();
}

// ---------- 新用户引导横幅：所有采集器都没有数据时显示一次 ----------
function renderOnboard() {
  const box = document.getElementById('onboard');
  if (!box) return;
  const total = Object.values(snap.rowStats || {}).reduce((x, y) => x + y, 0);
  const dismissed = !!safeGet(ONBOARD_KEY); // 隐私模式等 localStorage 不可用：safeGet 返回 null 只影响「记住已读」
  if (total > 0 || dismissed) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="glass onboard">
      <div class="onboard-head">
        <b class="onboard-title">第一次使用</b>
        <span class="mut onboard-msg">看板读取的是本机工具的使用记录：ZCode · Claude Code · Claude Desktop · ChatGPT·Codex(cc-switch) · WorkBuddy。装好并用上任意一个，数据 1 分钟内自动出现；额度卡需要对应套餐的凭证（设置里可配）。</span>
        <button id="onboardOk" class="btn">知道了</button>
      </div>
    </div>`;
  document.getElementById('onboardOk').onclick = () => {
    safeSet(ONBOARD_KEY, '1'); // localStorage 不可用时 safeSet 静默跳过，仅本次收起
    box.innerHTML = '';
  };
}

document.getElementById('daySeg').addEventListener('click', e => {
  if (e.target.dataset.d) {
    days = Number(e.target.dataset.d);
    document.querySelectorAll('#daySeg button').forEach(b => b.classList.toggle('on', b === e.target));
    load();
  }
});

document.getElementById('exportDetailCsv').addEventListener('click', () => { if (snap) exportDetailCsv(); });
document.getElementById('exportModelsCsv').addEventListener('click', () => { if (snap) exportModelsCsv(); });
document.getElementById('exportApiCsv').addEventListener('click', () => { if (snap) exportApiCsv(); });
document.getElementById('exportJson').addEventListener('click', () => { if (snap) exportJson(); });
document.getElementById('retryBtn').addEventListener('click', () => load());

// ---------- 主动刷新：强制重建快照（/api/refresh = ensureFresh(true)）后重拉渲染，不等 60s 周期 ----------
const refreshBtn = document.getElementById('refreshBtn');
refreshBtn.addEventListener('click', async () => {
  if (refreshBtn.disabled) return;
  refreshBtn.disabled = true;
  const oldText = refreshBtn.textContent;
  refreshBtn.textContent = '⟳ 刷新中…';
  try {
    const r = await fetch('/api/refresh', { method: 'POST' }); // POST-only：配合服务端防跨站驱动（CSRF）
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ok = await load();
    toast(ok ? '已刷新' : '快照已重建，但数据加载失败（60s 内自动重试）');
  } catch (e) {
    toast('刷新失败：' + e.message);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = oldText;
  }
});

// 设置面板保存 / 单价在线应用后通过 loadFn 重拉快照（见 settings.js）
initSettings(load);

// 站内通知中心：铃铛/消息卡片面板（角标与列表随 60s 轮询同步）
initNotify();

load();
loadReport();
refreshNotify();
setInterval(() => { load(); refreshNotify(); }, 60_000);
