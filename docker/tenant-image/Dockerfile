# syntax=docker/dockerfile:1
#
# Tenant container image for Claw Orchestrator.
# Each Slack user gets an isolated instance of this image.
#
# Build:
#   docker buildx build \
#     --platform linux/arm64,linux/amd64 \
#     --build-arg IMAGE_TAG=sha-<7char> \
#     -t claw-tenant:sha-<7char> \
#     docker/tenant-image/
#
# NOTE: No auth credentials (ANTHROPIC_API_KEY, etc.) are embedded here.
#       They are injected at runtime via bind-mounted auth-profiles.json.

FROM node:22-bookworm-slim

ARG IMAGE_TAG=dev
LABEL org.opencontainers.image.version="${IMAGE_TAG}"
LABEL org.opencontainers.image.title="claw-tenant"

# Install system dependencies and GitHub CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    curl \
    jq \
    ca-certificates \
    gnupg \
    bash \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Configure npm global prefix to /root/.npm-global so all global packages land in one place
ENV NPM_CONFIG_PREFIX=/root/.npm-global
ENV PATH=/root/.npm-global/bin:$PATH

# Install global npm CLIs
RUN npm install -g --no-fund --no-audit \
    openclaw \
    @anthropic-ai/claude-code \
    @openai/codex \
    vercel \
    convex

# Bake Ralph skills into the OpenClaw skills directory
RUN mkdir -p /root/.npm-global/lib/node_modules/openclaw/skills
COPY skills/ /root/.npm-global/lib/node_modules/openclaw/skills/

# Ralph scripts — installed to /opt/ralph so skills can reference them via RALPH_PATH
COPY ralph.sh /opt/ralph/ralph.sh
COPY qa-codex-loop.sh /opt/ralph/qa-codex-loop.sh
RUN chmod +x /opt/ralph/ralph.sh /opt/ralph/qa-codex-loop.sh

# Set RALPH_PATH so ralph-codex-loop skill works out of the box
ENV RALPH_PATH=/opt/ralph/ralph.sh

# Create non-root 'agent' user with uid/gid 1000 to match host ubuntu user
# This ensures bind-mounted volumes (created by ubuntu on the host) are writable
RUN useradd --uid 1000 --gid 1000 --create-home --home-dir /home/agent --shell /bin/bash agent 2>/dev/null || \
    useradd --create-home --home-dir /home/agent --shell /bin/bash agent

WORKDIR /home/agent

# Pre-create OpenClaw config directory and seed with minimal config
# This allows the gateway to start without interactive setup.
# The auth-profiles.json bind-mount lands in a subdirectory so the parent stays writable.
RUN mkdir -p /home/agent/.openclaw/agents/main/agent && \
    mkdir -p /home/agent/.openclaw/workspace && \
    chown -R agent:agent /home/agent/.openclaw
COPY --chown=agent:agent openclaw.json /home/agent/.openclaw/openclaw.json

# Copy server scripts to /usr/local/lib/
COPY --chown=root:root health-server.js /usr/local/lib/claw-health-server.js
COPY --chown=root:root message-server.js /usr/local/lib/claw-message-server.js

# Copy entrypoint script (runs as root to set up dirs; drops to agent via USER below)
COPY --chown=root:root entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER agent

# Expose agent runtime ports
EXPOSE 3100 3101

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
