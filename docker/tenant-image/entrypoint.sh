#!/usr/bin/env bash
# entrypoint.sh — Tenant container startup for Claw Orchestrator
# Runs as non-root 'agent' user

set -euo pipefail

export HOME=/home/agent
export XDG_CONFIG_HOME=/home/agent/.config
export XDG_CACHE_HOME=/home/agent/.cache
export XDG_STATE_HOME=/home/agent/.local/state

# ── Auth-profiles check (bind-mounted by control plane) ──────────────────────
AUTH_PROFILES="/home/agent/.openclaw/agents/main/agent/auth-profiles.json"
if [ ! -f "${AUTH_PROFILES}" ] || [ ! -s "${AUTH_PROFILES}" ]; then
  echo "ERROR: auth-profiles.json missing at ${AUTH_PROFILES}. Check host bind-mount." >&2
  exit 1
fi

# ── Claude Code credentials check ────────────────────────────────────────────
CREDENTIALS_PATH="/home/agent/.claude/.credentials.json"
if [ ! -f "${CREDENTIALS_PATH}" ] || [ ! -s "${CREDENTIALS_PATH}" ]; then
  echo "ERROR: .credentials.json missing at ${CREDENTIALS_PATH}. Check host bind-mount." >&2
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
  node /usr/local/lib/claw-health-server.js &
fi

# ── Message server (port 3100) ────────────────────────────────────────────────
if [ -f /usr/local/lib/claw-message-server.js ]; then
  node /usr/local/lib/claw-message-server.js &
fi

# ── Start OpenClaw gateway in foreground ─────────────────────────────────────
exec openclaw gateway
