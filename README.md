# Valet

self-hosted cursor cloud agents / amp orbs / etc

## Requirements

- linux server or mac with docker engine 24+ and compose v2
- claude/codex sub or anthropic/openai api key
- github token for private repositories and pull requests (optional)

## Install

```sh
git clone https://github.com/dropalltables/valet
cd valet
cp .env.example .env
# set POSTGRES_PASSWORD, VALET_SECRET_KEY (openssl rand -base64 32), VALET_PASSWORD
docker compose --profile sandbox build   # builds the sandbox image threads run in
docker compose up -d --build
```

Open http://localhost:3000, sign in with `VALET_PASSWORD`, and finish setup under Settings:

1. claude code: run `claude setup-token` and paste the token as an account
2. codex: *Sign in with ChatGPT* or paste an api key
3. github: paste a personal access token with `repo` scope
4. github app (optional): app id, private key, webhook secret. clone, push and PRs then use
   its installation tokens, and its webhook drives the PR features. webhook url is shown in
   Settings; it needs Contents + Pull requests read/write, Checks + Actions read, and the
   `check_run`, `check_suite`, `workflow_run`, `pull_request`, `issue_comment`,
   `pull_request_review_comment` events
5. several accounts per agent are fine; a thread runs under one and switches from its header

## Domain

Reverse proxy port 3000, proxy websockets, set `VALET_BASE_URL`. Services are subdomains:
point `*.valet.example.com` at the same box and issue a wildcard cert. Caddy:

```
valet.example.com, *.valet.example.com {
    tls {
        dns cloudflare {env.CF_API_TOKEN}
    }
    reverse_proxy 127.0.0.1:3000
}
```

## Coolify

1. new resource, docker compose, this repo, `docker-compose.yaml`. for published images use
   `docker-compose.yaml,docker-compose.prebuilt.yaml` with `VALET_IMAGE_PREFIX=ghcr.io/<owner>/`
2. env: `POSTGRES_PASSWORD`, `VALET_SECRET_KEY`, `VALET_PASSWORD`, `VALET_BASE_URL`,
   `VALET_SERVICE_DOMAIN`, `VALET_PROXY_NETWORK` (the app's uuid), `VALET_CERT_RESOLVER`
3. leave the domain field empty; the compose declares the traefik router from those vars.
   turn off "Escape special characters in labels" or they never interpolate
4. wildcards need a dns challenge. add a resolver to the proxy config and name it in
   `VALET_CERT_RESOLVER`. cloudflare:

   ```yaml
   services:
     traefik:
       environment:
         - CF_DNS_API_TOKEN=<token with Zone:DNS:Edit>
       command:
         - '--certificatesresolvers.cfdns.acme.dnschallenge=true'
         - '--certificatesresolvers.cfdns.acme.dnschallenge.provider=cloudflare'
         - '--certificatesresolvers.cfdns.acme.storage=/traefik/acme-cfdns.json'
   ```

Leave `VALET_DOCKER_NETWORK` and `VALET_REPOS_VOLUME` unset; core finds them from its own
container. Core pulls the sandbox image every ten minutes, so the daily rebuild (newest
claude code and codex) reaches new threads on its own. From a fork, make the three
packages public after the first `images` run.

## Project configuration

- `.valet/setup`: runs once after clone. idempotent
- `.valet/services.yaml`: services to keep running (below)
- `.valet/resume`: runs on every wake

Project env vars and secrets are set per project and reach the scripts, the services, and
the agent. Secret values are redacted from the transcript.

```yaml
services:
  web:
    command: npm run dev -- --port $PORT
    cwd: apps/web            # default: repo root
    browser: true            # or { path: /docs, title: Docs }
    health: /                # 2xx/3xx before it counts as ready
    review: false            # no Comment button on its pages
  api:
    command: uv run uvicorn app:app --port $PORT
    port: 8000               # default: assigned from 30000-32767
    env:
      WEB_URL: ${services.web.publicURL}
  worker:
    command: npm run worker  # no port: PORT and PUBLIC_URL unset
```

A service gets a port when it sets `port`, `browser`, or `health`, and runs as `valet` with
`PORT`, `PUBLIC_URL`, `VALET_THREAD_ID`, `VALET_SERVICE` set. Logs: `~/.valet/logs/<name>.log`.
Inside the sandbox:

```sh
valet service start web --command 'npm run dev -- --port $PORT' --browser
valet service list | logs web -f | restart web | remove web
valet url 8000           # service url for any port
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | required | database password |
| `VALET_SECRET_KEY` | required | encrypts stored credentials; losing it loses them |
| `VALET_PASSWORD` | empty | ui password; empty disables auth |
| `VALET_BASE_URL` | `http://localhost:3000` | public url |
| `VALET_SERVICE_DOMAIN` | host of `VALET_BASE_URL` | services live at `t-<thread>-p<port>.<domain>` |
| `VALET_BIND` / `VALET_PORT` | `127.0.0.1` / `3000` | ui bind |
| `VALET_IMAGE_PREFIX` | empty | registry prefix for `valet-*` images |
| `VALET_SANDBOX_IMAGE` | `${VALET_IMAGE_PREFIX}valet-sandbox:latest` | image threads run in |
| `VALET_IDLE_PAUSE_MINUTES` | `10` | idle time before a container is stopped |
| `VALET_SANDBOX_MEMORY` / `_CPUS` / `_PIDS` | `4g` / `2` / `2048` | per-sandbox limits |
| `VALET_MAX_RUNNING_SANDBOXES` | `8` | running containers before threads queue |
| `VALET_SNAPSHOTS` / `VALET_SNAPSHOT_MAX_GB` | `1` / `20` | reuse a snapshot of `.valet/setup`; storage budget |

## Development

```sh
bun install
docker compose up -d db
bun run dev:core   # :8080, needs the docker socket and the sandbox image
bun run dev:web    # :3000
```

Outside a container set `VALET_DOCKER_NETWORK=valet_valet` and `VALET_REPOS_VOLUME=valet_repos`.

## Security

- core holds the docker socket (root on the host). only `web` publishes a port
- agents run as an unprivileged user with `sudo`; treat a sandbox as untrusted beyond its repo
- credentials are encrypted with `VALET_SECRET_KEY` and injected at spawn, never baked in
- sandboxes: no swap, pid limit, no `NET_RAW`/`AUDIT_WRITE`/`MKNOD`/`SYS_PTRACE`. oom kills
  the offending process and the thread errors with the limit in the message
- block cloud metadata on the host: `iptables -I DOCKER-USER -d 169.254.169.254/32 -j DROP`

## License

AGPL-3.0. See `LICENSE`.
