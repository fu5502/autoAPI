#!/bin/sh
set -eu

display="${1:-${DISPLAY:-:99}}"
watched_pid="${2:-}"
timeout_seconds="${DISPLAY_STARTUP_TIMEOUT_SECONDS:-30}"

case "$timeout_seconds" in
  ''|*[!0-9]*)
    echo "DISPLAY_STARTUP_TIMEOUT_SECONDS must be a positive integer" >&2
    exit 2
    ;;
esac

if [ "$timeout_seconds" -lt 1 ]; then
  echo "DISPLAY_STARTUP_TIMEOUT_SECONDS must be at least 1" >&2
  exit 2
fi

deadline=$(( $(date +%s) + timeout_seconds ))
while :; do
  if xdpyinfo -display "$display" >/dev/null 2>&1; then
    exit 0
  fi

  if [ -n "$watched_pid" ] && ! kill -0 "$watched_pid" 2>/dev/null; then
    echo "X server process $watched_pid exited before $display became ready" >&2
    exit 1
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Timed out waiting for X server $display after ${timeout_seconds}s" >&2
    exit 1
  fi
  sleep 0.25
done
