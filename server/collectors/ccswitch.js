'use strict';
// cc-switch 采集：~/.cc-switch/cc-switch.db → proxy_request_logs
// app_type 拆分：codex → tool=codex；claude-desktop → tool=claudeDesktop
// created_at 是「秒」级时间戳
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');

const DB = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const TOOL_MAP = { codex: 'codex', 'claude-desktop': 'claudeDesktop' };

function collect() {
  let db;
  try {
    db = new DatabaseSync(DB, { readOnly: true });
  } catch (e) {
    return { rows: [], error: 'db open failed: ' + e.message, source: DB };
  }
  try {
    const st = db.prepare(`
      SELECT app_type, model, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens,
             total_cost_usd, created_at
      FROM proxy_request_logs
      WHERE created_at IS NOT NULL`);
    const rows = [];
    for (const r of st.iterate()) {
      const tool = TOOL_MAP[r.app_type];
      if (!tool) continue; // 未知 app_type 不丢数据也不误归——跳过并留待日志
      rows.push({
        tool,
        ts: Number(r.created_at) * 1000,
        model: r.model || 'unknown',
        inputTokens: r.input_tokens || 0,
        outputTokens: r.output_tokens || 0,
        reasoningTokens: 0,
        cacheReadTokens: r.cache_read_tokens || 0,
        cacheCreationTokens: r.cache_creation_tokens || 0,
        costUsd: r.total_cost_usd != null ? Number(r.total_cost_usd) : null,
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
