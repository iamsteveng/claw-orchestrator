#!/bin/bash
# update.sh — Safe update for a running claw-orchestrator deployment
#
# Run as: ubuntu (or repo owner) with sudo access
# Do NOT run as root — pnpm and git operations run as current user
#
# Usage:
#   bash deploy/scripts/update.sh [--skip-validation]
#
# What it does (10 steps):
#   1. Pre-deploy backup (when DB exists)
#   2. Stop services (reverse dependency order)
#   3. Pull latest code (smart pull — safe when AI agent has local commits)
#   4. Install pnpm dependencies
#   5. Build monorepo
#   6. Build tenant Docker image
#   7. Run Prisma migrations
#   8. Update out-of-repo env file + reload systemd unit files
#   9. Start services
#  10. Wait for health checks (+ optional validation)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${DEPLOY_DIR}/.env"
SYSTEM_ENV_FILE="/etc/claw-orchestrator/env"
SKIP_VALIDATION=false
RENDERED_SYSTEM_ENV="$(mktemp)"

# shellcheck source=deploy/scripts/runtime-env.sh
source "${SCRIPT_DIR}/runtime-env.sh"

cleanup() {
  rm -f "${RENDERED_SYSTEM_ENV}"
}
trap cleanup EXIT

for arg in "$@"; do
  [ "$arg" = "--skip-validation" ] && SKIP_VALIDATION=true
done

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
die() { log "FATAL: $*" >&2; exit 1; }

check_secrets() {
  [ -f "${ENV_FILE}" ] || die ".env file not found at ${ENV_FILE}"
  local secret token
  secret=$(sed -n 's/^SLACK_SIGNING_SECRET=//p' "${ENV_FILE}")
  token=$(sed -n 's/^SLACK_BOT_TOKEN=//p' "${ENV_FILE}")
  if [ -z "$secret" ] || [ "$secret" = "replace-with-real-value" ]; then
    die "SLACK_SIGNING_SECRET not set or is placeholder in ${ENV_FILE}"
  fi
  if [ -z "$token" ] || [ "$token" = "replace-with-real-value" ]; then
    die "SLACK_BOT_TOKEN not set or is placeholder in ${ENV_FILE}"
  fi
  # Ensure credential files are readable by the control plane (running as current user).
  # Files may be owned by a different uid if copied via scp from another machine.
  local openclaw_auth="${HOME}/.openclaw/agents/main/agent/auth-profiles.json"
  local claude_creds="${HOME}/.claude/.credentials.json"
  for f in "$openclaw_auth" "$claude_creds"; do
    [ -f "$f" ] && sudo chown "$(id -un):$(id -gn)" "$f" 2>/dev/null || true
  done
}

# Render the tracked runtime env template to the out-of-repo systemd env file.
# Sync supported runtime keys from repo .env without mutating the checked-in template.
install_system_env() {
  sudo mkdir -p /etc/claw-orchestrator
  sudo cp "${RENDERED_SYSTEM_ENV}" "${SYSTEM_ENV_FILE}"
  sudo chmod 640 "${SYSTEM_ENV_FILE}"
  sudo chown root:root "${SYSTEM_ENV_FILE}"
}

render_target_system_env() {
  render_runtime_env_file \
    "${DEPLOY_DIR}/deploy/systemd/claw-orchestrator.env" \
    "${ENV_FILE}" \
    "${RENDERED_SYSTEM_ENV}" \
    "${DEPLOY_DIR}"
}

# Poll :3200/health and :3101/health until both respond ok.
# Args: max_retries interval_seconds
wait_healthy() {
  local retries="${1:-30}" interval="${2:-2}"
  local i=0 cp_ok rl_ok
  while [ "$i" -lt "$retries" ]; do
    cp_ok=0
    rl_ok=0
    if curl -sf --max-time 3 http://localhost:3200/health 2>/dev/null | grep -q '"ok":true'; then cp_ok=1; fi
    if curl -sf --max-time 3 http://localhost:3101/health 2>/dev/null | grep -q '"ok":true'; then rl_ok=1; fi
    if [ "$cp_ok" -eq 1 ] && [ "$rl_ok" -eq 1 ]; then
      log "Services healthy (control-plane :3200 + relay :3101)."
      return 0
    fi
    i=$((i + 1))
    log "  Waiting for services... ($i/$retries)"
    sleep "$interval"
  done
  die "Services did not become healthy after $((retries * interval))s. Check: journalctl -u claw-control-plane -n 50"
}

# Conditional git pull — handles all git states safely.
# - Already up-to-date: no-op
# - Remote ahead (normal update): fast-forward merge
# - Local ahead (AI agent committed, not yet pushed): skip pull, log warning
# - Diverged: die with clear message
smart_pull() {
  git fetch origin
  local LOCAL REMOTE BASE
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse "@{u}" 2>/dev/null || die "No upstream branch configured. Run: git branch --set-upstream-to=origin/main main")
  BASE=$(git merge-base HEAD "@{u}")

  if [ "$LOCAL" = "$REMOTE" ]; then
    log "Already up to date."
  elif [ "$LOCAL" = "$BASE" ]; then
    log "Pulling remote changes..."
    git merge --ff-only "@{u}"
  elif [ "$REMOTE" = "$BASE" ]; then
    log "Local commits present and ahead of remote — skipping pull."
    log "NOTE: Push local commits to origin so future deployments pick them up."
  else
    die "Branches have diverged. Push local commits or resolve manually before redeploying."
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────

log "=== claw-orchestrator update ==="
log "DEPLOY_DIR=${DEPLOY_DIR}"

check_secrets

# Step 1/10: Pre-deploy backup
log "Step 1/10: Pre-deploy backup..."
if [ -f "${SYSTEM_ENV_FILE}" ]; then
  DB_PATH="$(read_env_value "${SYSTEM_ENV_FILE}" "DATABASE_URL" | sed -n 's/^file://p')"
  BACKUP_S3_BUCKET="$(read_env_value "${SYSTEM_ENV_FILE}" "S3_BUCKET")"
else
  DB_PATH="$(read_env_value "${ENV_FILE}" "DATABASE_URL" | sed -n 's/^file://p')"
  BACKUP_S3_BUCKET="$(read_env_value "${ENV_FILE}" "S3_BUCKET")"
fi
DB_PATH="${DB_PATH:-/data/claw-orchestrator/db.sqlite}"
if [ -f "$DB_PATH" ]; then
  S3_BUCKET="${BACKUP_S3_BUCKET:-}" sudo bash "${DEPLOY_DIR}/deploy/scripts/backup.sh" || \
    die "Backup failed. Aborting update to protect your data."
else
  log "  No DB found at ${DB_PATH} — skipping backup (first run or fresh server)."
fi

# Step 2/10: Stop services (reverse dependency order: scheduler → relay → control-plane)
log "Step 2/10: Stopping services..."
sudo systemctl stop claw-scheduler claw-slack-relay claw-control-plane 2>/dev/null || true

# Step 3/10: Pull latest code
log "Step 3/10: Pulling latest code..."
cd "${DEPLOY_DIR}"
smart_pull
render_target_system_env

# Step 4/10: pnpm dependencies
log "Step 4/10: Installing pnpm dependencies..."
CI=true pnpm install --frozen-lockfile

# Generate Prisma client and symlink into every pnpm store @prisma/client location.
# pnpm isolates packages so the generated client at node_modules/.prisma/client
# must be linked into each .pnpm/@prisma+client@*/node_modules/.prisma/client.
log "  Generating Prisma client..."
npx prisma generate --schema "${DEPLOY_DIR}/prisma/schema.prisma"
while IFS= read -r dot_prisma_dir; do
  rm -rf "${dot_prisma_dir}/client"
  mkdir -p "${dot_prisma_dir}"
  ln -s "${DEPLOY_DIR}/node_modules/.prisma/client" "${dot_prisma_dir}/client"
  log "  Linked ${dot_prisma_dir}/client"
done < <(find "${DEPLOY_DIR}/node_modules/.pnpm" -maxdepth 4 -type d -name '.prisma' 2>/dev/null)

# Step 5/10: Build monorepo
log "Step 5/10: Building monorepo..."
pnpm -r build

# Step 6/10: Tenant Docker image
log "Step 6/10: Building tenant Docker image..."
docker build -t claw-tenant:latest "${DEPLOY_DIR}/docker/tenant-image/"

# Step 7/10: Prisma migrations
log "Step 7/10: Running Prisma migrations..."
BACKUP_HINT="/data/backups/$(date -u +%Y-%m-%d)/db.sqlite"
RUNTIME_DATABASE_URL="$(read_env_value "${RENDERED_SYSTEM_ENV}" "DATABASE_URL")"
sudo env DATABASE_URL="${RUNTIME_DATABASE_URL}" \
  npx prisma migrate deploy --schema "${DEPLOY_DIR}/prisma/schema.prisma" || \
  die "Prisma migration failed. Services are stopped. Restore DB from backup at ${BACKUP_HINT} then start services manually."

# Step 8/10: Update env file + reload systemd
log "Step 8/10: Updating out-of-repo env file and reloading systemd..."
install_system_env
sudo bash "${DEPLOY_DIR}/deploy/scripts/install-services.sh"

# Step 9/10: Start services
log "Step 9/10: Starting services..."
sudo systemctl start claw-control-plane claw-slack-relay claw-scheduler

# Step 10/10: Health check
log "Step 10/10: Waiting for services to become healthy..."
wait_healthy 30 2

# Optional: smoke test
if [ "$SKIP_VALIDATION" = false ]; then
  log "Running deployment validation..."
  CLAW_RUNTIME_ENV_FILE="${SYSTEM_ENV_FILE}" bash "${DEPLOY_DIR}/scripts/validate-deployment.sh"
else
  log "Skipping validate-deployment.sh (--skip-validation passed)."
fi

log "=== Update complete ==="
