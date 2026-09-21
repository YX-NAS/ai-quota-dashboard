# AI 额度看板 · ai-quota-dashboard

本地优先（local-first）的 AI 工具用量与套餐额度监控看板。一个零依赖的 Node 服务，读取你本机 AI 工具的只读数据，展示**每日用量、成本、套餐实时额度（5h / 周窗口）与月底预估**，并附赠 MCP Server 与 macOS 菜单栏 / 桌面组件。

**所有数据只在本机读取与计算，不上传任何服务器，配置文件里的 API Key 永不离开你的电脑。**

## 支持什么

| 用量采集（本地只读） | 数据来源 |
|---|---|
| ChatGPT · Codex | `~/.cc-switch/cc-switch.db` 代理日志（实际 `cost_usd`） |
| Claude Desktop | 同上（cc-switch 代理日志，按 app_type 拆分） |
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| ZCode | `~/.zcode/cli/db/db.sqlite`（只计 completed） |
| WorkBuddy | `~/.workbuddy-ai/projects/**/*.jsonl` |

| 套餐实时额度（尽力而为，失败自动降级） | 接口 | 凭证来源 |
|---|---|---|
| ChatGPT（5h + 周窗口） | `chatgpt.com/backend-api/wham/usage` | `~/.codex/auth.json` 自动读取，或设置面板手动配置 |
| 智谱 Coding Plan 团队版（5h + 周窗口） | `open.bigmodel.cn` quota/limit | ZCode OAuth / WorkBuddy / ZCode 配置自动发现，或设置面板手动配置 |
| MiniMax Token Plan（5h + 周窗口） | `minimaxi.com` coding_plan/remains | `~/.workbuddy-ai/models.json` 自动发现，或设置面板手动配置 |

没装某个工具？对应采集器静默跳过，看板照常工作。

## 快速开始

要求：**Node.js 22+**（使用内置 `node:sqlite`，零 npm 依赖，无需 `npm install`）。macOS / Linux 均可；菜单栏与桌面组件仅 macOS。

```bash
git clone <本仓库地址> ai-quota-dashboard
cd ai-quota-dashboard
node server/index.js
# → http://localhost:7788（端口占用自动 +1）
```

首次启动会自动生成 `config/plans.json` 配置模板（额度、汇率等在网页「设置」里改即可）。

**macOS 一键启动（服务 + 菜单栏 + 桌面卡片）：**

```bash
./start-all.sh     # 可重复执行，已启动的跳过
./stop-all.sh      # 一键停止
```

开机自启：系统设置 → 通用 → 登录项 → 点「+」添加 `start-all.sh`（以「打开」方式注册）。

## 功能一览

- **🎯 今日产出目标**（默认 ¥200/天，设置里可改）：网页火焰渐变横幅（进度 + 分档鼓励语 + 按当前节奏的达标预测），菜单栏实时百分比（达标 🎆）+ 50%/100% 里程碑系统通知，桌面卡片目标进度条
- **昨日对比**：KPI / 横幅 / 工具卡 / 菜单栏 / MCP 显示「昨日同期」与「昨日全天」费用对比
- 四张工具卡片：今日 / 本月用量、本周 / 本月费用、额度进度、月底线性预估
- 每日明细表（7/30/90 天切换）+ 30 天成本堆叠趋势图（纯 SVG）
- 实时套餐额度（5h + 周窗口，带重置倒计时）
- **设置面板**（网页内即可完成全部配置）：
  - 各工具月额度（等价 ¥）与套餐名
  - USD→CNY 汇率、今日产出目标
  - 模型单价编辑（元/百万 token，留空 = 默认价，填数 = 覆盖，一键恢复默认；含未收录模型的补价入口）
  - 实时额度 Key（智谱 / MiniMax / ChatGPT，可手动配置；脱敏回显，留空回退自动发现）

## 口径（重要）

| 工具 | 成本口径 |
|---|---|
| Codex / Claude Desktop | cc-switch 代理日志的实际 `cost_usd`，按汇率折算展示 |
| ZCode / WorkBuddy / Claude Code（套餐路由） | **订阅制**，展示「等价按量成本」（内置单价表 × token），非实际扣费 |

数据源全部**只读**，绝不写入任何工具的原始数据库。日期切分按北京时间。

## MCP Server（供 ZCode / Claude Code / Codex / WorkBuddy 等调用）

`mcp/mcp.js` 是一个零依赖的 stdio MCP server，复用看板的采集与计价模块。在任何 MCP 客户端注册：

```bash
# Claude Code
claude mcp add --scope user ai-quota -- node /path/to/ai-quota-dashboard/mcp/mcp.js
# Codex
codex mcp add ai-quota -- node /path/to/ai-quota-dashboard/mcp/mcp.js
# 其他客户端：按 stdio server 配置，命令 node，参数 mcp/mcp.js 的绝对路径
```

提供 4 个工具：`ai_usage_summary(days)` / `ai_usage_today` / `ai_usage_tool(tool, days)` / `ai_usage_models`。

也可以当 CLI 直接跑：

```bash
node mcp/mcp.js today          # 今日简报
node mcp/mcp.js summary 30     # 近 30 天汇总
node mcp/mcp.js tool:zcode 7   # ZCode 近 7 天
node mcp/mcp.js models         # 模型维度费用
```

## macOS 组件（可选）

**菜单栏 ⚡︎**（`menubar/AIQuota.app`）：原生 Swift 单文件应用，显示今日等价成本 + 最紧窗口额度，点击展开各工具明细与实时额度（带重置倒计时）。每 5 分钟自动刷新。

**桌面卡片**（`desktop/AIQuotaWidget.app`）：SwiftUI 毛玻璃卡片，贴桌面不抢焦点，可收起/展开、拖动摆放（位置自动记住），显示今日金额 + 各套餐 5h/周进度条。

两者都需要看板服务在运行。重新编译：

```bash
cd menubar && swiftc -O -o AIQuota.app/Contents/MacOS/AIQuota menubar.swift
cd desktop && swiftc -O -o AIQuotaWidget.app/Contents/MacOS/AIQuotaWidget desktop-widget.swift
```

## 配置说明

全部配置在 `config/plans.json`（首次运行自动生成，已被 `.gitignore` 排除，模板见 `config/plans.example.json`）：

```jsonc
{
  "usdCnyRate": 7.2,                    // USD→CNY 汇率
  "plans": {                             // 每个工具的套餐名与月额度（等价 ¥）
    "zcode": { "label": "ZCode", "plan": "…", "cnyPerDay": null, "cnyPerMonth": 598 }
  },
  "priceOverrides": { "glm-5.3": { "in": 8, "out": 28, "cacheRead": 2 } },  // 单价覆盖（元/百万 token）
  "quotaKeys": {                         // 实时额度凭证（留空 = 自动发现）
    "zhipu":   { "token": "", "organizationId": "", "projectId": "" },
    "minimax": { "apiKey": "" },
    "chatgpt": { "accessToken": "" }
  },
  "dailyGoal": { "cny": 200 }            // 今日产出目标
}
```

推荐直接在网页「设置」面板里改，机密字段回显自动脱敏。

## 测试

```bash
node test/run-tests.js                  # 单元测试（计价/聚合/预估）
python3 test/verify-against-sources.py  # 独立复算今日数据，与页面对账
```

## 隐私与安全

- 所有采集只读，不写入任何工具的数据库
- API Key / OAuth Token 只保存在本机 `config/plans.json`，接口返回时脱敏
- 服务只监听 `127.0.0.1`，外部无法访问
- 实时额度接口（ChatGPT wham/usage、智谱 quota/limit、MiniMax remains）为厂商非公开端点，仅做只读查询；若接口变动导致不可用，看板自动降级为仅本地用量统计

## 目录结构

```
server/index.js         HTTP 服务 + 60s 定时刷新
server/collectors/      用量采集器 ×4 + 实时额度采集 ×3
server/lib/             计价 / 聚合 / 配置
web/                    前端单页（零依赖）
mcp/mcp.js              MCP Server（兼 CLI）
menubar/ desktop/       macOS 菜单栏与桌面组件（Swift，可选）
config/plans.json       用户配置（自动生成，不进版本库）
test/                   单元测试 + 数据核验
docs/DESIGN.md          设计文档
```

## License

[MIT](LICENSE)
