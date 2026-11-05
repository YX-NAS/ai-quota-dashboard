# ☁️ 云端部署指南（v1.7）

把本机运行的 AI 额度看板以**登录保护**的方式发布到云服务器/家庭服务器域名下。
核心原则一句话：**采集永远发生在数据所在的电脑上；云服务器只是加了门禁的显示器，拿不到任何密钥。**

---

## 0. 前提与架构

```
┌─────────────────────────┐   每 N 分钟 rsync 脱敏包    ┌──────────────────────────┐
│ 你的 Mac / NAS（数据源） │ ──────────────────────────▶ │ 云服务器（展示端，只读）   │
│  node server/index.js   │   history.sqlite(backup)    │  AI_QUOTA_HISTORY=readonly │
│  持有全部 API Key/Token  │   plans.json(去密钥)        │  零密钥                    │
│  scripts/cloud-sync.sh  │   vpn-state.json(数字基线)  │  登录鉴权(auth.json 哈希)  │
└─────────────────────────┘                             └────────────┬─────────────┘
                                                          HTTPS 反代 │ proxy_set_header Host $host
                                                              域名   ▼
                                                         https://quota.5176nas.site
```

- **版本要求**：两端 Node ≥ 22.13；服务器 git clone 本仓库 release tag（v1.7.0+）。
- **零密钥出境（机械保证，非口头承诺）**：`scripts/deploy-pack.js` 打包时整块删除 `quotaKeys`、清空
  `alerts.webhookUrl`，永不含 auth.json；即使配置失误也推不出密钥。服务器侧凭据用
  `hash-password.js` 在**服务器上**生成（scrypt 哈希，明文不落任何文件/仓库）。

## 1. 服务器初始化（一次性）

```bash
# 1.1 拉代码（用 release tag，不用 main）
git clone https://github.com/YX-NAS/ai-quota-dashboard.git /srv/ai-quota
cd /srv/ai-quota && git checkout v1.7.0

# 1.2 生成登录凭据（交互式输入密码，不回显；写入 config/auth.json 0600）
node scripts/hash-password.js wanye --save

# 1.3 systemd 服务（只读归档 + 域名白名单 + TLS cookie Secure）
sudo tee /etc/systemd/system/ai-quota.service <<'EOF'
[Unit]
Description=AI Quota Dashboard (read-only display)
After=network.target

[Service]
User=quotauser
WorkingDirectory=/srv/ai-quota
Environment=AI_QUOTA_CONFIG_DIR=/srv/ai-quota-config
Environment=AI_QUOTA_HISTORY=readonly
Environment=AQD_HOSTS=quota.5176nas.site
Environment=AQD_COOKIE_SECURE=1
Environment=PORT=7788
ExecStart=/usr/bin/env node server/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/ai-quota-config

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now ai-quota
```

## 2. HTTPS 反代（二选一）

### Caddy（推荐，自动证书）

```
quota.5176nas.site {
    reverse_proxy 127.0.0.1:7788
}
```

Caddy 默认转发原始 Host，满足鉴权前提。

### nginx

```
server {
    listen 443 ssl http2;
    server_name quota.5176nas.site;
    ssl_certificate ...; ssl_certificate_key ...;
    location / {
        proxy_pass http://127.0.0.1:7788;
        proxy_set_header Host $host;            # ← 必须！Node 用它区分「本机豁免/域名登录」
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

> ⚠️ 若反代不改写 Host（Node 看到的是 `127.0.0.1:port`），请求会命中「本机豁免」跳过登录。
> 部署核对表第 3 条专门验证这一点。要求更严时设 `AQD_TRUST_PROXY=0`：本机豁免一并关闭，
> 服务器本机上运维 curl 也要带登录 cookie。

## 3. 数据同步（本机侧，cron）

```bash
# 手动跑通一次
./scripts/cloud-sync.sh quotauser@your.server:/srv/ai-quota-config

# 进 crontab（每 10 分钟；首次会推 plans.json，之后只覆盖归档/状态文件不碰服务器配置）
*/10 * * * * cd /path/to/ai-quota-dashboard && ./scripts/cloud-sync.sh quotauser@your.server:/srv/ai-quota-config >> /tmp/aqd-sync.log 2>&1
```

- 归档用 SQLite `backup` API 导出**合并 WAL 的单文件**再 rsync——服务器 readOnly 打开不存在撕裂问题。
- `plans.json` 只在服务器还没有时首次推送（尊重服务器侧独立改动），日常只同步数据。
- 云端功能面：用量/费用/趋势/模型排行/网络流量历史/VPN 流量包卡（archived 标记，数据截至上次同步）
  全部可用；ChatGPT/MiniMax 实时额度、API 余额卡因云端无密钥自动隐藏，属预期。

## 4. 安全核对表（上线前逐条打勾）

1. [ ] `curl -sI http://127.0.0.1:7788/api/summary -H 'Host: quota.5176nas.site'` → **401/302**（域名未登录被拒）
2. [ ] 浏览器无痕模式开 `https://quota.5176nas.site` → 跳登录页；登录后能取数
3. [ ] `curl -s 'https://quota.5176nas.site/api/health' -o /dev/null -w '%{http_code}'` → 200；
      而 `/api/summary` 不带 cookie → 401（证明反代 Host 转发生效、没走本机豁免）
4. [ ] 服务器 `grep -l 'quotaKeys' /srv/ai-quota-config/plans.json` → 无输出（零密钥）
5. [ ] `ls -l /srv/ai-quota-config/auth.json` → `-rw-------` 且属主为服务用户
6. [ ] 连续 11 次错误密码登录 → 第 11 次返回 429（限流生效）
7. [ ] GitHub 仓库不含：plans.json / auth.json / *.sqlite / 任何真实 key（本仓库已在 CI 外定期扫描；
      自己 fork 后建议 `git log --all -S'你的某个key' ` 自查）
8. [ ] TLS 已启用（AQD_COOKIE_SECURE=1 只在 https 下有效；http 裸奔公网 = 会话可被嗅探，禁止）

## 5. 升级与回滚

```bash
# 服务器升级（展示端无状态，秒级）
cd /srv/ai-quota && git fetch --tags && git checkout v1.7.x && sudo systemctl restart ai-quota
# 会话为内存表：重启 = 全员重新登录（预期行为）
```

## 6. FAQ

- **云服务器能直接跑采集吗？** 不能也不该：工具原始数据（~/.zcode、~/.claude 等）在各自电脑上，
  云端跑了也是空数据 + 无密钥降级。同步归档是正确形态。
- **想两个电脑的数据合并上云？** 各跑各的 cloud-sync 会互相覆盖归档。用不同
  `AI_QUOTA_CONFIG_DIR` 起两份服务、两个子域名，或自行合并 sqlite（daily 表 PK 为 date+tool，天然去重）。
- **忘了密码？** 服务器上重跑 `node scripts/hash-password.js 用户名 --save` 覆盖 auth.json，
  重启服务（清会话）即重置。密码不存明文，无法找回只能重置。
- **登录页样式不对？** login.html 自包含，跟随 `aqd:theme` 与系统偏好；无外部依赖可缓存问题。
