#!/bin/sh
set -eu

export DISPLAY="${DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/autoapi-runtime}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

api_pid=""
display_pid=""

cleanup() {
  set +e
  if [ -n "$api_pid" ]; then
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
  if [ -n "$display_pid" ]; then
    kill "$display_pid" 2>/dev/null || true
    wait "$display_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT
trap 'exit 143' TERM INT HUP

if [ "${CHECKIN_ENABLE_NOVNC:-false}" = "true" ]; then
  start-novnc &
else
  start-checkin-display &
fi
display_pid=$!

if ! wait-for-display "$DISPLAY" "$display_pid"; then
  echo "The virtual display $DISPLAY did not become ready; API startup aborted." >&2
  for log_file in /tmp/xvfb.log /tmp/fluxbox.log /tmp/x11vnc.log /tmp/websockify.log; do
    if [ -f "$log_file" ]; then
      echo "--- $log_file ---" >&2
      tail -n 80 "$log_file" >&2 || true
    fi
  done
  exit 1
fi

if ! kill -0 "$display_pid" 2>/dev/null; then
  echo "The display supervisor exited after $DISPLAY became ready; API startup aborted." >&2
  exit 1
fi

node apps/api/dist/index.js &
api_pid=$!
wait "$api_pid"
