'use strict';
// DeepSeek Harness（dsh）会话采集：~/.dsh/sessions/<项目slug>/session-<uuid>/session.v4.jsonl.zstd。
// 数据源是 dsh 官方会话持久化（zstd 帧拼接的 JSONL，实测 @deepseek-ai/dsh-session-persistence-jsonl）：
//   首行 type:"session" 带 cwd（项目归因：工作区目录）；
//   每次模型请求完成落一行 type:"assistant/message"，data.usage =
//   { inputTokens(已剔除缓存读，disjoint 口径), outputTokens(含思考), cacheReadTokens?, reasoningTokens? }
//   + data.message.source.{provider,model} + 行级 seq/time（ms）。
// 计量口径与 codex-sessions 对齐：一条 assistant/message = 一次请求；inputTokens 已是净额，
// 缓存命中另列，聚合不会双计。子代理（delegationDepth>0）会话同样落盘——真实消耗，全部计入。
// 成本：dsh 走 DeepSeek API/账户直付，行无成本字段 → costUsd null 按单价表等价核算（pricing 已收录
// deepseek-v4 系），providerId=source.provider 进服务商/按量口径归因。
// 解码双路径：系统 zstd CLI 为多帧流主路径（Homebrew 绝对路径兜底，launchd 环境 PATH
// 不含 /opt/homebrew/bin 也能用）；Node ≥23.8 的 zlib.zstdDecompressSync 只在帧扫描判定
// 单帧时回退——多帧流它只解首帧且不报错，绝不用于多帧；两者皆无记 error（不抛，快照降级留痕）。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { historyCutoffMs } = require('../lib/store');

const ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const SESSION_FILE = 'session.v4.jsonl.zstd';
const MAX_DECOMP_BYTES = 256 * 1024 * 1024; // 单会话解压上限 256MB（超长会话文本可达数十 MB）

// —— 文件发现：sessions/<proj>/<session>/file 固定两层 + 防御递归深度 4 ——
function findSessionFiles(root, depth = 3, out = []) {
  if (depth < 0) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isFile() && e.name === SESSION_FILE) out.push(p);
    else if (e.isDirectory()) findSessionFiles(p, depth - 1, out);
  }
  return out;
}

// zstd 帧流解码（顺序即正确性优先级）：
// ① 系统 zstd CLI：多帧拼接流全量解码——dsh 会话是「每批追加一个 zstd 帧」的格式，这是主路径。
//    Homebrew zstd 装位置显式兜底（launchd/nohup 环境 PATH 可能不含 /opt/homebrew/bin）。
// ② Node zlib.zstdDecompressSync：实测对多帧流只解第一帧且**不报错**（静默截断丢数据）——
//    因此仅当帧扫描判定为单帧文件才允许走这条路；多帧且 CLI 不可用返回 null（如实 error，绝不半读）。
const ZSTD_PATHS = ['/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', '/usr/bin/zstd'];
function countFrames(buf) {
  let n = 0;
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) n++;
  }
  return n;
}
function decompress(file) {
  let cliErr = null;
  for (const bin of ['zstd', ...ZSTD_PATHS]) {
    try {
      return execFileSync(bin, ['-dc', '--quiet', file], { maxBuffer: MAX_DECOMP_BYTES + 4096 }).toString('utf8');
    } catch (e) { cliErr = e; } // 二进制不存在/解码失败都试下一个
  }
  try {
    const buf = fs.readFileSync(file);
    if (typeof zlib.zstdDecompressSync === 'function' && countFrames(buf) <= 1) {
      return zlib.zstdDecompressSync(buf, { maxOutputLength: MAX_DECOMP_BYTES }).toString('utf8');
    }
    // 多帧但无 CLI（Node<23.8 的 zlib 也只读首帧）：拒绝截断式读取
    return null;
  } catch { return null; }
}

// 单文件解析（纯逻辑拆 parseText 供测试直喂明文）
function parseText(text, file, afterMs) {
  const rows = [];
  let parseErrors = 0;
  let cwd = null;
  let ctxModel = 'unknown'; // request/context / assistant source 缺失时的兜底（跟随最近一次）
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { parseErrors++; continue; }
    if (!d || typeof d.type !== 'string') continue;
    // 注意：首行 type:"session" 是平铺 schema（cwd/id/createdAt 直接在顶层，无 data 包装）；
    // 其余事件行才有 data 包装（实测 @deepseek-ai/dsh-session-persistence-jsonl 持久化格式）
    if (d.type === 'session') {
      if (typeof d.cwd === 'string' && d.cwd) cwd = d.cwd;
      continue;
    }
    const data = d.data;
    if (d.type === 'request/context' && data && typeof data.model === 'string' && data.model) {
      ctxModel = data.model;
      continue;
    }
    if (d.type !== 'assistant/message' || !data || typeof data !== 'object') continue;
    const u = data.usage;
    if (!u || typeof u !== 'object') continue; // 无 usage 的 assistant 行（异常中断）不计量
    const ts = Number(d.time);
    if (!Number.isFinite(ts) || ts < afterMs) continue;
    const src = (data.message && data.message.source) || {};
    rows.push({
      tool: 'dsh',
      ts,
      providerId: typeof src.provider === 'string' && src.provider ? src.provider : 'deepseek',
      model: typeof src.model === 'string' && src.model ? src.model : ctxModel,
      // dsh mapUsage 为 disjoint 口径：inputTokens 已扣除缓存命中部分；outputTokens 含思考
      inputTokens: u.inputTokens || 0,
      outputTokens: u.outputTokens || 0,
      reasoningTokens: u.reasoningTokens || 0,
      cacheReadTokens: u.cacheReadTokens || 0,
      cacheCreationTokens: u.cacheWriteTokens || 0,
      costUsd: null,
      project: cwd,
      projectLabel: cwd ? path.basename(cwd) : null,
      dedupKey: file + '#' + d.seq, // 文件内 seq 唯一（撕裂尾行由 seq 去重兜底）
    });
  }
  return { rows, parseErrors };
}

// 进程内缓存（同 codex-sessions 策略）：文件未变（mtime+size 同）直接复用解析结果。
const statCache = new Map(); // file → 'mtime|size'
const rowCache = new Map();  // file → { rows, parseErrors }

function collect(root = ROOT, afterMs = historyCutoffMs()) {
  let files = [];
  try { fs.statSync(root); files = findSessionFiles(root); }
  catch { return { rows: [], error: null, source: root, filesScanned: 0 }; } // 未装 dsh：静默零数据
  const rows = [];
  let parseErrors = 0, filesScanned = 0, decodeFails = 0;
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    // 会话文件 mtime 早于下界：整个会话都不在窗口内，跳（会话可跨零点，宽 1 天）
    if (st.mtimeMs + 86400e3 < afterMs) continue;
    const stamp = st.mtimeMs + '|' + st.size;
    if (statCache.get(f) === stamp && rowCache.has(f)) {
      const cached = rowCache.get(f);
      filesScanned++;
      rows.push(...cached.rows);
      parseErrors += cached.parseErrors;
      continue;
    }
    const text = decompress(f);
    if (text == null) { decodeFails++; continue; } // 解码失败：本文件本轮不计，下轮自然重试
    const parsed = parseText(text, f, afterMs);
    statCache.set(f, stamp);
    rowCache.set(f, parsed);
    filesScanned++;
    rows.push(...parsed.rows);
    parseErrors += parsed.parseErrors;
  }
  const out = { rows, error: null, source: root, filesScanned };
  if (parseErrors) out.parseErrors = parseErrors;
  if (decodeFails) out.error = `${decodeFails} 个会话文件解码失败（dsh 会话为多帧 zstd 流，需系统 zstd：brew install zstd）`;
  return out;
}

module.exports = { collect, parseText, decompress, findSessionFiles, ROOT, SESSION_FILE };
