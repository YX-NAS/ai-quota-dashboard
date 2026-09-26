'use strict';
// WorkBuddy 采集：~/.workbuddy-ai/projects/**/*.jsonl → providerData.usage
// 去重键：(file, messageId, model)——一条消息可能落多行
// 只统计当前版 App（~/.workbuddy-ai），旧版 ~/.workbuddy 不混入
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { historyCutoffMs } = require('../lib/store');

const ROOT = path.join(os.homedir(), '.workbuddy-ai', 'projects');

function listJsonls(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonls(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
}

// cached_tokens 可能在对象或数组里（OpenAI 兼容格式差异）；数组元素缺字段时按 0 计，不清零整个和
function cachedFromDetails(details) {
  if (Array.isArray(details)) return details.reduce((s, x) => s + ((x && x.cached_tokens) || 0), 0);
  return (details && details.cached_tokens) || 0;
}

function collect(root = ROOT) {
  const files = [];
  listJsonls(root, files);
  if (!files.length) return { rows: [], error: null, source: root };

  // 行追加模型下安全：mtime 早于下界的文件不可能有新行，整个文件跳过
  const cutoff = historyCutoffMs();
  const seen = new Set();
  const rows = [];
  let parseErrors = 0;

  for (const f of files) {
    try {
      if (fs.statSync(f).mtimeMs < cutoff) continue;
    } catch { continue; }
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line || line.length < 20 || !line.includes('"usage"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { parseErrors++; continue; }
      const pd = d.providerData;
      if (!pd || !pd.usage) continue;
      const u = pd.usage;
      const model = pd.model || 'unknown';
      const mid = pd.messageId || (d.id || '');
      const dk = path.basename(f) + '|' + mid + '|' + model;
      if (seen.has(dk)) continue;
      const ts = Number(d.timestamp);
      if (!Number.isFinite(ts) || ts <= 0) continue;   // 时间非法的脏行跳过
      if (!Number.isFinite(Number(u.inputTokens)) || !Number.isFinite(Number(u.outputTokens))) continue;
      seen.add(dk);

      const raw = pd.rawUsage || {};
      const cacheHit = raw.prompt_cache_hit_tokens != null
        ? raw.prompt_cache_hit_tokens
        : cachedFromDetails(u.inputTokensDetails);

      rows.push({
        tool: 'workbuddy',
        ts,
        model: model.replace(/^custom-local:/, ''),
        inputTokens: u.inputTokens || 0,
        outputTokens: u.outputTokens || 0,
        reasoningTokens: 0,
        cacheReadTokens: cacheHit || 0,
        cacheCreationTokens: 0,
        costUsd: null,
        dedupKey: dk,
      });
    }
  }
  return { rows, error: parseErrors ? `${parseErrors} parse errors` : null, source: root };
}

module.exports = { collect, cachedFromDetails };
