#!/bin/bash
# Runs as root; supervisord drops each program to valet.
set -euo pipefail

mkdir -p /run/user/1000
chown valet:valet /run/user/1000
chmod 700 /run/user/1000

# X and ICE socket directories must be root-owned and sticky; Xvnc runs as valet and cannot create them.
mkdir -p /tmp/.X11-unix /tmp/.ICE-unix
chmod 1777 /tmp/.X11-unix /tmp/.ICE-unix

# A stopped container keeps /tmp and /run: a stale lock makes Xvnc refuse to start,
# a stale socket makes dbus-daemon refuse to bind.
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 /run/user/1000/bus

# ManagedService units log here; supervisord opens the files as root before the Node
# supervisor (which normally creates the directory) has started.
mkdir -p /home/valet/.valet/logs
chown valet:valet /home/valet/.valet /home/valet/.valet/logs

exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
