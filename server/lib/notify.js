'use strict';
// 站内通知中心（price-auto / alerts 共用的消息流）：落 config/notifications.json。
// 设计约束：体量小（上限 CAP 条，FIFO 淘汰最旧）、非机密（只有模型名/金额/文案，无密钥）；
// add/markRead/clear 绝不抛错（通知失败不影响主流程）；mtime 缓存与 plans.load 同策略，
// 外部改动（手工编辑/换机同步）自动失效。
const fs = require('node:fs');
const path = require('node:path');
const { CONFIG_DIR } = require('./plans'); // 复用同一配置目录（含 AI_QUOTA_CONFIG_DIR 测试重定向）

const FILE = path.join(CONFIG_DIR, 'notifications.json');
const CAP = 50;

let cache = null;
let cacheMtimeMs = 0;

function load() {
  let st = null;
  try { st = fs.statSync(FILE); } catch { return []; }
  if (cache && st && st.mtimeMs === cacheMtimeMs) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = Array.isArray(j) ? j.filter(x => x && typeof x === 'object') : [];
    cacheMtimeMs = st.mtimeMs;
  } catch {
    cache = []; // 损坏视同空：通知流不是关键数据，不值得备份恢复流程
    cacheMtimeMs = st ? st.mtimeMs : 0;
  }
  return cache;
}

function save(items) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // 原子写：同目录临时文件 + rename，避免半截 JSON
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, FILE);
  cache = items;
  try { cacheMtimeMs = fs.statSync(FILE).mtimeMs; } catch { cacheMtimeMs = 0; }
}

// add({ type, title, body, meta })：追加一条未读通知，返回新增条目；失败返回 null
function add(ev) {
  try {
    const title = String((ev && ev.title) || '').trim().slice(0, 120);
    if (!title) return null;
    const items = load();
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      ts: Date.now(),
      type: String((ev && ev.type) || 'info'),
      title,
      body: String((ev && ev.body) || '').slice(0, 2000),
      meta: (ev && ev.meta && typeof ev.meta === 'object' && !Array.isArray(ev.meta)) ? ev.meta : null,
      read: false,
    };
    items.unshift(item); // 新的在前
    if (items.length > CAP) items.length = CAP;
    save(items);
    return item;
  } catch { return null; }
}

// list()：{ items, unread }（items 全量，前端自己渲染已读态）
function list() {
  const items = load();
  return { items, unread: items.filter(x => !x.read).length };
}

// markRead(id?)：id 空 = 全部已读。返回受影响条数。
function markRead(id) {
  try {
    const items = load();
    let n = 0;
    for (const it of items) {
      if (it.read) continue;
      if (id == null || it.id === id) { it.read = true; n++; }
    }
    if (n) save(items);
    return n;
  } catch { return 0; }
}

function clear() {
  try { save([]); return true; } catch { return false; }
}

module.exports = { add, list, markRead, clear, FILE, CAP };
