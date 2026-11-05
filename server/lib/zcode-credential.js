'use strict';
// ZCode 凭证解密：enc:v1:iv.tag.ciphertext（AES-256-GCM，与 ZCode 客户端同源）。
// 原实现逐字节内联在 collectors/api-billing.js 与 collectors/zhipu-quota.js（两处相同），
// 现抽到这里共用；secret 派生顺序：ZCODE_CREDENTIAL_SECRET 环境变量 → 本机指纹回退串。

const crypto = require('node:crypto');
const os = require('node:os');

function decryptZcodeValue(v) {
  if (typeof v !== 'string' || !v.startsWith('enc:v1:')) return v;
  try {
    const [iv, tag, ct] = v.slice(7).split('.');
    const secret = process.env.ZCODE_CREDENTIAL_SECRET
      || `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`;
    const key = crypto.createHash('sha256').update(secret).digest();
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { decryptZcodeValue };
