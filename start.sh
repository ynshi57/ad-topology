#!/bin/bash
# ad-topology 一键启动/重启脚本
# 用法: bash start.sh

set -e
cd "$(dirname "$0")"
mkdir -p logs

echo "=== Stopping all old processes ==="
pkill -9 -f "node server/index.js" 2>/dev/null || true
pkill -9 -f "executor_harness" 2>/dev/null || true
pkill -9 -f "npx vite" 2>/dev/null || true
pkill -9 -f "node.*vite" 2>/dev/null || true
sleep 2

# Kill anything on our ports
for port in 5173 8765; do
  pid=$(cat /proc/net/tcp 2>/dev/null | awk -v p=$(printf '%04X' $port) '$2 ~ ":"p"$" && $4 == "0A" {print $10}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    for f in /proc/*/fd/*; do
      target=$(readlink "$f" 2>/dev/null)
      if echo "$target" | grep -q "socket:\[$pid\]"; then
        kill -9 "$(echo $f | cut -d/ -f3)" 2>/dev/null || true
      fi
    done
  fi
done
sleep 1

echo "=== Starting WebSocket backend (port 8765) ==="
SERVER_LOG="$PWD/logs/ad-topo-server.log"
VITE_LOG="$PWD/logs/ad-topo-vite.log"
nohup node server/index.js > "$SERVER_LOG" 2>&1 & disown
sleep 2

if ! ps aux | grep -q "[n]ode server/index.js"; then
  echo "ERROR: Backend failed to start. Check $SERVER_LOG"
  cat "$SERVER_LOG"
  exit 1
fi
echo "Backend OK ($(head -1 "$SERVER_LOG"))"

echo "=== Starting Vite frontend (port 5173) ==="
nohup npx vite --host 0.0.0.0 --port 5173 > "$VITE_LOG" 2>&1 & disown
sleep 3

VITE_PORT=$(grep -oP 'localhost:\K[0-9]+' "$VITE_LOG" | head -1)
if [ -z "$VITE_PORT" ]; then
  echo "ERROR: Vite failed to start. Check $VITE_LOG"
  cat "$VITE_LOG"
  exit 1
fi
echo "Vite OK (port $VITE_PORT)"

echo ""
echo "=== Ready ==="
echo "  Frontend: http://localhost:$VITE_PORT/"
echo "  Backend:  ws://localhost:8765"
echo "  Logs:     $SERVER_LOG, $VITE_LOG"
echo ""
echo "SSH tunnel: ssh -p 2041 -L 1${VITE_PORT}:localhost:${VITE_PORT} root@106.12.157.93"
echo "Then open:  http://localhost:1${VITE_PORT}/"
