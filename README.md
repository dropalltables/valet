# valet

self-hosted cursor cloud agents / amp orbs / etc

## requirements

- linux server or mac with docker engine 24+ and compose v2
- claude/codex sub or anthropic/openai api key
- github token for private repositories and pull requests (optional)

## install

```sh
git clone https://github.com/dropalltables/valet
cd valet
cp .env.example .env   # set POSTGRES_PASSWORD, VALET_SECRET_KEY (openssl rand -base64 32), VALET_PASSWORD
docker compose --profile sandbox build
docker compose up -d --build
```

open http://localhost:3000 and add accounts under settings: a claude `setup-token`, a
codex sign-in or api key, a github token. every env var is documented in `.env.example`.

on a domain: reverse proxy port 3000 with websockets, set `VALET_BASE_URL`, and point
`*.valet.example.com` at the box with a wildcard cert. services live on those subdomains.

## coolify

1. docker compose resource from this repo. leave the domain field empty
2. env: `VALET_BASE_URL`, `VALET_SERVICE_DOMAIN`, `VALET_PROXY_NETWORK` (the app's uuid),
   `VALET_CERT_RESOLVER` (a dns-challenge resolver you add to the proxy config)
3. turn off "escape special characters in labels"

## project configuration

- `.valet/setup`: runs once after clone
- `.valet/resume`: runs on every wake
- `.valet/services.yaml`: processes to keep running

```yaml
services:
  web:
    command: npm run dev -- --port $PORT
    browser: true     # shows in the services tab
    health: /
  api:
    command: uv run uvicorn app:app --port $PORT
    port: 8000        # default: assigned
```

inside the sandbox: `valet service start|list|logs|restart|remove`, `valet url <port>`.

## development

```sh
bun install && docker compose up -d db
VALET_DOCKER_NETWORK=valet_valet VALET_REPOS_VOLUME=valet_repos bun run dev:core
bun run dev:web
```

## security

core holds the docker socket; only `web` publishes a port. agents have `sudo` in their
container, so treat a sandbox as untrusted beyond its repo. on cloud hosts block metadata:
`iptables -I DOCKER-USER -d 169.254.169.254/32 -j DROP`.

## license

agpl-3.0. see `LICENSE`.
