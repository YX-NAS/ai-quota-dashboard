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
    // 只扫历史下界之后的行（started_at 单位毫秒）；文本类型的时间在 SQL 比较里恒为真，由下方 NaN 防护兜底。
    // LEFT JOIN session 取项目维度（project_id / directory）供「项目统计」聚合；
    // 旧版库没有 session 表时回退单表查询——行不带 project 字段，项目区自动隐藏，其余功能不受影响
    const cutoff = historyCutoffMs();
    let st;
    let prepErr = null; // 保存首个 prepare 异常：三级回退全败时给出根因（旧实现三级全败后 st 为 undefined，报 TypeError）
    try {
      st = db.prepare(`
        SELECT mu.started_at AS started_at, mu.provider_id AS provider_id, mu.model_id AS model_id,
               mu.input_tokens AS input_tokens, mu.output_tokens AS output_tokens,
               mu.reasoning_tokens AS reasoning_tokens,
               mu.cache_creation_input_tokens AS cache_creation_input_tokens,
               mu.cache_read_input_tokens AS cache_read_input_tokens,
               mu.status AS status, s.project_id AS zc_project, s.directory AS zc_dir
        FROM model_usage mu
        LEFT JOIN session s ON s.id = mu.session_id
        WHERE mu.started_at IS NOT NULL AND mu.started_at >= ?`);
    } catch (e) {
      prepErr = e;
      // 回退一：无 session 表 / session_id 列——单表查询仍带 provider_id（按量归因保留）
      try {
        st = db.prepare(`
          SELECT started_at, provider_id, model_id, input_tokens, output_tokens,
                 reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens,
                 status
          FROM model_usage
          WHERE started_at IS NOT NULL AND started_at >= ?`);
      } catch {
        // 回退二：连 provider_id 列都没有的更旧库——最小列集，只保用量采集不报错
        //（providerId/project 停用，按模型名归因，其余功能不受影响）
        try {
          st = db.prepare(`
            SELECT started_at, model_id, input_tokens, output_tokens,
                   reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens,
                   status
            FROM model_usage
            WHERE started_at IS NOT NULL AND started_at >= ?`);
        } catch {
          // 三级全败：库结构完全不认识（非 ZCode 库 / 损坏），返回首因而不是 TypeError
          return {
            rows: [],
            error: 'model_usage 查询失败: ' + (prepErr && prepErr.message ? prepErr.message : String(prepErr)),
            source: dbPath,
          };
        }
      }
    }
    const rows = [];
    for (const r of st.iterate(cutoff)) {
      if (r.status !== 'completed') continue; // error/cancelled/running 不计
      const ts = Number(r.started_at);
      if (!Number.isFinite(ts) || ts <= 0) continue; // 脏行（时间非法）直接跳过
      rows.push({
        tool: 'zcode',
        ts,
        providerId: r.provider_id || null, // 计费归因用：同一模型名可能走不同服务商账号（如百炼托管 GLM/Kimi）
        // 项目维度：session.project_id（目录派生串）为聚合键，directory basename 为展示名；
        // 会话被清理/旧库回退时为 null，行保留、只是不进项目统计
        project: r.zc_project || null,
        projectLabel: r.zc_project ? (r.zc_dir ? path.basename(r.zc_dir) : null) : null,
        model: r.model_id || 'unknown',
        inputTokens: r.input_tokens || 0,
        // 行级归一：outputTokens = 普通输出 + 思考（GLM 计费思考按输出价），
        // 与 claudeCode（Anthropic 语义 output_tokens 本就含思考）口径对齐；
        // 否则归档 daily_model（只有合并列）重估会按含思考的输出计价，与 raw 出现 ~2-3% 漂移
        outputTokens: (r.output_tokens || 0) + (r.reasoning_tokens || 0),
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
