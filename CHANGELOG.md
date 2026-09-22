# Changelog

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
