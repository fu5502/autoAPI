#!/bin/sh
set -eu

export DISPLAY="${DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/autoapi-runtime}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

: "${CHECKIN_VNC_PASSWORD:?CHECKIN_VNC_PASSWORD must be set to an 8-character password}"
if [ "${#CHECKIN_VNC_PASSWORD}" -ne 8 ] || [ "$CHECKIN_VNC_PASSWORD" = "replace8" ]; then
  echo "CHECKIN_VNC_PASSWORD must contain exactly 8 characters (VNC protocol limit)." >&2
  exit 1
fi

password_file=/tmp/x11vnc.pass
umask 077
x11vnc -storepasswd "$CHECKIN_VNC_PASSWORD" "$password_file" >/dev/null

xvfb_pid=""
fluxbox_pid=""
x11vnc_pid=""
websockify_pid=""

cleanup() {
  set +e
  for pid in "$websockify_pid" "$x11vnc_pid" "$fluxbox_pid" "$xvfb_pid"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT
trap 'exit 143' TERM INT HUP

Xvfb "$DISPLAY" -screen 0 1440x900x24 -ac +extension GLX +render -noreset -nolisten tcp >/tmp/xvfb.log 2>&1 &
xvfb_pid=$!
if ! wait-for-display "$DISPLAY" "$xvfb_pid"; then
  echo "Xvfb failed to provide $DISPLAY" >&2
  tail -n 80 /tmp/xvfb.log >&2 || true
  exit 1
fi

fluxbox_config=/tmp/fluxbox-init
wallpaper_setter=/tmp/Esetroot
printf 'session.screen0.rootCommand:\ttrue\n' >"$fluxbox_config"
printf '#!/bin/sh\nexit 0\n' >"$wallpaper_setter"
chmod 700 "$wallpaper_setter"
export PATH="/tmp:$PATH"
fluxbox -rc "$fluxbox_config" >/tmp/fluxbox.log 2>&1 &
fluxbox_pid=$!
sleep 0.25
if ! kill -0 "$fluxbox_pid" 2>/dev/null; then
  echo "Fluxbox exited while starting" >&2
  tail -n 80 /tmp/fluxbox.log >&2 || true
  exit 1
fi

x11vnc -display "$DISPLAY" -forever -shared -rfbauth "$password_file" -listen 127.0.0.1 -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
x11vnc_pid=$!
sleep 0.25
if ! kill -0 "$x11vnc_pid" 2>/dev/null; then
  echo "x11vnc exited while starting" >&2
  tail -n 80 /tmp/x11vnc.log >&2 || true
  exit 1
fi

websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
websockify_pid=$!
sleep 0.25
if ! kill -0 "$websockify_pid" 2>/dev/null; then
  echo "websockify exited while starting" >&2
  tail -n 80 /tmp/websockify.log >&2 || true
  exit 1
fi

while kill -0 "$xvfb_pid" 2>/dev/null \
  && kill -0 "$fluxbox_pid" 2>/dev/null \
  && kill -0 "$x11vnc_pid" 2>/dev/null \
  && kill -0 "$websockify_pid" 2>/dev/null; do
  sleep 1
done

echo "The noVNC display supervisor stopped unexpectedly" >&2
for log_file in /tmp/xvfb.log /tmp/fluxbox.log /tmp/x11vnc.log /tmp/websockify.log; do
  if [ -f "$log_file" ]; then
    echo "--- $log_file ---" >&2
    tail -n 80 "$log_file" >&2 || true
  fi
done
exit 1
