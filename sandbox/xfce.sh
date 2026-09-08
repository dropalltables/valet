#!/bin/bash
# supervisord orders program starts but does not wait for readiness. dbus-launch
# needs the display to exist, and when it does not, the bus dies while the already
# exec'd xfce4-session lives on without one.
set -euo pipefail

for _ in $(seq 1 150); do
  if [ -S /tmp/.X11-unix/X1 ] && xdpyinfo -display :1 >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

exec /usr/bin/dbus-launch --exit-with-session /usr/bin/xfce4-session
