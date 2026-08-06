#!/bin/sh
set -eu
export DISPLAY="${DISPLAY:-:99}"
api_pid=""

start-novnc &
browser_pid=$!
trap 'kill "$browser_pid" ${api_pid:+"$api_pid"} 2>/dev/null || true' EXIT TERM INT

sleep 1
if ! kill -0 "$browser_pid" 2>/dev/null; then
  wait "$browser_pid"
  exit $?
fi

node apps/api/dist/index.js &
api_pid=$!
wait "$api_pid"
