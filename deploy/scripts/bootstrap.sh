#!/bin/bash
# bootstrap.sh — One-step fresh install for claw-orchestrator on a new Ubuntu host.
#
# Run as a non-root user with sudo access. Do NOT run as root.
#
# Usage:
#   bash deploy/scripts/bootstrap.sh \
#     --signing-secret <slack-signing-secret> \
#     --bot-token <xoxb-token> \
#     [--domain <your-domain.example>] \
#     [--repo-dir <path>] \
#     [--skip-validation]
#
# Secrets can also be passed via env vars:
#   SLACK_SIGNING_SECRET=xxx SLACK_BOT_TOKEN=yyy bash deploy/scripts/bootstrap.sh
#
# What it does:
#   1. Installs Docker, Node.js 22, pnpm, sqlite3, git
#   2. Clones the repo (or skips if repo already present)
#   3. Writes .env with provided secrets
#   4. Checks host auth files (warns if missing, does not block)
#   5. Runs deploy/scripts/install.sh
#   6. Installs Caddy and configures HTTPS (only if --domain is given)

set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

# ── Argument parsing ──────────────────────────────────────────────────────────

SIGNING_SECRET="${SLACK_SIGNING_SECRET:-}"
BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
DOMAIN="${DOMAIN:-}"
REPO_URL="https://github.com/iamsteveng/claw-orchestrator.git"
REPO_DIR="${REPO_DIR:-$HOME/claw-orchestrator}"
SKIP_VALIDATION=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --signing-secret)  SIGNING_SECRET="$2"; shift 2 ;;
    --bot-token)       BOT_TOKEN="$2";      shift 2 ;;
    --domain)          DOMAIN="$2";         shift 2 ;;
    --repo-dir)        REPO_DIR="$2";       shift 2 ;;
    --skip-validation) SKIP_VALIDATION=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

log()  { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
die()  { log "FATAL: $*" >&2; exit 1; }
warn() { log "WARNING: $*"; }

[ -z "$SIGNING_SECRET" ] && die "--signing-secret (or SLACK_SIGNING_SECRET) is required"
[ -z "$BOT_TOKEN" ]      && die "--bot-token (or SLACK_BOT_TOKEN) is required"

# ── Step 1: System dependencies ───────────────────────────────────────────────

log "=== claw-orchestrator bootstrap ==="
log "Step 1/6: Installing system dependencies..."

if ! command -v docker &>/dev/null; then
  log "  Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

DOCKER_GROUP_ADDED=false
if ! groups "$USER" | grep -q '\bdocker\b'; then
  log "  Adding $USER to docker group..."
  sudo usermod -aG docker "$USER"
  DOCKER_GROUP_ADDED=true
fi

if ! node --version 2>/dev/null | grep -q '^v22'; then
  log "  Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
  sudo apt-get install -y nodejs
fi

for pkg in sqlite3 git curl; do
  if ! command -v "$pkg" &>/dev/null; then
    log "  Installing $pkg..."
    sudo apt-get install -y "$pkg"
  fi
done

if ! command -v pnpm &>/dev/null; then
  log "  Installing pnpm..."
  sudo npm install -g pnpm
fi

log "  Dependencies OK."

# If we just added the user to the docker group, the current shell session does
# not have the group yet. Re-exec the script under sg docker so that all
# subsequent docker calls (including those inside install.sh) work without
# requiring a logout/login.
if [ "$DOCKER_GROUP_ADDED" = true ] && ! docker info &>/dev/null 2>&1; then
  log "  Docker group not active in this session — re-launching under sg docker..."
  exec sg docker bash "$SCRIPT_PATH" \
    --signing-secret "$SIGNING_SECRET" \
    --bot-token "$BOT_TOKEN" \
    ${DOMAIN:+--domain "$DOMAIN"} \
    --repo-dir "$REPO_DIR" \
    ${SKIP_VALIDATION:+--skip-validation}
fi

# ── Step 2: Clone or skip repo ────────────────────────────────────────────────

log "Step 2/6: Setting up repository at ${REPO_DIR}..."

if [ -d "${REPO_DIR}/.git" ]; then
  log "  Repository already exists — skipping clone."
else
  git clone "$REPO_URL" "$REPO_DIR"
  log "  Cloned to ${REPO_DIR}."
fi

cd "$REPO_DIR"

# ── Step 3: Write .env ────────────────────────────────────────────────────────

log "Step 3/6: Writing .env..."

if [ ! -f .env ]; then
  cp .env.example .env
  log "  Created .env from .env.example."
fi

# Use the repo's set_env_value helper to avoid duplicating key= lines.
# shellcheck source=deploy/scripts/runtime-env.sh
source deploy/scripts/runtime-env.sh

set_env_value .env SLACK_SIGNING_SECRET "$SIGNING_SECRET"
set_env_value .env SLACK_BOT_TOKEN      "$BOT_TOKEN"

log "  Secrets written to .env."

# ── Step 4: Auth file check ───────────────────────────────────────────────────

log "Step 4/6: Checking host auth files..."

AUTH_WARN=0
OPENCLAW_AUTH="$HOME/.openclaw/agents/main/agent/auth-profiles.json"
CLAUDE_CREDS="$HOME/.claude/.credentials.json"

if [ ! -f "$OPENCLAW_AUTH" ]; then
  warn "Missing ${OPENCLAW_AUTH}"
  warn "  Tenant containers will have no model access until this file exists."
  warn "  Run 'openclaw auth' on this host to create it, then restart services."
  AUTH_WARN=1
fi

if [ ! -f "$CLAUDE_CREDS" ]; then
  warn "Missing ${CLAUDE_CREDS}"
  warn "  Claude Code inside containers will not be authenticated."
  warn "  Run 'claude' on this host to log in, then restart services."
  AUTH_WARN=1
fi

[ "$AUTH_WARN" -eq 0 ] && log "  Auth files OK."

# ── Step 5: Run install.sh ────────────────────────────────────────────────────

log "Step 5/6: Running deploy/scripts/install.sh..."

INSTALL_ARGS=()
[ "$SKIP_VALIDATION" = true ] && INSTALL_ARGS+=(--skip-validation)

bash deploy/scripts/install.sh "${INSTALL_ARGS[@]}"

# ── Step 6: Caddy (optional) ──────────────────────────────────────────────────

if [ -n "$DOMAIN" ]; then
  log "Step 6/6: Installing Caddy and configuring HTTPS for ${DOMAIN}..."

  if ! command -v caddy &>/dev/null; then
    sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | sudo tee /etc/apt/sources.list.d/caddy-stable.list
    sudo apt-get update && sudo apt-get install -y caddy
  fi

  sudo tee /etc/caddy/Caddyfile > /dev/null <<EOF
${DOMAIN} {
    reverse_proxy localhost:3101
}
EOF

  sudo systemctl enable --now caddy
  sudo systemctl reload caddy
  log "  Caddy configured — Slack events URL: https://${DOMAIN}/slack/events"
else
  log "Step 6/6: Skipping Caddy (no --domain provided)."
  log "  Add HTTPS in front of port 3101 before registering the Slack request URL."
fi

# ── Done ──────────────────────────────────────────────────────────────────────

log ""
log "=== Bootstrap complete ==="
log ""
log "Remaining manual steps:"
log ""
log "  1. Create your Slack app (if not done) — https://api.slack.com/apps"
log "     Use the manifest in README step 7, request URL:"
[ -n "$DOMAIN" ] && log "       https://${DOMAIN}/slack/events" || log "       https://<your-domain>/slack/events"
log ""
log "  2. Allowlist the first user (replace T_XXXX / U_XXXX with real IDs):"
log "       sqlite3 /data/claw-orchestrator/db.sqlite \\"
log "         \"INSERT INTO allowlist (id, slack_team_id, slack_user_id, added_by, created_at) \\"
log "          VALUES (lower(hex(randomblob(8))), 'T_XXXX', 'U_XXXX', 'admin', unixepoch() * 1000);\""
log ""
log "  3. Send the bot a DM in Slack to verify end-to-end routing."
