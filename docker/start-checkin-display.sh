#!/bin/sh
set -eu

export DISPLAY="${DISPLAY:-:99}"
Xvfb "$DISPLAY" -screen 0 1440x900x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
sleep 1

fluxbox_config=/tmp/fluxbox-init
wallpaper_setter=/tmp/Esetroot
printf 'session.screen0.rootCommand:\ttrue\n' >"$fluxbox_config"
printf '#!/bin/sh\nexit 0\n' >"$wallpaper_setter"
chmod 700 "$wallpaper_setter"
export PATH="/tmp:$PATH"
fluxbox -rc "$fluxbox_config" >/tmp/fluxbox.log 2>&1 &

wait
