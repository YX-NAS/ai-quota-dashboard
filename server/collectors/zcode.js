'use strict';
// ZCode 采集：~/.zcode/cli/db/db.sqlite → model_usage（只读直连，只计 completed）
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');
const { historyCutoffMs } = require('../lib/store');

const DB = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

function collect(dbPath = DB) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return { rows: [], error: 'db open failed: ' + e.message, source: dbPath };
  }
  try {
    // 只扫历史下界之后的行（started_at 单位毫秒）；文本类型的时间在 SQL 比较里恒为真，由下方 NaN 防护兜底
    const cutoff = historyCutoffMs();
    const st = db.prepare(`
      SELECT started_at, model_id, input_tokens, output_tokens,
             reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens,
             status
      FROM model_usage
      WHERE started_at IS NOT NULL AND started_at >= ?`);
    const rows = [];
    for (const r of st.iterate(cutoff)) {
      if (r.status !== 'completed') continue; // error/cancelled/running 不计
      const ts = Number(r.started_at);
      if (!Number.isFinite(ts) || ts <= 0) continue; // 脏行（时间非法）直接跳过
      rows.push({
        tool: 'zcode',
        ts,
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
    return { rows, error: null, source: dbPath };
  } catch (e) {
    return { rows: [], error: e.message, source: dbPath };
  } finally {
    try { db.close(); } catch {}
  }
}

module.exports = { collect };
