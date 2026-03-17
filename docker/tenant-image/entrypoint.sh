#!/usr/bin/env bash
# entrypoint.sh — Tenant container startup script for Claw Orchestrator
# Runs as non-root 'agent' user (uid=1000)

set -euo pipefail

# ── Environment ──────────────────────────────────────────────────────────────
export HOME=/home/agent
export XDG_CONFIG_HOME=/home/agent/.config
export XDG_CACHE_HOME=/home/agent/.cache
export XDG_STATE_HOME=/home/agent/.local/state

# ── Auth-profiles check ───────────────────────────────────────────────────────
AUTH_PROFILES_PATH="/root/.openclaw/agents/main/agent/auth-profiles.json"
if [ ! -f "${AUTH_PROFILES_PATH}" ]; then
  echo "ERROR: auth-profiles.json is missing. Model calls will fail. Ensure the host bind-mount is configured." >&2
fi

# ── Required directories ──────────────────────────────────────────────────────
mkdir -p \
  /home/agent/.ssh \
  /home/agent/.config \
  /home/agent/.cache \
  /home/agent/.local/state \
  /workspace

# ── SSH permissions ───────────────────────────────────────────────────────────
chmod 700 /home/agent/.ssh
# Fix permissions on any private key files (no extension or .pem, id_*, etc.)
if [ -n "$(ls /home/agent/.ssh/ 2>/dev/null)" ]; then
  find /home/agent/.ssh -maxdepth 1 -type f ! -name "*.pub" ! -name "known_hosts" ! -name "authorized_keys" ! -name "config" \
    -exec chmod 600 {} \;
fi

# ── Health server (port 3101) ─────────────────────────────────────────────────
if command -v node >/dev/null 2>&1 && [ -f /usr/local/lib/claw-health-server.js ]; then
  node /usr/local/lib/claw-health-server.js &
fi

# ── Message server (port 3100) ────────────────────────────────────────────────
if command -v node >/dev/null 2>&1 && [ -f /usr/local/lib/claw-message-server.js ]; then
  node /usr/local/lib/claw-message-server.js &
fi

# ── Start OpenClaw as main process ────────────────────────────────────────────
exec openclaw "$@"
