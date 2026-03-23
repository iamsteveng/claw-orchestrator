# syntax=docker/dockerfile:1
#
# Multi-stage Dockerfile for the Claw Orchestrator services.
# Builds control-plane, slack-relay, and scheduler from the monorepo.
#
# Build:
#   docker build --target control-plane -t claw-control-plane:latest -f docker/Dockerfile .
#   docker build --target slack-relay   -t claw-slack-relay:latest   -f docker/Dockerfile .
#   docker build --target scheduler     -t claw-scheduler:latest     -f docker/Dockerfile .
#
# Or via docker compose:
#   docker compose -f docker/docker-compose.test.yml up --build
#
# NOTE: No secrets (SLACK_BOT_TOKEN, etc.) are embedded here.
#       Supply them via .env file or environment variables at runtime.

# ─── Stage 1: base — install all workspace deps ────────────────────────────────
FROM node:22-bookworm-slim AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy pnpm workspace manifests first (for layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared-types/package.json        ./packages/shared-types/
COPY packages/shared-config/package.json       ./packages/shared-config/
COPY packages/docker-client/package.json       ./packages/docker-client/
COPY packages/test-utils/package.json          ./packages/test-utils/
COPY apps/control-plane/package.json           ./apps/control-plane/
COPY apps/slack-relay/package.json             ./apps/slack-relay/
COPY apps/scheduler/package.json               ./apps/scheduler/

# Install all dependencies (production + dev, needed for tsc)
RUN pnpm install --frozen-lockfile

# ─── Stage 2: build — compile TypeScript ──────────────────────────────────────
FROM base AS build

# Copy source files
COPY tsconfig.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY prisma/ ./prisma/

# Generate Prisma client
RUN pnpm prisma generate

# Build all packages and apps
RUN pnpm -r build

# ─── Stage 3: runtime-base — minimal runtime image ────────────────────────────
FROM node:22-bookworm-slim AS runtime-base

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared-types/package.json        ./packages/shared-types/
COPY packages/shared-config/package.json       ./packages/shared-config/
COPY packages/docker-client/package.json       ./packages/docker-client/
COPY packages/test-utils/package.json          ./packages/test-utils/
COPY apps/control-plane/package.json           ./apps/control-plane/
COPY apps/slack-relay/package.json             ./apps/slack-relay/
COPY apps/scheduler/package.json               ./apps/scheduler/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from build stage
COPY --from=build /app/packages/shared-types/dist   ./packages/shared-types/dist/
COPY --from=build /app/packages/shared-config/dist  ./packages/shared-config/dist/
COPY --from=build /app/packages/docker-client/dist  ./packages/docker-client/dist/
COPY --from=build /app/apps/control-plane/dist      ./apps/control-plane/dist/
COPY --from=build /app/apps/slack-relay/dist        ./apps/slack-relay/dist/
COPY --from=build /app/apps/scheduler/dist          ./apps/scheduler/dist/

# Copy Prisma schema + generated client
COPY --from=build /app/prisma ./prisma/
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma/

# ─── Stage 4: control-plane ───────────────────────────────────────────────────
FROM runtime-base AS control-plane

# Install Docker CLI so control-plane can manage tenant containers
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 3200

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3200/health || exit 1

CMD ["node", "apps/control-plane/dist/index.js"]

# ─── Stage 5: slack-relay ─────────────────────────────────────────────────────
FROM runtime-base AS slack-relay

EXPOSE 3101

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3101/health || exit 1

# Install curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

CMD ["node", "apps/slack-relay/dist/index.js"]

# ─── Stage 6: scheduler ───────────────────────────────────────────────────────
FROM runtime-base AS scheduler

CMD ["node", "apps/scheduler/dist/index.js"]
