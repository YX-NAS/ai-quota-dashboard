# AI 工具额度看板 · 设计文档

> 版本 v1.8.0 · 2026-11 · 项目名：ai-quota-dashboard（v1.5 基线 + §10.3–10.7 增量）

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
| Codex 官方会话 | `~/.codex/sessions/**/*.jsonl`（rollout） | `event_msg/token_count` 的 `info.last_token_usage`（本次调用增量）、`turn_context.model/cwd`、timestamp | 2026-10-15 起 cc-switch 停记 Codex，snapshot 以 cc-switch 末条时间为切换点接续，避免重叠期双计；无成本字段，GPT 订阅按单价表等价核算 |
| Claude Code | `~/.claude/projects/**/*.jsonl` → `message.usage` | input/output/cache_creation/cache_read tokens、model（cc-switch 路由）、timestamp(ISO) | `<synthetic>` 消息不计；按 (file, msg.id, model) 去重。**成本 = 等价按量成本** |
| WorkBuddy | `~/.workbuddy-ai/projects/**/*.jsonl` 行内 `providerData.usage` | inputTokens/outputTokens/cached_tokens（或 rawUsage.prompt_cache_hit_tokens）、model、timestamp(ms) | 同一消息可能多行，按 `(file, messageId, model)` 去重。**套餐：订阅制（自定义模型）** |
| DeepSeek Harness | `~/.dsh/sessions/<项目>/session-<uuid>/session.v4.jsonl.zstd`（多帧 zstd JSONL） | `assistant/message` 的 `usage`（inputTokens 已剔缓存读的 disjoint 口径 / outputTokens 含思考 / cacheRead / reasoning）、`message.source.{provider,model}`、会话头 `cwd` | 系统 zstd CLI 全量解码多帧（Homebrew 绝对路径兜底）；Node zlib 仅在单帧时回退——多帧只解首帧且不报错，禁止使用。无成本字段按单价表等价核算，`providerId` 进服务商/按量统计，子代理会话全计入 |
| ChatGPT 实时额度 | `~/.codex/auth.json` 的 OAuth access_token → `chatgpt.com/backend-api/wham/usage` | 套餐 rate-limit 窗口（5h/周/月） | 尽力而为：失败不阻塞，卡片显示「实时额度不可用」 |
| 智谱 Coding Plan 实时额度（团队版） | `open.bigmodel.cn/api/monitor/usage/quota/limit?type=2` + `bigmodel-organization`/`bigmodel-project` 头 | limits[]：unit3+number5 = 5h 窗口，unit6 = 周窗口（TOKENS/CREDIT_LIMIT，含 percentage 与 nextResetTime）；org/project 经 `/api/biz/customer/getCustomerInfo` 枚举 projectType=2 项目后试取 | 凭证按序：**plans.json `quotaKeys.zhipu`（设置面板手动配置，优先）** → ZCode OAuth（`~/.zcode/v2/credentials.json`，enc:v1 AES-256-GCM 本机可解）→ WorkBuddy GLM key → ZCode config key；org/project 手动配置优先，其次落盘缓存 `config/.zhipu-team-context.json`，OAuth 失效时凭 key+缓存继续查询 |
| MiniMax 实时额度 | `www.minimaxi.com/v1/api/openplatform/coding_plan/remains` | model_remains[]（general 通道的 5h/周剩余） | key 按序：plans.json `quotaKeys.minimax` → `~/.workbuddy-ai/models.json` 自动发现 |
| 智谱 API 按量计费余额 | `open.bigmodel.cn/api/biz/customer/getCustomerInfo`（`server/collectors/api-billing.js`） | `balance / availableBalance / rechargeAmount / giveAmount`（新账户未充值 = null → UI 显示「未充值」） | 凭证链：ZCode 自定义供应商 key → plans.json → ZCode OAuth → WorkBuddy/config key；2026-10-30 起用户停用团队套餐，ZCode 走个人按量账户；响应 60s 进程内缓存 |
| DeepSeek API 按量计费余额 | `api.deepseek.com/user/balance` | `balance_infos[]`（CNY 行的 total/granted/topped_up） | key 按序：ZCode 自定义供应商（provider_config.json）→ plans.json `quotaKeys.deepseek`（设置面板可配，脱敏存储）→ `~/.cc-switch/cc-switch.db` 的 DeepSeek 行自动发现 |
| Kimi API 按量计费余额 | `api.moonshot.cn/v1/users/me/balance` | `data.available_balance / cash_balance / voucher_balance` | key 按序：ZCode 自定义供应商（moonshot-kimi）→ plans.json `quotaKeys.moonshot` → cc-switch 'Kimi' 行 → WorkBuddy |
| ZCode 自定义服务商发现 + Key 健康检测 | `~/.zcode/v2/provider_config.json`（`server/lib/zcode-providers.js`，mtime 缓存随快照重读）→ 逐 provider 探活 `GET {base}/models`（anthropic-messages 型 base+`/v1/models` 走 x-api-key） | providerId/label/vendor/billingKind(按量·订阅)/models/keyMasked + keyChecks{ok,reason,checkedAt} | 「API 按量计费」区块的服务商卡片以此列表为准（增删服务商 ≤60s 自动跟上）；`sk-cp-` 前缀或 coding/start-plan 特征 = 订阅不查金额余额；探活不耗额度，只读 |
| 阿里云百炼账户余额 | BSS OpenAPI `business.aliyuncs.com/?Action=GetAccountBalance`（RPC HMAC-SHA1 签名，`server/collectors/api-billing.js`） | `Data.AvailableAmount/BalanceAmount/CreditAmount/Currency` | DashScope **无**按量余额接口（实测端点全 404）；需阿里云 AccessKey（plans.json `quotaKeys.bailian`，Secret 脱敏存储），未配置时卡片只显示用量费用 |
| 按服务商用量/费用 | 本机六采集器 rows × `vendorForRow`（`server/lib/store.js` `vendorAggregate`） | 各服务商今日/本月 requests、tokens、costCny | **归因以行的 `provider_id` 为准**（ZCode 采集器随行携带），订阅制 provider（`account:*`/coding-plan/start-plan）返回 null 不进按量桶；无 provider 的行回退模型名规则（`vendorOf`：glm→zhipu、MiniMax→minimax、deepseek、kimi/moonshot、qwen/qwq/tongyi→bailian、claude、gpt/codex）。百炼托管三方模型因此归 bailian。纯计算恒有（快照 `vendors` 字段），独立于 agg/历史归档；cc-switch 行真实 costUsd 直接采信，其余按单价表等价计费 |

口径说明：
- ZCode（bigmodel coding plan）与 WorkBuddy 自定义模型（GLM Coding Plan / MiniMax Token Plan）为**订阅套餐**，不按 token 扣费 → 展示「等价按量成本」+ 用户可配置的套餐额度。**2026-10-30 起智谱团队套餐已停用，转为 API 按量计费**（智谱个人账户 + DeepSeek 等，见「API 按量计费」区块）。
- Codex 走 cc-switch 代理的请求自带 `total_cost_usd`（OpenAI 官方价或配置单价），直接采信。

## 3. 目录结构

```
ai-quota-dashboard/
├── server/
│   ├── index.js            # HTTP 服务 + 路由 + 定时刷新（跨平台）
│   ├── lib/
│   │   ├── store.js        # 聚合存储：requests[]、日/月汇总、按服务商聚合、缓存
│   │   ├── pricing.js      # 单价表 + 成本计算 + 服务商归因（vendorOf / vendorForRow）
│   │   ├── plans.js        # 用户额度配置读写 (config/plans.json)
│   │   ├── price-source.js # 在线单价源拉取（parse/diff/merge + 安全 fetch）
│   │   ├── zcode-providers.js # ZCode 自定义模型服务商发现（provider_config.json 动态读）
│   │   ├── history.js      # 历史归档库 history.sqlite（写入 + 补缺合并 + daily_network 网络流量）
│   │   ├── alerts.js       # 额度预警引擎（评估 / 冷却 / webhook 推送 / 通道适配器）
│   │   ├── push.js         # 定时推送调度（每日摘要 / 周月报，复用 alerts 通道）
│   │   └── report.js       # 周报 / 月报生成（纯函数 → Markdown，表格版 + 列表版）
│   └── collectors/
│       ├── zcode.js        # ~/.zcode SQLite 只读采集（行带 provider_id 供计费归因）
│       ├── ccswitch.js     # ~/.cc-switch/cc-switch.db 采集
│       ├── codex-sessions.js # ~/.codex/sessions jsonl 采集（v1.7 接续 cc-switch 停更）
│       ├── claudecode.js   # ~/.claude jsonl 采集
│       ├── workbuddy.js    # ~/.workbuddy-ai jsonl 采集
│       ├── deepseek-harness.js # ~/.dsh 多帧 zstd 会话采集（v1.7.4）
│       ├── chatgpt-quota.js# ChatGPT 实时额度（尽力而为）
│       ├── minimax-quota.js# MiniMax 实时额度
│       ├── zhipu-quota.js  # 智谱 Coding Plan 实时额度（团队版，2026-10-30 起套餐停用）
│       ├── api-billing.js  # API 按量计费：各家余额（智谱/DeepSeek/Kimi/阿里云BSS）+ 逐服务商 Key 探活
│       ├── network-traffic.js # 网络流量采集（macOS 专属）：netstat -ib 差分 + SSID/端口名归因
│       └── vpn-quota.js    # VPN 订阅头流量包额度（v1.7）
├── web/
│   ├── index.html          # 单页看板
│   ├── login.html          # 云端登录页（自包含）
│   ├── js/                 # main / state / render-cards / tables / network / settings …
│   └── style.css
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

- 内置单价表（元/百万 token，2026-10-23 官方定价页采集）：GLM-5.3 / 5.2 = 8/28（缓存命中 2），GLM-5.3-Flash = 0.8/2.8（缓存 0.23），GLM-5.3-FlashX = 2/7（0.57）；MiniMax-M3 = 2.1/8.4（官方永久 5 折，缓存 0.42），M3.1-Flash = 1/4（0.1），M2.7 = 2.1/8.4；DeepSeek 分时计价取空闲/高峰均值：v4-pro = 6.75/20.25（0.23）、v4-flash = 1.5/6（0.03）；阿里云百炼（2026-10 北京地域最小档，缓存命中按输入价保守计）：qwen3.8-flash = 0.8/2.7，qwen3.7-plus = 2/8，qwen3.7-max = 12/36
- **在线更新单价**：设置面板「在线更新单价」区从价格源 JSON 拉最新价（默认 `config/prices.source.json` 的 jsDelivr 镜像），先预览差异再应用；应用 = 写入 `priceOverrides` + 立即重算历史。拉取仅 http/https、拒重定向、10s 超时、256KB 上限（`server/lib/price-source.js`，API `POST /api/prices/update {url, apply}`）
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
| `GET /api/report?type=week\|month&offset=N` | 周报/月报（title + markdown + data；offset 上限 week 520 / month 120，非法值钳回本期） |
| `GET /api/refresh` | 强制重扫 |
| `GET /api/plans` / `POST /api/plans` | 读取/保存额度配置（含 `quotaKeys`：三家实时额度的手动 key；GET 对机密字段脱敏，POST 按「空串清除 / 脱敏回显保留 / 其余为新值」合并，逻辑在 `server/lib/plans.js` 的 `applyQuotaKeysUpdate`） |
| `POST /api/prices/update` | 在线单价更新：`{url, apply}`；apply=false 拉取+校验+差异预览（不落盘），apply=true 合并进 priceOverrides 并立即重算 |
| `GET /web/*` | 静态文件 |

## 8. 页面设计（暗色/日间双主题，跟随系统；靛蓝主色渗透中性色，明快亲和）

0. 今日速览（`#todaySummary`，v1.8）：目标横幅下的一行结论——昨日同期涨跌 / 全天预计（超目标标黄）/ 今日主要花钱工具及占比 / 额度最紧的窗口 / 近 7 天日均 1.8 倍异常提示；任一维度无数据则整条不显示
1. 顶部：总览 KPI（今日请求 / 今日 token / 今日成本 / 本月成本）
2. 工具卡片区（ChatGPT·Codex / Claude Desktop / Claude Code / ZCode / WorkBuddy / DeepSeek Harness）：今日与本月用量、成本、额度进度条、**本月预估（日历天 + 当日进度外推，见 §10.7）**、数据新鲜度
3. 每日明细表：日期 × 工具 → 请求/token/费用，支持最近 7/30 天切换
4. 趋势图：30 天堆叠柱状（纯 SVG，无外部依赖）
5. 数据健康（`#healthSec`，v1.8）：可折叠表格，逐源行数/耗时/成败/错误、归档合并天数、远程额度与计费源、云同步新鲜度；有错自动展开
6. 设置抽屉：编辑各工具套餐额度、汇率、单价覆盖

窄屏（≤640px）：工具卡单列、KPI 两列（hero 跨列）、顶栏隐藏数据源长串、速览与健康紧凑化；报告 Markdown 容器 `overflow-x:auto` 自滚动（否则宽表把整页撑出横向滚动条）

## 9. 风险与对策

- **SQLite 锁**：Node 22 内置 `node:sqlite`，`new DatabaseSync(path, {readOnly: true})` 直连原始库（只读连接不 checkpoint、不写 -wal，已实测可打开两个 WAL 库）；连接用完即关，失败重试一次
- **codex auth.json 权限 600**：读文件仅在用户本机进程内，不外传；API 失败静默降级
- **jsonl 增量**：记录文件 (path, size, mtime)，变化才重扫；100MB 以内全量扫 < 3s
- **时区**：一切日期切分按北京时间（GMT+8）计算
- **端口冲突**：7788 被占则自动 +1 并在终端打印实际地址
- **口径标注（审核 P1-6/7）**：Codex 金额保留 USD 原值并列示「按汇率 X 折算为 ¥Y」；ZCode/WorkBuddy 卡片显著标注「订阅制 · 等价按量成本，非实际扣费」

## 10. v1.5 持久化与预警（含后续 v1.7 增量）

### 10.1 历史归档库（`config/history.sqlite`）

动机：各工具原始日志滚动清理，raw 扫描窗口（`AI_QUOTA_MAX_DAYS`）外的历史永久丢失；每次构建把每日聚合沉淀进本地 SQLite，构建快照时对窗口外日期补缺。约束：只写归档库，绝不碰工具原始库；打开/读写任何失败都降级为纯内存路径（`collectorErrors.history` 记录，不影响看板）。`AI_QUOTA_HISTORY=0` 完全关闭；`AI_QUOTA_CONFIG_DIR` 可把配置目录指到别处（网盘/同步盘上的 WAL 可能被云同步撕裂，建议指本地盘）。

表结构（schema_version 落 `meta`）：

| 表 | 主键 | 列 |
|---|---|---|
| `daily` | (date, tool) | requests、input/output/reasoning/cache_read/cache_creation tokens、cost_usd、cost_cny、equivalent_cny、sub_usd、pay_usd、sub_requests、pay_requests、updated_at |
| `daily_model` | (date, tool, model) | requests、4 类 token、cost_usd、cost_cny、equivalent_cny、updated_at |
| `alert_log` | rule_key | last_fired_at、status（预警冷却记录） |
| `meta` | key | value |

写入路径：journal_mode WAL 优先（设置后回读校验），失败降级 DELETE，再失败不开库；脏行指纹缓存（(date,tool[/model]) → 内容 hash）命中跳过 UPSERT，指纹在事务 COMMIT 成功后才并入（ROLLBACK 不更新，宁可重写不可漏写）。

合并口径（`mergeArchived`，纯函数）：

1. **raw 优先**：同 (date, tool) raw 存在则原样保留，归档行只补缺（补缺工具行、整纯归档日两种粒度）；
2. **归档按当前单价重估**：补缺行以当前 pricer 从 `daily_model` token 重估等价成本（归档存的是写入时点价，直接混编会污染趋势与环比）；实扣 `cost_usd` / `sub_usd` / `pay_usd` **不重估**；
3. **total 重算**：有补缺的日 `__total` 由合并后的 per-tool 行重算；
4. **models 全历史桶补缺**：`daily_model` 按 tool+model 聚合（SQL `GROUP BY` 下推）补入 raw 缺失的模型行。

**monthly / total 维度维持 raw-only**（无消费方），不在合并范围。

### 10.2 额度预警引擎（`server/lib/alerts.js`）

- **评估**：纯函数，输入快照 + plans.alerts；三家 provider（智谱/ChatGPT/MiniMax）× {5h, 周窗口} + 当日目标，最多 7 条 firing 事件；`available` 且 usedPercent ≥ 阈值才触发
- **冷却 key**：以窗口身份（resetAt 绝对时刻）为主；resetAt 缺失时 `fetchedAt + resetMsLeft` 兜底并按 **5 分钟桶量化**（否则倒计时每轮漂移、key 每轮不同，冷却永不命中）；冷却记录存 `alert_log`，SQL 失败自动退化内存实现
- **webhook URL 掩码**：path+query 即推送密钥——接口回显与日志只允许出现 `scheme://host/` + `••••`，错误消息消毒同样替换完整 URL 与 path 片段
- **SSRF 防护**：仅允许 http/https 协议（file:/data: 等显式拒绝），10s 超时、不跟随重定向；单条发送失败只记状态不抛
- **泄露面**：推送文案只含百分比 / 金额 / 倒计时，绝不含 token 或密钥明细；`run` 整体 try/catch，异常不得逃逸拖垮主进程

### 10.3 微信推送与定时调度（v1.7）

**通道适配器**（`alerts.js` `ADAPTERS`，`buildPayload → {url, headers, body}` + 可选 `verify(res)` 响应体校验钩子）：

| 通道 | 形态 | 说明 |
|---|---|---|
| `wecom` | 企业微信群机器人 webhook，`msgtype=markdown` | 主力微信通道：免费、无每日条数限制（20 条/分钟）、支持字体色。**关键陷阱**：业务失败也返回 HTTP 200 + `{"errcode":非0}`，必须 `verify()` 解析响应体（`httpRequest` 收集 ≤8KB 响应体供校验），否则配错的 key 被当成功 |
| `serverchan` | Server酱 SendKey，form 编码 `title/desp` | 微信服务号推送，免费版每天 5 条；desp 优先放 Markdown 卡片 |
| ntfy / bark / generic | 不变 | 纯文本，能力有限不卡片化 |

**消息卡片**（`renderCard`，多行 Markdown）：预警事件按数据渲染——剩余百分比（三家都有）、绝对值（仅智谱 used/total，千分位展示不解释单位口径）、重置倒计时 / 当日目标进度；wecom 标题着色 critical=红 / warning=灰 / info（摘要·测试）=绿。`digest` / 测试等自定义卡片直接走 `ev.card` 覆盖。

**定时推送**（`server/lib/push.js`，挂在快照构建成功后与 `alerts.run` 同点，无 cron）：

- **每日摘要**（`buildDigest` 纯函数）：今日消耗 / 目标进度 / 工具 Top3 / 三家 provider 当前 5h+周窗口用量（available 才列）
- **周报 / 月报**：复用 `report.js buildReport`，`format:'list'` 列表版（企业微信 markdown 不支持表格，三处表格降级为 `- 指标：值` 行；网页表格版零影响）；正文剥掉首行 H1 由通道标题代替
- **调度规则**：北京时间当天/周一/每月 1 号到点后首个快照周期触发；**去重键** `digest|YYYY-MM-DD` / `report|week|周一日期` / `report|month|YYYY-MM` 复用 `alert_log` 表；**失败也写 store**（本期不重试）；错过补发仅限当天（周二开机不补周一周报）；上周/上月无数据不推（`empty` 不写 store，当天晚些归档出数据可再评估）
- **配置**（`plans.alerts`，与预警共用通道）：`digest: {enabled, hour}`、`reportPush: {week: {enabled, hour}, month: {enabled, hour}}`，`load()` 会对老配置补齐嵌套 key；`POST /api/alerts/test` 用面板当前值（或已存配置）立即推一条测试消息，企业微信 errcode 的 errmsg 会透出到前端——配置对不对点一下就知道

### 10.4 网络流量监控（macOS，`server/collectors/network-traffic.js`）

- **采集口径**：跟随 60s 快照周期 spawn `netstat -ib`，解析 Link 行（`tokens[2]` 以 `<Link#N>` 标记、字节在末 7 列布局），只保留 `en*` 物理网卡；对**累计字节计数器做差分**得到区间上下行 —— 并发/重复构建天然不双计，计数器回绕（重启/唤醒清零）按 0 计并重置基线。
- **网络归因**：WiFi 接口 → `wifi:<SSID>`（SSID 探测链 `ipconfig getsummary` → `networksetup -getairportnetwork`）；其他 → `iface:<dev>`（label 取 `networksetup -listallhardwareports` 硬件端口名，10min 缓存）。**SSID 隐私**：macOS Sonoma+ 全命令行路径需「定位服务」授权宿主 App，未授权拿到 `<redacted>` → 按接口名归桶（label=Wi-Fi），前端卡片提示授权方法。
- **归档**：history.sqlite `daily_network(date, network, label, rx_bytes, tx_bytes)`，**增量累加 UPSERT**（`rx=rx+excluded.rx`，不走指纹缓存——差分即增量）；差分基线 + 当前网络记忆存 `config/network-state.json`（原子写），多进程（index.js / mcp.js）各自差分互不双计。
- **快照暴露**：`snap.network = { error, current:{key,label,iface,rxRate,txRate}, today, month, series[31天] }`，today/month/series 均从归档库回读（单一事实源）；失败只记 `collectorErrors.networkTraffic`（string），非 macOS 平台返回 error 不抛。
- **前端**：`web/js/render-network.js` —— 两个区块独立显隐：「网络流量」实时卡置于套餐额度进度条之下（含**每日流量目标进度条**，目标 `plans.dailyGoal.networkGB`，设置面板可配，0 = 不显示，档位配色同额度条），「网络流量趋势（近 30 天）」按网络堆叠柱状图紧挨成本趋势图（SVG 拼法同款，柱宽封顶 48px 居中），各自无数据整区隐藏。

### 10.5 VPN 流量包额度（macOS/跨平台，`server/collectors/vpn-quota.js`）

- **数据源**：面板「订阅地址」的 `subscription-userinfo` 响应头（upload/download/total/expire）= 服务端账单口径，与面板页面数字一致；不用登录 Cookie（token 在订阅路径内，长期有效），也不用本地 utun 差分（Clash 系统代理分流模式测不到隧道流量）。`http-json.requestMeta` HEAD 优先拿头，缺头退回 GET（体限 2MB 即弃）。
- **安全**：订阅 URL 属机密（`QUOTA_KEY_FIELDS.vpnPanel.secrets=['url']`），接口只出 `maskSecret` 掩码、掩码回显未改动 = 保留原值；错误回显前 `maskSubUrl` 把 path 整段替换 `/***`。协议白名单 + 不跟随重定向（同 SSRF 口径）。
- **今日用量**：累计计数器差值 = 增量，基线存 `config/vpn-state.json`（原子写，服务重启不双计）；增量累加进 `daily_vpn(date PK, used_bytes, total_bytes, expire_at)`（SQL 累加 + COALESCE 覆盖元数据）。
- **预警**：`alerts.evaluate` 第 8 类事件 `kind:'vpn'`，阈值 `thresholds.vpnUsed`（默认 90 = 已用%），冷却 key `vpn|北京日期`；≥99% critical。wecom `renderCard` 有 vpn 分支（剩余流量%+消息行），原始字节不进卡片避免 fmtNum 误导。
- **前端**：「套餐统计」区 VPN 卡（`render-cards.js`）：已用%进度条（档位同额度条）+ 剩余/到期（`Math.floor` 天与面板同口径）+ 今日/累计；未配置 skip 不渲染，失败态复用额度失败行。

### 10.6 DeepSeek Harness 会话采集（v1.7.4，`server/collectors/deepseek-harness.js`）

- **数据源**：`~/.dsh/sessions/<项目slug>/session-<uuid>/session.v4.jsonl.zstd`（dsh 官方会话持久化）。首行 `type:"session"` 带 `cwd`（项目归因）；每次模型请求完成追加一行 `type:"assistant/message"`，`data.usage = { inputTokens（已剔缓存读）, outputTokens（含思考）, cacheReadTokens?, reasoningTokens? }`，模型/服务商在 `data.message.source.{provider,model}`。
- **多帧 zstd 红线**：dsh 每批追加一个 zstd 帧。系统 `zstd -dc` 全量解码为主路径（含 `/opt/homebrew/bin/zstd` 等绝对路径兜底，launchd 环境 PATH 可能不含 Homebrew）；Node `zlib.zstdDecompressSync` 对多帧**只解首帧且不报错**，因此仅当帧扫描（`0x28B52FFD` 魔数计数）判定单帧时才回退；多帧无 CLI 返回 null 并记 `collectorErrors.dsh`，绝不半读。
- **归一**：一条 `assistant/message` = 一次请求；`inputTokens` 已是净额、缓存读单列（与 codex-sessions 同口径）；`costUsd` 为 null，按单价表（deepseek-v4 系）等价核算；`providerId=source.provider` 进服务商/按量归因；`cwd` 进项目统计；子代理（`delegationDepth>0`）会话同样计入真实消耗。
- **容错**：文件未变（mtime+size 同）复用解析缓存；坏行计数但保留其余行；单会话解压上限 256MB；未装 dsh（目录不存在）静默零数据。
- **依赖**：macOS 需 `brew install zstd`（README / USER_GUIDE 已注明）；Node ≥23.8 内建 zlib 仅作单帧回退。

### 10.7 预估口径统一与数据健康（v1.8）

- **一个概念只有一处实现**：`server/lib/forecast.js` 导出 `monthForecast({dailyKeys, spendCny, now, minElapsedDays})`、`dayForecast(...)`、`bjParts(now)`、`coverageStartDay(dailyKeys, now)`，web 端 `forecast(toolKey)` 只读快照 `snap.forecast`，不再自己做除法。
- **分母为什么不能是「有数据的天数」**：那样没花钱的周末不进分母，租金式日均被抬高（例：¥200 花在 19.5 个有数据日 → 日均 ¥10.26 → 月底 ¥318，正确 ¥307.69）；新装首日半天数据除以一整天则相反，预估只有真值一半。现口径：`elapsedDays = (今天 - 覆盖起点) + 当日已过比例`，`覆盖起点 = max(当月 1 日, 当月首条数据日)`；配置端（store.monthlyForecast）与展示端同源。
- **`minElapsedDays = MIN_ELAPSED_DAYS = 0.25`（6 小时）**：已过不足 6 小时返回 `ok:false`，前端显示「数据不足 6 小时」，避免拿半小时数据外推全天。
- **快照字段契约**：`collectorStatus[{rows,ms,ok,rawRows?}]`（六采集器，键与 `rowStats` 一致）、`historyStatus{ok,ms,days,covered}`、`forecast{today:{ok,projectedCny,elapsedFrac,spendCny}, month:{total, tools}}`；`tools` 缺数据时返回 `ok:false` 而非省略键，且**不得回退 `__total`**（旧 `monthlyForecast` 曾把其他工具金额算进单工具）。
- **数据健康面板**（`web/js/health.js`）：纯展示，不触发采集；远程源仅在「成功或报错」时列出（未配置不占行）；`<details>` 重渲染保留用户展开状态，有错时才默认展开。
