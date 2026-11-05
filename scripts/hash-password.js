#!/usr/bin/env node
'use strict';
// 登录凭据生成器（v1.7）：把明文密码转成 scrypt 哈希，写入 config/auth.json（0600）。
// auth.json 已被 gitignore —— 哈希不进 git、明文不落任何文件。云端部署只拷哈希（见 docs/DEPLOY.md）。
//
// 用法：
//   node scripts/hash-password.js <用户名> [密码] [--save]
//   密码省略时从 stdin 读入（避免进入 shell history）；--save 直接写 config/auth.json
// 输出：
//   不 --save 时打印 passHash 与可直接使用的 env 导出行（AQD_AUTH_USER / AQD_AUTH_PASS_HASH）
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword, AUTH_FILE } = require('../server/lib/auth');

async function readStdinLine() {
  return new Promise(resolve => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { buf += c; if (buf.includes('\n')) resolve(buf.split('\n')[0].replace(/\r$/, '')); });
    process.stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
  });
}

(async () => {
  const args = process.argv.slice(2);
  const save = args.includes('--save');
  const pos = args.filter(a => a !== '--save');
  const user = pos[0];
  if (!user) {
    console.error('用法: node scripts/hash-password.js <用户名> [密码] [--save]');
    console.error('  密码省略时从 stdin 读取（推荐，避免进入 shell 历史）');
    process.exit(1);
  }
  let pass = pos[1];
  if (pass == null) {
    const { spawnSync } = require('node:child_process');
    const ttyEcho = process.stdin.isTTY;
    if (ttyEcho) {
      process.stderr.write('密码（不回显）: ');
      spawnSync('stty', ['-echo']); // 关终端回显（macOS/Linux），读一行后恢复
    }
    pass = await readStdinLine();
    if (ttyEcho) { spawnSync('stty', ['echo']); process.stderr.write('\n'); }
  }
  if (!pass) { console.error('密码为空'); process.exit(1); }
  const passHash = hashPassword(pass);
  console.log('user     =', user);
  console.log('passHash =', passHash);
  if (save) {
    const dir = path.dirname(AUTH_FILE());
    fs.mkdirSync(dir, { recursive: true });
    const tmp = AUTH_FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ user, passHash, updated: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, AUTH_FILE());
    console.log('✓ 已写入', AUTH_FILE(), '(0600，gitignored)');
  } else {
    console.log('\n服务端 env 用法：');
    console.log('  export AQD_AUTH_USER=' + JSON.stringify(user));
    console.log('  export AQD_AUTH_PASS_HASH=' + JSON.stringify(passHash));
  }
})();
