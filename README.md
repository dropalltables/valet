# Valet

Self-hosted cloud coding agents. Valet runs Claude Code and Codex in isolated
containers on your own server, with a web UI for launching threads, watching the
transcript stream, reviewing diffs, using a terminal and a desktop inside the
sandbox, and opening pull requests.

## Requirements

- A Linux server (or a Mac for local use) with Docker Engine 24+ and Docker Compose v2.
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
| `VALET_SANDBOX_IMAGE` | `valet-sandbox:latest` | Image threads run in |
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
