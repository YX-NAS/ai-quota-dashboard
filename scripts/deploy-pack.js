#!/usr/bin/env node
'use strict';
// 云端部署包生成器（v1.7，零密钥上云的机械保证）：
//   node scripts/deploy-pack.js [输出目录=dist/cloud-pack]
//
// 产出（全部脱敏，可直接 scp/rsync 到云服务器）：
//   history.sqlite      归档快照（db.backup 单文件，含全部历史与网络/VPN 日表；WAL 已合并）
//   notifications.json  站内通知（内容只有金额/百分比/模型名，与推送泄露面同规）
//   vpn-state.json      VPN 累计基线（纯数字，供云端流量包卡回退渲染）
//   plans.json          脱敏配置：quotaKeys 整块移除（load() 自动补空模板）+ alerts.webhookUrl 清空
//                       （webhook 完整 URL 即推送密钥）；其余展示/计价配置原样保留
//   不会打包：auth.json（登录哈希单独放服务器）、config/.port、network-state.json、明文任何凭据
//
// 云端侧运行方式见 docs/DEPLOY.md（AI_QUOTA_HISTORY=readonly + AQD_HOSTS 域名 + auth 凭据）。
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const plansStore = require('../server/lib/plans');

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

  const files = fs.readdirSync(OUT);
  console.log('云端包就绪 →', OUT);
  console.log('  文件:', files.join(', ') || '(空)');
  if (removed.length) console.log('  已移除机密字段:', removed.join(', '));
  console.log('  确认输出目录中不含:', 'auth.json / quotaKeys / webhookUrl 明文 / vpnPanel.url');
  console.log('\n下一步（云服务器）：见 docs/DEPLOY.md —— 上述文件放服务器侧 AI_QUOTA_CONFIG_DIR，');
  console.log('服务以 AI_QUOTA_HISTORY=readonly 运行，登录凭据在服务器单独生成（不进 git、不从本机拷）。');
}
main().catch(e => { console.error('打包失败:', e.message); process.exit(1); });
