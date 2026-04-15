#!/usr/bin/env bash
# Explicit hard refresh only: pkill flutter run, force-stop app, fresh flutter run, then hot reload.
# Default Samsung iteration is hot reload (r) on an existing session — see .cursor/rules/flutter-samsung-preview-hot-reload-default.mdc
set -euo pipefail
export PATH="/home/carbondev/development/flutter/bin:$PATH"
DEVICE="${1:-adb-R5CY11AYZJW-5zQ0BJ._adb-tls-connect._tcp}"
CWMS="$(cd "$(dirname "$0")/.." && pwd)"
cd "$CWMS"

pkill -f "flutter_tools.snapshot run -d adb-R5CY11AYZJW" 2>/dev/null || true
sleep 2

adb -s "$DEVICE" shell am force-stop com.shopcarbon.wms.debug

PIDFILE="$CWMS/.cwms_flutter.pid"
LOG="$CWMS/.cwms_flutter_run.log"
rm -f "$PIDFILE"
: > "$LOG"

flutter run -d "$DEVICE" --pid-file="$PIDFILE" >>"$LOG" 2>&1 &
echo "flutter run started (log: $LOG), waiting for first sync..."

for _ in $(seq 1 240); do
  if [[ -f "$PIDFILE" ]] && grep -q "Flutter run key commands" "$LOG" 2>/dev/null; then
    sleep 2
    FP="$(cat "$PIDFILE")"
    kill -USR1 "$FP"
    echo "--- force-stop + fresh run + hot reload (r) on PID $FP ---"
    grep -E "Performing hot reload|Reloaded |Built |Installing" "$LOG" | tail -15 || true
    exit 0
  fi
  sleep 1
done

echo "--- TIMEOUT ---"
tail -50 "$LOG"
exit 1
