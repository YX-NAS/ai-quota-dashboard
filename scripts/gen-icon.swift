#!/usr/bin/swift
// App 图标生成器：暗夜玻璃底 + 霓虹环形额度表盘 + 环心多巴胺柱状图
// 用法: swift scripts/gen-icon.swift <输出目录>
//   产出 AppIcon.iconset/（iconutil 打包 .icns 用）、preview.png（1024 预览）、favicon.png（64）
// 设计语言与 web 界面同源：底 #05060f，青 #2dd6f5 / 紫 #a78bfa / 粉 #f472b6 / 琥珀 #fbbf24
import AppKit

let OUT = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/aiquota-icon"
let S = 1024.0

func hex(_ h: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat((h >> 16) & 0xff) / 255, green: CGFloat((h >> 8) & 0xff) / 255,
          blue: CGFloat(h & 0xff) / 255, alpha: a)
}

// 设计稿坐标（左上原点、1024 见方）→ CG 坐标（左下原点）
func dy(_ y: CGFloat) -> CGFloat { S - y }

func makeContext(_ px: Int) -> (NSGraphicsContext, NSBitmapImageRep) {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  let ctx = NSGraphicsContext(bitmapImageRep: rep)!
  return (ctx, rep)
}

// 四角星（闪光✦）
func starPath(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat) -> CGPath {
  let p = CGMutablePath()
  let k = r * 0.22
  let pts = [(0, -r), (k, -k), (r, 0), (k, k), (0, r), (-k, k), (-r, 0), (-k, -k)]
  p.move(to: CGPoint(x: cx + pts[0].0, y: cy + pts[0].1))
  for q in pts.dropFirst() { p.addLine(to: CGPoint(x: cx + q.0, y: cy + q.1)) }
  p.closeSubpath()
  return p
}

func drawIcon(_ ctx: NSGraphicsContext, px: Int) {
  let c = ctx.cgContext
  let s = CGFloat(px) / S
  c.saveGState()
  c.scaleBy(x: s, y: s)
  c.setAllowsAntialiasing(true)
  c.setShouldAntialias(true)

  // ---- 底板：macOS 圆角方形（824/1024，圆角 184），深空渐变 ----
  let plate = CGRect(x: 100, y: dy(924), width: 824, height: 824)
  let platePath = CGPath(roundedRect: plate, cornerWidth: 184, cornerHeight: 184, transform: nil)

  c.saveGState()
  c.setShadow(offset: CGSize(width: 0, height: -22), blur: 44, color: hex(0x000000, 0.5))
  c.addPath(platePath); c.fillPath()
  c.restoreGState()

  c.saveGState()
  c.addPath(platePath); c.clip()
  // 纵向深空渐变：顶部藏蓝 → 底部近黑
  let bg = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [hex(0x141a44), hex(0x0a0d22), hex(0x04050e)] as CFArray,
    locations: [0, 0.55, 1])!
  c.drawLinearGradient(bg, start: CGPoint(x: 512, y: dy(140)), end: CGPoint(x: 512, y: dy(920)), options: [])
  // 氛围光：顶部紫罗兰 + 底部粉（呼应界面极光背景）
  let glowV = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [hex(0xa78bfa, 0.15), hex(0xa78bfa, 0)] as CFArray, locations: [0, 1])!
  c.drawRadialGradient(glowV, startCenter: CGPoint(x: 400, y: dy(220)), startRadius: 0,
                       endCenter: CGPoint(x: 400, y: dy(220)), endRadius: 560, options: [])
  let glowP = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [hex(0xf472b6, 0.13), hex(0xf472b6, 0)] as CFArray, locations: [0, 1])!
  c.drawRadialGradient(glowP, startCenter: CGPoint(x: 660, y: dy(880)), startRadius: 0,
                       endCenter: CGPoint(x: 660, y: dy(880)), endRadius: 460, options: [])
  c.restoreGState()

  // 内缘高光
  c.saveGState()
  c.addPath(platePath)
  c.setStrokeColor(hex(0xffffff, 0.09)); c.setLineWidth(2.5); c.strokePath()
  c.restoreGState()

  // ---- 环形额度表盘：60° 缺口朝下，进度 72%（8 点钟方向顺时针走到 2 点半）----
  let cx = 512.0, cy = 512.0, r = 236.0, lw = 58.0
  let full = { (path: CGMutablePath) in
    path.addArc(center: CGPoint(x: cx, y: cy), radius: r, startAngle: 240 * .pi / 180,
                endAngle: -60 * .pi / 180, clockwise: true, transform: .identity)
  }
  // 轨道
  let track = CGMutablePath(); full(track)
  c.saveGState()
  c.setStrokeColor(hex(0x272e59, 1)); c.setLineWidth(lw); c.setLineCap(.round)
  c.addPath(track); c.strokePath()
  c.restoreGState()

  // 进度弧：先青色泛光，再渐变本体（青→紫→粉）
  let prog = CGMutablePath()
  prog.addArc(center: CGPoint(x: cx, y: cy), radius: r, startAngle: 240 * .pi / 180,
              endAngle: 24 * .pi / 180, clockwise: true, transform: .identity)
  c.saveGState()
  c.setShadow(offset: CGSize(width: 0, height: 0), blur: 46, color: hex(0x2dd6f5, 0.55))
  c.setStrokeColor(hex(0x2dd6f5, 0.35)); c.setLineWidth(lw + 14); c.setLineCap(.round)
  c.addPath(prog); c.strokePath()
  c.restoreGState()

  c.saveGState()
  c.addPath(prog)
  c.setLineWidth(lw); c.setLineCap(.round)
  c.replacePathWithStrokedPath()
  c.clip()
  let arc = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [hex(0x2dd6f5), hex(0xa78bfa), hex(0xf472b6)] as CFArray, locations: [0, 0.5, 1])!
  c.drawLinearGradient(arc, start: CGPoint(x: 300, y: dy(770)), end: CGPoint(x: 745, y: dy(400)), options: [])
  c.restoreGState()

  // 进度端点：彗星头（白核 + 粉色泛光）
  let tip = CGPoint(x: cx + r * cos(24 * .pi / 180), y: cy + r * sin(24 * .pi / 180))
  c.saveGState()
  c.setShadow(offset: .zero, blur: 30, color: hex(0xf472b6, 0.9))
  c.setFillColor(hex(0xffffff)); c.fillEllipse(in: CGRect(x: tip.x - 26, y: tip.y - 26, width: 52, height: 52))
  c.restoreGState()

  // ---- 环心柱状图：四工具用量，多巴胺色，底部对齐渐升 ----
  let bars: [(CGFloat, UInt32, UInt32)] = [
    (96, 0x2dd6f5, 0x9df1ff), (150, 0xa78bfa, 0xd9ccff), (204, 0xf472b6, 0xffc2dd), (258, 0xfbbf24, 0xffefb0),
  ]
  var bx = 512 - (4 * 42 + 3 * 24) / 2.0
  for (h, base, lite) in bars {
    let rect = CGRect(x: bx, y: dy(648), width: 42, height: h)
    let cap = CGPath(roundedRect: rect, cornerWidth: 21, cornerHeight: 21, transform: nil)
    c.saveGState()
    c.setShadow(offset: CGSize(width: 0, height: -6), blur: 20, color: hex(base, 0.55))
    c.addPath(cap)
    let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
      colors: [hex(lite), hex(base)] as CFArray, locations: [0, 1])!
    c.clip()
    c.drawLinearGradient(g, start: CGPoint(x: bx + 21, y: dy(648 - h)), end: CGPoint(x: bx + 21, y: dy(648)), options: [])
    c.restoreGState()
    bx += 66
  }

  // ---- 点缀星光（玄幻暗夜）----
  let stars: [(CGFloat, CGFloat, CGFloat, UInt32, CGFloat)] = [
    (300, 300, 16, 0xffffff, 0.55), (746, 336, 10, 0xffb3d4, 0.75), (700, 726, 6.5, 0x9df1ff, 0.7)]
  for (x, y, rad, col, a) in stars {
    c.saveGState()
    c.setShadow(offset: .zero, blur: 10, color: hex(col, a))
    c.setFillColor(hex(col, a))
    c.addPath(starPath(x, dy(y), rad)); c.fillPath()
    c.restoreGState()
  }

  c.restoreGState()
}

func writePNG(_ px: Int, _ path: String) {
  let (ctx, rep) = makeContext(px)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = ctx
  drawIcon(ctx, px: px)
  NSGraphicsContext.restoreGraphicsState()
  try! FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

let iconsetSizes: [(Int, String)] = [
  (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
  (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
  (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
  (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
  (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
]
for (px, name) in iconsetSizes { writePNG(px, "\(OUT)/AppIcon.iconset/\(name)") }
writePNG(1024, "\(OUT)/preview.png")
writePNG(64, "web/favicon.png")
print("done → \(OUT)/AppIcon.iconset, preview.png, web/favicon.png")
