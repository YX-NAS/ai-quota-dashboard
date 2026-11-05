'use strict';
// Codex 会话采集：~/.codex/sessions/**/*.jsonl（Codex CLI 官方 rollout 文件）。
// 背景：2026-10-15 起 cc-switch 不再记录 Codex 请求（cc-switch.db 停更），用量直接落在
// ~/.codex/sessions；本采集器接续该时段。与 cc-switch 的新旧切换在 snapshot.js 做
// （以 cc-switch 末条时间为切换点过滤，避免重叠期双计）。
// 行级口径：event_msg/token_count 的 info.last_token_usage = 本次调用增量（实测 fork/续写
// 文件不重放父会话事件，跨文件无重复）；模型取最近一次 turn_context.model（每轮一个）；
// 项目取 turn_context.cwd（与 claudeCode 同策略：cwd 近似归因，basename 展示）。
// 会话文件无成本字段：GPT 系走订阅（rate_limits.plan_type=plus），等价成本由单价表核算——
// 缺单价即 noPrice（只计 token 不计钱），价格源补齐 GPT 单价后自动重估。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsutil = require('../lib/fsutil');
const { historyCutoffMs } = require('../lib/store');

const ROOT = path.join(os.homedir(), '.codex', 'sessions');

// 进程内缓存（模块级；快照每 60s 重建一次）：与 claudecode.js 同策略。
//   statCache：path → { mtimeMs, size }，fsutil.listJsonlsCached 原位维护；
//   rowCache：path → { rows, parseErrors }，未变文件直接复用解析结果（rollout 文件 2~5MB，
//   全量重读每分钟数十 MB IO；行追加模型 ⇒ 未变 ⇒ 行集不变，复用不丢数据）。
const statCache = new Map();
const rowCache = new Map();

// 文件名携带会话起始日期（rollout-YYYY-MM-DDT…）：起始日早于下界 1 天以上的文件整文件跳过
//（会话可跨零点，宽松 1 天）；文件名不规范的不跳（逐行时间戳兜底）
const ROLLOUT_DATE_RE = /^rollout-(\d{4}-\d{2}-\d{2})T/;

function parseFile(p, afterMs) {
  const rows = [];
  let parseErrors = 0;
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return { rows, parseErrors }; }
  let model = 'unknown';
  let cwd = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { parseErrors++; continue; }
    const payload = d.payload;
    if (!payload || typeof payload !== 'object') continue;
    // 模型/工作目录跟随：turn_context 每轮自带 model+cwd；session_meta 等带同名字段时一并跟随
    if (typeof payload.model === 'string' && payload.model) model = payload.model;
    if (typeof payload.cwd === 'string' && payload.cwd) cwd = payload.cwd;
    if (payload.type !== 'token_count') continue;
    const u = payload.info && payload.info.last_token_usage;
    if (!u || typeof u !== 'object') continue;
    const ts = Date.parse(d.timestamp || '');
    if (!Number.isFinite(ts) || ts < afterMs) continue; // 时间非法/历史下界外：跳过
    rows.push({
      tool: 'codex',
      ts,
      model,
      inputTokens: u.input_tokens || 0,
      // 行级归一：outputTokens = 普通输出 + 思考（OpenAI 语义 output_tokens 不含 reasoning，
      // 与 zcode/claudeCode 的「合并列」口径对齐，避免归档重估漂移）
      outputTokens: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0),
      reasoningTokens: u.reasoning_output_tokens || 0,
      cacheReadTokens: u.cached_input_tokens || 0,
      cacheCreationTokens: u.cache_write_input_tokens || 0,
      costUsd: null,
      project: cwd || null,
      projectLabel: cwd ? path.basename(cwd) : null,
      dedupKey: null,
    });
  }
  return { rows, parseErrors };
}

function collect(root = ROOT, afterMs = historyCutoffMs()) {
  const files = fsutil.listJsonlsCached(root, statCache);
  const rows = [];
  let parseErrors = 0;
  let filesScanned = 0;
  // 文件名起始日 < 下界前 1 天 → 整文件跳过（不进缓存也不解析）
  const dayMs = 86400e3;
  for (const f of files) {
    const m = ROLLOUT_DATE_RE.exec(path.basename(f.path));
    if (m && Date.parse(m[1] + 'T00:00:00Z') + dayMs < afterMs) continue;
    let parsed;
    if (!f.changed && rowCache.has(f.path)) {
      parsed = rowCache.get(f.path); // 未变文件复用上次解析
    } else {
      parsed = parseFile(f.path, afterMs);
      rowCache.set(f.path, parsed);
    }
    filesScanned++;
    rows.push(...parsed.rows);
    parseErrors += parsed.parseErrors;
  }
  const out = { rows, error: null, source: root, filesScanned };
  if (parseErrors) out.parseErrors = parseErrors; // 坏行计数留痕（不丢数据不报错）
  return out;
}

module.exports = { collect, ROOT };
