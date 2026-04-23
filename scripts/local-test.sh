#!/usr/bin/env bash
# local-test.sh — Local test orchestrator for claw-orchestrator.
#
# Brings up the Docker Compose test stack, runs validate-deployment.sh sections 1-4
# (or more with flags), then tears down. All test state is isolated under /tmp/claw-local-test/.
#
# Usage:
#   bash scripts/local-test.sh                  # sections 1-4, stub creds
#   bash scripts/local-test.sh --full           # sections 1-5 (needs real creds + LLM)
#   bash scripts/local-test.sh --slack          # sections 1-6 (needs real Slack signing secret)
#   bash scripts/local-test.sh --keep           # don't tear down on exit (debugging)
#   bash scripts/local-test.sh --rebuild        # force --no-cache rebuild
#   bash scripts/local-test.sh --sections "2 3" # run specific sections only
#   bash scripts/local-test.sh --check-clean    # abort if claw-* systemd services are active
#
# Port coexistence: uses 13200 (CP) and 13101 (relay) so this stack can run alongside
# production systemd claw-* services bound to 3200/3101.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_TEST_ROOT="${LOCAL_TEST_ROOT:-/tmp/claw-local-test}"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.test.yml"

# ── Argument parsing ───────────────────────────────────────────────────────────

FULL=false
SLACK=false
KEEP=false
REBUILD=false
CHECK_CLEAN=false
SECTIONS="1 2 3 4"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --full)        FULL=true;  shift ;;
    --slack)       SLACK=true; FULL=true; shift ;;
    --keep)        KEEP=true;  shift ;;
    --rebuild)     REBUILD=true; shift ;;
    --check-clean) CHECK_CLEAN=true; shift ;;
    --sections)    SECTIONS="$2"; shift 2 ;;
    -h|--help)
      bash "$SCRIPT_DIR/validate-deployment.sh" --help
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if "$SLACK"; then SECTIONS="1 2 3 4 5 6"
elif "$FULL"; then SECTIONS="1 2 3 4 5"
fi

# ── Helpers ────────────────────────────────────────────────────────────────────

log()  { echo "[local-test] $*"; }
warn() { echo "[local-test] WARNING: $*" >&2; }
die()  { echo "[local-test] FATAL: $*" >&2; exit 1; }

# ── Teardown (registered as EXIT trap) ────────────────────────────────────────

VALIDATOR_EXIT=0

teardown() {
  if "$KEEP"; then
    log "--keep: leaving compose stack and $LOCAL_TEST_ROOT intact."
    log "To tear down manually: docker compose -f $COMPOSE_FILE --env-file $LOCAL_TEST_ROOT/env down -v --remove-orphans"
    exit "$VALIDATOR_EXIT"
  fi

  log "Tearing down compose stack..."
  docker compose -f "$COMPOSE_FILE" --env-file "$LOCAL_TEST_ROOT/env" down -v --remove-orphans 2>/dev/null || true

  log "Removing stray tenant containers..."
  # shellcheck disable=SC2046
  docker rm -f $(docker ps -q --filter 'name=^claw-tenant-' 2>/dev/null) 2>/dev/null || true

  log "Removing $LOCAL_TEST_ROOT..."
  rm -rf "$LOCAL_TEST_ROOT" || true

  exit "$VALIDATOR_EXIT"
}

trap teardown EXIT

# ── Preconditions ──────────────────────────────────────────────────────────────

log "Checking preconditions..."

command -v docker    >/dev/null 2>&1 || die "docker not found"
docker compose version >/dev/null 2>&1 || die "docker compose not found"
command -v sqlite3   >/dev/null 2>&1 || die "sqlite3 not found (required by validate-deployment.sh)"
command -v jq        >/dev/null 2>&1 || die "jq not found"
command -v curl      >/dev/null 2>&1 || die "curl not found"

if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ':(13200|13101)$'; then
  die "Host ports 13200 or 13101 already bound. Another compose test may be running. Override via CLAW_CP_HOST_PORT / CLAW_RELAY_HOST_PORT."
fi

SYSTEMD_ACTIVE=false
for svc in claw-control-plane claw-slack-relay claw-scheduler; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    SYSTEMD_ACTIVE=true
    break
  fi
done

if "$SYSTEMD_ACTIVE"; then
  MSG="claw-* systemd services are active. Compose test uses ports 13200/13101 and $LOCAL_TEST_ROOT/data — safe to coexist."
  if "$CHECK_CLEAN"; then
    echo "[local-test] FATAL: $MSG Pass --check-clean to enforce clean host." >&2
    exit 2
  else
    warn "$MSG"
  fi
fi

# ── Set up isolated state ──────────────────────────────────────────────────────

log "Setting up isolated state under $LOCAL_TEST_ROOT..."
mkdir -p "$LOCAL_TEST_ROOT"/{data,auth,home}

# Source stub-credentials helper
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/stub-credentials.sh"

AUTH_PROFILES_HOST="$LOCAL_TEST_ROOT/auth/auth-profiles.json"
CREDS_HOST="$LOCAL_TEST_ROOT/auth/.credentials.json"

REAL_AUTH="$HOME/.openclaw/agents/main/agent/auth-profiles.json"
REAL_CREDS="$HOME/.claude/.credentials.json"

if "$FULL" && [ -s "$REAL_AUTH" ] && [ -s "$REAL_CREDS" ]; then
  log "Copying real credentials for --full mode..."
  cp "$REAL_AUTH" "$AUTH_PROFILES_HOST"
  cp "$REAL_CREDS" "$CREDS_HOST"
  chmod 0600 "$AUTH_PROFILES_HOST" "$CREDS_HOST"
else
  log "Writing stub credentials..."
  ensure_credentials "$AUTH_PROFILES_HOST" "$CREDS_HOST" stub
fi

# Synthesize env file
SIGNING_SECRET="local-test-stub-signing-secret"
BOT_TOKEN="xoxb-local-test-stub-token"

if "$SLACK"; then
  REPO_ENV="$REPO_ROOT/.env"
  [ -f "$REPO_ENV" ] || die "--slack requires a .env file at $REPO_ENV with SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN"
  SIGNING_SECRET="$(grep '^SLACK_SIGNING_SECRET=' "$REPO_ENV" | cut -d= -f2-)" || true
  BOT_TOKEN="$(grep '^SLACK_BOT_TOKEN=' "$REPO_ENV" | cut -d= -f2-)" || true
  if [ -z "$SIGNING_SECRET" ] || [ "$SIGNING_SECRET" = "your-slack-signing-secret" ]; then
    die "--slack requires a real SLACK_SIGNING_SECRET in $REPO_ENV"
  fi
  if [ -z "$BOT_TOKEN" ] || [ "$BOT_TOKEN" = "xoxb-your-slack-bot-token" ]; then
    die "--slack requires a real SLACK_BOT_TOKEN in $REPO_ENV"
  fi
fi

log "Writing synthetic env file to $LOCAL_TEST_ROOT/env..."
cat > "$LOCAL_TEST_ROOT/env" <<EOF
# Synthetic env for claw-orchestrator local testing.
# Generated by scripts/local-test.sh — do not edit manually.
HOME=$LOCAL_TEST_ROOT/home
CONTROL_PLANE_PORT=3200
SLACK_RELAY_PORT=3101
DATABASE_URL=file:/data/tenants/orchestrator.db
DATA_DIR=/data/tenants
HOST_DATA_DIR=$LOCAL_TEST_ROOT/data
TENANT_IMAGE=claw-tenant:local-test
TEMPLATES_DIR=/opt/claw-orchestrator/templates
SLACK_SIGNING_SECRET=$SIGNING_SECRET
SLACK_BOT_TOKEN=$BOT_TOKEN
CONTROL_PLANE_URL=http://control-plane:3200
SCHEDULER_INTERVAL_MS=60000
IDLE_STOP_HOURS=48
LOG_LEVEL=info
NODE_ENV=production
CONTAINER_NETWORK=claw-orchestrator-test_default
EOF

# Export compose interpolation vars
export CLAW_TEST_DATA_DIR="$LOCAL_TEST_ROOT/data"
export CLAW_AUTH_PROFILES_HOST="$AUTH_PROFILES_HOST"
export CLAW_CREDS_HOST="$CREDS_HOST"
export CLAW_TEMPLATES_DIR_HOST="$REPO_ROOT/templates"
export CLAW_CP_HOST_PORT="13200"
export CLAW_RELAY_HOST_PORT="13101"
export CLAW_COMPOSE_ENV_FILE="$LOCAL_TEST_ROOT/env"

# ── Build tenant image ─────────────────────────────────────────────────────────

TENANT_DOCKERFILE="$REPO_ROOT/docker/tenant-image/Dockerfile"
[ -f "$TENANT_DOCKERFILE" ] || die "Tenant Dockerfile not found at $TENANT_DOCKERFILE"

log "Building claw-tenant:local-test..."
if "$REBUILD"; then
  docker build --no-cache -t claw-tenant:local-test "$REPO_ROOT/docker/tenant-image/"
else
  docker build -t claw-tenant:local-test "$REPO_ROOT/docker/tenant-image/"
fi

# ── Bring up compose ───────────────────────────────────────────────────────────

log "Starting compose stack..."
COMPOSE_CMD=(docker compose -f "$COMPOSE_FILE" --env-file "$LOCAL_TEST_ROOT/env")

if "$REBUILD"; then
  "${COMPOSE_CMD[@]}" up -d --build --no-cache
else
  "${COMPOSE_CMD[@]}" up -d --build
fi

# Assert compose network exists
docker network inspect claw-orchestrator-test_default >/dev/null 2>&1 \
  || die "Compose network claw-orchestrator-test_default not found after compose up"

# Wait for CP healthy
log "Waiting for control-plane to be healthy (up to 120s)..."
CP_DEADLINE=$(( $(date +%s) + 120 ))
until [ "$(docker inspect --format '{{.State.Health.Status}}' claw-cp-test 2>/dev/null || echo 'missing')" = "healthy" ]; do
  if [ "$(date +%s)" -ge "$CP_DEADLINE" ]; then
    warn "Control-plane did not become healthy in 120s:"
    "${COMPOSE_CMD[@]}" logs --tail=200 control-plane >&2 || true
    die "Timed out waiting for claw-cp-test to be healthy"
  fi
  sleep 2
done
log "Control-plane healthy."

# Wait for relay healthy
log "Waiting for slack-relay to be healthy (up to 60s)..."
RELAY_DEADLINE=$(( $(date +%s) + 60 ))
until [ "$(docker inspect --format '{{.State.Health.Status}}' claw-relay-test 2>/dev/null || echo 'missing')" = "healthy" ]; do
  if [ "$(date +%s)" -ge "$RELAY_DEADLINE" ]; then
    warn "Slack-relay did not become healthy in 60s:"
    "${COMPOSE_CMD[@]}" logs --tail=200 slack-relay >&2 || true
    die "Timed out waiting for claw-relay-test to be healthy"
  fi
  sleep 2
done
log "Slack-relay healthy."

# ── Run validator ──────────────────────────────────────────────────────────────

log "Running validate-deployment.sh sections: $SECTIONS"

set +e
# shellcheck disable=SC2086
CLAW_RUNTIME_ENV_FILE="$LOCAL_TEST_ROOT/env" \
CP_URL="http://localhost:13200" \
RELAY_URL="http://localhost:13101" \
RELAY_LOCAL_URL="http://localhost:13101/slack/events" \
SKIP_HTTPS_CHECK=1 \
AUTH_PROFILES="$AUTH_PROFILES_HOST" \
CREDS="$CREDS_HOST" \
TENANT_IMAGE="claw-tenant:local-test" \
  bash "$SCRIPT_DIR/validate-deployment.sh" $SECTIONS
VALIDATOR_EXIT=$?
set -e

log "Validator exit code: $VALIDATOR_EXIT"
