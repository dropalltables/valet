# Valet

Self-hosted cloud coding agents. Valet runs Claude Code and Codex in isolated
containers on your own server, with a web UI for launching threads, watching the
transcript stream, reviewing diffs, using a terminal and a desktop inside the
sandbox, and opening pull requests.

## Requirements

- A Linux server (or a Mac for local use) with Docker Engine 24+ and Docker Compose v2
  (v2.24+ for `docker-compose.prebuilt.yaml`, which uses the `!reset` tag).
- A Claude subscription (Pro, Max, Team, or Enterprise) or an Anthropic API key, for Claude Code.
- A ChatGPT subscription or an OpenAI API key, for Codex.
- A GitHub personal access token, for private repositories and pull requests.

## Install

```sh
git clone https://github.com/your-org/valet
cd valet
cp .env.example .env
# set POSTGRES_PASSWORD, VALET_SECRET_KEY (openssl rand -base64 32), VALET_PASSWORD
docker compose --profile sandbox build   # builds the sandbox image threads run in
docker compose up -d --build
```

Open http://localhost:3000, sign in with `VALET_PASSWORD`, and finish setup under Settings:

1. **Claude Code**: run `claude setup-token` on your own machine and paste the token.
   Anthropic's terms do not allow Valet to broker the login for you; the token is
   yours and stays encrypted in Valet's database.
2. **Codex**: click *Sign in with ChatGPT* (device code flow) or paste an OpenAI API key.
3. **GitHub**: paste a personal access token with `repo` scope.

Saving a Claude Code or Codex credential reads that agent's model list from its CLI
(in a short-lived sandbox container); *Refresh* under the credential reads it again.

To serve Valet on a domain, put a reverse proxy (Caddy, Traefik, nginx) in front of
port 3000 and set `VALET_BASE_URL`. WebSockets must be proxied. Portals (below) are
subdomains, so also point a wildcard DNS record `*.valet.example.com` at the same box
and issue a wildcard certificate. Caddy, with the DNS-challenge module for your provider:

```
valet.example.com, *.valet.example.com {
    tls {
        dns cloudflare {env.CF_API_TOKEN}
    }
    reverse_proxy 127.0.0.1:3000
}
```

Traefik: route `HostRegexp(...)` matching `valet.example.com` and `t-*.valet.example.com`
to the web service, and list `*.valet.example.com` under the certificate resolver's `domains`.

## Deploy on Coolify

Coolify names the compose project after the resource UUID, so the network and volumes are
`<uuid>_valet`, `<uuid>_repos`, `<uuid>_db-data`. Core reads its own container to find them,
so leave `VALET_DOCKER_NETWORK` and `VALET_REPOS_VOLUME` unset.

1. New resource, Docker Compose, this repository, compose file `docker-compose.yaml`.
   To deploy published images instead of building on the server, use the compose files
   `docker-compose.yaml,docker-compose.prebuilt.yaml` and set `VALET_IMAGE_PREFIX` to
   `ghcr.io/<owner>/`, leaving `VALET_SANDBOX_IMAGE` empty (a value there overrides
   the prefix).
2. Environment variables: `POSTGRES_PASSWORD`, `VALET_SECRET_KEY`, `VALET_PASSWORD`,
   `VALET_BASE_URL` (`https://valet.example.com`), `VALET_PORTAL_DOMAIN`
   (`valet.example.com`), and `VALET_IMAGE_PREFIX` when deploying published images.
3. Set the domain on the `web` service, port 3000. Coolify's Traefik joins the stack's
   network by itself.
4. Portals need a wildcard host, which the domain field cannot express, so add the labels
   to `web` yourself:

   ```yaml
   labels:
     - traefik.enable=true
     - traefik.http.routers.valet.rule=Host(`valet.example.com`) || HostRegexp(`^t-.+\.valet\.example\.com$`)
     - traefik.http.routers.valet.entrypoints=https
     - traefik.http.routers.valet.tls=true
     - traefik.http.routers.valet.tls.certresolver=letsencrypt
     - traefik.http.services.valet.loadbalancer.server.port=3000
   ```

   The wildcard certificate is a one-time setting on Coolify's own proxy (Server, Proxy,
   Dynamic Configuration): a DNS challenge for `*.valet.example.com`, since HTTP challenges
   cannot issue wildcards. Point `valet.example.com` and `*.valet.example.com` at the server.
5. Core mounts `/var/run/docker.sock`, which Coolify allows as it stands.
6. Core pulls the sandbox image when it is missing, on startup and every ten minutes, with
   progress in the log and under Settings. An image name without a registry host (the default
   `valet-sandbox:latest`) is built on the host instead, with
   `docker compose --profile sandbox build`.

The `images` workflow publishes `valet-core`, `valet-web` and `valet-sandbox` on every push to
`main`. From a fork, make the three packages public after its first run (Packages, Package
settings, Change visibility): neither compose nor core sends registry credentials. Its
`linux/arm64` jobs run on `ubuntu-24.04-arm`, which GitHub provides to public repositories only.

## How it works

```
browser ── web (Next.js) ── core (API + orchestrator) ── Postgres
                                   │ Docker socket
                                   ├── sandbox: thread A  (container + volume)
                                   ├── sandbox: thread B
                                   └── ...
```

- **One container per thread.** Core creates it from the `valet-sandbox` image with a
  persistent home volume, clones the repository on a new branch (`valet/<slug>-<id>`),
  runs `.valet/setup` if the repo has one, and starts the agent CLI inside it.
- **Pause and wake.** After `VALET_IDLE_PAUSE_MINUTES` without activity the container is
  stopped. Files, installed packages, and the agent's session survive. The next message
  starts it again and resumes the same agent session.
- **Transcript.** Core normalizes Claude Code's `stream-json` and Codex's app-server
  protocol into one event log stored in Postgres and streamed to the browser over
  WebSocket, so reloading or reconnecting never loses output.
- **Usage.** Cost, tokens, and turns rolled up by project and by agent and model over
  7 days, 30 days, or all time, with each agent's last reported rate-limit windows.
  Codex reports no cost, so its rows show tokens and turns only.
- **Permissions.** By default the container is the sandbox and the agent runs
  without prompts. Threads can be created in *ask* mode, where tool use outside
  file edits pauses for approval in the transcript.
- **Git.** GitHub credentials never sit in the container. Pushes and pull requests
  run through core with a short-lived credential helper.
- **Desktop and terminal.** Every sandbox runs a VNC desktop (Xfce, Chromium) and a
  tmux session for the Terminal tab (the user's own shell, separate from the agent);
  both are relayed through core, so no extra ports are exposed.
- **Services.** Long-lived processes (dev servers, watchers) run as supervised
  services inside the sandbox: the agent registers them with `valet service start`,
  or the repository declares them in `.valet/services.yaml` (below). Services with a port get
  `PORT` and `PUBLIC_URL`, restart when the sandbox wakes, and appear in the Services
  tab with logs and Start, Stop, Restart, and Remove controls.
- **Portals.** Every TCP port listening inside a running sandbox is reachable at
  `http://t-<thread>-p<port>.localhost:3000` (or `https://t-<thread>-p<port>.<VALET_PORTAL_DOMAIN>`
  on a server). The web app matches the hostname and forwards the whole request,
  WebSockets included, through core into the sandbox, where the supervisor connects to
  `127.0.0.1:<port>` with `Host: localhost:<port>`, so dev servers that bind to
  localhost work unchanged. Browsers resolve `*.localhost` to loopback, so nothing
  needs configuring locally. The Services tab lists the ports (named after the
  service that owns them, else by an optional committed `.valet/ports.json`, e.g.
  `{ "3000": "web" }`) and embeds one in a mini-browser; the agent knows the URL
  template through `VALET_PORTAL_URL_TEMPLATE`.
  With `VALET_PASSWORD` set, a portal host gets its own cookie after a redirect
  through the main host (logging out revokes those cookies), and *Share* issues
  links that open one portal for 1 hour to 7 days without a login. Request bodies
  sent to a portal are limited to 256 MB.
- **Notifications.** A thread that needs input, finishes a turn, or errors notifies
  through browser push (enabled per browser under Settings) and up to five outbound
  webhooks (Slack, Discord, ntfy, or a signed JSON POST). Push needs `VALET_BASE_URL`
  on HTTPS, except on localhost.

## Project configuration

Commit these to the repository:

- `.valet/setup`: runs once after clone (install dependencies, build). Must be idempotent.
  Anything it leaves running in its process group is stopped when it exits.
- `.valet/services.yaml`: services to keep running (below).
- `.valet/resume`: runs every time the container wakes, for one-off work that is not a service.

Project environment variables and secrets are set in the project's settings page and
are available to the scripts, the services, and the agent.

### Services

```yaml
services:
  web:
    command: npm run dev -- --port $PORT
    cwd: apps/web            # default: the repository root
    portal: true             # or { path: /docs, title: Docs }
    health: /                # GET must answer 2xx/3xx before the service counts as ready
  api:
    command: uv run uvicorn app:app --port $PORT
    port: 8000               # default: assigned from 30000-32767
    env:
      WEB_URL: ${services.web.publicURL}
  worker:
    command: npm run worker  # no port: PORT and PUBLIC_URL are not set
```

A service has a port when it sets `port`, `portal`, or `health`. It runs as user
`valet` in a login shell with the project environment, `PORT`, `PUBLIC_URL` (its portal
URL), `VALET_THREAD_ID`, and `VALET_SERVICE` set; it is restarted when it exits and
started again when the sandbox wakes. Logs go to `~/.valet/logs/<name>.log`.
`valet services ensure` applies the file; core runs it after `.valet/setup` and on
every wake. Inside the sandbox the agent (and the Terminal tab) can also manage
services ad hoc:

```sh
valet service start web --command 'npm run dev -- --port $PORT' --portal
valet service list
valet service logs web -f
valet service restart web
valet service remove web
valet portal 8000            # the portal URL for any port
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | required | Database password |
| `VALET_SECRET_KEY` | required | Encrypts stored credentials; losing it loses them |
| `VALET_PASSWORD` | empty | UI password; empty disables authentication |
| `VALET_BASE_URL` | `http://localhost:3000` | Public URL used in pull request bodies and portal URLs |
| `VALET_PORTAL_DOMAIN` | host of `VALET_BASE_URL` | Portals are served at `t-<thread>-p<port>.<domain>`; needs a wildcard DNS record on a server |
| `VALET_BIND` | `127.0.0.1` | Host interface for the UI port |
| `VALET_PORT` | `3000` | Host port for the UI |
| `VALET_IMAGE_PREFIX` | empty | Registry prefix for the `valet-*` images, e.g. `ghcr.io/your-org/` |
| `VALET_SANDBOX_IMAGE` | `${VALET_IMAGE_PREFIX}valet-sandbox:latest` | Image threads run in; core pulls it when it is missing and its name has a registry host |
| `VALET_DOCKER_NETWORK` | discovered | Network sandboxes join; read from core's own container |
| `VALET_REPOS_VOLUME` | discovered | Volume (or host path) holding bare repositories |
| `VALET_IDLE_PAUSE_MINUTES` | `10` | Idle time before a container is stopped |
| `VALET_SANDBOX_MEMORY` | `4g` | Memory limit per sandbox |
| `VALET_SANDBOX_CPUS` | `2` | CPU limit per sandbox |
| `VALET_MAX_RUNNING_SANDBOXES` | `8` | Running containers before new threads queue |

## Development

```sh
bun install
docker compose up -d db
bun run dev:core   # http://localhost:8080
bun run dev:web    # http://localhost:3000
```

Core needs the Docker socket and the sandbox image (`docker compose --profile sandbox build`).
Running outside a container, it cannot discover its own network and volume, so set
`VALET_DOCKER_NETWORK=valet_valet` and `VALET_REPOS_VOLUME=valet_repos`.

## Security notes

- Core holds the Docker socket, which is root-equivalent on the host. Do not expose
  core directly; only `web` publishes a port.
- Agents run as an unprivileged user inside their container with `sudo` available,
  because installing packages is part of the job. Treat a sandbox as untrusted with
  respect to the repository it was given, and nothing else.
- Credentials are encrypted at rest with `VALET_SECRET_KEY` and injected into agent
  processes as environment variables at spawn time, never written into the image.

## License

AGPL-3.0. See `LICENSE`.
