#!/bin/bash
# Runs one managed service (supervisord `command=` of every svc-<name> unit).
#
# The command, working directory, and the service's own variables come from
# ~/.valet/services/<name>.cmd, .cwd, and .env, written by the supervisor: user
# strings never pass through supervisord's config syntax. Project variables from ~/.valet/env fill in whatever supervisord's
# environment= (PORT, PUBLIC_URL, VALET_*) did not set, so the service sees the same
# variables as the agent and the setup script; the service's own env is applied last.
# The command runs in a login shell for PATH (bun, uv, nvm). The exit status is kept
# for `valet service status`: supervisord forgets it for processes that exit before
# startsecs.
name=$1
spec="$HOME/.valet/services/$name"
exit_file="$HOME/.valet/logs/$name.exit"
rm -f "$exit_file"

if ! cd -- "$(cat "$spec.cwd")"; then
  echo 1 >"$exit_file"
  exit 1
fi

if [ -f "$HOME/.valet/env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    var=${line%%=*}
    case $var in
      '' | '#'*) continue ;;
    esac
    [ -n "${!var+set}" ] || eval "export $line"
  done <"$HOME/.valet/env"
fi

set -a
. "$spec.env"
set +a

/bin/bash -lc "$(cat "$spec.cmd")"
code=$?
echo "$code" >"$exit_file"
exit "$code"
