#!/bin/bash
# 「未来已来」一键启动器 —— 双击启动，后台运行，无需保持终端
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

HEALTH_URL="http://127.0.0.1:3456/healthz"

# 只有健康接口确认是「未来已来」才视为已启动，不能把占用同一端口的其他程序认错。
if curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null | /usr/bin/grep -q '"service":"future-is-here"'; then
  open -a "Safari" http://127.0.0.1:3456
  exit 0
fi
if lsof -i :3456 > /dev/null 2>&1; then
  echo "⚠️ 3456 端口被其他程序占用，工作台没有启动，也不会结束对方进程。"
  sleep 3
  exit 1
fi

# 后台启动服务器（nohup 确保终端关闭后进程不被杀死）。
# 服务器自己维护最多两份、每份 1MB 的诊断日志，避免 shell 重定向无限增长。
mkdir -p ./.workbench
nohup node server.js > /dev/null 2>&1 &
disown

# 最多等待10秒，以真实健康接口为准。
for _ in {1..20}; do
  if curl -fsS --max-time 1 "$HEALTH_URL" 2>/dev/null | /usr/bin/grep -q '"service":"future-is-here"'; then
    open -a "Safari" http://127.0.0.1:3456
    exit 0
  fi
  sleep 0.5
done
echo "⚠️ 工作台未能在10秒内就绪，请查看 .workbench/server.log。"
sleep 3
exit 1
