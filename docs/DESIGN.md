# AI 工具额度看板 · 设计文档

> 版本 v1.0 · 2026-09 · 项目名：ai-quota-dashboard

## 1. 目标

一个本地网页应用，完整展示本机所有 AI 工具的使用额度：**每日每个工具的额度、已用额度、成本费用、预估费用**。

- 启动方式：`node server/index.js`（零 npm 依赖，Node 22 自带全部能力）
- 浏览器打开 `http://localhost:7788`，页面每 60 秒自动刷新
- 所有数据源**只读**，绝不写入任何工具的原始数据库

## 2. 数据源（已逐一验证）

| 工具 | 来源 | 字段 | 说明 |
|---|---|---|---|
| ZCode | `~/.zcode/cli/db/db.sqlite` → `model_usage` 表 | input/output/reasoning/cache_creation/cache_read tokens、provider_id、model_id、started_at(ms)、**status（只计 completed）** | Node 22 `node:sqlite` `readOnly:true` 直连，不做 checkpoint、不写 -wal。**套餐：智谱 Coding Plan（团队版）** |
| ChatGPT / Codex | `~/.cc-switch/cc-switch.db` → `proxy_request_logs` | input/output/cache_read/cache_creation tokens、model、**app_type（codex / claude-desktop 两种，必须拆开）**、total_cost_usd、created_at(s) | 时间戳为**秒**，`date(created_at,'unixepoch','+8 hours')` 转北京时间。**不用 usage_daily_rollups**（与明细对不上，语义混杂，双算风险）。**套餐：ChatGPT 订阅** |
| Claude Code | `~/.claude/projects/**/*.jsonl` → `message.usage` | input/output/cache_creation/cache_read tokens、model（cc-switch 路由）、timestamp(ISO) | `<synthetic>` 消息不计；按 (file, msg.id, model) 去重。**成本 = 等价按量成本** |
| WorkBuddy | `~/.workbuddy-ai/projects/**/*.jsonl` 行内 `providerData.usage` | inputTokens/outputTokens/cached_tokens（或 rawUsage.prompt_cache_hit_tokens）、model、timestamp(ms) | 同一消息可能多行，按 `(file, messageId, model)` 去重。**套餐：订阅制（自定义模型）** |
| ChatGPT 实时额度 | `~/.codex/auth.json` 的 OAuth access_token → `chatgpt.com/backend-api/wham/usage` | 套餐 rate-limit 窗口（5h/周/月） | 尽力而为：失败不阻塞，卡片显示「实时额度不可用」 |
| 智谱 Coding Plan 实时额度（团队版） | `open.bigmodel.cn/api/monitor/usage/quota/limit?type=2` + `bigmodel-organization`/`bigmodel-project` 头 | limits[]：unit3+number5 = 5h 窗口，unit6 = 周窗口（TOKENS/CREDIT_LIMIT，含 percentage 与 nextResetTime）；org/project 经 `/api/biz/customer/getCustomerInfo` 枚举 projectType=2 项目后试取 | 凭证按序：**plans.json `quotaKeys.zhipu`（设置面板手动配置，优先）** → ZCode OAuth（`~/.zcode/v2/credentials.json`，enc:v1 AES-256-GCM 本机可解）→ WorkBuddy GLM key → ZCode config key；org/project 手动配置优先，其次落盘缓存 `config/.zhipu-team-context.json`，OAuth 失效时凭 key+缓存继续查询 |
| MiniMax 实时额度 | `www.minimaxi.com/v1/api/openplatform/coding_plan/remains` | model_remains[]（general 通道的 5h/周剩余） | key 按序：plans.json `quotaKeys.minimax` → `~/.workbuddy-ai/models.json` 自动发现 |

口径说明：
- ZCode（bigmodel coding plan）与 WorkBuddy 自定义模型（GLM Coding Plan / MiniMax Token Plan）为**订阅套餐**，不按 token 扣费 → 展示「等价按量成本」+ 用户可配置的套餐额度。
- Codex 走 cc-switch 代理的请求自带 `total_cost_usd`（OpenAI 官方价或配置单价），直接采信。

## 3. 目录结构

```
ai-quota-dashboard/
├── server/
│   ├── index.js            # HTTP 服务 + 路由 + 定时刷新（跨平台）
│   ├── lib/
│   │   ├── store.js        # 聚合存储：requests[]、日/月汇总、缓存
│   │   ├── pricing.js      # 单价表 + 成本计算
│   │   └── plans.js        # 用户额度配置读写 (config/plans.json)
│   └── collectors/
│       ├── zcode.js        # ~/.zcode SQLite 只读采集
│       ├── ccswitch.js     # ~/.cc-switch/cc-switch.db 采集
│       ├── claudecode.js   # ~/.claude jsonl 采集
│       ├── workbuddy.js    # ~/.workbuddy-ai jsonl 采集
│       ├── chatgpt-quota.js# ChatGPT 实时额度（尽力而为）
│       ├── minimax-quota.js# MiniMax 实时额度
│       └── zhipu-quota.js  # 智谱 Coding Plan 实时额度（团队版）
├── web/
│   ├── index.html          # 单页看板
│   └── app.js + style.css
├── mcp/mcp.js              # MCP Server（兼 CLI）
├── menubar/                # macOS 菜单栏 menubar.swift + Windows 托盘 tray.ps1
├── desktop/                # macOS 桌面组件 desktop-widget.swift + Windows 卡片 widget.ps1
├── scripts/                # token 同步、演示数据生成、Windows 启停逻辑
├── start-all / stop-all    # 一键启停（.sh = macOS/Linux，.cmd+.ps1 = Windows）
├── config/plans.json       # 用户配置的套餐额度（首次运行生成模板）
├── docs/DESIGN.md
└── test/                   # 测试脚本 + fixtures
```

> 平台说明：数据源路径全部经 `os.homedir()` 解析（Windows 上即 `%USERPROFILE%\.zcode` 等，各家 CLI 跨平台行为一致），ZCode 凭证解密密钥按 `os.platform()` 动态派生，服务端无平台分支。平台差异只在外壳：macOS 用 Swift（菜单栏/桌面卡片），Windows 用系统自带 PowerShell + WinForms（托盘/卡片），均为零依赖单文件。

## 4. 数据模型（内部统一格式）

每条请求归一为：

```js
{ tool, ts(ms), model, inputTokens, outputTokens,
  cacheReadTokens, cacheCreationTokens, reasoningTokens,
  costUsd|null, dedupKey }
```

聚合层输出：
- `daily[tool][date]` → requests / tokens / costUsd
- `monthly[tool][YYYY-MM]` → 同上
- `today` 快照、`7d/30d` 趋势
- 额度 = plans.json 配置 + ChatGPT 实时（若可用）

## 5. 计价

- 内置单价表（元/百万 token，2026-09 采集）：glm-5.3 / glm-5.2 = 8/28，glm-5.3-flash = 0.8/2.8（缓存 0.23），MiniMax-M3 = 4.2/16.8（缓存 0.845），MiniMax-M2.7 = 2.1/8.4，GLM-5.3-Flash（ZCode 同价 flash）
- Codex：直接用库里的 `total_cost_usd`，不做二次估算
- 未收录模型：只计 token，不计费，页面标注「无单价」
- 展示货币：元；Codex 的 USD 乘汇率（默认 7.2，plans.json 可配）

## 6. 额度定义（不造数据）

- ChatGPT/Codex：实时额度优先；无实时数据时不显示进度条，只显示实测用量
- ZCode bigmodel / WorkBuddy 套餐：plans.json 里用户填「每日/每月额度（等价元）」，用等价成本对照
- 没有 配置额度 且 无实时 API 的工具 → 额度栏显示「未配置」

## 7. API

| 路由 | 说明 |
|---|---|
| `GET /` | 看板页面 |
| `GET /api/summary?days=30` | 全量聚合 JSON |
| `GET /api/refresh` | 强制重扫 |
| `GET /api/plans` / `POST /api/plans` | 读取/保存额度配置（含 `quotaKeys`：三家实时额度的手动 key；GET 对机密字段脱敏，POST 按「空串清除 / 脱敏回显保留 / 其余为新值」合并，逻辑在 `server/lib/plans.js` 的 `applyQuotaKeysUpdate`） |
| `GET /web/*` | 静态文件 |

## 8. 页面设计（暗色主题，跟随系统）

1. 顶部：总览 KPI（今日请求 / 今日 token / 今日成本 / 本月成本）
2. 工具卡片区（ChatGPT·Codex / Claude Desktop / ZCode / WorkBuddy）：今日与本月用量、成本、额度进度条、**本月预估（按已过天数线性外推）**、数据新鲜度
3. 每日明细表：日期 × 工具 → 请求/token/费用，支持最近 7/30 天切换
4. 趋势图：30 天堆叠柱状（纯 SVG，无外部依赖）
5. 设置抽屉：编辑各工具套餐额度、汇率、单价覆盖

## 9. 风险与对策

- **SQLite 锁**：Node 22 内置 `node:sqlite`，`new DatabaseSync(path, {readOnly: true})` 直连原始库（只读连接不 checkpoint、不写 -wal，已实测可打开两个 WAL 库）；连接用完即关，失败重试一次
- **codex auth.json 权限 600**：读文件仅在用户本机进程内，不外传；API 失败静默降级
- **jsonl 增量**：记录文件 (path, size, mtime)，变化才重扫；100MB 以内全量扫 < 3s
- **时区**：一切日期切分按北京时间（GMT+8）计算
- **端口冲突**：7788 被占则自动 +1 并在终端打印实际地址
- **口径标注（审核 P1-6/7）**：Codex 金额保留 USD 原值并列示「按汇率 X 折算为 ¥Y」；ZCode/WorkBuddy 卡片显著标注「订阅制 · 等价按量成本，非实际扣费」
