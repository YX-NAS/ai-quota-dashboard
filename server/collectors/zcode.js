'use strict';
// ZCode 采集：~/.zcode/cli/db/db.sqlite → model_usage（只读直连，只计 completed）
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');

const DB = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

function collect() {
  let db;
  try {
    db = new DatabaseSync(DB, { readOnly: true });
  } catch (e) {
    return { rows: [], error: 'db open failed: ' + e.message, source: DB };
  }
  try {
    const st = db.prepare(`
      SELECT started_at, model_id, input_tokens, output_tokens,
             reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens,
             status
      FROM model_usage
      WHERE started_at IS NOT NULL`);
    const rows = [];
    for (const r of st.iterate()) {
      if (r.status !== 'completed') continue; // error/cancelled/running 不计
      rows.push({
        tool: 'zcode',
        ts: Number(r.started_at),
        model: r.model_id || 'unknown',
        inputTokens: r.input_tokens || 0,
        outputTokens: r.output_tokens || 0,
        reasoningTokens: r.reasoning_tokens || 0,
        cacheReadTokens: r.cache_read_input_tokens || 0,
        cacheCreationTokens: r.cache_creation_input_tokens || 0,
        costUsd: null,
        dedupKey: null,
      });
    }
    return { rows, error: null, source: DB };
  } catch (e) {
    return { rows: [], error: e.message, source: DB };
  } finally {
    try { db.close(); } catch {}
  }
}

module.exports = { collect };
