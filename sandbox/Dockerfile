# syntax=docker/dockerfile:1.7
#
# The image every thread runs in: an unprivileged user with sudo, the agent CLIs,
# a toolchain, an Xfce desktop on Xvnc, and the Node supervisor core talks to.

# ---------------------------------------------------------------------------
# Stage 1: bundle the supervisor and compile node-pty for the target arch.
# ---------------------------------------------------------------------------
FROM node:24-bookworm AS supervisor

WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY sandbox/supervisor sandbox/supervisor

# node-pty publishes no linux prebuilds; node-gyp builds it here (python3, make, g++ are in the base image).
RUN npm ci -w @valet/supervisor --no-audit --no-fund \
 && test -f node_modules/node-pty/build/Release/pty.node \
 && npm run build -w @valet/supervisor \
 && mkdir -p /out/supervisor/node_modules/node-pty/build/Release \
 && cp sandbox/supervisor/dist/index.js sandbox/supervisor/dist/cli.js /out/supervisor/ \
 && cp -r node_modules/node-pty/lib node_modules/node-pty/package.json node_modules/node-pty/LICENSE /out/supervisor/node_modules/node-pty/ \
 && cp node_modules/node-pty/build/Release/pty.node /out/supervisor/node_modules/node-pty/build/Release/

# ---------------------------------------------------------------------------
# Stage 2: the sandbox.
# ---------------------------------------------------------------------------
FROM node:24-bookworm

ARG DEBIAN_FRONTEND=noninteractive

# The base image's `node` user (uid 1000) becomes `valet`.
# Chromium runs with --no-sandbox: its setuid helper (chromium-sandbox) needs to create
# namespaces, which Docker's default seccomp profile denies. The container is the sandbox.
# --test-type drops the "unsupported command-line flag" bar that --no-sandbox raises,
# --hide-crash-restore-bubble the restore prompt after a kill; --window-size fills the
# 1920x1080 desktop minus the panel, since xfwm4 ignores --start-maximized.
# The apt lists stay in the image (about 19 MB) so `sudo apt-get install` works in a thread.
RUN set -eux; \
    usermod -l valet -d /home/valet -m node; \
    groupmod -n valet node; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      git curl ca-certificates sudo tmux ripgrep jq less vim-tiny unzip zstd \
      python3 python3-pip python3-venv build-essential openssh-client locales procps \
      lsof iproute2 psmisc net-tools \
      supervisor dbus-x11 tigervnc-standalone-server \
      xfce4-session xfwm4 xfdesktop4 xfce4-panel xfce4-terminal thunar fonts-dejavu \
      chromium xdg-utils x11-utils xdotool wmctrl scrot; \
    mkdir -p -m 755 /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen; \
    locale-gen; \
    echo 'valet ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/valet; \
    chmod 0440 /etc/sudoers.d/valet; \
    printf '%s\n' 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-dev-shm-usage --test-type --hide-crash-restore-bubble --window-size=1920,1040"' > /etc/chromium.d/valet; \
    printf '%s\n' \
      '# remote extensions on by default' \
      'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --enable-remote-extensions"' \
      '# load the extensions installed to /usr/share/chromium/extensions, when there are any' \
      'if [ -n "$(ls -A /usr/share/chromium/extensions 2>/dev/null)" ]; then' \
      '  export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --load-extension=$(ls -dm /usr/share/chromium/extensions/* | tr -d '"'"'\n'"'"')"' \
      'fi' > /etc/chromium.d/extensions; \
    mkdir -p /valet/repos /home/valet/workspace /home/valet/.claude /home/valet/.codex; \
    chown -R valet:valet /home/valet /valet; \
    mkdir -p /etc/supervisor/conf.d/services; \
    chown valet:valet /etc/supervisor/conf.d/services

# Agent CLIs and the browser driver, global and world-readable (npm's prefix is /usr/local here).
# The platform binaries are optional deps or postinstall downloads; the version checks below fail the build if they did not land.
# agent-browser drives the system Chromium (AGENT_BROWSER_EXECUTABLE_PATH below) instead of downloading its own.
#
# Every build takes the newest release of each CLI. The images workflow resolves the
# versions first and passes them in, so this layer is rebuilt when a CLI ships and
# reused from cache otherwise; a local build without the args resolves them itself.
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG AGENT_BROWSER_VERSION=latest
RUN npm install -g --include=optional --allow-scripts=@anthropic-ai/claude-code,agent-browser --no-audit --no-fund \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
      agent-browser@${AGENT_BROWSER_VERSION} \
 && npm cache clean --force

# npm 11 blocks dependency install scripts it has not been told about (`npm approve-scripts`).
# Inside the sandbox every install script runs unreviewed: a malicious transitive
# dependency gets code execution at install time, in a container that is already the agent's.
RUN printf '%s\n' 'dangerously-allow-all-scripts=true' 'update-notifier=false' > /usr/local/etc/npmrc

COPY --from=supervisor /out/supervisor /opt/valet/supervisor
COPY sandbox/supervisord.conf /etc/supervisor/supervisord.conf
COPY sandbox/entrypoint.sh /usr/local/bin/valet-entrypoint
COPY sandbox/xfce.sh /usr/local/bin/valet-xfce
COPY sandbox/run-service.sh /usr/local/bin/valet-run-service
COPY --chown=valet:valet sandbox/tmux.conf /home/valet/.tmux.conf
# The `valet` CLI (services, service URLs) for the agent and the user's terminal; it talks to the supervisor's control socket.
RUN chmod 755 /opt/valet/supervisor/cli.js && ln -s /opt/valet/supervisor/cli.js /usr/local/bin/valet

ENV HOME=/home/valet \
    USER=valet \
    DISPLAY=:1 \
    XDG_RUNTIME_DIR=/run/user/1000 \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    LANG=en_US.UTF-8 \
    CLAUDE_CONFIG_DIR=/home/valet/.claude \
    CODEX_HOME=/home/valet/.codex \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    PATH=/home/valet/.local/bin:/home/valet/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER valet
WORKDIR /home/valet

RUN set -eux; \
    curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh; \
    curl -fsSL https://bun.sh/install | bash; \
    git config --global user.name Valet; \
    git config --global user.email valet@localhost; \
    git config --global init.defaultBranch main; \
    git config --global safe.directory '*'; \
    mkdir -p /home/valet/.config/xfce4/xfconf/xfce-perchannel-xml; \
    cp /etc/xdg/xfce4/panel/default.xml /home/valet/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml; \
    claude --version; \
    codex --version; \
    agent-browser --version; \
    gh --version; \
    uv --version; \
    bun --version; \
    rm -rf /home/valet/.cache /home/valet/.bun/install/cache

USER root

EXPOSE 9500
# /health needs the bearer token like every other route, so this must be shell form.
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=3 \
  CMD curl -fsS -H "Authorization: Bearer $VALET_SUPERVISOR_TOKEN" http://127.0.0.1:9500/health || exit 1

ENTRYPOINT ["/usr/local/bin/valet-entrypoint"]
