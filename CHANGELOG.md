# Changelog

## [1.7.2] - 2026-11-06

### 🔌 云端展示端补实时额度（ChatGPT / MiniMax 卡上线）

- 云端零密钥架构下实时额度采集器拿不到凭证 → 额度卡在云端一直隐藏。现在 **deploy-pack 从本机服务取当前额度快照**（`quota-snapshot.json`：只留百分比/倒计时等展示字段，**剥 `raw` 原始响应**——内含 user_id/邮箱 PII，零出境），cloud-sync 每轮推送。
- 云端 snapshot 在 readonly 模式下回退渲染：30 分钟新鲜窗内顶替失败额度源（live 结果永远优先），标记 `archived:true` → 卡片显示「主端同步 · 采集时刻」而非「实时」；文件缺失/过期保持隐藏，不挂假数字。
- 预警引擎跳过 archived 额度数据（主端已推送，防双发）；前端额度卡 fresh 行按 archived 分「主端同步 / 实时」两种口径文案。
- 测试 +2（PII 剥离 + 回退窗/优先序/预警防双发），共 **214 passed**。

## [1.7.1] - 2026-11-06

### 🛠 云端部署实测修复

- **deploy-pack**：`node:sqlite` 的 `db.backup` 在 Node 26 缺失 → 改 `VACUUM INTO`（只读、版本通吃）
- **readonly 新鲜度**：rsync 覆盖归档后单例连接按 mtime+size 自动重开，云端数据随同步刷新
- **归档合并解耦**：readonly 跳过写入不再误挡 `mergeArchived` 补缺（此前云端历史整体不可见）
- **cloud-sync**：脱敏 plans 每轮直接覆盖（服务器自生成模板曾挡掉首推）；全程 `rsync -z`（未压缩大传输在弱链路卡死）
- 按量统计多 Key 并卡优化（网页 + macOS 组件同口径）。测试 212 passed。

## [1.7.0] - 2026-11-06

### 🔐 登录鉴权 + 域名部署（v1.7 发布主线）

- **新增 `server/lib/auth.js`**：可选登录门禁 —— **配置了凭据即启用，未配置行为与 v1.6 逐位一致**（本地默认无感，菜单栏/桌面组件/MCP 零改动）。scrypt(N=16384) 密码哈希 + timingSafeEqual 恒时比较 + 来源 IP 限流（5 分钟失败 10 次 → 429）；会话为进程内存 token 表（HttpOnly + SameSite=Lax cookie，7 天滑动过期）。
- **零密钥上云（硬约束）**：凭据只来自 `config/auth.json`（0600，gitignored）或环境变量 `AQD_AUTH_USER`/`AQD_AUTH_PASS_HASH`；明文密码与一切 API Key 不进 git、不上云。`scripts/hash-password.js` 生成哈希（`--save` 直接落 auth.json）；`scripts/deploy-pack.js` 产出脱敏云端包（归档 backup 单文件 + 无 quotaKeys/webhookUrl 的 plans + 纯数字状态文件）；`scripts/cloud-sync.sh` 一键推送。
- **部署配置面**：`AQD_HOSTS`（逗号分隔的允许域名，Host 白名单从"仅本机"扩展为"本机 + 部署域名"）、`AQD_BIND`（默认 127.0.0.1，反代场景保持）、`AQD_COOKIE_SECURE=1`（TLS 下加 Secure）、`AQD_TRUST_PROXY=0`（连本机豁免也关闭）、`AI_QUOTA_HISTORY=readonly`（云端只读归档：sync 全部直通不写、SQLite readOnly 打开，根除"云端写入 × rsync 覆盖"竞态）。
- **本机豁免设计**：来源为回环地址**且** Host 为 localhost 系 → 免登录（本机消费方不受影响）；反代转发的域名 Host 请求走完整鉴权。登录页 `web/login.html` 自包含（不依赖被门禁的静态模块），主看板 401 自动跳登录页。
- **VPN 卡云端回退**：云端采集器无密钥必失败 → snapshot 用同步的 `daily_vpn` 归档行 + `vpn-state.json` 基线兜底渲染流量包卡（archived:true 标记数据截至同步点）。
- 测试 +6（哈希/会话/限流/豁免单测 ×4、readonly 归档直通 ×1、HTTP 门禁全流程集成 ×1），共 **211 passed**。

### ✨ VPN 流量包额度监控（订阅计量）

- **新增 `server/collectors/vpn-quota.js`**：读取 VPN 面板「订阅地址」响应头 `subscription-userinfo`（upload/download/total/expire）拿流量包计量。数据源 = 面板服务端账单（与网页「流量用量」逐字一致，实测 802.19+2.42GB 完全对上），**不依赖登录 Cookie、也不依赖本地网卡**（Clash 系统代理分流下 utun 计数器测不到隧道流量，这条路才准）。只发 HEAD 拿头，个别服务端 HEAD 不回头部时退回 GET（体限 2MB 即弃，不下盘）。
- **配置**：`plans.quotaKeys.vpnPanel.url`（设置面板 → VPN · 订阅地址，token 在路径内 = 机密字段，接口只出 `http…xxxx` 掩码；掩码回显未改动保留原值、清空回退引导态）。未配置时额度卡 skip 不渲染。
- **今日用量**：累计计数器单调增长，`config/vpn-state.json` 持久上次快照 → 每 60s 差值 = 本轮增量，累加进 history.sqlite 新表 `daily_vpn`（增量 UPSERT，`total/expire` 覆盖为最新、null 不清空）→ 回读今日/近 31 天序列。首采只建基线（增量 0）。
- **额度卡**：「套餐统计」区新增 VPN 流量包卡（`render-cards.js`）——已用占比进度条（>60% 黄 / >85% 红，档位同套餐额度条）+ 剩余/到期天数 + 今日/累计。到期天数 `Math.floor` 与面板「N 天后到期」同口径。
- **低余量预警**：`alerts.evaluate` 新增 VPN 事件（第 8 类），阈值 `alerts.thresholds.vpnUsed`（默认 90%，设置面板「VPN 已用」可调）；已用 ≥ 阈值即走现有 webhook 通道推送 + 站内通知，冷却 key `vpn|北京日期`（天级 + cooldownMinutes 内不重复）。≥99% 升 critical。wecom 卡片补 `vpn` 分支显示「剩余流量」。
- **[健壮] http-json 新增 `requestMeta`**：只取状态码 + 响应头的请求助手（HEAD 优先），契约同 getJson（resolve 永不 reject / 协议白名单 / 不跟随重定向 / reason 脱敏）；订阅 URL 含 token，任何错误回显前先过 `maskSubUrl`（path 整段 `/***`）。
- 测试 +7（订阅头解析 / 差分与重置 / 归档累加 / 预警评估 / 采集器端到端本地 sink / 脱敏合并 / 快照形状），共 **203 passed**。

### 🎨 UI 配色与交互改版（明快亲和）

- **色彩策略**：双主题 token 整表提亮——夜间从近黑 (#0c0e13) 转向「暮蓝」(#11141d)，日间从冷灰 (#f3f5f9) 转向「晨白」(#f7f8fd)；中性色（边框/悬停/滚动条/模型行底）全部带靛蓝倾向形成整体温度。主色拥有三块明确领地：KPI 今日成本卡的靛蓝晕染、区块标题导航 tick、目标横幅进度。
- **语义色提亮一档**并同步全部 rgba 底色（tags/keychip/横幅/测试结果）；日间语义色加深至 tint 底上 ≥4.5:1（green #097949 / amber #8a5c0c / red #c03843），双主题全部色对 WCAG 程序化验证通过。
- **交互反馈**：可拖拽卡片 hover 抬升 2px + 柔和投影（拖拽手柄暗示，非拖拽卡不假装可点）；所有按钮/分段控件补按压态（translateY(1px)）；主保存按钮加 accent 光晕；通知面板入场动画；页面级滚动条主题化（此前只有表内滚动条有主题）。
- **页面氛围**：顶部一道极淡品牌色晕染（随内容滚走）；长页面 12 个区块标题统一 accent tick 路标。静态资源版本 v=20261105-3。测试 195 passed。

### 💄 Web UI 细节打磨

- **布局修复**：目标横幅窄屏状态文案不再被挤成一字一行竖排（≤640px 状态文案独占一行，标题+大数字一行）；成本/网络两张每日柱状图在数据天数少时柱宽封顶 48px 并居中于各自槽位（此前单日数据会把整图铺成一块实心色）；服务商/项目卡的模型 chips 展开态限高 240px 内部滚动、「收起」钮 sticky 常驻（此前 53 个模型把卡片拉到 ~1400px，同行卡片下方大片留白）。
- **窄屏表格冻结首列**：≤1080px 明细/模型/API 表横向滚动时首列（日期/名称）sticky 固定；分层不透明背景还原 today / hover / 模型行着色，双主题已验证。
- **动效降噪**：顶栏 live-dot 呼吸点静态化（旁侧「每 60s 刷新 · 更新于…」已说明活性，无限脉冲属装饰动效）；进度条流光周期 2.6s→5s（保留状态配色身份）。
- **细节**：页面 h1 17→19px（拉开标题层级步进）；周报引用块去掉 3px 左边框（保留底色圆角）；静态资源版本号 bump（v=20261105-2）。

### ✨ 网络流量监控（按网络聚合，macOS）

- **新增 `server/collectors/network-traffic.js`**：跟随 60s 快照周期对 `netstat -ib` 的每接口累计字节数做**差分**，把区间流量归因到「当前接入的网络」——WiFi 按 SSID 归桶（`wifi:<SSID>`），有线/USB 网卡按硬件端口名（`iface:<dev>`，如 "USB 10/100/1000 LAN"）。只统计 `en*` 物理网卡：VPN(utun)/回环/桥接的流量都经物理网卡收发，归到底层网络即可，不重复也不漏计。
- **SSID 隐私适配**：macOS Sonoma 起所有命令行路径读 SSID 都要求「定位服务」授权宿主 App，未授权时按接口名归桶（label=Wi-Fi）并在卡片提示授权方法；授权后自动开始按真实 SSID 分账。
- **归档**：history.sqlite 新表 `daily_network`（PK `date+network`，**增量累加 UPSERT**——差分本身即增量，多进程不双计）；差分基线存 `config/network-state.json`（原子写），服务重启后宕机期流量归到当前网络，计数器回绕（重启/唤醒）按 0 计。
- **看板**：新增网络流量两个区块（`web/js/render-network.js`）——「网络流量」实时卡**紧跟套餐额度进度条之下**（今日/本月 上下行、基于本轮差值的实时速率、每日流量目标进度条），「网络流量趋势（近 30 天）」按网络堆叠柱状图紧挨成本趋势图，图例带各网络 30 天合计；两区各自无数据独立隐藏。
- **每日流量目标**：`plans.dailyGoal.networkGB`（GB/天，上下行合计；设置面板「📶 每日流量目标」可配，0 = 不显示进度条）。档位配色与套餐额度条一致（>60% 黄 / >85% 红），老配置 load() 自动补齐默认值，applyPlansUpdate 白名单合并。
- 测试 +10（netstat 解析 / SSID 打码 / 差分回绕 / 归档累加 / 快照形状 / networkGB 白名单合并与 load 补齐），共 **196 passed**。
- **桌面小组件同步展示**（macOS `desktop-widget.swift` 重编译 + Windows `widget.ps1` 镜像）：套餐额度条下方新增「📶 当前网络」行 —— 每日流量目标进度条（档位配色同额度条）、今日 ↓/↑ 与剩余、实时速率；宽松键值解析，旧版服务无 `network` 字段时整行不显示。
- 小组件同样支持 VPN 流量包：套餐额度下方「🔌 VPN 流量包」行（已用%进度条 + 剩余/今日/到期天数），`vpnQuota` 不可用时整块隐藏（macOS 已实拍验证，Windows 镜像）。

### ✨ 缺失模型单价自动补充（公共价格目录）

- **新增 `server/lib/price-catalog.js`**：接入 LiteLLM 社区价格目录（jsDelivr 镜像，~3MB / 4500+ 模型），per-token 美元价归一化为「裸模型名 → $/百万 token」（提供商前缀/品牌点前缀剥离、同名官方条目优先、缺价条目跳过、浮点规整）。
- **自动补充链路 `priceAuto.runPriceSupplement`**：圈定全历史出现但单价表（默认+覆盖）查不到的模型（`history.distinctModels`）→ 目录**精确裸名匹配**（宁缺勿错，不做模糊截断）→ 按 `usdCnyRate` 折算人民币写入 `priceOverrides`（设置面板可见可改）→ `ensureFresh(true)` 重估历史等价成本 → 站内 🔔 + webhook 通知。元数据落 `plans.priceAuto`（lastAt / source / matched / missed）。
- **触发**：设置 →「补充缺失单价」按钮（`POST /api/prices/supplement`）+ 每周自动查价成功后联动（同 7 天节奏，无缺失时跳过不拉 3MB 目录）。
- **首次真实运行**：自动补上 **14 个缺失模型**（gpt-6.1-sol / gpt-6-sol / gpt-5.6-sol / gpt-6.1-terra / gpt-6-luna / kimi-k3 / deepseek-v4.1-flash / claude-haiku-4-5 等），历史等价成本同步重估 —— Codex 11-1 用量（434 次）从「无价不计费」变为 **¥129.68 等价**，ChatGPT Plus 套餐卡即刻给出性价比结论（¥155 / $19.9，16 倍 → 已回本续订）。`codex-auto-review`、`default-model` 两个通用名目录无匹配，如实列报未匹配。
- **[修复] Codex 卡费用口径**：本月费用 = costCny（cc-switch 实扣/旧订阅等价）+ equivalentCny（会话源按单价表核算的等价），否则会话行等价不显示。
- **[健壮] fetchPrices 支持 maxBytes 参数**（单价源默认 256KB 不变，目录 8MB 同一套 SSRF 口径）。测试 +5（目录解析/匹配/补充流程/失败回退/无缺失跳过），共 **186 passed**。

### ✨ Codex 会话采集 + 套餐独立实体（按模型归集）

- **[修复] Codex 用量断档**：cc-switch 自 2026-10-15 起不再记录 Codex 请求（db 停更），新增 `~/.codex/sessions` 官方会话采集器（`server/collectors/codex-sessions.js`）：行级取 `token_count.last_token_usage` 增量、模型跟随 `turn_context`、项目取 `cwd`（项目统计同步支持 Codex）；未变文件复用解析缓存，文件名起始日预筛跳过历史外文件。快照层以 cc-switch 末条时间为切换点过滤，重叠期不双计。会话文件无成本字段：GPT 系等价成本待价格源补齐单价后自动核算（noPrice 只计次数并在卡片提示）。
- **[修复] 套餐归属口径**：套餐从「工具字段」升级为独立实体 `plans.subscriptions`（name / payCnyPerMonth / usdPerMonth / modelMatch / tools），性价比按**模型名匹配跨工具归集**——MiniMax Token Plan（¥119）现在能算到 ZCode 里跑的 MiniMax 模型等价成本（此前挂在 WorkBuddy 工具上、恰逢 0 用量而恒为 0）；设置面板新增套餐动态行编辑器；未配置时回退旧工具口径。
- **[修复] 未计价行请求归属**：aggregate 的无单价行现在也计入 subRequests / payRequests（否则 Codex 全月 noPrice 时工具卡显示「Plus 套餐 0 次」误导）。
- 测试 +4（codex-sessions 采集 ×2 / subscriptions 清洗 ×2），共 181 passed。

### ✨ 站内通知中心 + 套餐性价比对比

- **站内通知中心**：导航栏新增 🔔 铃铛（未读角标）+ 消息卡片下拉面板。三类事件入站内消息流：价格自动更新 / 价格源检查失败（price-auto）、额度预警（webhook 发送成功时同步入流，站内站外互为备份）。存储 `server/lib/notify.js`（`config/notifications.json`，上限 50 条 FIFO，add/markRead/clear 全不抛错）；API：`GET /api/notifications`、`POST …/read`（单条/全部）、`POST …/clear`；面板支持单条点击已读 / 全部已读 / 清空，60s 轮询同步角标。
- **套餐性价比**：工具卡下方新增「套餐性价比」区块（`web/js/plan-value.js`）：套餐**实付月费** vs **等价 API 消耗**（按实际用到的模型 × 官方单价折算；codex 取 Plus 套餐内 subUsd 口径，第三方实扣不算套餐内消耗）。新增 `plans.*.payCnyPerMonth`（人民币套餐真实月费字段，美元套餐继续用 `usdPerMonth`）；每卡给出本月已用进度条、全月线性外推、性价比倍数、回本线（¥/天）、上月等价对比与**购买建议**（已回本续订 / 接近回本省心 / 利用率偏低建议降档或按量 / 本月回落先观察；月初无消耗不下结论防误报）。
- 设置面板每工具新增「套餐真实月费（¥）」输入；测试 +3（notify 存储 / price-auto 站内通知联动），共 177 passed。

### ✨ 模型单价周自动更新 + 上线/下线通知

- **每周自动检查在线价格源**：服务每小时评估一次，距上次成功检查满 7 天才拉取；有**调价 / 新模型上线 / 旧模型下线**就自动合并进 `priceOverrides` 并按新价重算历史等价成本，随后经预警 webhook 推一条明细通知（价格变化超 15 条截断）；无差异静默更新检查记录。新增 `server/lib/price-auto.js`（独立 tick，不在快照钩子里做，避免 ensureFresh 重入）。
- **下线判定防误报**：每次成功检查把来源覆盖的模型名存进 `priceSource.modelsSeen`，「上次见过、这次没了」才算下线 —— 来源从未收录的本地模型（如 qwen 系）不误报；源里临时坏行也不误报（键名仍在清单），坏行在通知中单独提示「无效行跳过」（`parsePriceFile` 新增 `names`/`skipped`）。
- **设置面板**：「在线更新单价」区新增**每周自动检查开关**（`priceSource.auto`，默认开）与检查失败原因就地展示；手动「检查更新 / 应用更新」同步支持上线 / 下线差异预览；老配置自动补齐新字段。
- **容错**：拉取/校验失败不推进 `lastCheck`（下一轮 tick 重试，临时抖动不必等一周）；通知发送失败不回滚已应用的更新，失败原因落 alert_log。测试 +8（174 passed, 0 failed）。

### 🔍 全项目代码审查 + 多 Agent 修复（P0×0 · P1×8 · P2×13 · P3×30+ 逐项闭环）

四个只读审查 Agent 分区审查（服务端核心 / 采集器 / 前端 / 测试与外围），独立修复 Agent 按文件所有权并行修复，独立验证 Agent 29 项验收全 PASS。

**安全修复**
- **[P1] plans 机密清空**：`POST /api/plans` 传非对象 quotaKeys（如字符串）会静默清空全部已存 API Key——补类型守卫（非法类型整体忽略，测试锁定）
- **[P1] 前端 XSS ×3**：额度失败 reason、远端价格源 diff 字段、价格编辑器模型名（可经「应用更新」持久化进 plans.json）全部补 esc；esc 顺带补单引号转义
- **[P2] 探活错误回显泄漏**：4 个采集器的 HTTP helper 非 200 响应体片段原样进快照 reason（部分服务商会回显 key）→ 统一 sanitizeReason 掩 `sk-/rk-/ark-/Bearer` 形态
- **[P2] plans.json 标量根崩溃**：损坏为 `42`/`null` 时 buildSnapshot 持续 500 无自愈——视同损坏走 .bak + 模板分支
- **[P3] /api/refresh 改 POST-only**（原 GET 可被跨站 `<img>` 反复驱动全量重建）；days 负数钳制；500 固定文案不回显内部路径

**正确性 / 健壮性**
- **[P1] HTTP helper 悬挂**：4 个采集器的「响应体超限 `req.destroy()`」后 promise 永不 resolve（分块响应实测悬挂）——超限先 resolve 再 destroy，`server/lib/http-json.js` 统一收口四处
- **[P1] start-all.sh 探活竞态**：`--max-time 2` 打 /api/summary（冷服务 >2s 误判未运行 → 拉起双实例覆写 .port）——新增轻量 `GET /api/health`（不触发构建），sh/ps1 探活统一切换
- **[P1] 菜单栏空日误判失联**：每天首次请求前 `agg.daily` 无今日 key → 误发「服务未响应」通知 + 18 轮刷新风暴（~72 次外呼）——空日按空数据处理
- **[P1] CI swift job 恒挂**：两 Swift 文件合编 `swiftc -parse` 必报顶层表达式错误——改分别 parse
- **[P2] readBody 跨 chunk 多字节损坏**（>64KB 中文 body JSON.parse 失败）→ Buffer.concat；api-billing 串行 35s 超外层 race → 四组并行 + probeKey 8s 兜底；quota/apiBilling 失败静默 → 写入 collectorErrors；zcode 三级回退错误信息保真；history models 全历史补缺丢实扣（补 SUM(cost_usd)）；history 错误路径清指纹缓存；menubar dailyGoal=0 清零；desktop-widget 6s 超时数据竞态（NSLock 交接）；stop-all pkill 过宽误杀（sh/ps1 收窄锚定）；gen-demo-data rmSync 脚枪守护；forecast 东八区月末少一天；load() 并发序号守卫（旧响应覆盖新快照）；localStorage 两处裸调用（隐私模式整页中断/拖拽卡死）
- **[P3] 30+ 项**：withTimeout 定时器清理、jsonl 未变文件跳过（每分钟 33MB IO → 只读活跃文件）、ccswitch 未知 app_type 计数、zhipu 空 break→continue、chatgpt 空 accountId header、EPIPE catch、mcp offset 语义对齐、桌面卡 `__total` 双计、PS1 定时器失联回 15s、死代码/死选择器清理、恒真断言修复等

**代码结构优化（行为不变）**
- `server/lib/http-json.js`（HTTP GET 统一，4 份实现 → 1）、`server/lib/fsutil.js`（jsonl 枚举共用 + mtime 缓存）、`server/lib/zcode-credential.js`（凭证解密共用）、`server/lib/bjtime.js`（北京时间函数 4 份 → 1）、`server/lib/snapshot.js`（buildSnapshot 单一事实源，index.js 与 mcp.js 手抄双份合一）
- store.js 四聚合去重（tally/tallyModels/forEachWindow helper，两种费用口径显式化为 costMerge/costSplit）
- **前端 ES modules 拆分**：web/app.js（1697 行单文件全局脚本）→ `web/js/` 10 模块 50 导出符号（utils/storage/state/goal/ui/render-cards/render-tables/report/settings/main），import 图无环；裸 localStorage 13 处全部收口 safeGet/safeSet；index.html 改 `type="module"`；新增 web/package.json `{"type":"module"}`（根 package.json 为 commonjs，CI node --check 需要）
- index.js POST 路由抽 readJsonBody helper；mcp/mcp.js 复用统一快照（-22 行手抄）

**测试**：159 → 166（plans 守卫/标量根、多字节 body、history 实扣、快照数值对账、health/refresh 契约等 7 组新用例 + 2 处断言修正）。验证 Agent 29 项全 PASS（含真实数据对账 modelUsage/项目合计 == 当日总成本、中文 69KB body 完整性、机密守卫运行时复验）；浏览器五链路复验通过（刷新 POST/报表/设置/主题/chips/导出）。

### ✨ 新功能：日间/夜间主题 + 主动刷新按钮

- **看板主题能力**：全量颜色收敛为 CSS 变量两张表（`:root` 夜间 / `:root[data-theme="light"]` 日间），组件选择器零改动即可整主题切换；日间主题 = 中性浅灰底 + 深靛蓝强调（对比度按浅底校准：--accent #5563d8、语义色加深），`color-scheme` 随主题切换（原生表单控件/滚动条跟随）
- **主题切换按钮**（顶栏 ☀️/🌙）：点击日夜间互换并记忆（localStorage `aqd:theme`）；未手动选择过时**跟随系统外观**；首帧由 index.html 内联脚本在样式表加载前定主题（防闪白/闪黑，localStorage 与 matchMedia 各自降级兜底）
- **主动刷新按钮**（顶栏「⟳ 刷新」）：点击即调 `/api/refresh` 强制重建快照（平时 60s 周期），完成后重拉渲染并 toast「已刷新」；期间按钮禁用态明显（opacity + cursor），重建成功但重载失败时如实提示「快照已重建，但数据加载失败」；与 60s 轮询并发安全（服务端 building Promise 合并，不重复构建）
- 硬编码色清理：顶栏毛玻璃底、对话框/遮罩、滚动条、表格 hover 行、错误/成功文案、主按钮文字色、模型明细行底色全部变量化；趋势图文字/网格线补 CSS 级联兜底（Safari 对 SVG presentation attribute 中 var() 不支持，Chromium 零变化）
- 审核修复：按钮禁用态无视觉（P1，顺带修复设置面板「应用更新」初始禁用不可辨）；themeBtn 补 aria-label
- 零服务端改动、测试 159 全绿

### ✨ 新功能：今日模型排行 + 项目统计（核心数字强化）

- **KPI 核心数字强化**：五张 KPI 数字 24px→28px/700，「今日成本」为 hero 格——面板提亮 + 靛蓝强调大数字（34px）；≤1080px 窄屏自动降级（22px/26px）不溢出
- **今日模型排行**（按量统计下方新区块）：新聚合 `store.modelAggregate` → 快照 `modelUsage`，跨工具按模型归集今日/本月用量与费用（订阅工具计等价成本、按量工具计真实费用，与全局口径一致）；排行卡整行贯通，费用降序 + vendor 圆点（8 家服务商配色）+ 次数/tokens/费用 + 占比进度条，收起只看 Top5、一键展开全部（状态记忆 `aqd:modelRankOpen`）；无单价模型费用显示「—」并附未计价次数
- **项目统计**（今日占比与费用 · 累计总量）：新聚合 `store.projectAggregate` → 快照 `projectUsage`——**ZCode 走会话表精确归因**（`model_usage` LEFT JOIN `session` 取 project_id/directory，旧库无 session 表三级回退单表查询不报错）、**Claude Code 用会话 cwd 近似**；cc-switch / WorkBuddy 无项目概念不参与以免占比失真。每项目一卡：今日费用大字 + 今日占比条（分母=今日项目总费用）+ 今日/累计用量与累计费用 + 今日模型 chips（复用自动折叠，费用大头在前）；今日费用 Top6 之外折进「另有 N 个项目」条（状态记忆 `aqd:projectStatsOpen`）；项目卡可拖拽排序
- **展开收起**：排行 Top5 / 项目 6 张卡 / 模型 chips 三层折叠均可展开收起，localStorage 记忆（60s 刷新与重开页面保持）；无数据时整个区块自动隐藏
- 测试 154 → 159（modelAggregate 窗口/口径/vendor、projectAggregate 双窗口/无项目剔除/label 回退、zcode JOIN session 三级回退、buildSnapshot 断言 modelUsage/projectUsage 恒有）
- 审核修复：zcode 回退链对最老库（无 session 表且无 provider_id 列）三级兜底；排行卡窄视口单列边框与 KPI 窄屏降级；排行卡移除多余 data-key

### ✨ 新功能：API 维度费用（每把 API × 模型）

- **新表「API 维度费用（每把 API × 模型 · 今日 / 本月）」**（按量统计区下方）：数据来自新聚合 `store.apiAggregate` → 快照 `apiUsage` —— 每把 API（ZCode provider_id）单独一桶，桶内再按调用模型拆明细；API 行可点击展开模型行（费用 / 请求 / tokens 今日+本月双窗口），与「模型分类费用」表交互一致，支持导出 CSV
- **归因口径**：ZCode 行精确到每把 Key（如智谱 `bigmodel-api` 与 `bigmodel-api-usable` 分开显示各自费用与模型构成）；cc-switch / Claude Code 等无 provider 标记的行按模型名归因，落「按模型归因 · 服务商」桶——每服务商各桶合计与按量卡数字严格对账一致（测试覆盖）
- **口径过滤与按量卡对齐**：订阅制 provider（如 MiniMax Token Plan）不出现在本表；openai/anthropic 等 Codex/Claude 套餐等价成本归属也不进本表（与按量统计区只收真按量服务商一致），避免把套餐等价成本误读成 API 按量扣费
- 测试 151 → 154（apiAggregate 多 Key 分桶 / 模型归因桶 / 订阅剔除 / 百炼托管归属 / 窗口 / 对账）

### ✨ 新功能：微信额度监控提醒（企业微信 + Server酱）

- **企业微信群机器人通道**（`webhookType: 'wecom'`，推荐）：个人可免费注册企业微信 → 建群 → 群设置「添加群机器人」复制 Webhook 地址；免费无每日条数限制（20 条/分钟），支持 Markdown 卡片；Server酱（微信服务号）通道同步增强（desp 走 Markdown 卡片，注意免费版每天 5 条，预警 + 摘要 + 周报齐开会超，建议企业微信为主）
- **增强版 Markdown 卡片**：预警消息从单行文案升级为卡片——剩余百分比、智谱绝对值（千分位）、重置倒计时 / 当日目标进度；企业微信标题按级别着色（critical 红 / warning 灰 / 摘要与测试绿）
- **企业微信 errcode 陷阱修复**：其业务失败也返回 HTTP 200 + `errcode≠0`，此前只看状态码会把配错的 key 当成功；`httpRequest` 现收集 ≤8KB 响应体，适配器新增 `verify()` 钩子校验错误码
- **每日摘要定时推送**：当天到点（默认 21:00，可配 0~23 点）推一次——今日消耗 / 目标进度 / 工具 Top3 / 三家套餐当前窗口用量；错过当天内开机补推，跨天不补
- **周报 / 月报定时推送**：仅周一 / 每月 1 号到点（默认 9:00）推上一期报告；企业微信 Markdown 不支持表格，`buildReport` 新增 `format:'list'` 列表版（网页表格版零影响），正文剥 H1 由通道彩色标题代替
- **「发送测试」按钮**：设置面板填完通道和地址立即推一条测试消息（不落盘不占冷却），企业微信的 errmsg 直接透出——配错 key 一目了然；支持掩码回显自动换回已存值
- **去重复用 `alert_log`**：定时任务键 `digest|日期` / `report|week|周一` / `report|month|月`，失败也占本期不重试（与预警「失败占冷却窗」哲学一致）；`plans.json` 老配置 `load()` 自动补齐 `digest` / `reportPush` 嵌套键
- 测试 137 → 151（wecom 适配器 / verify / 卡片渲染 / push 调度三分支 / 配置合并 / 测试按钮端到端）

### ✨ 新功能：火山方舟接入（volcengine）

- **火山方舟 API 卡**：设置面板新增 `quotaKeys.volcengine.apiKey`（Key 链：ZCode 自定义 volcengine 供应商 → 设置面板），卡片展示 `/api/v3/models` 实拉的在售模型清单（只读不耗额度）兼做 Key 探活；同 key 接入 ZCode 自定义模型后自动并入 provider 卡，不重复出卡
- **实测边界**：方舟无按量余额接口（`/api/v3/users/me/balance` 等 2026-10-31 实测均 404，计费在火山引擎账户侧），卡片以「N 在售模型 · 共 N 款 · 退役中 N · 已下线 N」代替余额位
- **模型 chips 自动折叠**：在售模型动辄数十款（38 款 × 豆包长名 → 卡片 655px，同行卡被拉伸出大片空白），现 chips 一行放不下时自动收成一行（置顶的已配置高亮模型可见），末位「+N 个 ▾」chip 展开 / 「收起 ▴」收回，折叠后卡片高度与其他卡对齐（实测 655px → 319px vs 常规 328px）；展开态按卡记忆在 localStorage（60s 刷新 / 重开页面保持），全部 provider 卡的模型 chips 通用，窗口 resize 防抖重算断点
- **计费归属**：`doubao / seedance / seedream / hunyuan` 原生模型按模型名归 volcengine；方舟线路（providerId 含 ark/volc/doubao，排除讯飞 spark 误伤）托管的 GLM / DeepSeek / Kimi / Qwen 计费归火山（同百炼托管规则）；豆包系单价未内置，走设置面板 / 在线价格源补录
- **接入 ZCode 自定义模型**（2026-10-31 续）：`provider_config.json` 新增 `volcengine-ark`（ZCode 内置模板：anthropic-messages 协议 + `ark.cn-beijing.volces.com/api/compatible`），仅配置 `doubao-seed-2-1-pro-260915` / `doubao-seed-evolving` 两款（均实测 `/v1/messages` 可用，1M 上下文 · 支持工具调用）；provider 卡自动接管独立卡，配置的两款模型在 chips 置顶高亮（`.mm-on`）
- **探活认证修正**：方舟 `/api/compatible/v1/models` 实测只认 Bearer（x-api-key 401，聊天端点 `/v1/messages` 仍走 x-api-key），volcengine provider 探活强制 Bearer，否则 Key 误报失效
- 测试 132 → 135（parseArkModels、vendorOf 豆包系、vendorForRow 方舟托管归因；`inferVendor('volc-ark')` 断言随识别表更新翻转）→ 137（探活 Bearer 用例）

### 🔍 代码审查修复（v1.7 发布前全量 review）

- **P0 · 未计价模型用量消失**：`vendorAggregate` 此前把无单价模型的行整行丢弃——未录价模型（如 kimi-k3.1-pro）的请求量从服务商桶里消失，Kimi 卡误显示「0 次 ¥0」。现无单价行照常计入 requests/tokens，`noPriceRequests` 单列，费用行附「（N 次未计价）」提示，卡片不再误导
- **P0 · 桌面卡重复 ID 崩溃风险**：SwiftUI `ForEach(payg, id: \.label)` 在两个同厂商服务商（如两个 DeepSeek）短名重复时会撞 ID；改为 providerId 稳定 id
- **P1 · 一家余额慢拖死全部**：余额采集器内部 key 链是顺序尝试（每把最坏 10s），超快照 10s race 会把整个 `apiBilling` 变 null；现在每家独立包 9s 超时，超时仅该家降级
- **P1 · XSS 面**：套餐卡标题 `${it.name}`（来自远端 API 的 provider 字符串）未转义，补 esc；连带 data-key
- **P1 · 基线缺 Kimi**：无 ZCode 自定义配置但手动配了 Kimi key 的独立部署，Moonshot 余额不采集；moonshot 入基线（无 key 时不发网络请求，零成本）
- **P1 · 桌面卡刷新 300s → 120s**（与「随时检测」语义对齐）；费用口径文案统一为「按量线路用量 × 官方单价（无单价模型不计费）」
- 测试 129 → 130（新增未计价行计数用例）；未录价模型单价请经设置面板或在线价格源补录（官方价格页为 JS 渲染，抓取不到时不猜测）

### ✨ 新功能：智谱多 Key 监控

- **「其他智谱 Key」**：设置面板新增 `quotaKeys.zhipu.extraKeys`（每行「名称 | API Key」，可配多把），用于把独立于自己账户主 Key 的智谱 Key（如另一账户的「可用api」）补充进看板，与主账户智谱卡分开监控
- 网页「按量统计」区在智谱主卡后渲染每把额外 Key 的独立卡（按量徽章 + Key 有效/失效探活 + 掩码 + 检测时间）；桌面卡「按量 · 服务商」列表同步追加行（健康圆点 + 名称 +「仅探活」）
- **实测边界**：智谱标准 API Key 无余额查询接口（`getCustomerInfo` 仅认 OAuth JWT，API Key 实测 `APIKey not allow access`；2026-10-16 起 Key 分类管理，标准 Key 消耗账户余额），故额外 Key 卡只做 `/api/paas/v4/models` 探活（不耗额度）不展示余额；若某把 key 同时配置为 ZCode 自定义模型（provider），则跳过附加卡避免与 provider 卡重复
- 设置面板 textarea 脱敏回显、掩码未改动保留原值（与既有 quotaKeys 语义一致）；测试 130 → 132
- **「可用api」Key 接入 ZCode 自定义模型**（providerId `bigmodel-api-usable`，模板 bigmodel-api，模型 `glm-5.3` / `glm-5.3-flash`，两 ID 均经 `/api/paas/v4/models` 实测可用；另有 `glm-5.3-flashx` 未配置）：配入 `provider_config.json` 后看板自动发现（≤60s），provider 卡接管原「其他 Key」附加卡（linkedProvider 去重）
- **同服务商多 Key 串显修复**：同 vendor 出现多个按量 provider 时（如 bigmodel-api_my + 可用api），余额与用量费用此前会在每张卡重复显示同一服务商口径数字；现仅首个 provider 主卡展示，副卡注明「余额见主卡 / 用量费用合并统计」；测试 135 全绿

### 🗺 已知差距 / 后续规划

- Windows `widget.ps1` 未同步「按量/套餐」分区（macOS 优先）
- 阿里云 BSS `GetAccountBalance` 签名链路纯函数已测、真实 AccessKey 未实测（本机无凭证）
- 按量余额低水位预警（alerts.js 目前只覆盖套餐额度阈值）可后续接入
- kimi-k3.1-pro / kimi-k3 等新模型单价待官方价格源收录

### ✨ 新功能：按量统计 / 套餐统计分区

- 原「套餐实时额度」+「API 按量计费」两区块重组为语义分类：**「套餐统计」**（订阅卡：ChatGPT、MiniMax——实时 5h/周额度条 + 月费徽章）与**「按量统计」**（只收真按量服务商卡，订阅型服务商自动从按量区剔除）
- 套餐月费标注：`plans.*.usdPerMonth` 新字段（美元真实订阅价，展示时按汇率折算 ¥），设置面板每工具新增 USD 月费输入。例：ChatGPT `$19.9/月 · ≈¥143` 徽章、MiniMax `¥119/月`
- **macOS 桌面卡片与网页对齐**：展开态新增「按量 · 服务商」列表（每家一行：今日/本月费用 + 余额 + Key 健康圆点，列头图例）与「套餐」区月费标注（ChatGPT $19.9/月≈¥143、MiniMax ¥119/月绿色角标）；今日总额旁徽章由「实扣 $X」改为「按量 ¥X」（= 四家按量今日费用合计，更直观）；折叠态同步按量徽章。新增 `AI_QUOTA_WIDGET_DUMP=<png路径>` + `AI_QUOTA_WIDGET_COLLAPSED=0/1` 调试环境变量（视图自绘截图，免屏幕录制权限即可视觉验证）
- Windows 桌面卡片 `widget.ps1` 本版未同步分区（已知差距，macOS 优先），后续跟进

### ✨ 新功能：API 按量计费（服务商余额 + 用量费用）

- **服务商列表以 ZCode 自定义模型配置（`~/.zcode/v2/provider_config.json`）为事实源，每次快照（60s）动态发现**——用户在 ZCode 里增删服务商，看板自动跟上，零配置；无该配置时回退基线服务商。每家一卡：**智谱 / DeepSeek / 阿里云百炼 / Kimi** 按量卡 + **MiniMax** 订阅卡（`sk-cp-` 前缀 / coding-plan 特征自动分类，订阅卡标注「不按量扣费」）
- **Key 随时检测**：每个服务商用自己配置的 key 探一次 OpenAI 兼容 `/models` 端点（不耗额度；anthropic 型走 `x-api-key`，baseUrl/api.type 通用规则 + 五家模板表兜底），卡片标题出「Key 有效 / Key 失效(原因) / 未检测」徽标；未知服务商带自定义 baseUrl 也能探
- 卡内展示：账户余额 + 今日/本月费用与用量（本机请求日志 × 官方单价，模型 chips 列出该服务商配置的模型）。余额源实测：智谱 getCustomerInfo、DeepSeek /user/balance、Kimi /v1/users/me/balance（available/cash/voucher）；百炼无按量余额接口（DashScope 实测 404）→ 可选在设置面板配阿里云 AccessKey（ID + Secret，Secret 脱敏存储）走 BSS `GetAccountBalance`（RPC HMAC-SHA1 签名零依赖实现，纯函数单测覆盖，真实签名链路未实测）
- 内置单价新增：qwen3.8-flash 0.8/2.7、qwen3.7-plus 2/8、qwen3.7-max 12/36（2026-10 百炼北京档）；设置面板新增 DeepSeek / Kimi API Key 与阿里云 AccessKey 配置项
- **计费归因走 `provider_id` 而非模型名**：ZCode 采集行携带 provider_id，订阅制 provider（`account:*`/coding-plan/start-plan）不进按量费用桶；百炼托管的三方模型（GLM/Kimi）归百炼。修复后智谱按量卡不再混入团队套餐调用
- 套餐实时额度区块移除失效的智谱团队卡，仅保留 ChatGPT / MiniMax 订阅卡；测试 106 → 128

## 1.6.0（2026-10-24）

### ✨ 新功能：工具卡片显示/隐藏

- 设置面板新增「卡片显示」区：5 个工具卡片（ChatGPT·Codex / Claude Desktop / Claude Code / ZCode / WorkBuddy）可勾选显隐，取消勾选的工具有卡片区整卡隐藏（含未启用折叠区），表格 / 趋势图 / 每日明细数据不受影响；卡片区有隐藏时显示「已隐藏 N 个工具卡片 · 设置 → 卡片显示 可恢复」提示。配置存 `plans.json` 的 `hiddenCards`（服务端白名单校验 + 去重）

### ✨ 新功能：应用程序启动器

- 新增 `scripts/make-launcher.sh`：一键生成「AI 额度看板」启动器并安装到 `/Applications`——双击或 Spotlight 搜「AI 额度看板」= 启动服务（幂等）+ 菜单栏 + 桌面卡片 + 打开网页；复用霓虹表盘图标，`LSUIElement` 纯启动器不占 Dock；GUI 环境自动补 Homebrew PATH；端口走 `config/.port` 发现契约（7788 被占自动 +1 也能正确打开网页）。构建产物同步保留在 `dist/`
- `start-all.sh` 服务存活判断从 `pgrep` 改为 HTTP 探活（`/api/summary`）：修复进程僵死/退出中被误判「已在运行」导致跳过启动的竞态

### ✨ 新功能：在线更新模型单价

- 设置面板新增「在线更新单价」区：填价格源 URL →「检查更新」预览差异（模型 / 字段 / 旧价 → 新价 / 新增模型）→「应用更新」写入单价覆盖表并立即按新价重算全部历史等价成本。默认源指向本仓库 `config/prices.source.json` 的 jsDelivr 镜像（GitHub 直连不稳时可换任意 JSON 地址）。API：`POST /api/prices/update {url, apply}`（apply=false 只预览不落盘）
- 价格源格式：`{ schema, updated, source, models: { 模型名: { in, out, cacheRead?, cacheWrite? } } }`（元/百万 token，坏行自动跳过）；拉取侧安全口径与预警 webhook 一致——仅 http/https、拒绝重定向、10s 超时、256KB 上限；`priceSource.url` 存 plans.json，最近检查结果（时间/源日期/模型数）回显在面板
- 内置单价表更新至 2026-10-23 官方价：GLM 系列不变（新增 GLM-5.3-FlashX 2/7/0.57）；**MiniMax-M3 永久 5 折 4.2/16.8 → 2.1/8.4**（缓存 0.845→0.42）、新增 MiniMax-M3.1-Flash 1/4/0.1；DeepSeek 改分时计价，取空闲/高峰均值折算（v4-pro 4/16→6.75/20.25，v4-flash 1/4→1.5/6）。价格来源：智谱 / MiniMax / DeepSeek 官方定价页

### 🐛 修复：隐藏卡片后卡片区留白

- 「已隐藏 N 个」提示条与「未启用工具」折叠条此前是卡片网格的子元素，各占一格 296px 卡位，且拖拽排序会把它们顶到最左格——隐藏 2 张卡后 3 张卡被挤到一边、左侧整格空白。现两者移出网格放入独立容器整行显示，网格只装真正的卡片，`auto-fit` 可正常折叠空轨道：剩余卡片（1/2/3 张均验证）自动拉伸铺满整行宽度

### 🛠 macOS 菜单栏健壮性

- 刘海屏菜单栏图标过满时，系统会把 ⚡ 图标整块挤出屏幕（isVisible 仍为 true）——启动 2s 后自查，被挤出即发系统通知告知去留出空间
- 服务失联改为通知触达 + 每 5s 自愈重试（有上限），恢复后重置；此前静默失败用户无感知

### 🧪 测试

- 单元测试 99 → **106**（价格源解析 / 差异 / 合并纯函数 + `/api/prices/update` 预览-应用-错误路径端到端 + hiddenCards 白名单校验）

### 🎨 Web UI 重设计（数据看板主题）

- 视觉从「玄幻暗夜」（极光背景 + 星野 canvas + 霓虹渐变 + 流光动效）重做为克制的**数据看板**风格：中性暗色面板 + 单一靛蓝强调色，语义色只留给状态（绿=正向 / 琥珀=预警 / 红=超支）
- 移除极光、星空、网格三层背景与常驻 canvas 动画、火焰渐变、大段落渐变文字——降低视觉噪音，长时间盯盘更省眼
- 额度进度条新增**流光**：高光沿填充条 2.6s 循环扫过，颜色随额度状态变化——正常=七彩光谱（青→靛→紫→粉）、>80% 预警=琥珀金、>100% 超支=红（纯 transform 合成层动画，`prefers-reduced-motion` 下自动关闭）
- 新增 sticky 顶栏（品牌额度表盘 SVG 标记 + 数据源状态行 + 设置按钮），长页面滚动时操作始终可达
- 工具卡片与趋势图统一 5 色分类体系（卡片头部圆点 = 堆叠柱图例色），工具与图表数据一眼对应
- 表格升级：sticky 表头 + 圆角滚动容器，每日明细固定高度内滚动（「全部（归档）」数千行不再把页面拉到无限长），今日行高亮
- 趋势图 Y 轴刻度加内边距修复左侧截断；图表/周报区域收进统一卡片容器
- 可达性：全局键盘焦点环（:focus-visible）、次要文字对比度提升（AA+）、小字号从 10/11px 提升到 12px、保留 prefers-reduced-motion 降级
- 文案去表情符号化（预算横幅、额度条、引导横幅），语义改由颜色与文字表达；Toast 移至右下角中性样式

## 1.5.0（2026-10-07）

### ✨ 新功能

- **历史数据持久化**：每次构建把每日聚合自动写入 `config/history.sqlite`（含 -wal/-shm 伴生文件），原始工具日志被滚动清理后历史不丢；每日明细新增「全部（归档）」选项（days=3650，约十年）。环境变量 `AI_QUOTA_HISTORY=0` 可关闭（回到纯实时扫描）；归档库损坏自动降级不影响看板。兼容：老 `plans.json` 无 `alerts` key 自动补默认值；归档行按当前单价重估（改价后历史跟随新价，实扣 costUsd 不重估）
- **额度预警推送**：设置面板新增「额度预警推送」区（默认关闭）——启用开关 + 四通道（ntfy / Bark / Server酱 / 通用 Webhook JSON）+ 推送地址（脱敏回显，与额度 Key 同语义：不改=保留、清空=停用）+ 三个阈值（5h 窗口 85%、周窗口 85%、当日目标 100%，可调 0~100）+ 冷却分钟（默认 60）。服务每 60s 重建快照后评估触发；推送内容只含百分比/金额/倒计时，绝不含密钥或 token 明细；预警冷却记录存 history.sqlite（`AI_QUOTA_HISTORY=0` 时内存，重启后会重推一次）
- **周报 · 月报**：网页新增「周报 · 月报」区块（趋势图之后）——周/月切换、上一期/下一期、复制 Markdown、下载 .md；内容七节：标题（周期起止）/ 总览（成本·请求·token 环比）/ 工具榜 / 模型榜 Top5 / 最贵的一天 / 预算达成率 / 口径脚注。周 = 北京时间 ISO 周（周一起）。API：`GET /api/report?type=week|month&offset=N`（week≤520、month≤120）；MCP 新工具 `ai_usage_report(type, offset)`；CLI：`node mcp/mcp.js report week|month [offset]`
- 单价表支持可选 `cacheWrite` 字段（缓存写入价）：缺省按输入价计 cache_creation，可 `priceOverrides` 覆盖

### 🛠 正确性修复

- 首次构建日志漏计 Claude Code 行数（首轮扫描丢行）
- 缓存写入 token（cache_creation）此前未计价——现按 cacheWrite 单价（缺省输入价）计入等价成本
- ZCode 思考 token 计价口径统一：归档重估与实时一致，消除 +2.6% 漂移
- MCP 报表补归档合并（周月报 / 汇总工具的数据源与网页对齐，含历史归档日）

### ⚡ 性能

- 归档写入脏行指纹缓存：内容未变的行跳过 UPSERT，稳态每 60s 由约 900 行写入降到 0~10 行/分钟
- 归档合并全历史 (tool,model) 聚合下推为 SQL `GROUP BY`，省掉 JS 全表遍历

### 🧪 测试

- 单元测试 35 → **99**（历史归档合并、预警引擎、周月报生成、cacheWrite 计价、配置兼容）

## 1.4.0（2026-09-28）

### ✨ 新功能

- **应用图标**：从零设计的霓虹环形额度表盘图标（暗夜玻璃底 + 青→紫→粉渐变进度环 + 多巴胺柱状图 + 星光），装入 macOS 菜单栏 / 桌面卡片两个 app，网页新增 favicon
- 图标生成器 `scripts/gen-icon.swift` 进仓库：纯系统库绘制、零依赖，`swift scripts/gen-icon.swift <输出目录>` 一键产出全套尺寸（iconset / 预览图 / favicon）

### 🛠 正确性修复

- 服务双栈回环监听：修复部分环境下浏览器访问 `localhost` 报 `ERR_CONNECTION_REFUSED`（IPv4/IPv6 解析不一致）
- 全新用户（空 HOME / 空配置）首次启动体验：无凭证时额度卡片隐藏而非报错、零数据引导横幅、趋势图占位文案、Node 版本门槛中文前置拦截、端口全占用明确报错退出

## 1.3.0（2026-09-26）

商用就绪版本：全流程多代理审核（产品/交互 × 工程/安全）→ 双端开发 → QA → 视觉验收后的产物。

### 🔒 安全

- **修复 `/api/summary` 明文返回套餐密钥**（P0）：摘要载荷不再携带 `quotaKeys`，机密字段一律掩码；HTTP 增加 Host 白名单（非 localhost 直接 403，防 DNS rebinding 读取）；写接口强制 `Content-Type: application/json`（415），大请求体返回 413，坏 JSON 返回 400
- `config/plans.json` 原子写入（临时文件 + rename）、文件权限收紧为 600、损坏时自动备份 `.bak` 再落模板（不再静默覆盖用户配置）
- 菜单栏移除 `/tmp` 调试日志写入

### ✨ 新功能

- **数据导出**：每日明细 / 模型费用一键导出 CSV（带 BOM，Excel 直开），整份快照导出 JSON——数据属于你
- **端口发现**：服务把实际端口写入 `config/.port`，菜单栏 / 桌面卡片 / 网页自动跟随；7788 被占自动后移时三端不再失明（环境变量 `AI_QUOTA_PORT` 可强制指定）
- 菜单新增「打开桌面卡片」（⌘D），优先仓库相对路径、回退按应用名唤起
- 当日目标成本支持设 0（关闭目标横幅）

### 🛠 正确性修复

- WorkBuddy 缓存命中 token 求和运算符优先级 bug（缓存被清零 → 等价成本虚高）
- 采集器 NaN/脏行整行防护（时间戳、token 数、costUsd 非有限数不再污染聚合）
- 设置保存校验：非法价格/额度字段剔除，不再写出 NaN 成本
- `plans.json` mtime 缓存失效：外部脚本（如 ChatGPT token 同步）改文件后服务即时感知，设置面板不再用旧缓存回滚
- 服务首次构建竞态：并发请求等待同一次构建，不再 500

### ⚡ 性能

- 历史扫描默认回看 365 天（`AI_QUOTA_MAX_DAYS` 可调）：SQLite 查询加时间下界，jsonl 按文件 mtime 整文件跳过

### 🖥 macOS 端

- 菜单栏数据拉取全面异步化：主线程不再被阻塞（服务忙时菜单栏不再假死），迟到回调按代际丢弃
- 菜单固定深色玻璃 + 亮色多巴胺配色（不再随系统亮暗/壁纸变化导致看不清）；状态栏标题高亮色 + 深色投影
- 桌面卡片：副屏负坐标位置记忆修复、屏幕对象强解防护

### 🌐 Web UX

- 未配置凭证的额度卡不再渲染「假错误卡」；零用量工具卡折叠为一行（可展开）
- 首屏加载骨架 + 「看板服务未响应」错误横幅与重试按钮；设置保存成功/失败均有反馈
- 口径诚实化：模型费用表标注「全部历史」；数据源副标题补 `~/.claude`；昨日同期金额不再折行孤行

### 📦 打包与工程

- npm 发布就绪：`files` 白名单、bin 入口 shebang、`engines >= 22.13.0`（`node:sqlite` 无旗标最低版）
- 新增 GitHub Actions CI：Node 22.13/24 × Linux/macOS 测试矩阵 + Swift 语法检查
- MCP serverInfo 版本对齐 package.json；CLI `summary/models` 支持天数参数（`node mcp.js summary 30`）
- 单元测试 20 → **35**（采集器 fixture、安全回归、配置校验、端口文件）

## 1.2.0（2026-09-22）

- 新增：**Windows 支持**——服务端与全部采集器本就跨平台（`os.homedir()` 数据源、动态 `os.platform()` 凭证解密），本版补齐 Windows 形态：`start-all.cmd` / `stop-all.cmd` 一键启停（薄包装，逻辑在 `scripts/start-all.ps1`，含 node 版本检测、token 同步、端口探测与服务就绪等待）
- 新增：`menubar/tray.ps1` Windows 托盘插件（零依赖 PowerShell + WinForms，对齐 macOS 菜单栏）——圆盘图标按当日目标进度换色（绿/橙/红），左键弹全部明细（工具行多巴胺配色、本周合计、昨日同期、真实扣费、目标方块进度条、套餐 5h/周额度），目标 50% / 100% 里程碑系统通知（Toast），服务未就绪 15s 快速重试
- 新增：`desktop/widget.ps1` Windows 桌面卡片（零依赖 PowerShell + GDI+ 自绘，对齐 macOS 桌面组件）——暗色霓虹卡片（金额火焰渐变、发光进度条、渐变描边），可收起、可拖动（位置记在 `%LOCALAPPDATA%`）、右键切换置顶，高 DPI 适配
- 文档：README 中英文新增 Windows 章节（含开机自启 `shell:startup`、防火墙首次授权 FAQ），平台徽章加 Windows；package.json `os` 加 `win32`，版本 1.2.0

## 1.1.0（2026-09-22）

- 改版：「今日产出目标」改为「当日目标成本」——从产出冲刺（花得越多越燃）改为预算口径：剩余预算、按当前节奏预计用完时间、用完/超支预警；网页横幅、设置面板、菜单栏（含系统通知）、MCP 输出文案同步更新
- 改版：网页换装玄幻暗夜主题——极光漂移背景 + 星野 canvas 动效 + 玻璃拟态卡片 + 霓虹渐变进度条（流光效果）+ 首次入场动效；信息密度提升、留白压缩，模型费用表首列左对齐，趋势图 Y 轴整数刻度
- 新增：网页工具卡 / 套餐额度卡拖拽排序（Pointer Events 实现，顺序 localStorage 持久化）；设置面板新增 ✕ 关闭按钮与底部固定操作条，隐藏原生 number spinner
- 桌面卡片：霓虹渐变描边 + 光晕特效、金额火焰渐变、进度条发光；所有字段单行显示（自动缩字不换行），卡片加宽 246→262
- 菜单栏：状态栏标题多巴胺分段配色（金黄闪电 + 青色金额 + 目标/额度按紧张度分档变色），菜单工具行换高饱和多巴胺色系
- 文档：README 四张配图全部重拍（暗色主题 + 演示数据 + 宣传图排版，五卡同排 / 三色额度条 / 完整设置面板），中英文案同步；新增 `scripts/gen-demo-data.js` 演示数据生成器（隔离 HOME 跑假数据实例，可一键重产截图）

## 1.0.1（2026-09-22）

- 修复：实时额度进度条「剩余百分比」的浮点尾数显示（如「剩 12.700000000000003%」→「剩 12.7%」）
- 文档：README 全新改版（口语化产品介绍），新增看板界面截图（演示数据生成，`docs/screenshots/`）；新增英文版 README.en.md

## 1.0.0（2026-09-21）

首个公开发布版本。

- 看板服务：Web 单页看板（KPI 总览 / 工具卡片 / 带宽额度 / 每日明细 / 30 天趋势），60s 自动刷新
- 用量采集（全部只读）：ZCode（`~/.zcode` SQLite）、cc-switch 代理日志（Codex / Claude Desktop）、Claude Code（`~/.claude` jsonl）、WorkBuddy（`~/.workbuddy-ai` jsonl）
- 套餐实时额度：ChatGPT（wham/usage，5h + 周）、智谱 Coding Plan（团队版 quota/limit，5h + 周）、MiniMax Token Plan（coding_plan/remains，5h + 周），凭证支持自动发现与设置面板手动配置，失败自动降级
- 计价：内置单价表（元/百万 token）+ 网页设置面板覆盖（含未收录模型补价）、USD→CNY 汇率、月底线性预估、昨日同期对比
- 今日产出目标：横幅 / 菜单栏 / 桌面卡片进度 + 里程碑通知
- MCP Server（stdio，零依赖）：`ai_usage_summary` / `ai_usage_today` / `ai_usage_tool` / `ai_usage_models`，兼作 CLI
- macOS 菜单栏应用与桌面小组件（Swift 单文件，可选组件）
- 隐私：所有数据仅在本机读取与计算，配置文件（含 API Key）默认不进版本库
