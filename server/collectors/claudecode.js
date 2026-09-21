'use strict';
// Claude Code 采集：~/.claude/projects/**/*.jsonl → message.usage
// 路由模型来自 cc-switch（智谱/MiniMax/DeepSeek 等套餐），按模型单价算等价成本
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(os.homedir(), '.claude', 'projects');

function listJsonls(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonls(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
}

function collect() {
  const files = [];
  listJsonls(ROOT, files);
  if (!files.length) return { rows: [], error: null, source: ROOT };

  const seen = new Set();
  const rows = [];
  let parseErrors = 0;

  for (const f of files) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line || line.length < 20 || !line.includes('"usage"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { parseErrors++; continue; }
      const msg = d.message;
      const u = msg && msg.usage;
      if (!u || !msg.model) continue;
      const model = msg.model === '<synthetic>' ? null : msg.model;
      if (!model) continue; // 合成消息不计
      // 去重：assistant message id 同会话内唯一
      const mid = msg.id || '';
      const dk = path.basename(f) + '|' + mid + '|' + model;
      if (seen.has(dk)) continue;
      seen.add(dk);

      const ts = d.timestamp ? Date.parse(d.timestamp) : null;
      if (!ts) continue;

      rows.push({
        tool: 'claudeCode',
        ts,
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
  }
  return { rows, error: parseErrors ? `${parseErrors} parse errors` : null, source: ROOT };
}

module.exports = { collect };
