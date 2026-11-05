'use strict';
// JSONL 目录遍历公共助手：原实现逐字节内联在 collectors/claudecode.js 与
// collectors/workbuddy.js（两处相同），现抽到这里共用。

const fs = require('node:fs');
const path = require('node:path');

// 递归枚举 dir 下所有 .jsonl 文件（追加进 out）；目录不可读时静默返回。
// 与 claudecode.js / workbuddy.js 的原实现逐字节一致。
function listJsonls(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonls(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
}

// 带 stat 缓存的变体（供采集器做「未变文件跳过重读」）：
//   cache：Map<path, {mtimeMs, size}>，本函数原位更新（新/变文件刷成当前 stat，
//          目录里已消失的路径被剪除）。
// 返回 [{ path, mtimeMs, changed }]，按 readdir 顺序；changed=false 表示 stat 与上次
// 采集一致（jsonl 为行追加模型 → 行集未变，调用方可复用上次解析结果，不再整读整析）。
// statSync 失败的文件按「本轮不可见」处理（不返回，由调用方顺带清理对应解析缓存）。
function listJsonlsCached(dir, cache) {
  const files = [];
  listJsonls(dir, files);
  const seen = new Set();
  const out = [];
  for (const p of files) {
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    seen.add(p);
    const prev = cache.get(p);
    const changed = !prev || prev.mtimeMs !== st.mtimeMs || prev.size !== st.size;
    cache.set(p, { mtimeMs: st.mtimeMs, size: st.size });
    out.push({ path: p, mtimeMs: st.mtimeMs, changed });
  }
  for (const p of cache.keys()) if (!seen.has(p)) cache.delete(p);
  return out;
}

module.exports = { listJsonls, listJsonlsCached };
