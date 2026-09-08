#!/bin/bash
# supervisord orders program starts but does not wait for readiness. xfce4-session
# needs the display and the session bus (program dbus, at DBUS_SESSION_BUS_ADDRESS)
# to exist; without the bus it would dbus-launch a private one that agent shells
# cannot reach.
set -euo pipefail

for _ in $(seq 1 150); do
  if [ -S /tmp/.X11-unix/X1 ] && [ -S /run/user/1000/bus ] && xdpyinfo -display :1 >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

exec /usr/bin/xfce4-session
