// AI 用量桌面小组件 · 单文件 Swift（浮动卡片、可拖动、记住位置）
// 数据源：看板服务 http://127.0.0.1:7788（node server/index.js）
// 编译: swiftc -O -o AIQuotaWidget.app/Contents/MacOS/AIQuotaWidget desktop-widget.swift
import Cocoa
import SwiftUI

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

// ---------- 数据 ----------
struct UsageAgg {
    var requests = 0, inputTokens = 0, outputTokens = 0
    var costUsd = 0.0, costCny = 0.0, equivalentCny = 0.0
    var subUsd = 0.0, payUsd = 0.0
    init(_ dict: [String: Any]) {
        if let v = dict["requests"] as? Int { requests = v }
        if let v = dict["inputTokens"] as? Int { inputTokens = v }
        if let v = dict["outputTokens"] as? Int { outputTokens = v }
        if let v = dict["costUsd"] as? Double { costUsd = v }
        if let v = dict["costCny"] as? Double { costCny = v }
        if let v = dict["equivalentCny"] as? Double { equivalentCny = v }
        if let v = dict["subUsd"] as? Double { subUsd = v }
        if let v = dict["payUsd"] as? Double { payUsd = v }
    }
}
struct QuotaWindow { var usedPercent: Int?; var resetMsLeft: Double? }
struct PlanQuota {
    var provider = ""
    var shortName = ""
    var fiveHour = QuotaWindow(); var weekly = QuotaWindow()
}
struct WidgetData {
    var ok = false
    var req = 0, tok = 0
    var cny = 0.0, payUsd = 0.0
    var quotas: [PlanQuota] = []
    var fetchedAt = Date.distantPast
    var collapsed = false
    var goalCny = 0.0   // 今日产出目标 ¥
    var goalPct = 0.0
    var weekCny = 0.0   // 本周（周一起）等价成本
}
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
// 目标成本进度提示语（与网页/菜单栏同款分档，预算口径）
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

func bjToday() -> String {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
    f.timeZone = TimeZone(identifier: "Asia/Shanghai")
    return f.string(from: Date())
}

func fetchWidgetData() -> WidgetData {
    var out = WidgetData()
    let sem = DispatchSemaphore(value: 0)
    let u = URL(string: "http://127.0.0.1:\(serverPort())/api/summary?days=8")!
    URLSession.shared.dataTask(with: u) { data, _, _ in
        defer { sem.signal() }
        guard let d = data,
              let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let agg = obj["agg"] as? [String: Any],
              let daily = agg["daily"] as? [String: Any] else { return }
        if let dayRaw = daily[bjToday()] as? [String: Any],
           let total = dayRaw["__total"] as? [String: Any] {
            let t = UsageAgg(total)
            out.req = t.requests
            out.tok = t.inputTokens + t.outputTokens
            out.cny = t.costCny + t.equivalentCny
            for (_, v) in dayRaw {
                if let vd = v as? [String: Any] { out.payUsd += UsageAgg(vd).payUsd }
            }
        }
        // 本周合计（北京 ISO 周一起）
        let monday = bjWeekStart()
        for (k, v) in daily {
            guard k >= monday, let vd = v as? [String: Any], let tot = vd["__total"] as? [String: Any] else { continue }
            let a = UsageAgg(tot)
            out.weekCny += a.costCny + a.equivalentCny
        }
        for (key, short) in [("chatgptQuota", "ChatGPT"), ("minimaxQuota", "MiniMax"), ("zhipuQuota", "智谱")] {
            guard let q = obj[key] as? [String: Any], (q["available"] as? Bool) == true else { continue }
            var pq = PlanQuota()
            pq.provider = (q["provider"] as? String) ?? short
            pq.shortName = short
            if let fh = q["fiveHour"] as? [String: Any] {
                pq.fiveHour = QuotaWindow(usedPercent: fh["usedPercent"] as? Int, resetMsLeft: fh["resetMsLeft"] as? Double)
            }
            if let wk = q["weekly"] as? [String: Any] {
                pq.weekly = QuotaWindow(usedPercent: wk["usedPercent"] as? Int, resetMsLeft: wk["resetMsLeft"] as? Double)
            }
            out.quotas.append(pq)
        }
        if let plans = obj["plans"] as? [String: Any],
           let goal = plans["dailyGoal"] as? [String: Any],
           let g = goal["cny"] as? Double, g > 0 {
            out.goalCny = g
            out.goalPct = min(out.cny / g * 100, 999)
        }
        out.ok = true
        out.fetchedAt = Date()
    }.resume()
    _ = sem.wait(timeout: .now() + 6)
    return out
}

// ---------- SwiftUI 界面 ----------
func fmtTok(_ v: Int) -> String {
    if Double(v) >= 1e8 { return String(format: "%.2f亿", Double(v)/1e8) }
    if Double(v) >= 1e4 { return String(format: "%.1f万", Double(v)/1e4) }
    return "\(v)"
}
func fmtReset(_ ms: Double?) -> String {
    guard let ms = ms, ms > 0 else { return "" }
    let h = Int(ms) / 3_600_000, m = Int(ms) % 3_600_000 / 60_000
    return h > 0 ? "\(h)h\(m)m" : "\(m)m"
}
func barColor(_ pct: Int) -> Color { pct > 85 ? .red : pct > 60 ? .yellow : .green }

struct Bar: View {
    let label: String; let pct: Int?; let reset: Double?
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                Spacer()
                if let p = pct {
                    Text("\(p)% · \(fmtReset(reset))").font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(p > 85 ? Color.red : Color.secondary)
                        .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                } else { Text("—").font(.system(size: 10)).foregroundStyle(.secondary) }
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.12))
                    Capsule().fill(
                        LinearGradient(colors: [barColor(pct ?? 0).opacity(0.75), barColor(pct ?? 0)],
                                       startPoint: .leading, endPoint: .trailing)
                    )
                    .shadow(color: barColor(pct ?? 0).opacity(0.55), radius: 2.5)
                    .frame(width: pct != nil ? g.size.width * CGFloat(min(pct!, 100)) / 100 : 0)
                }
            }.frame(height: 4)
        }
    }
}

// 金额主数：火焰渐变 + 光晕（与网页横幅同款渐变语言）
struct AmountText: View {
    let value: Double
    let size: CGFloat
    var body: some View {
        Text("¥\(value, specifier: "%.2f")")
            .font(.system(size: size, weight: .semibold, design: .rounded))
            .foregroundStyle(
                LinearGradient(colors: [
                    Color(red: 1.0, green: 0.78, blue: 0.25),
                    Color(red: 1.0, green: 0.45, blue: 0.42),
                    Color(red: 0.91, green: 0.47, blue: 0.98),
                ], startPoint: .leading, endPoint: .trailing)
            )
            .shadow(color: Color(red: 1.0, green: 0.45, blue: 0.42).opacity(0.4), radius: 5)
            .lineLimit(1).fixedSize(horizontal: true, vertical: false)
    }
}

struct CardView: View {
    @ObservedObject var store: DataStore
    var onRefresh: () -> Void
    var onToggleCollapse: () -> Void
    var onClose: () -> Void

    // 小圆按钮（无 @State：命令行编译不支持宏，用固定浅背景即可）
    struct CircleBtn: View {
        let symbol: String
        let tip: String
        let action: () -> Void
        var body: some View {
            Button(action: action) {
                Image(systemName: symbol)
                    .font(.system(size: 9, weight: .medium))
                    .frame(width: 18, height: 18)
                    .background(Circle().fill(Color.primary.opacity(0.08)))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help(tip)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center) {
                Text("⚡ 今日 AI 用量")
                    .font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                Text(store.data.fetchedAt == .distantPast ? "" : store.data.fetchedAt.formatted(.dateTime.hour().minute()))
                    .font(.system(size: 9)).foregroundStyle(.tertiary)
                Spacer()
                CircleBtn(symbol: "arrow.clockwise", tip: "立即刷新", action: onRefresh)
                CircleBtn(symbol: store.data.collapsed ? "chevron.down" : "chevron.up",
                          tip: store.data.collapsed ? "展开" : "收起", action: onToggleCollapse)
                CircleBtn(symbol: "xmark", tip: "退出小组件", action: onClose)
            }
            if !store.data.ok {
                Text("看板服务未响应\n启动: node server/index.js")
                    .font(.system(size: 11)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 12)
            } else if store.data.collapsed {
                // 折叠态：费用 + 总 token + 各套餐 5h 百分比（所有字段单行）
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        AmountText(value: store.data.cny, size: 17)
                        if store.data.payUsd > 0.005 {
                            Text(String(format: "实扣 $%.2f", store.data.payUsd))
                                .font(.system(size: 10)).foregroundStyle(.secondary)
                                .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                        } else {
                            Text("套餐内").font(.system(size: 10)).foregroundStyle(.green)
                        }
                        Spacer()
                    }
                    Text("\(store.data.req) 次 · \(fmtTok(store.data.tok)) tokens")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                        .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                    HStack(spacing: 10) {
                        Text("5h").font(.system(size: 10)).foregroundStyle(.tertiary)
                        ForEach(store.data.quotas, id: \.shortName) { q in
                            HStack(spacing: 3) {
                                Circle().fill(barColor(q.fiveHour.usedPercent ?? 0)).frame(width: 5, height: 5)
                                Text(q.shortName).font(.system(size: 10)).foregroundStyle(.secondary)
                                Text(q.fiveHour.usedPercent != nil ? "\(q.fiveHour.usedPercent!)%" : "—")
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(q.fiveHour.usedPercent.map(barColor) ?? Color.secondary)
                            }
                            .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                        }
                    }
                    if store.data.goalCny > 0 {
                        Text(String(format: "🎯 目标 %.0f%%  ¥%.0f/¥%.0f %@", store.data.goalPct, store.data.cny, store.data.goalCny,
                                    store.data.goalPct >= 100 ? "🎆" : ""))
                            .font(.system(size: 10))
                            .foregroundStyle(store.data.goalPct >= 100 ? .green : .orange)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .allowsTightening(true)
                    }
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    AmountText(value: store.data.cny, size: 26)
                    if store.data.payUsd > 0.005 {
                        Text(String(format: "实扣 $%.2f", store.data.payUsd))
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                            .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                    } else {
                        Text("全部在套餐内").font(.system(size: 10)).foregroundStyle(.green)
                            .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                    }
                    Spacer()
                }
                Text("\(store.data.req) 次 · \(fmtTok(store.data.tok)) tokens")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                Text(String(format: "本周累计 ¥%.2f（周一起）", store.data.weekCny))
                    .font(.system(size: 10)).foregroundStyle(.tertiary)
                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                ForEach(store.data.quotas, id: \.shortName) { q in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(q.shortName).font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                            .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                        Bar(label: "5h", pct: q.fiveHour.usedPercent, reset: q.fiveHour.resetMsLeft)
                        Bar(label: "周", pct: q.weekly.usedPercent, reset: q.weekly.resetMsLeft)
                    }
                }
                if store.data.goalCny > 0 {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text("🎯 当日目标成本").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                                .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                            Spacer()
                            Text(store.data.goalPct >= 100 ? "💯" : String(format: "%.0f%%", store.data.goalPct))
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(store.data.goalPct >= 100 ? .green : .orange)
                                .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                        }
                        Bar(label: "¥", pct: Int(min(store.data.goalPct, 100)), reset: nil)
                        Text(goalMessage(store.data.goalPct))
                            .font(.system(size: 9)).foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .allowsTightening(true)
                    }
                    .padding(.top, 2)
                }
            }
        }
        .padding(14)
        .frame(width: 262)
        .background(HeightProbe())   // 上报内容真实高度 → 窗口自适应
        .background(VisualEffectBlur())
        .overlay(
            // 霓虹渐变描边 + 柔和光晕
            RoundedRectangle(cornerRadius: 18)
                .strokeBorder(
                    AngularGradient(colors: [
                        Color(red: 0.18, green: 0.84, blue: 0.96),
                        Color(red: 0.43, green: 0.49, blue: 1.0),
                        Color(red: 0.91, green: 0.47, blue: 0.98),
                        Color(red: 1.0, green: 0.7, blue: 0.25),
                        Color(red: 0.18, green: 0.84, blue: 0.96),
                    ], center: .center),
                    lineWidth: 1.2
                )
                .opacity(0.65)
        )
        .shadow(color: Color(red: 0.43, green: 0.49, blue: 1.0).opacity(0.30), radius: 14)
        .clipShape(RoundedRectangle(cornerRadius: 18))
    }
}

struct VisualEffectBlur: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .hudWindow
        v.blendingMode = .behindWindow
        v.state = .active
        return v
    }
    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

// SwiftUI 内容自测量：CardView 每次布局把自己的真实高度上报给窗口（比 intrinsicContentSize 可靠）
final class HeightBox {
    var onReport: ((CGFloat) -> Void)?
}
let widgetHeightBox = HeightBox()
struct HeightProbe: View {
    var body: some View {
        GeometryReader { g in
            Color.clear
                .onAppear { widgetHeightBox.onReport?(g.size.height) }
                .onChange(of: g.size.height) { _, h in widgetHeightBox.onReport?(h) }
        }
    }
}

final class DataStore: ObservableObject {
    @Published var data = WidgetData()
    private var timer: Timer?
    private let collapseKey = "AIQuotaWidgetCollapsed"
    init() {
        data.collapsed = UserDefaults.standard.bool(forKey: collapseKey)
        reload()
        timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in self?.reload() }
    }
    func reload() {
        DispatchQueue.global().async {
            var d = fetchWidgetData()
            DispatchQueue.main.async {
                d.collapsed = self.data.collapsed // 刷新不丢折叠状态
                self.data = d
            }
        }
    }
    func toggleCollapse() {
        data.collapsed.toggle()
        UserDefaults.standard.set(data.collapsed, forKey: collapseKey)
    }
}

// 自定义窗口：任何内容区按下都触发原生拖动（SwiftUI 会吞 mouseDown，isMovableByWindowBackground 失效）
final class WidgetWindow: NSWindow {
    override func mouseDown(with event: NSEvent) {
        performDrag(with: event)
    }
}

// ---------- 窗口 ----------
final class WidgetAppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let store = DataStore()
    let positionKey = "AIQuotaWidgetFrame"
    static let cardWidth: CGFloat = 262

    // 窗口高度 = SwiftUI 内容自适应（NSHostingView 内建约束自动贴合；此方法作为兜底，上边缘锚定）
    func setHeight(_ h: CGFloat, animated: Bool) {
        guard let window = window else { return }
        let h = max(h, 80)
        let f = window.frame
        guard abs(f.height - h) > 0.5 else { return }
        // 保持上边缘位置不变，向下伸缩
        window.setFrame(NSRect(x: f.origin.x, y: f.maxY - h, width: f.width, height: h),
                        display: true, animate: animated)
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        let collapsed = UserDefaults.standard.bool(forKey: "AIQuotaWidgetCollapsed")
        store.data.collapsed = collapsed
        let size = NSSize(width: Self.cardWidth, height: collapsed ? 120 : 280) // 初值，首帧布局后按上报高度校准
        // 拿不到主屏时用默认 frame 兜底（不强解崩溃）
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        var origin = NSPoint(x: screen.maxX - size.width - 24, y: screen.maxY - size.height - 60)
        if let saved = UserDefaults.standard.string(forKey: positionKey) {
            let parts = saved.split(separator: ",").compactMap { Double($0) }
            if parts.count == 2 {
                let p = NSPoint(x: parts[0], y: parts[1])
                // 位置校验：允许副屏负坐标，只要落在任一屏幕可见帧范围内即视为有效
                let onAnyScreen = NSScreen.screens.contains { s in s.visibleFrame.contains(p) }
                if onAnyScreen && abs(p.x) < 40000 && abs(p.y) < 40000 { origin = p }
            }
        }
        window = WidgetWindow(contentRect: NSRect(origin: origin, size: size),
                          styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        // floating 层：常驻可见但不抢焦点（desktopWindow 层在部分系统 borderless 下不渲染，弃用）
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        window.isMovableByWindowBackground = true
        window.hasShadow = true
        window.hidesOnDeactivate = false
        window.title = "AIQuotaWidget"
        // SwiftUI 内容上报高度 → 校准窗口（折叠切换等大幅变化带动画，常规刷新直接贴合）
        // 必须在挂载 hosting view 之前注册：首帧布局在 contentView 赋值时就会触发 onAppear
        widgetHeightBox.onReport = { [weak self] h in
            DispatchQueue.main.async {
                guard let self = self, let f = self.window?.frame else { return }
                let animated = abs(f.height - h) > 40
                self.setHeight(h, animated: animated)
            }
        }
        let host = NSHostingView(rootView: CardView(
            store: store,
            onRefresh: { [weak self] in self?.store.reload() },
            onToggleCollapse: { [weak self] in self?.toggleCollapse() },
            onClose: { [weak self] in self?.quit() }
        ))
        host.frame = NSRect(origin: .zero, size: size)
        host.autoresizingMask = [.width, .height] // 窗口高度变化时内容跟随
        window.contentView = host

        let menu = NSMenu()
        let top = NSMenuItem(title: "切换置顶/普通", action: #selector(toggleTop), keyEquivalent: "t"); top.target = self
        let collapse = NSMenuItem(title: "收起/展开卡片", action: #selector(toggleCollapse), keyEquivalent: "e"); collapse.target = self
        let web = NSMenuItem(title: "打开看板网页", action: #selector(openWeb), keyEquivalent: "w"); web.target = self
        let refresh = NSMenuItem(title: "立即刷新", action: #selector(refreshNow), keyEquivalent: "r"); refresh.target = self
        let quit = NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q"); quit.target = self
        for i in [top, collapse, web, refresh, quit] { menu.addItem(i) }
        window.menu = menu

        NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: window, queue: .main) { [weak self] _ in
            guard let self = self, let f = self.window?.frame.origin else { return }
            UserDefaults.standard.set("\(f.x),\(f.y)", forKey: self.positionKey)
        }
        window.makeKeyAndOrderFront(nil)
    }

    var isTop = false
    @objc func toggleTop() {
        isTop.toggle()
        window.level = isTop ? .statusBar : .floating
    }
    @objc func toggleCollapse() {
        store.toggleCollapse() // 高度由 $data 订阅自动校准
    }
    @objc func openWeb() { if let u = URL(string: "http://localhost:\(serverPort())") { NSWorkspace.shared.open(u) } }
    @objc func refreshNow() { store.reload() }
    @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = WidgetAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
