'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');

// Antigravity 客户端共享此目录。仅读汇总计数，不读取会话正文或生成元数据。
function collect(root = ROOT) {
  let files;
  try {
    files = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { usage: null, error: null };
    return { usage: null, error: '无法读取 Antigravity 会话目录' };
  }

  const usage = { conversations: 0, generations: 0 };
  let failed = 0;
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.db')) continue;
    try {
      const db = new DatabaseSync(path.join(root, file.name), { readOnly: true });
      try {
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM gen_metadata').get();
        usage.conversations++;
        usage.generations += count;
      } finally {
        db.close();
      }
    } catch {
      failed++;
    }
  }
  return {
    usage: failed && !usage.conversations ? null : usage,
    error: failed ? `${failed} 个 Antigravity 会话库无法读取，统计可能不完整` : null,
  };
}

module.exports = { collect };
