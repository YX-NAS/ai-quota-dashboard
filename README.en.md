# AI Quota Dashboard

[English](README.en.md) | [中文](README.md)

![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)

A local-first dashboard for monitoring your AI tools: daily usage, cost, plan quota in real time (5-hour / weekly windows) and month-end forecasts. One zero-dependency Node service reads read-only data from the AI tools on your machine, and ships with an MCP server plus optional macOS menu bar / desktop widgets.

**All data is read and computed locally. Nothing is uploaded anywhere, and the API keys in your config never leave your computer.**

> The UI is in Chinese (dates follow Asia/Shanghai). PRs to internationalize the web UI are welcome.

## What it supports

| Usage collectors (local, read-only) | Data source |
|---|---|
| ChatGPT · Codex | proxy logs in `~/.cc-switch/cc-switch.db` (actual `cost_usd`) |
| Claude Desktop | same cc-switch proxy logs, split by `app_type` |
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| ZCode | `~/.zcode/cli/db/db.sqlite` (completed requests only) |
| WorkBuddy | `~/.workbuddy-ai/projects/**/*.jsonl` |

| Real-time plan quotas (best-effort, degrades gracefully) | Endpoint | Credentials |
|---|---|---|
| ChatGPT (5h + weekly windows) | `chatgpt.com/backend-api/wham/usage` | read automatically from `~/.codex/auth.json`, or set manually in Settings |
| Zhipu (GLM) Coding Plan, team edition (5h + weekly) | `open.bigmodel.cn` quota/limit | auto-discovered from ZCode OAuth / WorkBuddy / ZCode config, or set manually |
| MiniMax Token Plan (5h + weekly) | `minimaxi.com` coding_plan/remains | auto-discovered from `~/.workbuddy-ai/models.json`, or set manually |

Don't have one of these tools installed? Its collector is skipped silently and the rest of the dashboard works as usual.

## Quick start

Requirements: **Node.js 22+** (built-in `node:sqlite`, zero npm dependencies — no `npm install`). Works on macOS and Linux; the menu bar app and desktop widget are macOS-only.

```bash
git clone https://github.com/YX-NAS/ai-quota-dashboard.git
cd ai-quota-dashboard
node server/index.js
# → http://localhost:7788 (automatically tries the next port if taken)
```

On first launch a `config/plans.json` template is generated automatically (edit everything from the in-app Settings panel).

**macOS one-click start (server + menu bar + desktop widget):**

```bash
./start-all.sh     # idempotent — running components are skipped
./stop-all.sh      # stop everything
```

Launch at login: System Settings → General → Login Items → add `start-all.sh` (via "Open with").

## Features

- **🎯 Daily output goal** (default ¥200/day, configurable): flame-gradient web banner with pace forecast, live percentage in the menu bar (🎆 on target), 50%/100% milestone notifications, goal progress bar on the desktop widget
- **Yesterday comparison**: KPIs / banner / tool cards / menu bar / MCP all show "yesterday same time" and "yesterday full day" deltas
- Four tool cards: today / month-to-date usage, weekly & monthly cost, quota progress, linear month-end forecast
- Daily detail table (7/30/90 days) + 30-day stacked cost chart (pure SVG)
- Real-time plan quotas (5h + weekly windows with reset countdowns)
- **Settings panel** (everything configurable in the browser):
  - Per-tool plan name and monthly quota (equivalent ¥)
  - USD→CNY rate, daily output goal
  - Model price editor (CNY per million tokens; empty = default, number = override, one-click reset; supports pricing unlisted models)
  - Quota API keys (Zhipu / MiniMax / ChatGPT; masked on display, empty falls back to auto-discovery)

## Cost accounting (important)

| Tool | Cost basis |
|---|---|
| Codex / Claude Desktop | actual `cost_usd` from cc-switch proxy logs, converted at your configured rate |
| ZCode / WorkBuddy / Claude Code (plan-routed) | **subscription** — shows "equivalent pay-as-you-go cost" (built-in price table × tokens), not actual billing |

All data sources are **read-only**; no tool's database is ever written to. Days are split by Beijing time.

## MCP server (for ZCode / Claude Code / Codex / WorkBuddy, etc.)

`mcp/mcp.js` is a zero-dependency stdio MCP server reusing the dashboard's collectors and pricing. Register it in any MCP client:

```bash
# Claude Code
claude mcp add --scope user ai-quota -- node /path/to/ai-quota-dashboard/mcp/mcp.js
# Codex
codex mcp add ai-quota -- node /path/to/ai-quota-dashboard/mcp/mcp.js
# Other clients: stdio server, command node, args = absolute path to mcp/mcp.js
```

Exposes 4 tools: `ai_usage_summary(days)` / `ai_usage_today` / `ai_usage_tool(tool, days)` / `ai_usage_models`.

Also works as a CLI:

```bash
node mcp/mcp.js today          # today's brief
node mcp/mcp.js summary 30     # last 30 days
node mcp/mcp.js tool:zcode 7   # per-tool detail
node mcp/mcp.js models         # cost by model
```

## macOS extras (optional)

**Menu bar ⚡︎** (`menubar/AIQuota.app`): native single-file Swift app showing today's equivalent cost plus the tightest quota window, with a per-tool breakdown and live plan quotas (with reset countdowns). Refreshes every 5 minutes.

**Desktop widget** (`desktop/AIQuotaWidget.app`): SwiftUI frosted-glass card pinned to the desktop (never steals focus), collapsible, draggable (position remembered), showing today's cost and 5h/weekly quota bars.

Both require the dashboard server to be running. Rebuild after editing the Swift sources:

```bash
cd menubar && swiftc -O -o AIQuota.app/Contents/MacOS/AIQuota menubar.swift
cd desktop && swiftc -O -o AIQuotaWidget.app/Contents/MacOS/AIQuotaWidget desktop-widget.swift
```

## Configuration

Everything lives in `config/plans.json` (auto-generated on first launch; excluded by `.gitignore`; see `config/plans.example.json`):

```jsonc
{
  "usdCnyRate": 7.2,                    // USD→CNY rate
  "plans": {                             // per-tool plan name & monthly quota (equivalent ¥)
    "zcode": { "label": "ZCode", "plan": "…", "cnyPerDay": null, "cnyPerMonth": 598 }
  },
  "priceOverrides": { "glm-5.3": { "in": 8, "out": 28, "cacheRead": 2 } },  // CNY per M tokens
  "quotaKeys": {                         // real-time quota credentials (empty = auto-discovery)
    "zhipu":   { "token": "", "organizationId": "", "projectId": "" },
    "minimax": { "apiKey": "" },
    "chatgpt": { "accessToken": "" }
  },
  "dailyGoal": { "cny": 200 }            // daily output goal
}
```

Editing via the in-app Settings panel is recommended; secret fields are masked on display.

## Tests

```bash
node test/run-tests.js                  # unit tests (pricing / aggregation / forecast)
python3 test/verify-against-sources.py  # independently recompute today's numbers and cross-check
```

## FAQ

**A tool card shows no data?**
That tool isn't installed or has no local records; its collector is skipped silently. Check that the source path exists: `~/.zcode/cli/db/db.sqlite`, `~/.cc-switch/cc-switch.db`, `~/.claude/projects/`, `~/.workbuddy-ai/projects/`.

**Read failures / empty data on macOS?**
macOS TCC may block terminal apps from reading `~/.codex`, `~/.zcode`, etc. Grant Full Disk Access to your terminal app (or node) under System Settings → Privacy & Security → Full Disk Access, then restart the server.

**Real-time quota shows "unavailable"?**
Usually an expired manually-set token. Clear the key in Settings (falls back to auto-discovery) or re-run `python3 scripts/sync-chatgpt-token.py`. These quota endpoints are undocumented vendor APIs; when they change, the dashboard degrades to local-usage-only without affecting usage/cost data.

**Port 7788 taken?**
The server automatically tries the next 20 ports; the actual URL is printed to the startup log (`/tmp/ai-quota-server.log`).

**Can I deploy it on a server / share over LAN?**
It's designed as a single-machine, local tool: data sources live in each machine's home directory and the server binds to `127.0.0.1` only. Run one copy per machine; put your own authenticated reverse proxy in front if you need remote access.

## Privacy & security

- All collection is read-only; nothing is written to any tool's database
- API keys / OAuth tokens stay in local `config/plans.json` and are masked in API responses
- The server listens on `127.0.0.1` only
- The real-time quota endpoints (ChatGPT wham/usage, Zhipu quota/limit, MiniMax remains) are undocumented vendor APIs used read-only; if they change, the dashboard degrades gracefully to local usage stats only

## Project layout

```
server/index.js         HTTP server + 60s refresh loop
server/collectors/      4 usage collectors + 3 real-time quota collectors
server/lib/             pricing / aggregation / config
web/                    zero-dependency frontend single page
mcp/mcp.js              MCP server (doubles as CLI)
menubar/ desktop/       optional macOS menu bar & desktop widget (Swift)
config/plans.json       user config (auto-generated, not committed)
test/                   unit tests + data cross-check
docs/DESIGN.md          design document
```

## License

[MIT](LICENSE)
