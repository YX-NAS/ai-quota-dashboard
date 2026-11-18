#!/bin/zsh
# AI 用量看板一键停止：桌面卡片 + 菜单栏 + 看板服务
# 用法: ./stop-all.sh

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "停止桌面卡片..."
pkill -x AIQuotaWidget 2>/dev/null && echo "  已停止" || echo "  未在运行"

echo "停止菜单栏应用..."
pkill -x AIQuota 2>/dev/null && echo "  已停止" || echo "  未在运行"

echo "停止看板服务..."
# 匹配「本仓库」的脚本路径（绝对路径锚定 + 兼容不同 node 二进制的全路径命令行）——
# 旧版裸匹配 "server/index.js" 会误杀其他仓库/项目里的同名服务进程
pkill -f "$DIR/server/index.js" 2>/dev/null && echo "  已停止（命令行匹配）" || echo "  命令行匹配未命中"
# v1.8.3 端口段兜底：npm start 等相对命令行 pkill -f 匹配不到（实测残留过双实例存活），
# 扫默认端口段找带本服务 health 指纹的监听进程，校验 cwd 归属本仓库后 kill。
for p in $(seq 7788 7807); do
  for pid in $(lsof -nP -tiTCP:$p -sTCP:LISTEN 2>/dev/null); do
    curl -s --max-time 2 "http://127.0.0.1:${p}/api/health" 2>/dev/null | grep -q '"ok":true' || continue
    cwd="$(lsof -p "$pid" 2>/dev/null | awk '$4=="cwd"{print $NF; exit}')"
    [ "$cwd" = "$DIR" ] && kill "$pid" 2>/dev/null && echo "  已停止 :${p} 上的实例 (pid ${pid})"
  done
done

echo "全部停止。网页端将无法访问，MCP/CLI 查询不受影响（按需自启）。"
