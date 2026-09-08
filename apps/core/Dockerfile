# Build context is the repository root (see docker-compose.yaml).
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/core/package.json apps/core/
RUN npm ci --workspace @valet/core --workspace @valet/shared --include-workspace-root=false --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/core apps/core
RUN npm run build -w @valet/core

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/core/package.json apps/core/
RUN npm ci --omit=dev --workspace @valet/core --workspace @valet/shared --include-workspace-root=false --no-audit --no-fund \
  && npm cache clean --force
COPY --from=build /app/apps/core/dist apps/core/dist
COPY apps/core/drizzle apps/core/drizzle
WORKDIR /app/apps/core
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# Runs as root: core drives the Docker socket, which is root-equivalent anyway.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
