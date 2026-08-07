#!/bin/sh
set -eu

export DISPLAY="${DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/autoapi-runtime}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

xvfb_pid=""
fluxbox_pid=""

cleanup() {
  set +e
  if [ -n "$fluxbox_pid" ]; then
    kill "$fluxbox_pid" 2>/dev/null || true
    wait "$fluxbox_pid" 2>/dev/null || true
  fi
  if [ -n "$xvfb_pid" ]; then
    kill "$xvfb_pid" 2>/dev/null || true
    wait "$xvfb_pid" 2>/dev/null || true
  fi
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

while kill -0 "$xvfb_pid" 2>/dev/null && kill -0 "$fluxbox_pid" 2>/dev/null; do
  sleep 1
done

echo "The check-in display supervisor stopped unexpectedly" >&2
tail -n 80 /tmp/xvfb.log >&2 || true
tail -n 80 /tmp/fluxbox.log >&2 || true
exit 1
