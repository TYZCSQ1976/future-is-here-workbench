#!/bin/bash
# 「未来已来」停止服务器 —— 双击即停
cd "$(dirname "$0")"

PID_FILE="./.workbench/server.pid.json"
if [ ! -f "$PID_FILE" ]; then
  echo "ℹ️ 工作台没有在运行。"
  sleep 1
  exit 0
fi

PID="$(node -e 'try{const x=require(process.argv[1]);if(Number.isInteger(x.pid))process.stdout.write(String(x.pid))}catch{}' "$PID_FILE")"
INSTANCE="$(node -e 'try{const x=require(process.argv[1]);if(x.instanceId)process.stdout.write(String(x.instanceId))}catch{}' "$PID_FILE")"
if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
  # 上次若被系统强制结束，健康接口来不及清理身份文件；这里只删除已确认不存在的旧记录。
  rm -f "$PID_FILE"
  echo "ℹ️ 工作台没有在运行，已清理过期的进程记录。"
  sleep 1
  exit 0
fi
HEALTH="$(curl -fsS --max-time 2 http://127.0.0.1:3456/healthz 2>/dev/null || true)"
if [ -z "$PID" ] || [ -z "$INSTANCE" ] || ! printf '%s' "$HEALTH" | /usr/bin/grep -q "\"instanceId\":\"$INSTANCE\""; then
  echo "⚠️ 无法确认3456端口上的程序属于这次工作台进程，已拒绝结束任何进程。"
  sleep 3
  exit 1
fi

kill -TERM "$PID" 2>/dev/null
for _ in {1..20}; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "⏹ 工作台已安全停止。"
    sleep 1
    exit 0
  fi
  sleep 0.25
done
echo "⚠️ 工作台仍在收尾，请稍后再次查看；系统没有强制杀进程。"
sleep 1
