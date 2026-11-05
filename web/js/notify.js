// 站内通知中心：导航栏铃铛（未读角标）+ 消息卡片下拉面板（/api/notifications）
// 消息来源：价格自动更新 / 价格源检查失败（price-auto）、额度预警（alerts）
import { esc } from './utils.js';

const panel = document.getElementById('notifyPanel');
const badge = document.getElementById('notifyBadge');
const listEl = document.getElementById('notifyList');

const TYPE_META = {
  'price-update': { icon: '💰', label: '价格更新' },
  'price-error':  { icon: '⚠️', label: '价格源异常' },
  'quota-alert':  { icon: '📢', label: '额度预警' },
};

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// 拉取并渲染：角标 + 列表。任何失败静默（铃铛维持原状，不打断主渲染）
export async function refreshNotify() {
  try {
    const r = await fetch('/api/notifications');
    if (!r.ok) return;
    const j = await r.json();
    const n = j.unread || 0;
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
    renderList(j.items || []);
  } catch { /* 服务未起 / 网络抖动 */ }
}

function renderList(items) {
  if (!items.length) {
    listEl.innerHTML = '<div class="notify-empty">暂无通知 —— 价格自动更新与额度预警会出现在这里</div>';
    return;
  }
  listEl.innerHTML = items.map(it => {
    const meta = TYPE_META[it.type] || { icon: '🔔', label: '通知' };
    return `<div class="notify-item${it.read ? '' : ' unread'}" data-id="${esc(it.id)}" title="${it.read ? '已读' : '点击标为已读'}">
      <div class="notify-item-head">
        <span class="notify-icon">${meta.icon}</span>
        <span class="notify-title">${esc(it.title)}</span>
        <span class="notify-time">${timeAgo(it.ts)}</span>
      </div>
      ${it.body ? `<div class="notify-body">${esc(it.body).replace(/\n/g, '<br>')}</div>` : ''}
      <div class="notify-foot"><span class="notify-type">${esc(meta.label)}</span>${it.read ? '' : '<span class="notify-dot"></span>'}</div>
    </div>`;
  }).join('');
}

async function post(url, body) {
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { /* 静默 */ }
}

export function initNotify() {
  if (!document.getElementById('notifyBtn')) return;
  document.getElementById('notifyBtn').addEventListener('click', async e => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    if (!panel.hidden) refreshNotify(); // 打开时重拉一次，保证角标与列表最新
  });
  // 点面板外关闭（面板内点击不关）
  document.addEventListener('click', e => {
    if (!panel.hidden && !panel.contains(e.target)) panel.hidden = true;
  });
  document.getElementById('notifyReadAll').addEventListener('click', async e => {
    e.stopPropagation();
    await post('/api/notifications/read', {});
    refreshNotify();
  });
  document.getElementById('notifyClear').addEventListener('click', async e => {
    e.stopPropagation();
    await post('/api/notifications/clear', {});
    refreshNotify();
  });
  // 单条消息卡点击 → 标为已读（服务端幂等；就地反馈后重拉校准角标）
  listEl.addEventListener('click', async e => {
    const item = e.target.closest('.notify-item');
    if (!item) return;
    item.classList.remove('unread');
    await post('/api/notifications/read', { id: item.dataset.id });
    refreshNotify();
  });
}
