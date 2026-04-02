#!/bin/bash
# install.sh — Fresh-install entry point for claw-orchestrator on a new Ubuntu server
#
# Run as: ubuntu (or repo owner) with sudo access
# Do NOT run as root — pnpm and git operations run as current user
#
# Usage:
#   bash deploy/scripts/install.sh [--skip-validation]
#
# Prerequisites:
#   - node, pnpm, docker, sqlite3 must be installed
#   - .env file in repo root with real SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN
#
# What it does (9 steps):
#   1. Check prerequisites (tools + secrets)
#   2. Create /data/ directories and claw system user
#   3. Install out-of-repo env file at /etc/claw-orchestrator/env
#   4. Install pnpm dependencies
#   5. Build monorepo
#   6. Build tenant Docker image
#   7. Run Prisma migrations
#   8. Install + enable systemd services and start them
#   9. Wait for health checks (+ optional validation)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${DEPLOY_DIR}/.env"
SYSTEM_ENV_FILE="/etc/claw-orchestrator/env"
SKIP_VALIDATION=false

# shellcheck source=deploy/scripts/runtime-env.sh
source "${SCRIPT_DIR}/runtime-env.sh"

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
  { [ -z "$secret" ] || [ "$secret" = "replace-with-real-value" ]; } && \
    die "SLACK_SIGNING_SECRET not set or is placeholder in ${ENV_FILE}"
  { [ -z "$token" ] || [ "$token" = "replace-with-real-value" ]; } && \
    die "SLACK_BOT_TOKEN not set or is placeholder in ${ENV_FILE}"
}

# Render the tracked runtime env template to the out-of-repo systemd env file.
# Sync supported runtime keys from repo .env without mutating the checked-in template.
install_system_env() {
  sudo mkdir -p /etc/claw-orchestrator
  local rendered_env
  rendered_env="$(mktemp)"
  render_runtime_env_file \
    "${DEPLOY_DIR}/deploy/systemd/claw-orchestrator.env" \
    "${ENV_FILE}" \
    "${rendered_env}" \
    "${DEPLOY_DIR}"
  sudo cp "${rendered_env}" "${SYSTEM_ENV_FILE}"
  rm -f "${rendered_env}"
  sudo chmod 640 "${SYSTEM_ENV_FILE}"
  sudo chown root:root "${SYSTEM_ENV_FILE}"
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

# ── Main ──────────────────────────────────────────────────────────────────────

log "=== claw-orchestrator fresh install ==="
log "DEPLOY_DIR=${DEPLOY_DIR}"

# Step 1/9: Prerequisites
log "Step 1/9: Checking prerequisites (tools + secrets)..."
for tool in node pnpm docker sqlite3; do
  command -v "$tool" > /dev/null 2>&1 || die "Required tool not found: ${tool}. Install it and re-run."
done
check_secrets
log "  Prerequisites OK."

# Step 2/9: Directories and system user
log "Step 2/9: Creating /data/ directories and claw system user..."
sudo bash "${DEPLOY_DIR}/deploy/scripts/setup-dirs.sh"

# Step 3/9: Out-of-repo env file
log "Step 3/9: Installing out-of-repo env file at ${SYSTEM_ENV_FILE}..."
install_system_env
log "  Env file installed (git-tracked template is unchanged)."

# Step 4/9: pnpm dependencies
log "Step 4/9: Installing pnpm dependencies..."
cd "${DEPLOY_DIR}"
pnpm install --frozen-lockfile

# Step 5/9: Build monorepo
log "Step 5/9: Building monorepo..."
pnpm -r build

# Step 6/9: Tenant Docker image
log "Step 6/9: Building tenant Docker image..."
docker build -t claw-tenant:latest "${DEPLOY_DIR}/docker/tenant-image/"

# Step 7/9: Prisma migrations
log "Step 7/9: Running Prisma migrations..."
cd "${DEPLOY_DIR}/apps/control-plane"
DATABASE_URL="$(read_env_value "${SYSTEM_ENV_FILE}" "DATABASE_URL")" \
  npx prisma migrate deploy
cd "${DEPLOY_DIR}"

# Step 8/9: Systemd services
log "Step 8/9: Installing and enabling systemd services..."
sudo bash "${DEPLOY_DIR}/deploy/scripts/install-services.sh"
sudo systemctl start claw-control-plane claw-slack-relay claw-scheduler

# Step 9/9: Health check
log "Step 9/9: Waiting for services to become healthy..."
wait_healthy 30 2

# Optional: smoke test
if [ "$SKIP_VALIDATION" = false ]; then
  log "Running deployment validation..."
  CLAW_RUNTIME_ENV_FILE="${SYSTEM_ENV_FILE}" bash "${DEPLOY_DIR}/scripts/validate-deployment.sh"
else
  log "Skipping validate-deployment.sh (--skip-validation passed)."
fi

log "=== Install complete ==="
