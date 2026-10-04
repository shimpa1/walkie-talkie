# syntax=docker/dockerfile:1

# Build stage: compile TypeScript. Dev dependencies stay out of the runtime image.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: Node plus the tools firstmate's scripts need (bash, jq, python3,
# git, curl). The firstmate home itself is bind-mounted at run time, not baked in.
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    jq \
    python3 \
    git \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/dist ./dist
COPY public ./public
COPY package.json ./package.json

# Default to the unprivileged node user (uid 1000). Compose overrides this with
# the PUID/PGID that owns FM_HOME so queued records stay owned by the operator.
USER node

EXPOSE 8787

# Standalone health asks firstmate whether it is ready; a multi-user gateway
# (FM_WT_MODE=gateway) serves no firstmate of its own and reports on /healthz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD if [ "${FM_WT_MODE:-standalone}" = gateway ]; then path=healthz; else path=api/health; fi; \
    curl -fsS "http://127.0.0.1:${FM_WT_PORT:-8787}/${path}" >/dev/null || exit 1

CMD ["node", "dist/src/index.js"]
