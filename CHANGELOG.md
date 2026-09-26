# Changelog

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
