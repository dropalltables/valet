# Build from the repository root: docker build -t valet-web:latest -f apps/web/Dockerfile .
# VALET_CORE_URL, VALET_PASSWORD, VALET_BASE_URL, and VALET_PORTAL_DOMAIN are read at
# request time (apps/web/proxy.ts), so one image serves every deployment.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/core/package.json apps/core/
COPY sandbox/supervisor/package.json sandbox/supervisor/
RUN npm ci --no-audit --no-fund --workspace @valet/web --include-workspace-root

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @valet/web

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
