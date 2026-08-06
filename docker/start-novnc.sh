#!/bin/sh
set -eu

export DISPLAY="${DISPLAY:-:99}"
: "${CHECKIN_VNC_PASSWORD:?CHECKIN_VNC_PASSWORD must be set to an 8-character password}"
if [ "${#CHECKIN_VNC_PASSWORD}" -ne 8 ] || [ "$CHECKIN_VNC_PASSWORD" = "replace8" ]; then
  echo "CHECKIN_VNC_PASSWORD must contain exactly 8 characters (VNC protocol limit)." >&2
  exit 1
fi

password_file=/tmp/x11vnc.pass
umask 077
x11vnc -storepasswd "$CHECKIN_VNC_PASSWORD" "$password_file" >/dev/null
Xvfb "$DISPLAY" -screen 0 1440x900x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display "$DISPLAY" -forever -shared -rfbauth "$password_file" -listen 127.0.0.1 -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &

wait
