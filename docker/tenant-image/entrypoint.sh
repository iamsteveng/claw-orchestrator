#!/usr/bin/env bash
# entrypoint.sh — Tenant container startup for Claw Orchestrator
# Runs as root initially to fix file ownership, then drops to agent user

set -euo pipefail

# Fix ownership of home directory (files copied by host ubuntu user have wrong uid)
chown -R agent:agent /home/agent 2>/dev/null || true

export HOME=/home/agent
export XDG_CONFIG_HOME=/home/agent/.config
export XDG_CACHE_HOME=/home/agent/.cache
export XDG_STATE_HOME=/home/agent/.local/state

# ── Auth-profiles check (copied by control plane during provisioning) ────────
AUTH_PROFILES="/home/agent/.openclaw/agents/main/agent/auth-profiles.json"
if [ ! -f "${AUTH_PROFILES}" ] || [ ! -s "${AUTH_PROFILES}" ]; then
  echo "WARNING: auth-profiles.json not found at ${AUTH_PROFILES}. Model calls may fail." >&2
fi

# ── Claude Code credentials check ────────────────────────────────────────────
CREDENTIALS_PATH="/home/agent/.claude/.credentials.json"
if [ ! -f "${CREDENTIALS_PATH}" ] || [ ! -s "${CREDENTIALS_PATH}" ]; then
  echo "ERROR: .credentials.json is missing or empty. Claude CLI authentication will fail. Ensure ~/.claude/.credentials.json exists on the host and is bind-mounted." >&2
  exit 1
fi

# ── Required directories ──────────────────────────────────────────────────────
mkdir -p \
  /home/agent/.ssh \
  /home/agent/.cache \
  /home/agent/.local/state \
  /workspace

chmod 700 /home/agent/.ssh 2>/dev/null || true

# ── Health server (port 3101) ─────────────────────────────────────────────────
if [ -f /usr/local/lib/claw-health-server.js ]; then
  su -s /bin/bash agent -c "node /usr/local/lib/claw-health-server.js" &
fi

# ── Message server (port 3100) ────────────────────────────────────────────────
if [ -f /usr/local/lib/claw-message-server.js ]; then
  su -s /bin/bash agent -c "RELAY_TOKEN=$RELAY_TOKEN node /usr/local/lib/claw-message-server.js" &
fi

# ── Drop to agent user and start OpenClaw gateway in foreground ──────────────
exec su -s /bin/bash agent -c "exec openclaw gateway"
