# 🎯 AI Quota Dashboard

[English](README.en.md) | [中文](README.md)

![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)

**You use AI coding tools every day — but can you answer: how much did today cost? How much of your Zhipu 5-hour window is left? What will this month cost at the current pace?**

This dashboard turns those questions into one screen of numbers. It quietly reads the local records of ZCode, Claude Code, Codex and WorkBuddy on your machine, prices every request, and watches every quota window — **nothing ever leaves your computer**.

![Dashboard overview: daily cost target + KPIs + per-tool cards](docs/screenshots/dashboard.png)

> The UI is in Chinese (dates follow Asia/Shanghai). PRs to internationalize the web UI are welcome. Screenshots above use **demo data**.

## What you get

**Real-time 5-hour / weekly quota bars for every plan** — turns yellow, then red, as you approach the limit, with reset countdowns. No more logging into vendor consoles to check usage:

![Real-time plan quotas](docs/screenshots/quotas.png)

**Where the money goes** — a daily breakdown table and a 30-day stacked trend chart, per tool and per model:

![Daily breakdown](docs/screenshots/daily.png)

**Everything is configurable in the browser**: exchange rate, monthly quotas, model prices, quota API keys (masked on display):

![Settings panel](docs/screenshots/settings.png)

- 💸 **Today's spend**: one card per tool with today / week / month costs; subscription tools get an "equivalent pay-as-you-go" estimate so they're comparable with metered ones
- 🎯 **Daily cost target**: set a ¥200/day budget and track remaining budget plus projected exhaustion time in the banner, the percentage in the menu bar, and a system notification when it's used up (💸)
- 🆚 **vs yesterday**: same-time comparison, green when you're shipping more
- 🔌 **MCP server**: let ZCode / Claude Code / Codex answer "how much quota did I burn this week?"

## 🚀 Up and running in 30 seconds

Install [Node.js 22+](https://nodejs.org), then:

```bash
git clone https://github.com/YX-NAS/ai-quota-dashboard.git
cd ai-quota-dashboard
node server/index.js
# Open http://localhost:7788 — that's it.
```

Zero npm dependencies, no `npm install`. A config template is generated on first launch; everything else lives in the in-app Settings panel.

macOS one-click full setup (server + menu bar ⚡︎ + desktop widget):

```bash
./start-all.sh     # idempotent — running components are skipped
./stop-all.sh      # stop everything
```

Launch at login: System Settings → General → Login Items → add `start-all.sh`.

## 🧰 What it supports

| Usage collectors (local, read-only) | Data source |
|---|---|
| ChatGPT · Codex | cc-switch proxy logs (actual `cost_usd`) |
| Claude Desktop | same logs, split by app_type |
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |
| WorkBuddy | `~/.workbuddy-ai/projects/**/*.jsonl` |

| Real-time plan quotas (best-effort) | Credentials |
|---|---|
| ChatGPT (5h + weekly) | auto-read from `~/.codex/auth.json`, or set in Settings |
| Zhipu (GLM) Coding Plan, team edition (5h + weekly) | auto-discovered from ZCode OAuth / WorkBuddy / ZCode config, or set manually |
| MiniMax Token Plan (5h + weekly) | auto-discovered from `~/.workbuddy-ai/models.json`, or set manually |

A tool you don't use? Its card simply doesn't appear.

## 💰 How costs are calculated

| Tool | Cost basis |
|---|---|
| Codex / Claude Desktop | actual `cost_usd` from proxy logs, converted at your rate |
| ZCode / WorkBuddy / Claude Code (plan-routed) | **subscription** — shows "equivalent pay-as-you-go cost" (built-in price table × tokens), clearly labeled as non-billing |

Built-in prices (CNY per million tokens) cover common GLM / MiniMax / DeepSeek models and are editable in Settings. Unlisted models count tokens only — no made-up numbers. Days split by Beijing time.

## 🔌 MCP server

Register once in any MCP client and your assistant can answer quota questions anytime:

```bash
# Claude Code
claude mcp add --scope user ai-quota -- node /path/to/ai-quota-dashboard/mcp/mcp.js
# Codex
codex mcp add ai-quota -- node /path/to/ai-quota-dashboard/mcp/mcp.js
```

Exposes `ai_usage_summary` / `ai_usage_today` / `ai_usage_tool` / `ai_usage_models`; doubles as a CLI:

```bash
node mcp/mcp.js today        # today's brief
node mcp/mcp.js summary 30   # last 30 days
```

## 🍯 macOS menu bar + desktop widget (optional)

- **Menu bar ⚡︎**: today's cost + tightest quota window, full breakdown on click, auto-refresh every 5 minutes
- **Desktop widget**: frosted-glass card pinned to the desktop, collapsible, draggable, position remembered

Build with one command each (needs macOS + Xcode CLT):

```bash
cd menubar && swiftc -O -o AIQuota.app/Contents/MacOS/AIQuota menubar.swift
cd desktop && swiftc -O -o AIQuotaWidget.app/Contents/MacOS/AIQuotaWidget desktop-widget.swift
```

## ⚙️ Configuration

Everything lives in `config/plans.json` (auto-generated; excluded by gitignore; see [config/plans.example.json](config/plans.example.json)). In-app Settings is recommended; secret fields are masked.

```jsonc
{
  "usdCnyRate": 7.2,
  "plans": { "zcode": { "cnyPerMonth": 598 } },
  "priceOverrides": { "glm-5.3": { "in": 8, "out": 28, "cacheRead": 2 } },
  "quotaKeys": { "zhipu": { "token": "" } },
  "dailyGoal": { "cny": 200 }
}
```

## 🧪 Tests

```bash
node test/run-tests.js                  # unit tests (pricing / aggregation / forecast)
python3 test/verify-against-sources.py  # independently recompute today's numbers
```

## ❓ FAQ

**A tool card shows no data?**
That tool isn't installed or has no records yet; its collector is skipped. Check the source path exists (see table above).

**Read failures / empty data on macOS?**
Almost certainly macOS TCC. Grant Full Disk Access to your terminal app (or node) under System Settings → Privacy & Security, then restart.

**Real-time quota shows "unavailable"?**
An expired manually-set token, most likely. Clear the key in Settings (falls back to auto-discovery), or re-run `python3 scripts/sync-chatgpt-token.py` for ChatGPT. These endpoints are undocumented vendor APIs; when they change, the dashboard degrades to local stats only.

**Port 7788 taken?**
It automatically tries the next 20 ports; the actual URL is in the startup log.

**Can I trust the numbers?**
They reconcile row-for-row with the source databases. Run `python3 test/verify-against-sources.py` to cross-check any day.

**Server / LAN deployment?**
It's a single-machine tool by design (local data sources, binds to `127.0.0.1`). Run one copy per machine; bring your own authenticated reverse proxy for remote access.

## 🔒 Privacy & security

- All collection is **read-only**; no tool's database is ever written
- API keys stay in local `config/plans.json`, masked in API responses
- Server binds to `127.0.0.1` only
- No uploads, no sync, no telemetry — your usage data is yours

## 📂 Project layout

```
server/index.js         HTTP server + 60s refresh loop
server/collectors/      4 usage collectors + 3 real-time quota collectors
server/lib/             pricing / aggregation / config
web/                    zero-dependency frontend
mcp/mcp.js              MCP server (doubles as CLI)
menubar/ desktop/       optional macOS menu bar & desktop widget (Swift)
config/plans.json       user config (auto-generated, not committed)
test/                   unit tests + data cross-check
docs/                   design doc + screenshots
```

## License

[MIT](LICENSE)
