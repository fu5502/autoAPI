#!/bin/sh
set -eu
export DISPLAY="${DISPLAY:-:99}"
api_pid=""
display_pid=""

if [ "${CHECKIN_ENABLE_NOVNC:-false}" = "true" ]; then
  start-novnc &
else
  start-checkin-display &
fi
display_pid=$!
trap 'kill "$display_pid" ${api_pid:+"$api_pid"} 2>/dev/null || true' EXIT TERM INT

sleep 1
if ! kill -0 "$display_pid" 2>/dev/null; then
  wait "$display_pid"
  exit $?
fi

node apps/api/dist/index.js &
api_pid=$!
wait "$api_pid"
