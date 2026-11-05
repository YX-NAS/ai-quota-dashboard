'use strict';
// WorkBuddy 采集：~/.workbuddy-ai/projects/**/*.jsonl → providerData.usage
// 去重键：(file, messageId, model)——一条消息可能落多行
// 只统计当前版 App（~/.workbuddy-ai），旧版 ~/.workbuddy 不混入
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsutil = require('../lib/fsutil');
const { historyCutoffMs } = require('../lib/store');

const ROOT = path.join(os.homedir(), '.workbuddy-ai', 'projects');

// 进程内缓存（模块级；快照每 60s 重建一次），口径与 claudecode.js 一致：
//   statCache：path → { mtimeMs, size }，由 fsutil.listJsonlsCached 原位维护，判断文件自上次采集后是否变化
//   rowCache：path → { rows, parseErrors }，未变文件直接复用上次解析结果，不再整读整析（33MB/次 IO 降为只读活跃会话文件）
// jsonl 为行追加模型：文件未变 ⇒ 行集不变，复用不丢数据；聚合（aggregate）每轮由 index.js
// 基于本轮 collect 的全量行重算，与全量重读等价。目录中消失的文件由 fsutil 剪出 statCache、
// 这里顺带剪出 rowCache，不产生陈旧行。行级去重（dedupKey）在并入阶段统一做（按文件
// 处理序先到先得，与原逐行去重同口径），缓存里保留文件自身全部行，跨文件碰撞不因缓存失真。
const statCache = new Map();
const rowCache = new Map();

// cached_tokens 可能在对象或数组里（OpenAI 兼容格式差异）；数组元素缺字段时按 0 计，不清零整个和
function cachedFromDetails(details) {
  if (Array.isArray(details)) return details.reduce((s, x) => s + ((x && x.cached_tokens) || 0), 0);
  return (details && details.cached_tokens) || 0;
}

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
        const pd = d.providerData;
        if (!pd || !pd.usage) continue;
        const u = pd.usage;
        const model = pd.model || 'unknown';
        const mid = pd.messageId || (d.id || '');
        const ts = Number(d.timestamp);
        if (!Number.isFinite(ts) || ts <= 0) continue;   // 时间非法的脏行跳过
        // 校验与取值同一口径（Number）：数字字符串也接受为数值，堵住字符串原样入行、下游拼接
        if (!Number.isFinite(Number(u.inputTokens)) || !Number.isFinite(Number(u.outputTokens))) continue;
        const raw = pd.rawUsage || {};
        const cacheHit = raw.prompt_cache_hit_tokens != null
          ? raw.prompt_cache_hit_tokens
          : cachedFromDetails(u.inputTokensDetails);

        fileRows.push({
          tool: 'workbuddy',
          ts,
          model: model.replace(/^custom-local:/, ''),
          inputTokens: Number(u.inputTokens) || 0,
          outputTokens: Number(u.outputTokens) || 0,
          reasoningTokens: 0,
          cacheReadTokens: cacheHit || 0,
          cacheCreationTokens: 0,
          costUsd: null,
          dedupKey: path.basename(f) + '|' + mid + '|' + model,
        });
      }
      rowCache.set(f, { rows: fileRows, parseErrors: fileParseErrors });
    }
    for (const r of fileRows) {
      if (seen.has(r.dedupKey)) continue; // 去重：同消息可能落多行，只计一次（按文件序先到先得）
      seen.add(r.dedupKey);
      rows.push(r);
    }
    parseErrors += fileParseErrors;
  }
  return { rows, error: parseErrors ? `${parseErrors} parse errors` : null, source: root };
}

module.exports = { collect, cachedFromDetails };
