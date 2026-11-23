#!/data/data/com.termux/files/usr/bin/bash
# Runs the agent and restarts it after crashes. Ctrl+C / SIGTERM stops it cleanly.
set -u
cd "$(dirname "$0")/.."
termux-wake-lock || true
trap 'termux-wake-unlock || true' EXIT
trap 'kill -TERM "$PID" 2>/dev/null; wait "$PID"; exit 0' INT TERM

while true; do
  python camera_agent.py --config config.json &
  PID=$!
  wait "$PID"
  CODE=$?
  [ "$CODE" -eq 0 ] && exit 0
  echo "$(date -Is) agent exited with code $CODE, restarting in 15s"
  sleep 15
done
