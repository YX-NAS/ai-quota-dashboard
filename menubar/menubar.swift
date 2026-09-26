// AI 用量菜单栏插件 · 单文件 Swift
// 依赖看板服务（node server/index.js），端口见 serverPort()：环境变量 AI_QUOTA_PORT > 仓库根 config/.port > 默认 7788
// 编译: swiftc -O -o AIQuota.app/Contents/MacOS/AIQuota menubar.swift
import Cocoa
import Foundation

// 看板端口发现：① 环境变量 AI_QUOTA_PORT ② 仓库根 config/.port（bundlePath 上跳两级）③ 默认 7788，启动读一次后缓存
func serverPort() -> Int {
    enum PortCache { static var port = 0 }
    if PortCache.port > 0 { return PortCache.port }
    var port = 0
    if let s = ProcessInfo.processInfo.environment["AI_QUOTA_PORT"] { port = Int(s) ?? 0 }
    if port <= 0 {
        let f = (Bundle.main.bundlePath as NSString).appendingPathComponent("../../config/.port")
        if let s = try? String(contentsOfFile: (f as NSString).standardizingPath, encoding: .utf8) {
            port = Int(s.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        }
    }
    PortCache.port = port > 0 ? port : 7788
    return PortCache.port
}

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

// 一次当日刷新的完整结果（后台线程解析，主线程统一落库到全局变量）
struct DayFetchResult {
    var tools: [String: UsageAgg] = [:]
    var weekCny = 0.0
    var ySameCny = 0.0
    var todayGoalCny = 0.0
}

// 解析 /api/summary：当日各工具明细 + 本周合计 + 昨日同期 + 当日目标（纯函数，可后台线程调用）
func parseSummary(_ d: Data, date: String) -> DayFetchResult? {
    guard let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
          let agg = obj["agg"] as? [String: Any],
          let daily = agg["daily"] as? [String: Any],
          let dayRaw = daily[date] as? [String: Any] else { return nil }
    var r = DayFetchResult()
    for (k, v) in dayRaw {
        if let vd = v as? [String: Any] { r.tools[k] = UsageAgg(vd) }
    }
    // 本周合计（北京 ISO 周一起）
    let monday = bjWeekStart()
    for (k, v) in daily {
        guard k >= monday, let vd = v as? [String: Any], let tot = vd["__total"] as? [String: Any] else { continue }
        let a = UsageAgg(tot)
        r.weekCny += a.costCny + a.equivalentCny
    }
    // 昨日同期
    if let cmp = obj["cmp"] as? [String: Any],
       let ys = cmp["yesterdaySameTime"] as? [String: Any],
       let tot = ys["total"] as? [String: Any] {
        r.ySameCny = tot["cny"] as? Double ?? 0
    }
    if let plans = obj["plans"] as? [String: Any],
       let goal = plans["dailyGoal"] as? [String: Any],
       let g = goal["cny"] as? Double, g > 0 {
        r.todayGoalCny = g
    }
    return r
}

// 异步拉当日明细（completion 在主线程回调；result 为 nil 表示两个地址都失败，errMsg 为最后一条错误）
// days=8 覆盖整个 ISO 周（今天 + 最多前 7 天），一次请求同时取今日明细与本周合计
func fetchDayUsage(_ date: String, completion: @escaping (DayFetchResult?, String?) -> Void) {
    // 127.0.0.1 失败回退 localhost，沿用原双地址策略
    let urls = [URL(string: "http://127.0.0.1:\(serverPort())/api/summary?days=8")!,
                URL(string: "http://localhost:\(serverPort())/api/summary?days=8")!]
    func attempt(_ i: Int, lastErr: String?) {
        guard i < urls.count else { DispatchQueue.main.async { completion(nil, lastErr) }; return }
        let req = URLRequest(url: urls[i], timeoutInterval: 10)
        URLSession.shared.dataTask(with: req) { data, _, err in
            if err == nil, let d = data, let r = parseSummary(d, date: date) {
                DispatchQueue.main.async { completion(r, nil) }
                return
            }
            let msg = err.map { "网络: \($0.localizedDescription)" } ?? "解析失败(\(data?.count ?? 0)B)"
            attempt(i + 1, lastErr: msg)
        }.resume()
    }
    attempt(0, lastErr: nil)
}

var weekCny = 0.0 // 本周（周一起）等价成本合计（只在主线程读写）
var ySameCny = 0.0 // 昨日同期（昨日此刻之前）等价成本（只在主线程读写）
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
var todayGoalCny = 0.0 // 当日目标成本（plans.dailyGoal.cny，等价成本口径）

// 目标成本进度提示语（与网页同款分档）
func goalMessage(_ pct: Double) -> String {
    switch pct {
    case ..<1: return "新的一天，预算就位 🚀"
    case ..<25: return "预算充裕，安心干活 💭"
    case ..<50: return "消耗平稳，余量尚多 ✨"
    case ..<75: return "已用过半，留意节奏 🌀"
    case ..<100: return "预算将尽，要紧的优先 ⚠️"
    case ..<150: return "目标成本已用完 💸"
    default: return "已大幅超出目标成本 🚨"
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
        notifyOSX("今日成本已过半 🌀", String(format: "已 ¥%.0f / 目标 ¥%.0f，留意消耗节奏", spent, todayGoalCny))
    }
    if pct >= 100 && stage < 100 {
        stage = 100
        notifyOSX("🎯 当日目标成本已用完 💸", String(format: "已花 ¥%.0f · 达到目标 ¥%.0f，继续跑将超出", spent, todayGoalCny))
    }
    UserDefaults.standard.set(stage, forKey: "goalNotifyStage")
}
func notifyOSX(_ title: String, _ body: String) {
    // osascript 参数转义：先处理反斜杠再处理引号，避免拼接出越权转义
    func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }
    // 后台队列跑 osascript 并 waitUntilExit 回收子进程（防僵尸积累），不阻塞主线程
    DispatchQueue.global().async {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", "display notification \"\(esc(body))\" with title \"\(esc(title))\" sound name \"Glass\""]
        try? p.run()
        p.waitUntilExit()
    }
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

// 异步拉套餐实时额度（completion 在主线程回调；失败/为空返回空数组，语义同原 fetchQuotas() ?? []）
func fetchQuotas(completion: @escaping ([PlanQuota]) -> Void) {
    let u = URL(string: "http://127.0.0.1:\(serverPort())/api/summary?days=1")!
    URLSession.shared.dataTask(with: u) { data, _, _ in
        var out: [PlanQuota] = []
        if let d = data,
           let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
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
        }
        DispatchQueue.main.async { completion(out) }
    }.resume()
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

// ---------- 多巴胺配色（跟随菜单亮/暗外观自适应，保证对比度） ----------
// 教训：菜单弹层跟随系统外观（亮色系统的菜单是浅底），固定高亮色在浅底上不可读
struct Palette {
    let gold: NSColor      // 标题/合计
    let cyan: NSColor      // 金额/额度区块标题
    let pink: NSColor      // 超支警示
    let orange: NSColor    // 接近阈值
    let lime: NSColor      // 健康态
    let violet: NSColor    // WorkBuddy
    let money: NSColor     // 金额高亮（暗色=白，亮色=标签色）
    let tierGood: NSColor  // 额度/成本健康
    let tierMid: NSColor   // 接近阈值
    let tierHigh: NSColor  // 已超/紧急
}
func dopaminePalette(dark: Bool) -> Palette {
    if dark {
        return Palette(
            gold: NSColor(red: 1.0, green: 0.84, blue: 0.10, alpha: 1),
            cyan: NSColor(red: 0.20, green: 0.86, blue: 1.0, alpha: 1),
            pink: NSColor(red: 1.0, green: 0.29, blue: 0.51, alpha: 1),
            orange: NSColor(red: 1.0, green: 0.70, blue: 0.25, alpha: 1),
            lime: NSColor(red: 0.71, green: 1.0, blue: 0.25, alpha: 1),
            violet: NSColor(red: 0.78, green: 0.57, blue: 1.0, alpha: 1),
            money: .white,
            tierGood: NSColor(red: 0.35, green: 0.95, blue: 0.55, alpha: 1),
            tierMid: NSColor(red: 1.0, green: 0.77, blue: 0.10, alpha: 1),
            tierHigh: NSColor(red: 1.0, green: 0.33, blue: 0.33, alpha: 1))
    }
    // 亮色菜单：同名色相的深色版，浅底上对比度 ≥ 4.5:1
    return Palette(
        gold: NSColor(red: 0.65, green: 0.47, blue: 0.00, alpha: 1),
        cyan: NSColor(red: 0.00, green: 0.50, blue: 0.70, alpha: 1),
        pink: NSColor(red: 0.80, green: 0.04, blue: 0.40, alpha: 1),
        orange: NSColor(red: 0.75, green: 0.36, blue: 0.00, alpha: 1),
        lime: NSColor(red: 0.28, green: 0.50, blue: 0.00, alpha: 1),
        violet: NSColor(red: 0.46, green: 0.21, blue: 0.80, alpha: 1),
        money: .labelColor,
        tierGood: NSColor(red: 0.00, green: 0.48, blue: 0.25, alpha: 1),
        tierMid: NSColor(red: 0.68, green: 0.43, blue: 0.00, alpha: 1),
        tierHigh: NSColor(red: 0.78, green: 0.08, blue: 0.12, alpha: 1))
}

// 状态栏标题专用：高亮多巴胺色 + 深色描边/投影（字幕级可读性）。
// 菜单栏条的实际底色由壁纸+半透明材料决定，检测不可靠（系统外观和壁纸亮度都试过会踩反），
// 高亮色 + 深色描边在亮/暗条上都清晰，无需检测。
private let barGold = NSColor(red: 1.0, green: 0.84, blue: 0.04, alpha: 1)
private let barSky = NSColor(red: 0.36, green: 0.84, blue: 1.0, alpha: 1)
private let barPink = NSColor(red: 1.0, green: 0.48, blue: 0.72, alpha: 1)
private let barOrange = NSColor(red: 1.0, green: 0.70, blue: 0.25, alpha: 1)
private let barLime = NSColor(red: 0.71, green: 1.0, blue: 0.30, alpha: 1)
private let barHigh = NSColor(red: 1.0, green: 0.35, blue: 0.35, alpha: 1)
private let barMid = NSColor(red: 1.0, green: 0.77, blue: 0.24, alpha: 1)

func barSegment(_ s: String, _ color: NSColor, font: NSFont) -> NSAttributedString {
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.55)
    shadow.shadowBlurRadius = 2.5
    shadow.shadowOffset = NSSize(width: 0, height: 1)
    return NSAttributedString(string: s, attributes: [
        .font: font,
        .foregroundColor: color,
        .shadow: shadow,
    ])
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
    var refreshing = false // 刷新进行中：状态栏显示 ⚡ … 占位
    var fetchGen = 0 // 刷新代际：新刷新开始 +1，迟到回调代际不匹配即丢弃

    let toolNames: [String: String] = [
        "codex": "ChatGPT·Codex", "claudeDesktop": "Claude Desktop",
        "claudeCode": "Claude Code", "zcode": "ZCode", "workbuddy": "WorkBuddy",
    ]

    // 当前生效的多巴胺配色：菜单固定为深色玻璃 + 亮色版色板。
    // 不跟随系统亮暗——液态玻璃菜单的视觉底色由壁纸决定（跟系统模式无关），
    // 绑定系统外观会在「深色系统 + 亮壁纸」时产出亮色文字踩浅玻璃的糊面。
    // 固定深色玻璃后视觉恒定：永远是深底亮字，对比度有保证。
    var pal: Palette { dopaminePalette(dark: true) }

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
        // 代际 token：刷新期间状态栏显示 ⚡ …，超时迟到的旧请求结果不再写状态
        fetchGen += 1
        let gen = fetchGen
        refreshing = true
        updateTitle()
        fetchDayUsage(bjToday()) { [weak self] result, errMsg in
            guard let self = self, gen == self.fetchGen else { return }
            self.refreshing = false
            guard let result = result else {
                self.lastOK = false
                lastFetchError = errMsg
                self.toolRows = []
                self.todayTotal = (0, 0, 0)
                self.updateTitle()
                return
            }
            self.lastOK = true
            lastFetchError = nil
            // 全局可变量只在主线程写（本闭包已在主队列）
            weekCny = result.weekCny
            ySameCny = result.ySameCny
            if result.todayGoalCny > 0 { todayGoalCny = result.todayGoalCny }
            var rows: [(String, Int, Int, Double)] = []
            var totReq = 0, totTok = 0
            var totCny = 0.0
            var pay = 0.0
            for (key, name) in self.toolNames.sorted(by: { $0.value < $1.value }) {
                guard let a = result.tools[key] else { continue }
                let tok = a.inputTokens + a.outputTokens
                let cny = a.costCny + a.equivalentCny
                rows.append((name, a.requests, tok, cny))
                totReq += a.requests
                totTok += tok
                totCny += cny
                pay += a.payUsd
            }
            self.toolRows = rows
            self.todayTotal = (totReq, totTok, totCny)
            self.realPay = pay
            fetchQuotas { quotas in
                guard gen == self.fetchGen else { return }
                self.planQuotas = quotas
                if todayGoalCny > 0 {
                    self.goalPct = min(self.todayTotal.cny / todayGoalCny * 100, 999)
                    notifyGoalMilestone(pct: self.goalPct, spent: self.todayTotal.cny)
                }
                self.updateTitle()
                self.rebuildMenu()
            }
        }
    }

    func updateTitle() {
        guard let btn = statusItem.button else { return }
        btn.font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .bold)
        let font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .bold)
        // 高亮多巴胺色 + 深色投影：亮/暗菜单栏条上都清晰（不依赖外观检测）
        let text = NSMutableAttributedString()
        if refreshing {
            text.append(barSegment("⚡ …", .systemGray, font: font))
        } else if !lastOK {
            text.append(barSegment("⚡︎ --", .systemGray, font: font))
        } else {
            text.append(barSegment("⚡", barGold, font: font))
            text.append(barSegment(fmtCny(todayTotal.cny), barSky, font: font))
            if todayGoalCny > 0 {
                let gc: NSColor = goalPct >= 100 ? barPink : goalPct >= 75 ? barOrange : barLime
                text.append(barSegment(goalPct >= 100 ? " 💸" : String(format: " ·%.0f%%", goalPct), gc, font: font))
            }
            if let tightest = planQuotas.compactMap({ $0.fiveHour.usedPercent }).max() {
                let qc: NSColor = tightest > 85 ? barHigh : tightest > 60 ? barMid : barSky
                text.append(barSegment(" ·5h\(tightest)%", qc, font: font))
            }
        }
        btn.attributedTitle = text
    }

    func rebuildMenu() {
        let menu = NSMenu()

        // 信息行辅助：保持 enabled（避免系统置灰），上彩色
        // 多巴胺配色（自适应亮暗外观）
        let c = pal
        let toolColors: [String: NSColor] = [
            "ChatGPT·Codex": c.lime,
            "Claude Desktop": c.orange,
            "Claude Code": c.pink,
            "ZCode": c.cyan,
            "WorkBuddy": c.violet,
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

        infoItem("⚡ 今日 AI 用量（北京时间）", color: c.gold, bold: true, mono: false)
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
                // 金额部分单独高亮（暗色菜单=白，亮色菜单=标签色）
                if let r = m.title.range(of: "¥") {
                    let money = String(m.title[r.lowerBound...])
                    let attr = NSAttributedString(string: "        " + money, attributes: [
                        .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .bold),
                        .foregroundColor: c.money,
                    ])
                    text.replaceCharacters(in: NSRange(location: m.title.utf16.count - money.utf16.count, length: money.utf16.count), with: attr)
                }
                m.attributedTitle = text
                menu.addItem(m)
            }
            menu.addItem(.separator())
            infoItem(String(format: "合计 %d 次 · %@ · 等价 %@", todayTotal.req, fmtTok(todayTotal.tok) as NSString, fmtCny(todayTotal.cny) as NSString), color: c.gold, bold: true)
            infoItem(String(format: "本周（周一起）等价 %@", fmtCny(weekCny) as NSString), color: c.gold, bold: true)
            if ySameCny > 0.005 {
                let d = todayTotal.cny / ySameCny * 100 - 100
                let color: NSColor = d >= 0 ? c.tierGood : c.orange
                infoItem(String(format: "昨日同期 %@ · 今日 %@%.0f%%", fmtCny(ySameCny) as NSString, d >= 0 ? "↑" : "↓", abs(d)), color: color, bold: true)
            }
            if realPay > 0.005 {
                infoItem(String(format: "真实扣费 $%.2f（其余为套餐等价）", realPay), color: c.tierHigh, bold: true)
            }

            // 当日目标成本（方块进度条 + 提示语）：绿=余量健康，橙=接近目标，红=已用完/超出
            if todayGoalCny > 0 {
                menu.addItem(.separator())
                let filled = Int((goalPct / 100 * 10).rounded(.down))
                let bar = String(repeating: "▓", count: max(0, min(filled, 10))) + String(repeating: "░", count: 10 - max(0, min(filled, 10)))
                let color: NSColor = goalPct >= 100 ? c.tierHigh : goalPct >= 75 ? c.orange : c.tierGood
                infoItem(String(format: "🎯 成本 %@ %.0f%%  ¥%.0f/¥%.0f", bar as NSString, goalPct, todayTotal.cny, todayGoalCny), color: color, bold: true)
                infoItem("   " + goalMessage(goalPct), color: color, mono: false)
            }
        }

        // 套餐实时额度区块
        if !planQuotas.isEmpty {
            menu.addItem(.separator())
            infoItem("📶 套餐实时额度", color: c.cyan, bold: true, mono: false)
            for q in planQuotas {
                if let u5 = q.fiveHour.usedPercent {
                    // 按最紧的窗口选色：绿(<60) 黄(60-85) 红(>85)，自适应亮暗
                    let pct = max(u5, q.weekly.usedPercent ?? 0)
                    let color: NSColor = pct > 85 ? c.tierHigh : pct > 60 ? c.tierMid : c.tierGood
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
        let widgetItem = NSMenuItem(title: "打开桌面卡片", action: #selector(openWidget), keyEquivalent: "d")
        widgetItem.target = self
        menu.addItem(widgetItem)
        let refreshItem = NSMenuItem(title: "立即刷新", action: #selector(doRefresh), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)
        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        // 固定深色玻璃：菜单底色不再随壁纸/系统模式漂移，亮色文字永远有足够对比度
        menu.appearance = NSAppearance(named: .darkAqua)
        statusItem.menu = menu
    }

    @objc func doRefresh() { refresh(nil) }

    @objc func openWeb() {
        if let url = URL(string: "http://localhost:\(serverPort())") { NSWorkspace.shared.open(url) }
    }
    @objc func openWidget() {
        // 优先找与菜单栏 app 同仓库的 desktop/AIQuotaWidget.app（bundlePath 在 menubar/ 下，需上跳两级到仓库根）
        let sibling = (Bundle.main.bundlePath as NSString).appendingPathComponent("../../desktop/AIQuotaWidget.app")
        let path = (sibling as NSString).standardizingPath
        if FileManager.default.fileExists(atPath: path) {
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        } else {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            p.arguments = ["-a", "AIQuotaWidget"]
            try? p.run()
        }
    }
    @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)  // 菜单栏应用，不占 Dock
app.run()
