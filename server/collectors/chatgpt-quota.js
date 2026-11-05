'use strict';
// ChatGPT 实时额度：~/.codex/auth.json 的 OAuth token → wham/usage
// token 来源：config/plans.json 的 quotaKeys.chatgpt.accessToken（设置面板配置，优先；手动 token 过期需手动更新），
//             否则读 auth.json（codex CLI 会自动刷新，一般留空即可）
// 尽力而为：任何失败都静默降级，返回 { available: false, reason }
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getJson } = require('../lib/http-json');
const plansStore = require('../lib/plans');

const AUTH = path.join(os.homedir(), '.codex', 'auth.json');

// HTTP 实现移到 server/lib/http-json.js 的 getJson（[P1] 体超限先 resolve 再 destroy 修悬挂；
// 非 200 reason 带脱敏后的响应体片段）。对外契约不变：{ ok, data?, reason? }。
function fetchUsage(accessToken, accountId) {
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'User-Agent': 'ai-quota-dashboard/1.0',
  };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId; // accountId 为空时不发空串头
  return getJson('https://chatgpt.com/backend-api/wham/usage', { headers, timeoutMs: 8000 });
}

async function collect() {
  let manualToken = null;
  try { manualToken = String(((plansStore.load().quotaKeys || {}).chatgpt || {}).accessToken || '').trim() || null; } catch { /* 忽略 */ }

  let accessToken = manualToken;
  let accountId = null;
  let source = 'plans.json quotaKeys.chatgpt';
  if (!accessToken) {
    let auth;
    try { auth = JSON.parse(fs.readFileSync(AUTH, 'utf8')); }
    catch (e) {
      // 新机器没有 ~/.codex/auth.json 属「未配置」而非故障：结构化标记让前端隐藏该卡而非显示英文报错
      const notConfigured = e.code === 'ENOENT';
      return { available: false, notConfigured, reason: notConfigured ? '未找到 ChatGPT 登录（~/.codex/auth.json，设置面板可手动配置）' : 'auth.json unreadable: ' + e.message, source: AUTH };
    }
    const tokens = auth.tokens || auth;
    accessToken = tokens.access_token;
    accountId = tokens.account_id || auth.account_id;
    source = AUTH;
  }
  if (!accessToken) return { available: false, reason: 'no access_token', source: AUTH };

  const r = await fetchUsage(accessToken, accountId);
  if (!r.ok) return { available: false, reason: r.reason, source };

  const rl = (r.data && r.data.rate_limit) || {};
  const pw = rl.primary_window || {};    // 5h 窗口
  const sw = rl.secondary_window || {};  // 周窗口
  return {
    available: true,
    provider: 'ChatGPT ' + ((r.data && r.data.plan_type) || 'plus').toUpperCase(),
    fiveHour: {
      usedPercent: pw.used_percent ?? null,
      remainingPercent: pw.used_percent != null ? 100 - pw.used_percent : null,
      resetAt: pw.reset_at, resetMsLeft: pw.reset_after_seconds ? pw.reset_after_seconds * 1000 : null,
    },
    weekly: {
      usedPercent: sw.used_percent ?? null,
      remainingPercent: sw.used_percent != null ? 100 - sw.used_percent : null,
      resetAt: sw.reset_at, resetMsLeft: sw.reset_after_seconds ? sw.reset_after_seconds * 1000 : null,
    },
    limitReached: !!rl.limit_reached,
    raw: r.data,
    fetchedAt: Date.now(),
    source: 'chatgpt.com/backend-api/wham/usage',
  };
}

module.exports = { collect };
