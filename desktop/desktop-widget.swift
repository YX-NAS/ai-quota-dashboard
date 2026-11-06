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
    var costText = ""            // 月费标注（$19.9/月·≈¥143 / ¥119/月）
    var fiveHour = QuotaWindow(); var weekly = QuotaWindow()
}
// 按量服务商行（与网页「按量统计」区对齐：今日/本月费用 + 余额 + Key 健康）
struct PaygRowData {
    var id = ""                  // providerId 作稳定 id（同厂商多 provider 已并为一行，id 取首个）
    var label = ""
    var todayCny = 0.0, monthCny = 0.0
    var reqs = 0
    var balText = "—"            // 余额短文案：¥6380 / 未充值 / 需配AK / 未配
    var keyOk: Bool? = nil       // nil = 未探测
}
struct WidgetData {
    var ok = false
    var req = 0, tok = 0
    var cny = 0.0, payUsd = 0.0
    var quotas: [PlanQuota] = []
    var payg: [PaygRowData] = []
    var paygToday = 0.0          // 按量服务商今日费用合计
    var fetchedAt = Date.distantPast
    var collapsed = false
    var goalCny = 0.0   // 今日产出目标 ¥
    var goalPct = 0.0
    var weekCny = 0.0   // 本周（周一起）等价成本
    // 网络流量（与网页「网络流量」卡对齐：当前网络 + 今日上下行 + 每日目标进度条）
    var netLabel = ""
    var netRx = 0.0, netTx = 0.0            // 今日字节
    var netRxRate = 0.0, netTxRate = 0.0    // 实时速率（字节/秒，本轮差值口径）
    var netGoalBytes = 0.0, netPct = 0.0    // 0 = 未配目标（不画进度条）
    // VPN 流量包（对齐网页「套餐统计」VPN 卡：订阅计量，服务端账单；-1 = 不可用整行隐藏）
    var vpnPct = -1.0
    var vpnRemaining = 0.0, vpnToday = 0.0  // 字节
    var vpnDaysLeft = -1                    // -1 = 无到期信息
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

// 拉一次 /api/summary 组装卡片数据（内部 6s 超时兜底）。
// 并发交接说明：sem.wait 超时返回后，URLSession 回调线程仍可能迟到执行——out 被逃逸闭包按引用
// 捕获，若回调直接改写 out 会与调用线程 return 时的结构体拷贝构成无同步数据竞争（撕裂读风险）。
// 因此回调先在局部变量 r 装好完整结果，最后在锁内一次性交给 out；调用线程也在锁内读出快照。
// 超时后迟到的回调只会安全地写一个即将被丢弃的局部箱，主路径（reload 的异步包装）语义不变。
func fetchWidgetData() -> WidgetData {
    var out = WidgetData()
    let lock = NSLock()
    let sem = DispatchSemaphore(value: 0)
    let u = URL(string: "http://127.0.0.1:\(serverPort())/api/summary?days=8")!
    URLSession.shared.dataTask(with: u) { data, _, _ in
        defer { sem.signal() }
        guard let d = data,
              let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let agg = obj["agg"] as? [String: Any],
              let daily = agg["daily"] as? [String: Any] else { return }
        var r = WidgetData()
        if let dayRaw = daily[bjToday()] as? [String: Any],
           let total = dayRaw["__total"] as? [String: Any] {
            let t = UsageAgg(total)
            r.req = t.requests
            r.tok = t.inputTokens + t.outputTokens
            r.cny = t.costCny + t.equivalentCny
            // payUsd 只累加各工具桶；__total 已是各工具之和，跳过避免双计（与 widget.ps1 同口径）
            for (k, v) in dayRaw where k != "__total" {
                if let vd = v as? [String: Any] { r.payUsd += UsageAgg(vd).payUsd }
            }
        }
        // 本周合计（北京 ISO 周一起）
        let monday = bjWeekStart()
        for (k, v) in daily {
            guard k >= monday, let vd = v as? [String: Any], let tot = vd["__total"] as? [String: Any] else { continue }
            let a = UsageAgg(tot)
            r.weekCny += a.costCny + a.equivalentCny
        }
        // 套餐月费文案（USD 真实订阅价优先，附 ¥ 折算；否则用等价月额度）
        let plansObj = obj["plans"] as? [String: Any]
        let plansPlans = plansObj?["plans"] as? [String: Any]
        let fx = ((plansObj?["usdCnyRate"] as? NSNumber)?.doubleValue ?? 7.2)
        func costText(_ toolKey: String) -> String {
            guard let p = plansPlans?[toolKey] as? [String: Any] else { return "" }
            if let u = (p["usdPerMonth"] as? NSNumber)?.doubleValue, u > 0 {
                return String(format: "$%.1f/月 · ≈¥%.0f", u, u * fx)
            }
            if let c = (p["cnyPerMonth"] as? NSNumber)?.doubleValue, c > 0 {
                return String(format: "¥%.0f/月", c)
            }
            return ""
        }
        let shortToolMap = [("chatgptQuota", "ChatGPT", "codex"), ("minimaxQuota", "MiniMax", "workbuddy"), ("zhipuQuota", "智谱", "")]
        for (key, short, toolKey) in shortToolMap {
            guard let q = obj[key] as? [String: Any], (q["available"] as? Bool) == true else { continue }
            var pq = PlanQuota()
            pq.provider = (q["provider"] as? String) ?? short
            pq.shortName = short
            pq.costText = toolKey.isEmpty ? "" : costText(toolKey)
            if let fh = q["fiveHour"] as? [String: Any] {
                pq.fiveHour = QuotaWindow(usedPercent: (fh["usedPercent"] as? NSNumber)?.intValue, resetMsLeft: (fh["resetMsLeft"] as? NSNumber)?.doubleValue)
            }
            if let wk = q["weekly"] as? [String: Any] {
                pq.weekly = QuotaWindow(usedPercent: (wk["usedPercent"] as? NSNumber)?.intValue, resetMsLeft: (wk["resetMsLeft"] as? NSNumber)?.doubleValue)
            }
            r.quotas.append(pq)
        }
        // 按量服务商行：apiBilling.providers(payg) × vendors 费用桶 × apiBilling[vendor] 余额 × keyChecks
        if let ab = obj["apiBilling"] as? [String: Any],
           let provs = ab["providers"] as? [[String: Any]] {
            let vends = obj["vendors"] as? [String: Any] ?? [:]
            let kcs = ab["keyChecks"] as? [String: Any] ?? [:]
            func balText(_ vendor: String, _ q: [String: Any]?) -> String {
                guard let q = q, (q["available"] as? Bool) == true else {
                    if vendor == "bailian" { return "需配AK" }
                    return (q?["notConfigured"] as? Bool) == true ? "未配key" : "—"
                }
                if vendor == "zhipu", let ac = q["account"] as? [String: Any] {
                    let b = (ac["availableBalance"] as? NSNumber) ?? (ac["balance"] as? NSNumber)
                    return b != nil ? String(format: "¥%.0f", b!.doubleValue) : "未充值"
                }
                if let bal = q["balance"] as? [String: Any], let t = (bal["total"] as? NSNumber)?.doubleValue {
                    return String(format: "¥%.0f", t)
                }
                return "—"
            }
            // 同服务商多个按量 provider 合并为一行（余额/费用本就按服务商口径，拆行只是重复同组数字）；
            // 与网页「按量统计」并卡策略一致。keyOk 取各 key 与：任一失效即失效，全未探测为 nil
            var byVendor: [String: Int] = [:]   // vendor → r.payg 下标
            for p in provs {
                guard (p["billingKind"] as? String) != "subscription" else { continue }
                let vendor = (p["vendor"] as? String) ?? ""
                guard !vendor.isEmpty else { continue }
                let pid = p["providerId"] as? String
                if let i = byVendor[vendor] {
                    if let pid = pid, let kk = kcs[pid] as? [String: Any] {
                        let ok = (kk["ok"] as? Bool) ?? false
                        r.payg[i].keyOk = (r.payg[i].keyOk == false || ok == false) ? false : true
                    }
                    continue
                }
                byVendor[vendor] = r.payg.count
                var row = PaygRowData()
                row.id = pid ?? vendor
                row.label = shortVendor(vendor, (p["label"] as? String) ?? vendor)
                if let pid = pid, let kk = kcs[pid] as? [String: Any] {
                    row.keyOk = (kk["ok"] as? Bool) ?? false
                }
                if let vv = vends[vendor] as? [String: Any] {
                    if let t = vv["today"] as? [String: Any] {
                        row.todayCny = (t["costCny"] as? NSNumber)?.doubleValue ?? 0
                        row.reqs = (t["requests"] as? NSNumber)?.intValue ?? 0
                    }
                    if let m = vv["month"] as? [String: Any] {
                        row.monthCny = (m["costCny"] as? NSNumber)?.doubleValue ?? 0
                    }
                }
                row.balText = balText(vendor, ab[vendor] as? [String: Any])
                r.payg.append(row)
            }
            // 智谱「其他 Key」行（与网页附加卡对齐）：健康圆点 + 名称，费用 0/仅探活
            //（智谱标准 Key 无余额接口；linkedProvider 非空 = 已有 provider 卡的 key，跳过）
            if let extras = ab["zhipuExtraKeys"] as? [[String: Any]] {
                for x in extras where (x["linkedProvider"] as? String) == nil {
                    var row = PaygRowData()
                    row.id = "zhipu-extra-" + ((x["label"] as? String) ?? "")
                    row.label = "智谱·" + ((x["label"] as? String) ?? "Key")
                    row.keyOk = (x["checked"] as? Bool) == true ? ((x["ok"] as? Bool) ?? false) : nil
                    row.balText = "仅探活"
                    r.payg.append(row)
                }
            }
            r.paygToday = r.payg.reduce(0) { $0 + $1.todayCny }
        }
        if let plans = obj["plans"] as? [String: Any],
           let goal = plans["dailyGoal"] as? [String: Any],
           let g = goal["cny"] as? Double, g > 0 {
            r.goalCny = g
            r.goalPct = min(r.cny / g * 100, 999)
        }
        // 网络流量：snap.network.current（网络名）+ today（今日上下行字节）+ plans.dailyGoal.networkGB（目标）
        // 键值宽松读取：字段缺失/服务旧版本 → 保持空，不显示该行（向后兼容）
        if let nw = obj["network"] as? [String: Any],
           let cur = nw["current"] as? [String: Any],
           let label = cur["label"] as? String, !label.isEmpty {
            r.netLabel = label
            r.netRxRate = (cur["rxRate"] as? NSNumber)?.doubleValue ?? 0
            r.netTxRate = (cur["txRate"] as? NSNumber)?.doubleValue ?? 0
            if let t = nw["today"] as? [String: Any] {
                r.netRx = (t["rx"] as? NSNumber)?.doubleValue ?? 0
                r.netTx = (t["tx"] as? NSNumber)?.doubleValue ?? 0
            }
            let gb = ((obj["plans"] as? [String: Any])?["dailyGoal"] as? [String: Any])?["networkGB"] as? NSNumber
            if let g = gb?.doubleValue, g > 0 {
                r.netGoalBytes = g * 1024 * 1024 * 1024
                r.netPct = (r.netRx + r.netTx) / r.netGoalBytes * 100
            }
        }
        // VPN 流量包：snap.vpnQuota（订阅头计量）——available 才显示；未配置/采集失败保持隐藏，
        // 旧版服务无该字段同样静默跳过（键值宽松读取，与网络行同规矩）
        if let vq = obj["vpnQuota"] as? [String: Any], (vq["available"] as? Bool) == true,
           let pct = (vq["usedPercent"] as? NSNumber)?.doubleValue, pct.isFinite {
            r.vpnPct = pct
            r.vpnRemaining = (vq["remainingBytes"] as? NSNumber)?.doubleValue ?? 0
            r.vpnToday = (vq["todayBytes"] as? NSNumber)?.doubleValue ?? 0
            let nowMs = Date().timeIntervalSince1970 * 1000
            if let exp = (vq["expireAt"] as? NSNumber)?.doubleValue, exp > nowMs {
                r.vpnDaysLeft = Int((exp - nowMs) / 86400000) // floor，与面板/网页「N 天后到期」同口径
            }
        }
        r.ok = true
        r.fetchedAt = Date()
        lock.lock(); out = r; lock.unlock()
    }.resume()
    _ = sem.wait(timeout: .now() + 6)
    lock.lock(); let snapshot = out; lock.unlock()
    return snapshot
}

// ---------- SwiftUI 界面 ----------
func fmtTok(_ v: Int) -> String {
    if Double(v) >= 1e8 { return String(format: "%.2f亿", Double(v)/1e8) }
    if Double(v) >= 1e4 { return String(format: "%.1f万", Double(v)/1e4) }
    return "\(v)"
}
// 字节流量格式化（1024 进制，与网页 fmtBytes 同口径）
func fmtBytes(_ v: Double) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"]
    var x = abs(v); var i = 0
    while x >= 1024 && i < units.count - 1 { x /= 1024; i += 1 }
    return String(format: (i == 0 || x >= 100) ? "%.0f%@" : "%.1f%@", x, units[i])
}
func fmtReset(_ ms: Double?) -> String {
    guard let ms = ms, ms > 0 else { return "" }
    let h = Int(ms) / 3_600_000, m = Int(ms) % 3_600_000 / 60_000
    return h > 0 ? "\(h)h\(m)m" : "\(m)m"
}
func barColor(_ pct: Int) -> Color { pct > 85 ? .red : pct > 60 ? .yellow : .green }
// 金额紧凑格式：<100 留分位，更大取整（卡片 262px 宽度约束）
func fmtM(_ v: Double) -> String { v >= 100 ? String(format: "¥%.0f", v) : String(format: "¥%.2f", v) }
// 服务商短名（与网页区对应，长中文描述截去括号部分）
func shortVendor(_ vendor: String, _ label: String) -> String {
    switch vendor {
    case "zhipu": return "智谱"
    case "deepseek": return "DeepSeek"
    case "bailian": return "百炼"
    case "moonshot": return "Kimi"
    default: return String(label.split(separator: "（").first.map(Substring.init) ?? Substring(label))
    }
}

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
                        if store.data.paygToday > 0.005 {
                            Text(String(format: "按量 %@", fmtM(store.data.paygToday)))
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
                    if store.data.paygToday > 0.005 {
                        Text(String(format: "按量 %@", fmtM(store.data.paygToday)))
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                            .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                    } else {
                        Text("今日全在套餐内").font(.system(size: 10)).foregroundStyle(.green)
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
                // ---------- 按量统计（与网页区块对齐：今日 · 本月 · 余额，圆点=Key 健康） ----------
                if !store.data.payg.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("按量 · 服务商").font(.system(size: 9, weight: .medium)).foregroundStyle(.tertiary)
                                .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                            Spacer()
                            Text("今日 · 本月 · 余额").font(.system(size: 8)).foregroundStyle(.quaternary)
                                .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                        }
                        ForEach(store.data.payg, id: \.id) { r in
                            HStack(spacing: 5) {
                                Circle()
                                    .fill(r.keyOk == nil ? Color.secondary.opacity(0.35) : (r.keyOk == true ? Color.green : Color.red))
                                    .frame(width: 4, height: 4)
                                Text(r.label).font(.system(size: 10)).foregroundStyle(.secondary)
                                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                                Spacer(minLength: 4)
                                Text(fmtM(r.todayCny)).font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(r.todayCny >= 0.005 ? Color.primary : Color.secondary)
                                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                                Text(fmtM(r.monthCny)).font(.system(size: 9, design: .monospaced)).foregroundStyle(.tertiary)
                                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                                Text(r.balText).font(.system(size: 9, design: .monospaced)).foregroundStyle(.tertiary)
                                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                            }
                        }
                    }
                    .padding(.top, 3)
                }
                // ---------- 套餐统计（月费标注 + 5h/周额度条） ----------
                ForEach(store.data.quotas, id: \.shortName) { q in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 5) {
                            Text(q.shortName).font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                                .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                            if !q.costText.isEmpty {
                                Text(q.costText).font(.system(size: 9)).foregroundStyle(.green)
                                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                            }
                            Spacer()
                        }
                        Bar(label: "5h", pct: q.fiveHour.usedPercent, reset: q.fiveHour.resetMsLeft)
                        Bar(label: "周", pct: q.weekly.usedPercent, reset: q.weekly.resetMsLeft)
                    }
                    .padding(.top, 2)
                }
                // ---------- VPN 流量包（订阅计量服务端账单；未配置/采集失败整行隐藏，同网页 skip 口径） ----------
                if store.data.vpnPct >= 0 {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("🔌 VPN 流量包").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                            .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                        Bar(label: "流量包已用", pct: Int(min(store.data.vpnPct, 100)), reset: nil)
                        Text(String(format: "剩余 %@ · 今日 %@", fmtBytes(store.data.vpnRemaining), fmtBytes(store.data.vpnToday))
                            + (store.data.vpnDaysLeft >= 0
                               ? String(format: " · %d 天后到期", store.data.vpnDaysLeft)
                               : ""))
                            .font(.system(size: 9)).foregroundStyle(.tertiary)
                            .lineLimit(1).minimumScaleFactor(0.75).allowsTightening(true)
                    }
                    .padding(.top, 2)
                }
                // ---------- 网络流量（紧跟套餐额度条下方，与网页同位置同口径） ----------
                if !store.data.netLabel.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 5) {
                            Text("📶 " + store.data.netLabel).font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                                .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                            Spacer()
                        }
                        if store.data.netGoalBytes > 0 {
                            Bar(label: "每日流量目标", pct: Int(min(store.data.netPct, 100)), reset: nil)
                        }
                        Text(String(format: "今日 ↓%@ · ↑%@", fmtBytes(store.data.netRx), fmtBytes(store.data.netTx))
                            + (store.data.netGoalBytes > 0
                               ? String(format: " · 剩 %@", fmtBytes(max(store.data.netGoalBytes - store.data.netRx - store.data.netTx, 0)))
                               : ""))
                            .font(.system(size: 9)).foregroundStyle(.tertiary)
                            .lineLimit(1).minimumScaleFactor(0.75).allowsTightening(true)
                        if store.data.netRxRate > 1024 || store.data.netTxRate > 1024 {
                            Text(String(format: "实时速率 ↓%@/s · ↑%@/s", fmtBytes(store.data.netRxRate), fmtBytes(store.data.netTxRate)))
                                .font(.system(size: 9, design: .monospaced)).foregroundStyle(.tertiary)
                                .lineLimit(1).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.top, 2)
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
        // 120s：与「随时检测」语义对齐（服务端 60s 快照 + key 探活，卡片取最近一次）
        timer = Timer.scheduledTimer(withTimeInterval: 120, repeats: true) { [weak self] _ in self?.reload() }
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
        var collapsed = UserDefaults.standard.bool(forKey: "AIQuotaWidgetCollapsed")
        if let e = ProcessInfo.processInfo.environment["AI_QUOTA_WIDGET_COLLAPSED"] { collapsed = e == "1" }
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

        // 调试出图：AI_QUOTA_WIDGET_DUMP=<png路径> 时，等首帧数据就绪后把窗口内容缓存成 PNG 再退出
        // （本机无屏幕录制权限，用视图自绘截图做视觉验证；host 已在 makeKeyAndOrderFront 挂好）
        if let dumpPath = ProcessInfo.processInfo.environment["AI_QUOTA_WIDGET_DUMP"], !dumpPath.isEmpty {
            func snap() {
                guard let cv = self.window.contentView, cv.bounds.height > 60 else { return }
                guard let rep = cv.bitmapImageRepForCachingDisplay(in: cv.bounds) else { return }
                cv.cacheDisplay(in: cv.bounds, to: rep)
                guard let png = rep.representation(using: .png, properties: [:]) else { return }
                try? png.write(to: URL(fileURLWithPath: dumpPath))
            }
            // 折叠态窗口很矮，等数据回来（fetchWidgetData 6s 超时）后再连拍几帧
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { snap(); NSApp.terminate(nil) }
        }
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
