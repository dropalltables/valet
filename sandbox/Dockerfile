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
 && cp sandbox/supervisor/dist/index.js /out/supervisor/index.js \
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
RUN set -eux; \
    usermod -l valet -d /home/valet -m node; \
    groupmod -n valet node; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      git curl ca-certificates sudo tmux ripgrep jq less vim-tiny unzip zstd \
      python3 python3-pip python3-venv build-essential openssh-client locales procps \
      supervisor dbus-x11 tigervnc-standalone-server \
      xfce4-session xfwm4 xfdesktop4 xfce4-panel xfce4-terminal thunar fonts-dejavu \
      chromium xdg-utils x11-utils; \
    mkdir -p -m 755 /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*; \
    sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen; \
    locale-gen; \
    echo 'valet ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/valet; \
    chmod 0440 /etc/sudoers.d/valet; \
    printf '%s\n' 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-dev-shm-usage"' > /etc/chromium.d/valet; \
    mkdir -p /valet/repos /home/valet/workspace /home/valet/.claude /home/valet/.codex; \
    chown -R valet:valet /home/valet /valet

# Agent CLIs, global and world-readable (npm's prefix is /usr/local here).
# The platform binaries are optional deps; the version checks below fail the build if they did not land.
RUN npm install -g --include=optional --allow-scripts=@anthropic-ai/claude-code --no-audit --no-fund \
      @anthropic-ai/claude-code@2.1.263 \
      @openai/codex@0.153.4 \
 && npm cache clean --force

COPY --from=supervisor /out/supervisor /opt/valet/supervisor
COPY sandbox/supervisord.conf /etc/supervisor/conf.d/valet.conf
COPY sandbox/entrypoint.sh /usr/local/bin/valet-entrypoint
COPY sandbox/xfce.sh /usr/local/bin/valet-xfce
COPY --chown=valet:valet sandbox/tmux.conf /home/valet/.tmux.conf

ENV HOME=/home/valet \
    USER=valet \
    DISPLAY=:1 \
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
