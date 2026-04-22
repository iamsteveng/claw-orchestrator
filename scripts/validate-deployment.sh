#!/bin/bash
# validate-deployment.sh — Claw Orchestrator operational validation
# Run: bash scripts/validate-deployment.sh

PASS=0
FAIL=0

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEM_ENV_FILE="/etc/claw-orchestrator/env"
ENV_FILE="${CLAW_RUNTIME_ENV_FILE:-$SYSTEM_ENV_FILE}"
[ -f "$ENV_FILE" ] || ENV_FILE="$BASE/.env"

# shellcheck source=deploy/scripts/runtime-env.sh
source "$BASE/deploy/scripts/runtime-env.sh"

DB="$(read_env_value "$ENV_FILE" "DATABASE_URL" | sed 's/^file://')"
DB="${DB:-/data/claw-orchestrator/db.sqlite}"
DATA_DIR="$(read_env_value "$ENV_FILE" "DATA_DIR")"
DATA_DIR="${DATA_DIR:-/data/tenants}"
SIGNING_SECRET="$(read_env_value "$ENV_FILE" "SLACK_SIGNING_SECRET")"
RELAY_PUBLIC_URL="$(read_env_value "$ENV_FILE" "RELAY_PUBLIC_URL")"
RELAY_URL="${RELAY_PUBLIC_URL:-https://13.212.162.85.nip.io}/slack/events"
TEST_TEAM="T0ABHS0G3"
TEST_USER="U08M34UT0FL"

check() {
  local name="$1" result="$2" detail="${3:-}"
  if [ "$result" = "PASS" ]; then
    echo "  ✅ $name"
    PASS=$((PASS+1))
  else
    echo "  ❌ $name${detail:+ — $detail}"
    FAIL=$((FAIL+1))
  fi
}

section() { echo ""; echo "── $1 ──"; }

send_slack_event() {
  local text="$1"
  local ts
  ts=$(date +%s%3N | head -c 10).$(date +%N | head -c 6)
  local body
  body=$(printf '{"type":"event_callback","event_id":"Ev%s","team_id":"%s","event":{"type":"message","user":"%s","text":"%s","channel":"D_VALIDATE","ts":"%s","event_ts":"%s"}}' \
    "$(date +%s)" "$TEST_TEAM" "$TEST_USER" "$text" "$ts" "$ts")
  local timestamp
  timestamp=$(date +%s)
  local sig_base="v0:${timestamp}:${body}"
  local sig
  sig="v0=$(echo -n "$sig_base" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" | awk '{print $2}')"
  curl -s -o /dev/null -w "%{http_code}" -X POST "$RELAY_URL" \
    -H "Content-Type: application/json" \
    -H "X-Slack-Request-Timestamp: $timestamp" \
    -H "X-Slack-Signature: $sig" \
    -d "$body"
}

# ── 1. Service Health ──────────────────────────────────────────────────────────
section "1. Service Health"

CP_OK=$(curl -s --max-time 5 http://localhost:3200/health 2>/dev/null | grep -c '"ok":true' || true)
check "Control plane (port 3200)" "$([ "$CP_OK" -ge 1 ] && echo PASS || echo FAIL)" "http://localhost:3200/health"

RELAY_OK=$(curl -s --max-time 5 http://localhost:3101/health 2>/dev/null | grep -c '"ok":true' || true)
check "Slack relay (port 3101)" "$([ "$RELAY_OK" -ge 1 ] && echo PASS || echo FAIL)" "http://localhost:3101/health"

SCHED_OK=0
if pgrep -f "apps/scheduler" > /dev/null 2>&1 || pm2 list 2>/dev/null | grep -q "claw-scheduler.*online"; then
  SCHED_OK=1
fi
check "Scheduler process" "$([ "$SCHED_OK" -ge 1 ] && echo PASS || echo FAIL)"

HTTPS_OK=$(curl -sk --max-time 10 "$RELAY_URL" -X GET 2>/dev/null | head -c 10 | wc -c || true)
check "HTTPS endpoint reachable" "$([ "$HTTPS_OK" -gt 0 ] && echo PASS || echo FAIL)" "$RELAY_URL"

# ── 2. Config & Auth ───────────────────────────────────────────────────────────
section "2. Config & Auth"

check "Runtime env file exists" "$([ -f "$ENV_FILE" ] && echo PASS || echo FAIL)" "$ENV_FILE"

for VAR in SLACK_SIGNING_SECRET SLACK_BOT_TOKEN DATABASE_URL DATA_DIR; do
  VAL="$(read_env_value "$ENV_FILE" "$VAR")"
  check "env: $VAR set" "$([ -n "$VAL" ] && echo PASS || echo FAIL)"
done

AUTH_PROFILES="$HOME/.openclaw/agents/main/agent/auth-profiles.json"
check "auth-profiles.json exists" "$([ -f "$AUTH_PROFILES" ] && [ -s "$AUTH_PROFILES" ] && echo PASS || echo FAIL)" "$AUTH_PROFILES"

CREDS="$HOME/.claude/.credentials.json"
check ".credentials.json exists" "$([ -f "$CREDS" ] && [ -s "$CREDS" ] && echo PASS || echo FAIL)" "$CREDS"

check "SQLite DB exists" "$([ -f "$DB" ] && echo PASS || echo FAIL)" "$DB"

# Ensure test user is in the allowlist (idempotent — skips if already present)
sqlite3 "$DB" "INSERT OR IGNORE INTO allowlist (id, slack_team_id, slack_user_id, added_by, created_at) VALUES ('validate-test-user', '$TEST_TEAM', '$TEST_USER', 'validate-deployment.sh', $(date +%s%3N));" 2>/dev/null || true
check "Allowlist has test user" "$(sqlite3 "$DB" "SELECT COUNT(*) FROM allowlist WHERE slack_team_id='$TEST_TEAM' AND slack_user_id='$TEST_USER' AND revoked_at IS NULL;" 2>/dev/null | grep -q "^1$" && echo PASS || echo FAIL)"

# ── 3. Docker ─────────────────────────────────────────────────────────────────
section "3. Docker"

DOCKER_OK=$(docker ps > /dev/null 2>&1 && echo PASS || echo FAIL)
check "Docker daemon running" "$DOCKER_OK"

IMAGE_OK=$(docker images claw-tenant:latest --format "{{.Repository}}" 2>/dev/null | grep -c claw-tenant || true)
check "claw-tenant:latest image exists" "$([ "$IMAGE_OK" -ge 1 ] && echo PASS || echo FAIL)"

# Quick container smoke test
TMPDIR_TEST="/tmp/claw-validate-$$"
mkdir -p "$TMPDIR_TEST"/{home,workspace,config,logs,secrets}
mkdir -p "$TMPDIR_TEST/home/.openclaw"
cp "$BASE/docker/tenant-image/openclaw.json" "$TMPDIR_TEST/home/.openclaw/openclaw.json"
chmod 777 "$TMPDIR_TEST"/{home,workspace,config,logs,secrets}

CONTAINER_OK="FAIL"
CONTAINER_DETAIL=""
if [ "$DOCKER_OK" = "PASS" ] && [ "$IMAGE_OK" -ge 1 ]; then
  CID=$(docker run -d --memory=3g --memory-swap=3g \
    -v "$TMPDIR_TEST/home:/home/agent" \
    -v "$TMPDIR_TEST/workspace:/workspace" \
    -v "$TMPDIR_TEST/config:/home/agent/.config" \
    -v "$AUTH_PROFILES:/home/agent/.openclaw/agents/main/agent/auth-profiles.json:ro" \
    -v "$CREDS:/home/agent/.claude/.credentials.json:ro" \
    -e 'HOME=/home/agent' -e 'XDG_CONFIG_HOME=/home/agent/.config' \
    -e 'XDG_CACHE_HOME=/home/agent/.cache' -e 'XDG_STATE_HOME=/home/agent/.local/state' \
    claw-tenant:latest 2>/dev/null || true)

  if [ -n "$CID" ]; then
    sleep 10
    STATUS=$(docker inspect "$CID" --format '{{.State.Status}}' 2>/dev/null || echo "gone")
    if [ "$STATUS" = "running" ]; then
      CONTAINER_OK="PASS"
      docker stop "$CID" > /dev/null 2>&1 || true
    else
      CONTAINER_DETAIL="container exited — $(docker logs "$CID" 2>&1 | tail -3 | tr '\n' ' ')"
      docker rm -f "$CID" > /dev/null 2>&1 || true
    fi
  else
    CONTAINER_DETAIL="docker run failed"
  fi
fi
sudo rm -rf "$TMPDIR_TEST" 2>/dev/null || rm -rf "$TMPDIR_TEST" 2>/dev/null || true
check "Container starts and stays running" "$CONTAINER_OK" "$CONTAINER_DETAIL"

# ── 4. Tenant Provisioning ────────────────────────────────────────────────────
section "4. Tenant Provisioning (signed Slack event)"

# Clean up any stale test tenant first
STALE=$(sqlite3 "$DB" "SELECT id FROM tenants WHERE slack_team_id='$TEST_TEAM' AND slack_user_id='$TEST_USER';" 2>/dev/null || true)
if [ -n "$STALE" ]; then
  docker rm -f "claw-tenant-$STALE" > /dev/null 2>&1 || true
  sqlite3 "$DB" "DELETE FROM tenants WHERE id='$STALE';" 2>/dev/null || true
  rm -rf "$DATA_DIR/$STALE" 2>/dev/null || true
fi

DATA_WRITABLE=$(touch "$DATA_DIR/.write-test" 2>/dev/null && rm "$DATA_DIR/.write-test" && echo PASS || echo FAIL)
check "/data/tenants writable" "$DATA_WRITABLE"

PROV_OK="FAIL"
PROV_DETAIL=""
if [ "$CP_OK" -ge 1 ] && [ "$RELAY_OK" -ge 1 ] && [ -n "$SIGNING_SECRET" ]; then
  HTTP_CODE=$(send_slack_event "validate deployment test $(date +%s)" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    # Poll for ACTIVE up to 120s
    DEADLINE=$(($(date +%s) + 120))
    TENANT_STATUS=""
    TENANT_ID=""
    while [ "$(date +%s)" -lt "$DEADLINE" ]; do
      TENANT_ID=$(sqlite3 "$DB" "SELECT id FROM tenants WHERE slack_team_id='$TEST_TEAM' AND slack_user_id='$TEST_USER' ORDER BY created_at DESC LIMIT 1;" 2>/dev/null || true)
      TENANT_STATUS=$(sqlite3 "$DB" "SELECT status FROM tenants WHERE id='$TENANT_ID';" 2>/dev/null || true)
      if [ "$TENANT_STATUS" = "ACTIVE" ]; then
        PROV_OK="PASS"
        break
      elif [ "$TENANT_STATUS" = "FAILED" ]; then
        PROV_DETAIL="tenant FAILED — $(docker logs claw-tenant-$TENANT_ID 2>&1 | tail -3 | tr '\n' ' ')"
        break
      fi
      sleep 3
    done
    [ -z "$TENANT_STATUS" ] && PROV_DETAIL="no tenant created after 120s"
    [ "$TENANT_STATUS" != "ACTIVE" ] && [ "$TENANT_STATUS" != "FAILED" ] && PROV_DETAIL="timed out in status: $TENANT_STATUS"
  else
    PROV_DETAIL="relay returned HTTP $HTTP_CODE"
  fi
else
  PROV_DETAIL="skipped — services not healthy or signing secret missing"
fi
check "Tenant provisioning → ACTIVE" "$PROV_OK" "$PROV_DETAIL"

# ── 5. Message Delivery ────────────────────────────────────────────────────────
section "5. Message Delivery"

MSG_OK="FAIL"
MSG_DETAIL=""
if [ "$PROV_OK" = "PASS" ] && [ -n "$TENANT_ID" ]; then
  SLACK_EVENT_ID="Ev_validate_$(date +%s)"
  HTTP_CODE=$(send_slack_event "hello from validation script" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    DEADLINE=$(($(date +%s) + 30))
    while [ "$(date +%s)" -lt "$DEADLINE" ]; do
      DELIVERED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM message_queue WHERE tenant_id='$TENANT_ID' AND status='DELIVERED';" 2>/dev/null || echo 0)
      if [ "$DELIVERED" -ge 1 ]; then
        MSG_OK="PASS"
        break
      fi
      sleep 2
    done
    [ "$MSG_OK" != "PASS" ] && MSG_DETAIL="no DELIVERED message after 30s"
  else
    MSG_DETAIL="relay returned HTTP $HTTP_CODE"
  fi
else
  MSG_DETAIL="skipped — provisioning did not succeed"
fi
check "Message delivered to tenant" "$MSG_OK" "$MSG_DETAIL"

# ── Cleanup ────────────────────────────────────────────────────────────────────
if [ -n "${TENANT_ID:-}" ]; then
  docker stop "claw-tenant-$TENANT_ID" > /dev/null 2>&1 || true
  docker rm -f "claw-tenant-$TENANT_ID" > /dev/null 2>&1 || true
  sqlite3 "$DB" "DELETE FROM tenants WHERE id='$TENANT_ID';" 2>/dev/null || true
  rm -rf "$DATA_DIR/$TENANT_ID" 2>/dev/null || true
fi
sqlite3 "$DB" "DELETE FROM allowlist WHERE id='validate-test-user';" 2>/dev/null || true

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ DEPLOYMENT FULLY OPERATIONAL"
else
  echo "  ❌ $FAIL issue(s) need attention"
fi
echo "═══════════════════════════════════"
exit "$FAIL"
