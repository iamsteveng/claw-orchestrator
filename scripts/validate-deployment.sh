#!/bin/bash
# validate-deployment.sh — Claw Orchestrator modular deployment validation
#
# Six independent sections, each testing one module:
#   1. Service Health       — are the 3 processes alive and reachable?
#   2. Config & Auth        — are credentials and env vars correct?
#   3. Docker Image         — is the tenant image built and runnable?
#   4. Provisioning Module  — does POST /provision create all expected state?
#   5. Lifecycle + Message  — does /start → ACTIVE → /message work end-to-end via CP API?
#   6. Full Slack Flow      — does a signed Slack event trigger the full relay→CP→container path?
#
# Usage:
#   bash scripts/validate-deployment.sh          # run all 6 sections
#   bash scripts/validate-deployment.sh 3        # section 3 only
#   bash scripts/validate-deployment.sh 4 5      # sections 4 and 5
#   bash scripts/validate-deployment.sh 5 6      # sections 5 and 6

PASS=0
FAIL=0

# Section selector — default to all, otherwise use positional args
if [ $# -eq 0 ]; then
  SELECTED="1 2 3 4 5 6"
else
  SELECTED="$*"
fi
section_enabled() {
  local s; for s in $SELECTED; do [ "$s" = "$1" ] && return 0; done; return 1
}

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEM_ENV_FILE="/etc/claw-orchestrator/env"
ENV_FILE="${CLAW_RUNTIME_ENV_FILE:-$SYSTEM_ENV_FILE}"
[ -f "$ENV_FILE" ] || ENV_FILE="$BASE/.env"

source "$BASE/deploy/scripts/runtime-env.sh"

DB="$(read_env_value "$ENV_FILE" "DATABASE_URL" | sed 's/^file://')"
DB="${DB:-/data/claw-orchestrator/db.sqlite}"
DATA_DIR="$(read_env_value "$ENV_FILE" "DATA_DIR")"
DATA_DIR="${DATA_DIR:-/data/tenants}"
SIGNING_SECRET="$(read_env_value "$ENV_FILE" "SLACK_SIGNING_SECRET")"
RELAY_PUBLIC_URL="$(read_env_value "$ENV_FILE" "RELAY_PUBLIC_URL")"
RELAY_HTTPS_URL="${RELAY_PUBLIC_URL:-https://13.212.162.85.nip.io}/slack/events"
RELAY_LOCAL_URL="http://localhost:3101/slack/events"
CP_URL="http://localhost:3200"

_ENV_HOME="$(read_env_value "$ENV_FILE" "HOME")"
AGENT_HOME="${_ENV_HOME:-$(getent passwd ubuntu | cut -d: -f6 2>/dev/null || echo "$HOME")}"

TEST_TEAM="T0ABHS0G3"
TEST_USER="U08M34UT0FL"

# ── Helpers ────────────────────────────────────────────────────────────────

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

# Remove all DB rows and disk state for the test tenant.
cleanup_test_tenant() {
  local tid
  tid=$(sqlite3 "$DB" "SELECT id FROM tenants WHERE slack_team_id='$TEST_TEAM' AND slack_user_id='$TEST_USER' LIMIT 1;" 2>/dev/null || true)
  if [ -n "$tid" ]; then
    docker stop "claw-tenant-$tid" > /dev/null 2>&1 || true
    docker rm -f "claw-tenant-$tid" > /dev/null 2>&1 || true
    sqlite3 "$DB" "DELETE FROM startup_locks   WHERE tenant_id='$tid';" 2>/dev/null || true
    sqlite3 "$DB" "DELETE FROM message_queue   WHERE tenant_id='$tid';" 2>/dev/null || true
    sqlite3 "$DB" "DELETE FROM audit_log       WHERE tenant_id='$tid';" 2>/dev/null || true
    sqlite3 "$DB" "DELETE FROM tenants         WHERE id='$tid';"        2>/dev/null || true
    sudo rm -rf "$DATA_DIR/$tid" 2>/dev/null || rm -rf "$DATA_DIR/$tid" 2>/dev/null || true
  fi
}

# Build a signed Slack event body and post it to the local relay.
# Prints the HTTP status code.
send_slack_event() {
  local text="$1"
  local ts evt_ts body sig
  ts=$(date +%s)
  evt_ts=$(date +%s%3N | head -c 10).$(date +%N | head -c 6)
  body=$(printf '{"type":"event_callback","event_id":"Ev%s","team_id":"%s","event":{"type":"message","user":"%s","text":"%s","channel":"D_VALIDATE","ts":"%s","event_ts":"%s"}}' \
    "$ts" "$TEST_TEAM" "$TEST_USER" "$text" "$evt_ts" "$evt_ts")
  sig="v0=$(echo -n "v0:${ts}:${body}" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" | awk '{print $2}')"
  curl -s --max-time 10 -o /dev/null -w "%{http_code}" -X POST "$RELAY_LOCAL_URL" \
    -H "Content-Type: application/json" \
    -H "X-Slack-Request-Timestamp: $ts" \
    -H "X-Slack-Signature: $sig" \
    -d "$body"
}

# ── Guards (always computed — sections 4/5/6 depend on these) ─────────────
CP_OK=$(curl -s --max-time 5 "$CP_URL/health" 2>/dev/null | grep -c '"ok":true' || true)
RELAY_OK=$(curl -s --max-time 5 "http://localhost:3101/health" 2>/dev/null | grep -c '"ok":true' || true)

SCHED_OK=0
if pgrep -f "apps/scheduler" > /dev/null 2>&1 \
    || pm2 list 2>/dev/null | grep -q "claw-scheduler.*online" \
    || systemctl is-active claw-scheduler 2>/dev/null | grep -q "^active$"; then
  SCHED_OK=1
fi

RELAY_HTTPS_HOST="$(echo "$RELAY_HTTPS_URL" | sed 's|https://\([^/:]*\).*|\1|')"
HTTPS_OK=$(curl -sk --max-time 10 --resolve "${RELAY_HTTPS_HOST}:443:127.0.0.1" \
  "$RELAY_HTTPS_URL" -X GET 2>/dev/null | head -c 10 | wc -c || true)

DOCKER_OK=$(docker ps > /dev/null 2>&1 && echo PASS || echo FAIL)
IMAGE_OK=$(docker images claw-tenant:latest --format "{{.Repository}}" 2>/dev/null | grep -c claw-tenant || true)

AUTH_PROFILES="$AGENT_HOME/.openclaw/agents/main/agent/auth-profiles.json"
CREDS="$AGENT_HOME/.claude/.credentials.json"

# Ensure test user is in the allowlist (idempotent — needed by sections 5+6)
sqlite3 "$DB" "INSERT OR IGNORE INTO allowlist (id, slack_team_id, slack_user_id, added_by, created_at)
  VALUES ('validate-test-user', '$TEST_TEAM', '$TEST_USER', 'validate-deployment.sh', $(date +%s%3N));" 2>/dev/null || true

# ── 1. Service Health ──────────────────────────────────────────────────────
if section_enabled 1; then
  section "1. Service Health"
  check "Control plane (port 3200)" "$([ "$CP_OK" -ge 1 ] && echo PASS || echo FAIL)" "$CP_URL/health"
  check "Slack relay (port 3101)" "$([ "$RELAY_OK" -ge 1 ] && echo PASS || echo FAIL)"
  check "Scheduler process" "$([ "$SCHED_OK" -ge 1 ] && echo PASS || echo FAIL)"
  check "HTTPS endpoint reachable" "$([ "$HTTPS_OK" -gt 0 ] && echo PASS || echo FAIL)" "$RELAY_HTTPS_URL"
fi

# ── 2. Config & Auth ───────────────────────────────────────────────────────
if section_enabled 2; then
  section "2. Config & Auth"
  check "Runtime env file exists" "$([ -f "$ENV_FILE" ] && echo PASS || echo FAIL)" "$ENV_FILE"
  for VAR in SLACK_SIGNING_SECRET SLACK_BOT_TOKEN DATABASE_URL DATA_DIR; do
    VAL="$(read_env_value "$ENV_FILE" "$VAR")"
    check "env: $VAR set" "$([ -n "$VAL" ] && echo PASS || echo FAIL)"
  done
  check "auth-profiles.json exists" \
    "$([ -f "$AUTH_PROFILES" ] && [ -s "$AUTH_PROFILES" ] && echo PASS || echo FAIL)" "$AUTH_PROFILES"
  check ".credentials.json exists" \
    "$([ -f "$CREDS" ] && [ -s "$CREDS" ] && echo PASS || echo FAIL)" "$CREDS"
  check "SQLite DB exists" "$([ -f "$DB" ] && echo PASS || echo FAIL)" "$DB"
  check "Allowlist has test user" \
    "$([ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM allowlist WHERE slack_team_id='$TEST_TEAM' AND slack_user_id='$TEST_USER' AND revoked_at IS NULL;" 2>/dev/null)" -ge 1 ] \
      && echo PASS || echo FAIL)"
fi

# ── 3. Docker Image ────────────────────────────────────────────────────────
if section_enabled 3; then
  section "3. Docker Image"
  check "Docker daemon running" "$DOCKER_OK"
  check "claw-tenant:latest image exists" "$([ "$IMAGE_OK" -ge 1 ] && echo PASS || echo FAIL)"

  # Smoke test: start container; it should stay running for 10s
  SMOKE_DIR="/tmp/claw-validate-smoke-$$"
  mkdir -p "$SMOKE_DIR"/{home,workspace,config,logs,secrets}
  mkdir -p "$SMOKE_DIR/home/.openclaw/agents/main/agent"
  mkdir -p "$SMOKE_DIR/home/.claude"
  cat > "$SMOKE_DIR/home/.openclaw/openclaw.json" <<'JSON'
{"wizard":{"lastRunAt":"2026-01-01T00:00:00.000Z","lastRunVersion":"2026.4.15","lastRunMode":"local"},"auth":{"profiles":{"anthropic:default":{"provider":"anthropic","mode":"token"}}},"gateway":{"port":19001,"mode":"local","bind":"auto"},"agents":{"defaults":{"model":{"primary":"anthropic/claude-sonnet-4-6"},"workspace":"/workspace"}}}
JSON
  # Copy credentials into the smoke dir so the container uses copies, not the
  # real host files. Direct bind-mounts would let the gateway atomically rewrite
  # them (owned by container agent uid=1001), making them unreadable by ubuntu.
  cp "$AUTH_PROFILES" "$SMOKE_DIR/home/.openclaw/agents/main/agent/auth-profiles.json" 2>/dev/null || true
  cp "$CREDS" "$SMOKE_DIR/home/.claude/.credentials.json" 2>/dev/null || true
  chmod -R 777 "$SMOKE_DIR"

  SMOKE_OK="FAIL"
  SMOKE_DETAIL=""
  if [ "$DOCKER_OK" = "PASS" ] && [ "$IMAGE_OK" -ge 1 ]; then
    SMOKE_CID=$(docker run -d --memory=3g --memory-swap=3g \
      -v "$SMOKE_DIR/home:/home/agent" \
      -v "$SMOKE_DIR/workspace:/workspace" \
      -v "$SMOKE_DIR/config:/home/agent/.config" \
      -e "HOME=/home/agent" -e "XDG_CONFIG_HOME=/home/agent/.config" \
      -e "XDG_CACHE_HOME=/home/agent/.cache" -e "XDG_STATE_HOME=/home/agent/.local/state" \
      -e "RELAY_TOKEN=smoke-test-token" \
      claw-tenant:latest 2>/dev/null || true)

    if [ -n "$SMOKE_CID" ]; then
      sleep 10
      SMOKE_STATUS=$(docker inspect "$SMOKE_CID" --format '{{.State.Status}}' 2>/dev/null || echo "gone")
      if [ "$SMOKE_STATUS" = "running" ]; then
        SMOKE_OK="PASS"
      else
        SMOKE_DETAIL="container exited — $(docker logs "$SMOKE_CID" 2>&1 | tail -3 | tr '\n' '|')"
      fi
      docker rm -f "$SMOKE_CID" > /dev/null 2>&1 || true
    else
      SMOKE_DETAIL="docker run failed"
    fi
  fi
  sudo rm -rf "$SMOKE_DIR" 2>/dev/null || rm -rf "$SMOKE_DIR" 2>/dev/null || true
  check "Container starts and stays running (10s)" "$SMOKE_OK" "$SMOKE_DETAIL"
fi

# ── 4. Provisioning Module ─────────────────────────────────────────────────
if section_enabled 4; then
  section "4. Provisioning Module (POST /provision → verify dirs + DB)"

  cleanup_test_tenant

  PROV_TENANT_ID=""
  PROV_RELAY_TOKEN=""

  if [ "$CP_OK" -ge 1 ]; then
    PROV_RESP=$(curl -s --max-time 15 -X POST "$CP_URL/v1/tenants/provision" \
      -H "Content-Type: application/json" \
      -d "{\"slackTeamId\":\"$TEST_TEAM\",\"slackUserId\":\"$TEST_USER\"}" 2>/dev/null || echo "")
    PROV_TENANT_ID=$(echo "$PROV_RESP" | grep -o '"tenantId":"[^"]*"' | cut -d'"' -f4 || true)
    PROV_RELAY_TOKEN=$(echo "$PROV_RESP" | grep -o '"relayToken":"[^"]*"' | cut -d'"' -f4 || true)
  fi

  check "POST /provision returns tenantId + relayToken" \
    "$([ -n "$PROV_TENANT_ID" ] && [ -n "$PROV_RELAY_TOKEN" ] && echo PASS || echo FAIL)" \
    "${PROV_RESP:-CP not available}"

  if [ -n "$PROV_TENANT_ID" ]; then
    MISSING_DIRS=""
    for d in home workspace config logs secrets; do
      [ -d "$DATA_DIR/$PROV_TENANT_ID/$d" ] || MISSING_DIRS="$MISSING_DIRS $d"
    done
    check "All tenant dirs on disk (home workspace config logs secrets)" \
      "$([ -z "$MISSING_DIRS" ] && echo PASS || echo FAIL)" \
      "missing:$MISSING_DIRS"

    PROV_DB=$(sqlite3 "$DB" "SELECT status FROM tenants WHERE id='$PROV_TENANT_ID';" 2>/dev/null || echo "")
    check "DB status=NEW after provision" \
      "$([ "$PROV_DB" = "NEW" ] && echo PASS || echo FAIL)" "got: $PROV_DB"
  else
    check "All tenant dirs on disk (home workspace config logs secrets)" "FAIL" "skipped — provision failed"
    check "DB status=NEW after provision" "FAIL" "skipped — provision failed"
  fi

  cleanup_test_tenant
fi

# ── 5. Container Lifecycle + Direct Message Delivery ──────────────────────
if section_enabled 5; then
  section "5. Container Lifecycle + Message Delivery (via CP API)"

  cleanup_test_tenant

  LIFE_TENANT_ID=""
  LIFE_RELAY_TOKEN=""
  LIFE_STATUS=""

  if [ "$CP_OK" -ge 1 ] && [ "$DOCKER_OK" = "PASS" ] && [ "$IMAGE_OK" -ge 1 ]; then
    # Step A: provision
    LIFE_RESP=$(curl -s --max-time 15 -X POST "$CP_URL/v1/tenants/provision" \
      -H "Content-Type: application/json" \
      -d "{\"slackTeamId\":\"$TEST_TEAM\",\"slackUserId\":\"$TEST_USER\"}" 2>/dev/null || echo "")
    LIFE_TENANT_ID=$(echo "$LIFE_RESP" | grep -o '"tenantId":"[^"]*"' | cut -d'"' -f4 || true)
    LIFE_RELAY_TOKEN=$(echo "$LIFE_RESP" | grep -o '"relayToken":"[^"]*"' | cut -d'"' -f4 || true)

    # Step B: start container
    if [ -n "$LIFE_TENANT_ID" ]; then
      curl -s --max-time 10 -X POST "$CP_URL/v1/tenants/$LIFE_TENANT_ID/start" \
        -H "Content-Type: application/json" -d '{}' > /dev/null 2>&1 || true

      # Step C: poll for ACTIVE (health server waits for gateway port 19001 — takes ~50s)
      DEADLINE=$(($(date +%s) + 120))
      while [ "$(date +%s)" -lt "$DEADLINE" ]; do
        LIFE_STATUS=$(sqlite3 "$DB" "SELECT status FROM tenants WHERE id='$LIFE_TENANT_ID';" 2>/dev/null || echo "")
        [ "$LIFE_STATUS" = "ACTIVE" ] && break
        [ "$LIFE_STATUS" = "FAILED" ] || [ "$LIFE_STATUS" = "UNHEALTHY" ] && break
        sleep 3
      done
    fi
  fi

  if [ "$LIFE_STATUS" = "ACTIVE" ]; then
    check "Tenant reaches ACTIVE (container + gateway ready)" "PASS"

    RUNNING=$(docker ps --filter "name=claw-tenant-$LIFE_TENANT_ID" --format "{{.Names}}" 2>/dev/null | grep -c "." || true)
    check "Container is running in Docker" "$([ "$RUNNING" -ge 1 ] && echo PASS || echo FAIL)"

    # Step D: deliver a message directly via CP /message
    MSG_ID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "validate-msg-$(date +%s)")
    MSG_PAYLOAD=$(printf '{"messageId":"%s","slackEventId":"validate-direct-%s","userId":"%s","teamId":"%s","text":"say hi","slackPayload":{},"timestamp":%s}' \
      "$MSG_ID" "$(date +%s)" "$TEST_USER" "$TEST_TEAM" "$(date +%s%3N)")

    MSG_RESP=$(curl -s --max-time 150 -X POST "$CP_URL/v1/tenants/$LIFE_TENANT_ID/message" \
      -H "Content-Type: application/json" \
      -H "x-relay-token: $LIFE_RELAY_TOKEN" \
      -d "$MSG_PAYLOAD" 2>/dev/null || echo "")
    MSG_OK_VAL=$(echo "$MSG_RESP" | grep -c '"ok":true' || true)
    check "Direct /message → ok:true (LLM responded)" \
      "$([ "$MSG_OK_VAL" -ge 1 ] && echo PASS || echo FAIL)" \
      "$([ "$MSG_OK_VAL" -lt 1 ] && echo "$MSG_RESP" || true)"
  else
    check "Tenant reaches ACTIVE (container + gateway ready)" "FAIL" \
      "$([ -n "$LIFE_STATUS" ] && echo "status: $LIFE_STATUS" || echo "no tenant created")"
    check "Container is running in Docker" "FAIL" "skipped"
    check "Direct /message → ok:true (LLM responded)" "FAIL" "skipped"
  fi

  cleanup_test_tenant
fi

# ── 6. Full Slack Flow (E2E) ──────────────────────────────────────────────
if section_enabled 6; then
  section "6. Full Slack Flow — signed event → relay → CP → container → DELIVERED"

  cleanup_test_tenant

  E2E_TENANT_ID=""
  E2E_STATUS=""
  E2E_MSG_OK="FAIL"
  E2E_MSG_DETAIL="no DELIVERED message"

  if [ "$CP_OK" -ge 1 ] && [ "$RELAY_OK" -ge 1 ] && [ -n "$SIGNING_SECRET" ] \
      && [ "$DOCKER_OK" = "PASS" ] && [ "$IMAGE_OK" -ge 1 ]; then

    HTTP_CODE=$(send_slack_event "validate e2e $(date +%s)" 2>/dev/null || echo "000")
    check "Relay accepts signed event (200)" \
      "$([ "$HTTP_CODE" = "200" ] && echo PASS || echo FAIL)" "got HTTP $HTTP_CODE"

    if [ "$HTTP_CODE" = "200" ]; then
      # Poll for ACTIVE (relay starts the container asynchronously)
      DEADLINE=$(($(date +%s) + 150))
      while [ "$(date +%s)" -lt "$DEADLINE" ]; do
        E2E_TENANT_ID=$(sqlite3 "$DB" \
          "SELECT id FROM tenants WHERE slack_team_id='$TEST_TEAM' AND slack_user_id='$TEST_USER' ORDER BY created_at DESC LIMIT 1;" \
          2>/dev/null || true)
        E2E_STATUS=$([ -n "$E2E_TENANT_ID" ] && \
          sqlite3 "$DB" "SELECT status FROM tenants WHERE id='$E2E_TENANT_ID';" 2>/dev/null || echo "")
        [ "$E2E_STATUS" = "ACTIVE" ] && break
        [ "$E2E_STATUS" = "FAILED" ] || [ "$E2E_STATUS" = "UNHEALTHY" ] && break
        sleep 3
      done

      check "Tenant reaches ACTIVE via Slack flow" \
        "$([ "$E2E_STATUS" = "ACTIVE" ] && echo PASS || echo FAIL)" \
        "$([ "$E2E_STATUS" != "ACTIVE" ] && echo "status: ${E2E_STATUS:-not created}" || true)"

      if [ "$E2E_STATUS" = "ACTIVE" ]; then
        # Poll for DELIVERED
        DEADLINE=$(($(date +%s) + 120))
        while [ "$(date +%s)" -lt "$DEADLINE" ]; do
          QUEUE_DELIVERED=$(sqlite3 "$DB" \
            "SELECT COUNT(*) FROM message_queue WHERE tenant_id='$E2E_TENANT_ID' AND status='DELIVERED';" \
            2>/dev/null || echo 0)
          AUDIT_DELIVERED=$(sqlite3 "$DB" \
            "SELECT COUNT(*) FROM audit_log WHERE tenant_id='$E2E_TENANT_ID' AND event_type='MESSAGE_DELIVERED';" \
            2>/dev/null || echo 0)
          if [ "$QUEUE_DELIVERED" -ge 1 ] || [ "$AUDIT_DELIVERED" -ge 1 ]; then
            E2E_MSG_OK="PASS"
            E2E_MSG_DETAIL=""
            break
          fi
          sleep 3
        done
        check "Message DELIVERED end-to-end" "$E2E_MSG_OK" "$E2E_MSG_DETAIL"
      else
        check "Message DELIVERED end-to-end" "FAIL" "skipped — ACTIVE not reached"
      fi
    else
      check "Tenant reaches ACTIVE via Slack flow" "FAIL" "skipped — relay rejected event"
      check "Message DELIVERED end-to-end" "FAIL" "skipped"
    fi
  else
    check "Relay accepts signed event (200)" "FAIL" "skipped — services not healthy or signing secret missing"
    check "Tenant reaches ACTIVE via Slack flow" "FAIL" "skipped"
    check "Message DELIVERED end-to-end" "FAIL" "skipped"
  fi
fi

# ── Cleanup ────────────────────────────────────────────────────────────────
cleanup_test_tenant
sqlite3 "$DB" "DELETE FROM allowlist WHERE id='validate-test-user';" 2>/dev/null || true

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
if [ "$SELECTED" != "1 2 3 4 5 6" ]; then
  echo "  Sections: $SELECTED"
fi
echo "  Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ ALL CHECKS PASSED"
else
  echo "  ❌ $FAIL issue(s) need attention"
fi
echo "═══════════════════════════════════════════"
exit "$FAIL"
