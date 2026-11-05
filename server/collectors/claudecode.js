'use strict';
// Claude Code 采集：~/.claude/projects/**/*.jsonl → message.usage
// 路由模型来自 cc-switch（智谱/MiniMax/DeepSeek 等套餐），按模型单价算等价成本
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsutil = require('../lib/fsutil');
const { historyCutoffMs } = require('../lib/store');

const ROOT = path.join(os.homedir(), '.claude', 'projects');

// 进程内缓存（模块级；快照每 60s 重建一次）：
//   statCache：path → { mtimeMs, size }，由 fsutil.listJsonlsCached 原位维护，判断文件自上次采集后是否变化
//   rowCache：path → { rows, parseErrors }，未变文件直接复用上次解析结果，不再整读整析（33MB/次 IO 降为只读活跃会话文件）
// jsonl 为行追加模型：文件未变 ⇒ 行集不变，复用不丢数据；聚合（aggregate）每轮由 index.js
// 基于本轮 collect 的全量行重算，与全量重读等价。目录中消失的文件由 fsutil 剪出 statCache、
// 这里顺带剪出 rowCache，不产生陈旧行。行级去重（dedupKey）在并入阶段统一做（按文件
// 处理序先到先得，与原逐行去重同口径），缓存里保留文件自身全部行，跨文件碰撞不因缓存失真。
const statCache = new Map();
const rowCache = new Map();

function collect(root = ROOT) {
  const entries = fsutil.listJsonlsCached(root, statCache);
  if (!entries.length) return { rows: [], error: null, source: root };

  // 行追加模型下安全：mtime 早于下界的文件不可能有新行，整个文件跳过
  const cutoff = historyCutoffMs();
  const seen = new Set();
  const rows = [];
  let parseErrors = 0;

  for (const { path: f, mtimeMs, changed } of entries) {
    if (mtimeMs < cutoff) { rowCache.delete(f); continue; }
    let fileRows, fileParseErrors;
    if (!changed) {
      // 未变文件：整文件行集复用缓存（含该文件的 parseErrors，error 汇报口径不变）
      const cached = rowCache.get(f);
      if (!cached) continue;
      fileRows = cached.rows;
      fileParseErrors = cached.parseErrors;
    } else {
      let content;
      try { content = fs.readFileSync(f, 'utf8'); } catch { rowCache.delete(f); continue; }
      fileRows = [];
      fileParseErrors = 0;
      for (const line of content.split('\n')) {
        if (!line || line.length < 20 || !line.includes('"usage"')) continue;
        let d;
        try { d = JSON.parse(line); } catch { fileParseErrors++; continue; }
        const msg = d.message;
        const u = msg && msg.usage;
        if (!u || !msg.model) continue;
        const model = msg.model === '<synthetic>' ? null : msg.model;
        if (!model) continue; // 合成消息不计
        const mid = msg.id || '';
        const dk = path.basename(f) + '|' + mid + '|' + model; // assistant message id 同会话内唯一
        const ts = d.timestamp ? Date.parse(d.timestamp) : null;
        if (!ts) continue;

        // 项目维度近似：jsonl 行自带会话 cwd，目录 basename 作项目展示名（无 cwd 的旧行不带项目）
        const cwd = typeof d.cwd === 'string' ? d.cwd : '';
        fileRows.push({
          tool: 'claudeCode',
          ts,
          project: cwd || null,
          projectLabel: cwd ? path.basename(cwd) : null,
          model,
          inputTokens: u.input_tokens || 0,
          outputTokens: u.output_tokens || 0,
          reasoningTokens: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
          cacheReadTokens: u.cache_read_input_tokens || 0,
          cacheCreationTokens: u.cache_creation_input_tokens || 0,
          costUsd: null,
          dedupKey: dk,
        });
      }
      rowCache.set(f, { rows: fileRows, parseErrors: fileParseErrors });
    }
    for (const r of fileRows) {
      if (seen.has(r.dedupKey)) continue; // 去重：同会话 message id 只计一次（按文件序先到先得）
      seen.add(r.dedupKey);
      rows.push(r);
    }
    parseErrors += fileParseErrors;
  }
  return { rows, error: parseErrors ? `${parseErrors} parse errors` : null, source: root };
}

module.exports = { collect };
