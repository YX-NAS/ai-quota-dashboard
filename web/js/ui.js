// 交互层：模型 chips 折叠 / 主题切换 / 卡片拖拽排序（Pointer Events）/ mm-toggle 委托 / resize 防抖 / 入场动效摘除
import { safeGet, safeSet, THEME_KEY, mmOpenKeyOf, cardOrderKey } from './storage.js';

// 模型 chips 容器由 render-cards 的 modelChipsHtml() 渲染，这里只负责量宽折叠。
// 折叠量宽：一行放不下的 chips 就地隐藏，末位留「+N 个 ▾」；一行本来就放得下则不出折叠钮。
// 断点随卡片宽度变化，窗口 resize 后需重跑（见文件底部监听）。
// 放在本模块：renderBillingCards / renderProjectStats（跨模块）与下方 mm-toggle 委托、resize 防抖都要调用，
// 归入渲染模块会与 applyCardOrder 形成 ui ↔ 渲染循环依赖。
export function foldModelChips() {
  document.querySelectorAll('.billing-models').forEach(box => {
    const btn = box.querySelector('.mm-toggle');
    if (!btn) return;
    const chips = [...box.querySelectorAll('.mm:not(.mm-toggle)')];
    chips.forEach(c => { c.style.display = ''; });
    if (box.classList.contains('open')) {
      btn.hidden = false;
      btn.textContent = '收起 ▴';
      btn.title = '收起模型列表';
      return;
    }
    btn.hidden = false;
    btn.textContent = `+${chips.length} 个 ▾`; // 先按最大计数占位，量出折叠钮自身宽度
    const gap = 5;
    let avail = box.clientWidth - btn.offsetWidth - gap;
    let shown = 0;
    for (const c of chips) {
      const w = c.offsetWidth + gap;
      if (w > avail) break;
      avail -= w;
      shown++;
    }
    const rest = chips.length - shown;
    if (rest <= 0) { btn.hidden = true; return; } // 一行放得下：无需折叠
    for (let i = shown; i < chips.length; i++) chips[i].style.display = 'none';
    btn.textContent = `+${rest} 个 ▾`;
    btn.title = `展开其余 ${rest} 个模型（共 ${chips.length} 个）`;
  });
}

// ---------- 主题（日间/夜间）：首帧前的 data-theme 由 index.html 内联脚本设定，这里只负责切换与按钮图标 ----------
// 纯 CSS 变量切换（style.css :root 与 :root[data-theme="light"] 两张变量表），无需重渲染
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const btn = document.getElementById('themeBtn');
  if (!btn) return;
  btn.textContent = t === 'light' ? '🌙' : '☀️';   // 图标 = 将切换到的主题
  btn.title = t === 'light' ? '切换到夜间主题' : '切换到日间主题';
  btn.setAttribute('aria-label', btn.title);        // 纯图标按钮：无文字内容，读屏朗读 aria-label（与 title 同步）
}
applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
document.getElementById('themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  safeSet(THEME_KEY, next);
  applyTheme(next);
});

// ---------- 卡片拖拽排序（Pointer Events 实现 + localStorage 持久化） ----------
// 不用 HTML5 DnD：合成事件无法触发原生 dragstart，且 Pointer 方案支持触控笔、动效完全可控
const dragGhost = document.getElementById('dragGhost');
let drag = null; // { card, container, id, startX, startY, active }

// 渲染后按已保存顺序重排（新出现的卡片追加在末尾；提示/折叠等辅助行没有 data-key，固定排到最后整行显示）
export function applyCardOrder(id) {
  const c = document.getElementById(id);
  let saved;
  try { saved = JSON.parse(safeGet(cardOrderKey(id)) || 'null'); } catch { saved = null; } // JSON.parse 可能抛（坏数据），保留独立 try
  if (!Array.isArray(saved) || !saved.length) return;
  const byKey = {};
  for (const el of [...c.children]) if (el.dataset.key) byKey[el.dataset.key] = el;
  for (const k of saved) if (byKey[k]) { c.appendChild(byKey[k]); delete byKey[k]; }
  for (const el of [...c.children]) if (!el.dataset.key) c.appendChild(el);
}
function persistCardOrder(id) {
  // localStorage 不可用（隐私模式）时静默跳过持久化——safeSet 内部吞异常，不会中断 pointerup 里的 drag = null，避免卡死拖拽状态机
  safeSet(cardOrderKey(id),
    JSON.stringify([...document.getElementById(id).children].map(el => el.dataset.key)));
}
// 网格布局下找坐标最近的卡片作为插入参照
function nearestCard(c, x, y) {
  let best = null, bestD = Infinity;
  for (const el of c.querySelectorAll('.card')) {
    if (el === drag.card) continue;
    const r = el.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = el; }
  }
  return best;
}
function enableCardDnD(id) {
  const c = document.getElementById(id);
  c.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.pointerType === 'touch') return; // 触摸留给页面滚动
    const card = e.target.closest('.card');
    if (!card || !c.contains(card)) return;
    drag = { card, container: c, id, startX: e.clientX, startY: e.clientY, active: false };
  });
}
document.addEventListener('pointermove', e => {
  if (!drag) return;
  if (!drag.active) {
    // 位移超过 6px 才算拖拽，避免误伤点击
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
    drag.active = true;
    drag.card.classList.add('dragging');
    document.body.classList.add('dragging-any');
    const h3 = drag.card.querySelector('h3');
    dragGhost.textContent = '⟪ ' + (h3 ? h3.textContent.trim() : '') + ' ⟫';
    dragGhost.style.display = 'block';
  }
  e.preventDefault();
  dragGhost.style.left = e.clientX + 18 + 'px';
  dragGhost.style.top = e.clientY - 34 + 'px';
  const target = nearestCard(drag.container, e.clientX, e.clientY);
  if (!target) { drag.container.appendChild(drag.card); return; }
  const r = target.getBoundingClientRect();
  const before = e.clientX < r.left + r.width / 2;
  drag.container.insertBefore(drag.card, before ? target : target.nextSibling);
}, { passive: false });
document.addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.active) {
    drag.card.classList.remove('dragging');
    document.body.classList.remove('dragging-any');
    dragGhost.style.display = 'none';
    persistCardOrder(drag.id);
  }
  drag = null;
});
document.addEventListener('pointercancel', () => {
  if (drag) {
    drag.card.classList.remove('dragging');
    document.body.classList.remove('dragging-any');
    dragGhost.style.display = 'none';
  }
  drag = null;
});
enableCardDnD('cards');
enableCardDnD('quotaCards');
enableCardDnD('billingCards');
enableCardDnD('projectCards'); // 项目卡可拖拽排序；排行卡整行贯通不带 data-key，不参与拖拽（保护行内文本选择）

// 模型 chips 折叠钮：事件委托绑定一次（卡片每 60s 重渲染，不逐个绑），展开态按卡写入 localStorage
document.addEventListener('click', e => {
  const btn = e.target.closest('.mm-toggle');
  if (!btn) return;
  const box = btn.closest('.billing-models');
  if (!box) return;
  const open = !box.classList.contains('open');
  box.classList.toggle('open', open);
  safeSet(mmOpenKeyOf(box.dataset.mm), open ? '1' : '0');
  foldModelChips();
});
// 窗口宽度变化 → 卡片变宽/变窄，防抖重算 chips 折叠断点
let mmFoldT = 0;
window.addEventListener('resize', () => { clearTimeout(mmFoldT); mmFoldT = setTimeout(foldModelChips, 120); });

// 入场动效只播一次：1s 后摘除标记，避免 60s 自动刷新时整页闪动
setTimeout(() => document.body.classList.remove('anim-once'), 1000);
