// AI 用量菜单栏插件 · 单文件 Swift
// 依赖看板服务 http://localhost:7788（node server/index.js）
// 编译: swiftc -O -o AIQuota.app/Contents/MacOS/AIQuota menubar.swift
import Cocoa
import Foundation

// ---------- 数据模型 ----------
// daily[date] 是混合体（数值字段 + 工具对象），Codable 处理麻烦，直接用 JSONSerialization
struct UsageAgg {
    var requests = 0, inputTokens = 0, outputTokens = 0
    var costUsd = 0.0, costCny = 0.0, equivalentCny = 0.0
    var subUsd = 0.0, payUsd = 0.0, subRequests = 0, payRequests = 0
    init(_ dict: [String: Any]) {
        if let v = dict["requests"] as? Int { requests = v }
        if let v = dict["inputTokens"] as? Int { inputTokens = v }
        if let v = dict["outputTokens"] as? Int { outputTokens = v }
        if let v = dict["costUsd"] as? Double { costUsd = v }
        if let v = dict["costCny"] as? Double { costCny = v }
        if let v = dict["equivalentCny"] as? Double { equivalentCny = v }
        if let v = dict["subUsd"] as? Double { subUsd = v }
        if let v = dict["payUsd"] as? Double { payUsd = v }
        if let v = dict["subRequests"] as? Int { subRequests = v }
        if let v = dict["payRequests"] as? Int { payRequests = v }
    }
}

func fetchDayUsage(_ date: String) -> [String: UsageAgg]? {
    let sem = DispatchSemaphore(value: 0)
    var result: [String: UsageAgg]?
    // days=8 覆盖整个 ISO 周（今天 + 最多前 7 天），一次请求同时取今日明细与本周合计
    let urls = [URL(string: "http://127.0.0.1:7788/api/summary?days=8")!,
                URL(string: "http://localhost:7788/api/summary?days=8")!]
    for u in urls {
        URLSession.shared.dataTask(with: u) { data, _, err in
            defer { sem.signal() }
            if let err = err { lastFetchError = "网络: \(err.localizedDescription)"; return }
            guard let d = data,
                  let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
                  let agg = obj["agg"] as? [String: Any],
                  let daily = agg["daily"] as? [String: Any],
                  let dayRaw = daily[date] as? [String: Any] else {
                lastFetchError = "解析失败(\(data?.count ?? 0)B)"
                return
            }
            var tools: [String: UsageAgg] = [:]
            for (k, v) in dayRaw {
                if let vd = v as? [String: Any] { tools[k] = UsageAgg(vd) }
            }
            result = tools
            // 本周合计（北京 ISO 周一起）
            let monday = bjWeekStart()
            var wk = 0.0
            for (k, v) in daily {
                guard k >= monday, let vd = v as? [String: Any], let tot = vd["__total"] as? [String: Any] else { continue }
                let a = UsageAgg(tot)
                wk += a.costCny + a.equivalentCny
            }
            weekCny = wk
            // 昨日同期
            if let cmp = obj["cmp"] as? [String: Any],
               let ys = cmp["yesterdaySameTime"] as? [String: Any],
               let tot = ys["total"] as? [String: Any] {
                ySameCny = tot["cny"] as? Double ?? 0
            }
            if let plans = obj["plans"] as? [String: Any],
               let goal = plans["dailyGoal"] as? [String: Any],
               let g = goal["cny"] as? Double, g > 0 {
                todayGoalCny = g
            }
            lastFetchError = nil
        }.resume()
        _ = sem.wait(timeout: .now() + 5)
        if result != nil { break }
    }
    return result
}

var weekCny = 0.0 // 本周（周一起）等价成本合计
var ySameCny = 0.0 // 昨日同期（昨日此刻之前）等价成本
func bjWeekStart() -> String {
    var cal = Calendar(identifier: .iso8601)
    cal.timeZone = TimeZone(identifier: "Asia/Shanghai")!
    let comps = cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: Date())
    let monday = cal.date(from: comps) ?? Date()
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = cal.timeZone
    return f.string(from: monday)
}

var lastFetchError: String? = "尚未获取"
var todayGoalCny = 0.0 // 今日产出目标（plans.dailyGoal.cny，等价成本口径）

// 目标进度鼓励语（与网页同款分档）
func goalMessage(_ pct: Double) -> String {
    switch pct {
    case ..<1: return "新的一天，等你点火 🚀"
    case ..<25: return "热身中，思路冒泡 💭"
    case ..<50: return "渐入佳境，火花积聚 ✨"
    case ..<75: return "火力全开，脑洞大开 🌀"
    case ..<100: return "冲刺！火花四射就在眼前 🔥"
    case ..<150: return "达标！今日火花四射 🎆"
    default: return "超神发挥，刹不住车 🏆"
    }
}

// 里程碑系统通知（50% / 100% 各一次，跨天自动重置）
func notifyGoalMilestone(pct: Double, spent: Double) {
    let df = DateFormatter(); df.dateFormat = "yyyy-MM-dd"; df.timeZone = TimeZone(identifier: "Asia/Shanghai")
    let today = df.string(from: Date())
    let lastDate = UserDefaults.standard.string(forKey: "goalNotifyDate") ?? ""
    if lastDate != today { UserDefaults.standard.set(today, forKey: "goalNotifyDate"); UserDefaults.standard.set(0, forKey: "goalNotifyStage") }
    var stage = UserDefaults.standard.integer(forKey: "goalNotifyStage")
    if pct >= 50 && stage < 50 {
        stage = 50
        notifyOSX("今日产出过半 ✨", String(format: "已 ¥%.0f / ¥%.0f，火花正在积聚，继续！", spent, todayGoalCny))
    }
    if pct >= 100 && stage < 100 {
        stage = 100
        notifyOSX("🎯 今日产出目标达成！", String(format: "已跑够 ¥%.0f 的 token · 火花四射 🎆", todayGoalCny))
    }
    UserDefaults.standard.set(stage, forKey: "goalNotifyStage")
}
func notifyOSX(_ title: String, _ body: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-e", "display notification \"\(body.replacingOccurrences(of: "\"", with: "'"))\" with title \"\(title.replacingOccurrences(of: "\"", with: "'"))\" sound name \"Glass\""]
    try? p.run()
}

// 套餐实时额度（5h/周窗口）
struct QuotaWindow {
    var usedPercent: Int?      // 已用百分比
    var resetMsLeft: Double?   // 重置倒计时
}
struct PlanQuota {
    var provider = ""
    var fiveHour = QuotaWindow()
    var weekly = QuotaWindow()
}

func fetchQuotas() -> [PlanQuota]? {
    let sem = DispatchSemaphore(value: 0)
    var result: [PlanQuota]?
    let u = URL(string: "http://127.0.0.1:7788/api/summary?days=1")!
    URLSession.shared.dataTask(with: u) { data, _, _ in
        defer { sem.signal() }
        guard let d = data,
              let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
        var out: [PlanQuota] = []
        for key in ["chatgptQuota", "minimaxQuota", "zhipuQuota"] {
            guard let q = obj[key] as? [String: Any], (q["available"] as? Bool) == true else { continue }
            var pq = PlanQuota()
            pq.provider = (q["provider"] as? String) ?? key
            if let fh = q["fiveHour"] as? [String: Any] {
                pq.fiveHour = QuotaWindow(usedPercent: fh["usedPercent"] as? Int,
                                          resetMsLeft: fh["resetMsLeft"] as? Double)
            }
            if let wk = q["weekly"] as? [String: Any] {
                pq.weekly = QuotaWindow(usedPercent: wk["usedPercent"] as? Int,
                                        resetMsLeft: wk["resetMsLeft"] as? Double)
            }
            out.append(pq)
        }
        if !out.isEmpty { result = out }
    }.resume()
    _ = sem.wait(timeout: .now() + 5)
    return result
}

func fmtReset(_ ms: Double?) -> String {
    guard let ms = ms, ms > 0 else { return "" }
    let h = Int(ms) / 3_600_000, m = Int(ms) % 3_600_000 / 60_000
    return "剩\(h)h\(m)m"
}

func bjToday() -> String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = TimeZone(identifier: "Asia/Shanghai")
    return f.string(from: Date())
}

func fmtCny(_ v: Double) -> String { String(format: "¥%.2f", v) }
func fmtTok(_ v: Int) -> String {
    if v >= 100_000_000 { return String(format: "%.2f亿", Double(v)/1e8) }
    if v >= 10_000 { return String(format: "%.1f万", Double(v)/1e4) }
    return "\(v)"
}

// ---------- 菜单栏应用 ----------
final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var timer: Timer?

    // 今日快照
    var todayTotal = (req: 0, tok: 0, cny: 0.0)
    var toolRows: [(String, Int, Int, Double)] = []  // 名称, 请求, token, ¥
    var realPay = 0.0
    var lastOK = false
    var planQuotas: [PlanQuota] = []
    var goalPct = 0.0

    let toolNames: [String: String] = [
        "codex": "ChatGPT·Codex", "claudeDesktop": "Claude Desktop",
        "claudeCode": "Claude Code", "zcode": "ZCode", "workbuddy": "WorkBuddy",
    ]

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        rebuildMenu()
        refresh(nil)
        timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            self?.refresh(nil)
        }
    }

    @objc func refresh(_ sender: Any?) {
        let today = bjToday()
        guard let dayObj = fetchDayUsage(today) else {
            lastOK = false
            toolRows = []
            todayTotal = (0, 0, 0)
            updateTitle()
            return
        }
        lastOK = true

        var rows: [(String, Int, Int, Double)] = []
        var totReq = 0, totTok = 0
        var totCny = 0.0
        var pay = 0.0
        for (key, name) in toolNames.sorted(by: { $0.value < $1.value }) {
            guard let a = dayObj[key] else { continue }
            let tok = a.inputTokens + a.outputTokens
            let cny = a.costCny + a.equivalentCny
            rows.append((name, a.requests, tok, cny))
            totReq += a.requests
            totTok += tok
            totCny += cny
            pay += a.payUsd
        }
        toolRows = rows
        todayTotal = (totReq, totTok, totCny)
        realPay = pay
        planQuotas = fetchQuotas() ?? []
        if todayGoalCny > 0 {
            goalPct = min(todayTotal.cny / todayGoalCny * 100, 999)
            notifyGoalMilestone(pct: goalPct, spent: todayTotal.cny)
        }
        updateTitle()
        rebuildMenu()
    }

    func updateTitle() {
        guard let btn = statusItem.button else { return }
        // 高对比度：加粗 + 系统标签色（状态栏默认正文色，禁用置灰效果）
        btn.font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .bold)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .bold),
        ]
        if !lastOK {
            btn.attributedTitle = NSAttributedString(string: "⚡︎ --", attributes: attrs)
        } else {
            // 金额 + 目标进度 + 最紧张的 5h 窗口百分比；额度紧张时整体变警示色
            var goalPart = ""
            if todayGoalCny > 0 {
                goalPart = goalPct >= 100 ? " 🎆" : String(format: " ·%.0f%%", goalPct)
            }
            var suffix = ""
            var warning = false
            if let tightest = planQuotas.compactMap({ $0.fiveHour.usedPercent }).max() {
                suffix = " ·5h\(tightest)%"
                warning = tightest > 85
            }
            let text = "⚡︎ " + fmtCny(todayTotal.cny) + goalPart + suffix
            let finalAttrs = warning ? attrs.merging([.foregroundColor: NSColor.systemRed]) { $1 } : attrs
            btn.attributedTitle = NSAttributedString(string: text, attributes: finalAttrs)
        }
        try? "title=\(btn.title) lastOK=\(lastOK) rows=\(toolRows.count) quotas=\(planQuotas.count) goal=\(todayGoalCny)>\(Int(goalPct))% err=\(lastFetchError ?? "-")".write(toFile: "/tmp/aiquota_debug.log", atomically: true, encoding: .utf8)
    }

    func rebuildMenu() {
        let menu = NSMenu()

        // 信息行辅助：保持 enabled（避免系统置灰），上彩色
        // 工具行配色（暗色菜单栏下选高亮度系）
        let toolColors: [String: NSColor] = [
            "ChatGPT·Codex": .systemGreen,
            "Claude Desktop": .systemOrange,
            "Claude Code": .systemPurple,
            "ZCode": .systemCyan,
            "WorkBuddy": .systemBlue,
        ]

        func infoItem(_ title: String, color: NSColor = .labelColor, bold: Bool = false, mono: Bool = true) -> NSMenuItem {
            let m = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let font = bold
                ? NSFont.systemFont(ofSize: 13, weight: .semibold)
                : NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium)
            m.attributedTitle = NSAttributedString(string: title, attributes: [
                .font: font,
                .foregroundColor: color,
            ])
            menu.addItem(m)
            return m
        }

        infoItem("⚡ 今日 AI 用量（北京时间）", color: .systemYellow, bold: true, mono: false)
        menu.addItem(.separator())

        if toolRows.isEmpty {
            infoItem(lastOK ? "今天还没有请求" : ("获取失败: " + (lastFetchError ?? "?")))
        } else {
            // 对齐的明细行：工具名带各自品牌色，金额白色加粗
            for (name, req, tok, cny) in toolRows {
                let color = toolColors[name] ?? .labelColor
                let m = NSMenuItem(title: String(format: "%-16s %5d 次  ¥%7.2f", (name as NSString).utf8String!, req, cny), action: nil, keyEquivalent: "")
                let text = NSMutableAttributedString()
                text.append(NSAttributedString(string: m.title, attributes: [
                    .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium),
                    .foregroundColor: color,
                ]))
                // 金额部分单独上白色粗体
                if let r = m.title.range(of: "¥") {
                    let money = String(m.title[r.lowerBound...])
                    let attr = NSAttributedString(string: "        " + money, attributes: [
                        .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .bold),
                        .foregroundColor: NSColor.white,
                    ])
                    text.replaceCharacters(in: NSRange(location: m.title.utf16.count - money.utf16.count, length: money.utf16.count), with: attr)
                }
                m.attributedTitle = text
                menu.addItem(m)
            }
            menu.addItem(.separator())
            infoItem(String(format: "合计 %d 次 · %@ · 等价 %@", todayTotal.req, fmtTok(todayTotal.tok) as NSString, fmtCny(todayTotal.cny) as NSString), color: .systemYellow, bold: true)
            infoItem(String(format: "本周（周一起）等价 %@", fmtCny(weekCny) as NSString), color: .systemYellow, bold: true)
            if ySameCny > 0.005 {
                let d = todayTotal.cny / ySameCny * 100 - 100
                let color: NSColor = d >= 0 ? .systemGreen : .systemOrange
                infoItem(String(format: "昨日同期 %@ · 今日 %@%.0f%%", fmtCny(ySameCny) as NSString, d >= 0 ? "↑" : "↓", abs(d)), color: color, bold: true)
            }
            if realPay > 0.005 {
                infoItem(String(format: "真实扣费 $%.2f（其余为套餐等价）", realPay), color: .systemRed, bold: true)
            }

            // 今日产出目标（方块进度条 + 鼓励语）
            if todayGoalCny > 0 {
                menu.addItem(.separator())
                let filled = Int((goalPct / 100 * 10).rounded(.down))
                let bar = String(repeating: "▓", count: max(0, min(filled, 10))) + String(repeating: "░", count: 10 - max(0, min(filled, 10)))
                let color: NSColor = goalPct >= 100 ? .systemGreen : goalPct >= 75 ? .systemYellow : .systemOrange
                infoItem(String(format: "🎯 目标 %@ %.0f%%  ¥%.0f/¥%.0f", bar as NSString, goalPct, todayTotal.cny, todayGoalCny), color: color, bold: true)
                infoItem("   " + goalMessage(goalPct), color: color, mono: false)
            }
        }

        // 套餐实时额度区块
        if !planQuotas.isEmpty {
            menu.addItem(.separator())
            infoItem("📶 套餐实时额度", color: .systemTeal, bold: true, mono: false)
            for q in planQuotas {
                if let u5 = q.fiveHour.usedPercent {
                    // 按最紧的窗口选色：绿(<60) 黄(60-85) 红(>85)
                    let pct = max(u5, q.weekly.usedPercent ?? 0)
                    let color: NSColor = pct > 85 ? .systemRed : pct > 60 ? .systemYellow : .systemGreen
                    let m = NSMenuItem(title: String(format: "  %@  5h %d%% %@ ｜ 周 %d%% %@", q.provider, u5, fmtReset(q.fiveHour.resetMsLeft), q.weekly.usedPercent ?? -1, fmtReset(q.weekly.resetMsLeft)), action: nil, keyEquivalent: "")
                    m.attributedTitle = NSAttributedString(string: m.title, attributes: [
                        .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .semibold),
                        .foregroundColor: color,
                    ])
                    menu.addItem(m)
                }
            }
        }

        menu.addItem(.separator())
        let webItem = NSMenuItem(title: "打开看板网页", action: #selector(openWeb), keyEquivalent: "w")
        webItem.target = self
        menu.addItem(webItem)
        let refreshItem = NSMenuItem(title: "立即刷新", action: #selector(doRefresh), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)
        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        statusItem.menu = menu
    }

    @objc func doRefresh() { refresh(nil) }

    @objc func openWeb() {
        if let url = URL(string: "http://localhost:7788") { NSWorkspace.shared.open(url) }
    }
    @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)  // 菜单栏应用，不占 Dock
app.run()
