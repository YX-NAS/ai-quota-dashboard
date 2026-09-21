#!/bin/zsh
# AI 用量看板一键停止：桌面卡片 + 菜单栏 + 看板服务
# 用法: ./stop-all.sh

echo "停止桌面卡片..."
pkill -x AIQuotaWidget 2>/dev/null && echo "  已停止" || echo "  未在运行"

echo "停止菜单栏应用..."
pkill -x AIQuota 2>/dev/null && echo "  已停止" || echo "  未在运行"

echo "停止看板服务..."
# 直接匹配 node server/index.js 进程（连父 shell 一起结束，防止残留）
pkill -f "node server/index.js" 2>/dev/null && echo "  已停止" || echo "  未在运行"

echo "全部停止。网页端将无法访问，MCP/CLI 查询不受影响（按需自启）。"
