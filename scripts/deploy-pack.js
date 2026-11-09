#!/usr/bin/env node
'use strict';
// 云端部署包生成器（v1.7，零密钥上云的机械保证）：
//   node scripts/deploy-pack.js [输出目录=dist/cloud-pack]
//
// 产出（全部脱敏，可直接 scp/rsync 到云服务器）：
//   history.sqlite       归档快照（VACUUM INTO 一致性单文件，含全部历史与网络/VPN 日表）
//   notifications.json   站内通知（内容只有金额/百分比/模型名，与推送泄露面同规）
//   vpn-state.json       VPN 累计基线（纯数字，供云端流量包卡回退渲染）
//   quota-snapshot.json  实时额度展示快照（本机服务现值，剥 raw 后无 PII 无密钥；
//                        云端展示端回退渲染 ChatGPT/MiniMax 额度卡，服务未运行则跳过）
//   plans.json           脱敏配置：quotaKeys 整块移除（load() 自动补空模板）+ alerts.webhookUrl 清空
//                        （webhook 完整 URL 即推送密钥）；其余展示/计价配置原样保留
//   不会打包：auth.json（登录哈希单独放服务器）、config/.port、network-state.json、明文任何凭据
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const plansStore = require('../server/lib/plans');
const { getJson } = require('../server/lib/http-json');

// quota-snapshot.json 的字段提取：实时额度采集结果同步给云端展示端回退渲染。
// 白名单剥 raw（含 user_id/邮箱等 PII，前端不使用），fetchedAt 保留主端原采集时刻。
// 纯函数（导出供测试）：summary 为 GET /api/summary 返回体；不可用的源整键省略。
function extractQuotaSnapshot(summary, now = Date.now()) {
  const out = { generatedAt: now };
  for (const key of ['chatgptQuota', 'minimaxQuota', 'zhipuQuota']) {
    const q = summary && summary[key];
    if (q && q.available) {
      const clone = Object.assign({}, q);
      delete clone.raw; // PII 剥离：user_id/email 等原始响应字段不上云
      out[key] = clone;
    }
  }
  // network 只带 current（网络名+速率展示字段；today/month/series 云端从同步归档读，无需快照）
  const cur = summary && summary.network && summary.network.current;
  if (cur && cur.label) out.network = { current: cur };
  return out;
}

// 取本机运行中服务的 summary（端口发现契约同菜单栏：config/.port 优先，回退 7788）；
// 服务没跑 / 超时 → null（pack 不含额度快照，云端保持现状，不报错）
async function fetchLocalSummary(timeoutMs = 15_000) {
  let port = Number(process.env.PORT || 7788);
  try { port = Number(fs.readFileSync(path.join(plansStore.CONFIG_DIR, '.port'), 'utf8').trim()) || port; } catch { /* 用默认 */ }
  const r = await getJson(`http://127.0.0.1:${port}/api/summary?days=2`, { timeoutMs });
  return r.ok ? r.data : null;
}

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'cloud-pack'));

// quotaKeys 里可能存在的机密字段（防御式：整块删除最彻底，这里只记录删了什么给用户确认）
function sanitizePlans(plans) {
  const next = JSON.parse(JSON.stringify(plans || {}));
  const removed = [];
  if (next.quotaKeys && Object.keys(next.quotaKeys).length) {
    for (const [tool, obj] of Object.entries(next.quotaKeys)) {
      for (const [f, v] of Object.entries(obj || {})) {
        if (typeof v === 'string' && v) removed.push(`quotaKeys.${tool}.${f}`);
        if (f === 'extraKeys' && Array.isArray(v) && v.length) removed.push(`quotaKeys.${tool}.extraKeys×${v.length}`);
      }
    }
  }
  delete next.quotaKeys; // 云端采集器自动发现无源可寻（无本地凭证目录），空模板即可
  if (next.alerts && next.alerts.webhookUrl) { removed.push('alerts.webhookUrl'); next.alerts.webhookUrl = ''; }
  return { next, removed };
}

async function main() {
  const cfgDir = plansStore.CONFIG_DIR;
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // ① 归档库：VACUUM INTO 产出合并 WAL 的一致性单文件快照（只读执行、不写源库，
  //    Node 22/26 通吃——node:sqlite 的 db.backup 在部分版本不存在，不再依赖）
  const srcDb = path.join(cfgDir, 'history.sqlite');
  if (fs.existsSync(srcDb)) {
    const db = new DatabaseSync(srcDb, { readOnly: true });
    try {
      db.exec(`VACUUM INTO '${path.join(OUT, 'history.sqlite').replace(/'/g, "''")}'`);
    } finally { db.close(); }
  }

  // ② 脱敏 plans
  const { next, removed } = sanitizePlans(plansStore.load());
  fs.writeFileSync(path.join(OUT, 'plans.json'), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });

  // ③ 无密钥的运行时数据（存在才拷）
  for (const f of ['notifications.json', 'vpn-state.json']) {
    const src = path.join(cfgDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, f));
  }

  // ④ 实时额度展示快照（本机服务在跑才有；取不到静默跳过，云端沿用旧文件或保持隐藏）
  try {
    const sum = await fetchLocalSummary();
    if (sum) {
      const qs = extractQuotaSnapshot(sum);
      fs.writeFileSync(path.join(OUT, 'quota-snapshot.json'), JSON.stringify(qs, null, 2) + '\n');
    }
  } catch { /* 服务未运行：不阻塞打包 */ }

  // ⑤ 同步标记：syncedAt = 本轮打包时刻。云端陈旧判定唯一依据——只有「pack 成功 + rsync 送达」
  // 才刷新它（rsync 失败时云端留旧值），所以断网/断供期间云端能诚实显示「已陈旧 X 小时」，
  // 而不是被主端"我以为我在同步"的自我声明骗过。阈值与展示端 snapshot.js STALE_AFTER_HOURS 一致
  fs.writeFileSync(path.join(OUT, 'sync-marker.json'), JSON.stringify({ syncedAt: Date.now() }, null, 2) + '\n');

  const files = fs.readdirSync(OUT);
  console.log('云端包就绪 →', OUT);
  console.log('  文件:', files.join(', ') || '(空)');
  if (removed.length) console.log('  已移除机密字段:', removed.join(', '));
  console.log('  确认输出目录中不含:', 'auth.json / quotaKeys / webhookUrl 明文 / vpnPanel.url / quota raw');
  console.log('\n下一步（云服务器）：见 docs/DEPLOY.md —— 上述文件放服务器侧 AI_QUOTA_CONFIG_DIR，');
  console.log('服务以 AI_QUOTA_HISTORY=readonly 运行，登录凭据在服务器单独生成（不进 git、不从本机拷）。');
}

if (require.main === module) main().catch(e => { console.error('打包失败:', e.message); process.exit(1); });
module.exports = { extractQuotaSnapshot, sanitizePlans };
