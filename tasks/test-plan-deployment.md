# Test Plan: Claw Orchestrator — Full End-to-End Deployment Validation

## Source

- **Mode:** Objective
- **Objective Type:** `acceptance`
- **Target:** Claw Orchestrator — full end-to-end deployment validation
- **Generated:** 2026-03-20T00:48:00Z

---

## Scope

This test plan covers the full deployment lifecycle of the Claw Orchestrator system, which consists of three services:

- **control-plane** (port 3200): tenant provisioning, state management, message routing
- **slack-relay** (port 3101): Slack event ingestion, health endpoint, auth filtering
- **scheduler**: background task scheduling and tenant wake logic

Testing validates that the system correctly provisions isolated Docker containers per Slack user tenant, routes messages into those containers, and returns responses — across start, restart, and edge-case scenarios.

**In scope:**
- Service startup and port binding
- Process manager restart resilience
- Environment configuration validation
- Tenant provisioning (directory creation, permissions)
- Docker container lifecycle (bind mounts, health, runtime)
- OpenClaw gateway startup inside container
- Health endpoint availability
- Slack DM end-to-end message flow
- Credential file accessibility inside container
- Tenant state persistence and reuse
- Unauthorized user rejection
- AGENTS.md pre-seeding
- Interim "working on it" message timing
- Server reboot survival
- OOM detection and tenant marking
- Stopped tenant wake-on-message

---

## Out of Scope

- Internal scheduling algorithm correctness beyond observable behavior
- Slack API rate limiting or upstream Slack availability
- Container image build process (assumes image pre-built)
- TLS/HTTPS termination specifics
- Multi-region or multi-host deployments
- Performance benchmarking or load testing
- Unit-level testing of individual modules

---

## Assumptions and Ambiguities

| ID    | Issue | Assumed Interpretation | Impact if Wrong |
|-------|-------|------------------------|-----------------|
| A-001 | "Services stay up" duration not specified | Services remain running for at least 60 seconds after start with no exit | May miss flapping services that restart quickly |
| A-002 | Process manager type not specified | Assumed PM2 or systemd — tests use `pm2 restart all` or `systemctl restart` as examples | Commands may need adjustment for actual PM |
| A-003 | Slack test fixture method | Slack DM tests use Option A: direct signed HTTP POST with HMAC-SHA256 to relay at https://13.212.162.85.nip.io/slack/events — no real Slack DMs required | Signing secret or relay URL changes would require test updates |
| A-004 | "Allowlisted user" definition not specified | Assumed controlled by an env var `ALLOWED_SLACK_USERS` or config file; test uses known fixture user ID | Wrong allowlist mechanism would break auth tests |
| A-005 | OOM simulation method not specified | OOM simulated by running `stress --vm 1 --vm-bytes <excess>M` inside container or lowering container `--memory` limit | Platform may not support memory limit enforcement |
| A-006 | Database for tenant state assumed to be SQLite | sqlite3 CLI used for state inspection; adjust if Postgres/other | Commands non-functional if different DB |
| A-007 | Container agent user UID assumed 1001 | Dockerfile configures agent user with UID 1001 | Permission tests fail if UID differs |
| A-008 | "Scheduler" service has no explicit port | No port-based health check for scheduler; checked via process existence | Scheduler may expose metrics endpoint |
| A-009 | Interim message timing is ">= 15 seconds from first message" | Test waits 20 seconds and checks Slack API/relay logs for interim message send | Timer may be configurable |
| A-010 | `openclaw gateway start` assumed non-blocking with PID file | Command runs, exits 0, background process persists | Blocking command would change test steps |

---

## Risk Areas

| Risk | Severity | Mitigation |
|------|----------|------------|
| Port conflicts after process manager restart | P0 | Explicit EADDRINUSE log scan post-restart |
| Bind mount path drift (host vs container) | P0 | Validate each mount path before docker run |
| Zod env validation silent failure | P0 | Grep service logs for known error string |
| UID mismatch breaking tenant write access | P0 | Explicit stat + write test on provisioned directory |
| OOM killed container not surfacing UNHEALTHY | P2 | Poll tenant state DB after OOM event |
| Race condition on tenant wake message delivery | P2 | Allow 10-second retry window for wake test |

---

## Objective Strategy

**Type:** acceptance

**Focus:** Contract coverage against expected deployment behavior across all lifecycle phases.

**Required scenario sets:**

1. **Happy path** — services start, config loads, provisioning succeeds, message roundtrip works
2. **Validation failure** — unauthorized user, bad config, missing mounts
3. **Permission/error path** — OOM, stopped tenant, post-restart state

All P0 scenarios must pass for acceptance gate to open. P1 scenarios must pass for production readiness. P2 scenarios are required for sign-off on operational resilience.

---

## Scenario Matrix

| ID | Source | Level | Scenario | Steps | Expected Result | Evidence | Priority |
|----|--------|-------|----------|-------|-----------------|----------|----------|
| TC-001 | OBJ-ACCEPT | e2e | All 3 services start and stay up | 1. Run start command for control-plane, slack-relay, scheduler. 2. Wait 10 seconds. 3. Check process list and port bindings: `ss -tlnp \| grep -E '3200\|3101'`. 4. Check scheduler process: `pgrep -f scheduler`. 5. Wait 60 seconds, re-check all three. | All processes running; ports 3200 and 3101 bound; no unexpected exits in logs | Process list output, port binding output, service logs (no ERROR/exit lines) | P0 |
| TC-002 | OBJ-ACCEPT | e2e | Services survive process manager restart without EADDRINUSE | 1. Confirm all services running (TC-001 passing). 2. Run `pm2 restart all` (or equivalent). 3. Wait 15 seconds. 4. Check logs: `pm2 logs --lines 100 \| grep -i EADDRINUSE`. 5. Confirm ports re-bound: `ss -tlnp \| grep -E '3200\|3101'` | No EADDRINUSE errors in logs; ports re-bound successfully after restart | PM restart log, grep output (empty = pass), port check output | P0 |
| TC-003 | OBJ-ACCEPT | e2e | Services load .env config — Zod validation passes | 1. Start all services fresh. 2. Wait 5 seconds. 3. Grep service logs for Zod error: `grep -r "Invalid input: expected string" /var/log/claw/ \|\| pm2 logs --lines 200 \| grep "Invalid input"`. 4. Confirm each service log shows "config loaded" or "started" without validation errors. | No Zod validation error lines in logs; services reach "started" state | Log grep output (empty = pass), startup confirmation lines from each service | P0 |
| TC-004 | OBJ-ACCEPT | e2e | Provisioning creates /data/tenants/<id>/ with correct permissions | 1. Trigger provisioning for test user (send DM or POST to control-plane API). 2. Note tenant ID from response or DB. 3. Check directory: `ls -la /data/tenants/<id>/`. 4. Test write access as UID 1001: `docker run --rm -u 1001 -v /data/tenants/<id>:/t alpine sh -c "touch /t/probe && rm /t/probe"`. | Directory exists under /data/tenants/; writable by UID 1001 (exit 0 on write probe) | Directory listing (showing owner/perms), docker write probe exit code = 0 | P0 |
| TC-005 | OBJ-ACCEPT | e2e | Docker run succeeds with correct bind mounts | 1. Run docker container for a test tenant with required bind mounts. 2. Capture exit code and container status after 10 seconds: `docker inspect <id> --format '{{.State.Status}}'`. 3. Check for OOM: `docker inspect <id> --format '{{.State.OOMKilled}}'`. 4. Check for permission errors in container logs: `docker logs <id> 2>&1 \| grep -i "permission denied"`. | Container status = "running"; OOMKilled = false; no permission denied in logs | docker inspect output, docker logs grep (empty = pass), container status | P0 |
| TC-006 | OBJ-ACCEPT | e2e | OpenClaw gateway starts inside container | 1. Exec into running container: `docker exec <id> openclaw gateway status`. 2. If not running: `docker exec <id> openclaw gateway start`. 3. Check exit code: `echo $?`. 4. Re-run status: `docker exec <id> openclaw gateway status`. | `openclaw gateway start` exits 0; subsequent status shows gateway running/active | gateway start command exit code = 0, status output showing active | P0 |
| TC-007 | OBJ-ACCEPT | e2e | Health server responds at container port 3101 | 1. Identify host port mapped to container port 3101: `docker inspect <id> --format '{{json .NetworkSettings.Ports}}'`. 2. Send health check: `curl -sf http://localhost:<host-port>/health`. 3. Check HTTP status code: `curl -o /dev/null -w "%{http_code}" http://localhost:<host-port>/health`. | HTTP 200 response from /health endpoint; response body non-empty | curl output (200 status, response body), docker inspect port mapping | P0 |
| TC-008 | OBJ-ACCEPT | e2e | Incoming DM from allowlisted Slack user triggers provisioning and bot replies | 1. Build signed Slack event_callback JSON for team_id=T0ABHS0G3, user_id=U08M34UT0FL. 2. Compute HMAC-SHA256 signature using signing secret. 3. POST to https://13.212.162.85.nip.io/slack/events with X-Slack-Request-Timestamp and X-Slack-Signature headers. 4. Check relay response HTTP code. 5. Poll DB: `sqlite3 /data/claw-orchestrator/db.sqlite "SELECT id, status FROM tenants WHERE slack_team_id='T0ABHS0G3' AND slack_user_id='U08M34UT0FL';"`. 6. Check relay logs for bot reply. | HTTP 200 from relay; tenant row created in DB with status ACTIVE; reply event logged | curl response (200), sqlite3 query result showing ACTIVE tenant, relay outbound log showing reply | P0 |
| TC-009 | OBJ-ACCEPT | e2e | Message delivered to container and response returned to Slack user | 1. After TC-008 provisions tenant, build a signed follow-up event_callback payload for same user (team_id=T0ABHS0G3, user_id=U08M34UT0FL). 2. Compute HMAC-SHA256 signature and POST to https://13.212.162.85.nip.io/slack/events. 3. Wait 5 seconds. 4. Look up container ID from DB and check: `docker exec ${CONTAINER_ID} tail -5 /workspace/.message-log`. 5. Check relay outbound log for response sent back to user. | Message appears in container workspace log or docker logs; relay logs show outbound message with correct user ID | Container message log output, relay outbound log grep showing chat.postMessage | P0 |
| TC-010 | OBJ-ACCEPT | e2e | auth-profiles.json and .credentials.json readable inside container | 1. Check file presence: `docker exec <id> ls -la /home/agent/auth-profiles.json /home/agent/.credentials.json`. 2. Check readability: `docker exec <id> cat /home/agent/auth-profiles.json \| head -5`. 3. Check .credentials.json: `docker exec <id> cat /home/agent/.credentials.json \| head -5`. | Both files exist at /home/agent/ paths; cat exits 0; content is non-empty JSON | ls -la output, cat exit codes = 0, non-empty content (first 5 lines) | P0 |
| TC-011 | OBJ-ACCEPT | e2e | Second message from same user reuses tenant (no re-provisioning) | 1. After TC-008 establishes tenant, record original tenant ID: `sqlite3 /data/claw-orchestrator/db.sqlite "SELECT id FROM tenants WHERE slack_team_id='T0ABHS0G3' AND slack_user_id='U08M34UT0FL' ORDER BY created_at ASC LIMIT 1;"`. 2. Build and send a second signed event_callback payload for same user (team_id=T0ABHS0G3, user_id=U08M34UT0FL) to https://13.212.162.85.nip.io/slack/events. 3. Wait 3 seconds. 4. Query DB tenant count: `sqlite3 /data/claw-orchestrator/db.sqlite "SELECT COUNT(*) FROM tenants WHERE slack_team_id='T0ABHS0G3' AND slack_user_id='U08M34UT0FL';"`. 5. Verify count = 1 and ID matches original. | Tenant count remains 1; same tenant ID; no new container spawned | sqlite3 count = 1, ID match confirmed, docker ps showing no duplicate | P1 |
| TC-012 | OBJ-ACCEPT | e2e | Unauthorized user receives rejection message | 1. Build signed Slack event_callback payload for unauthorized user (team_id=T_UNKNOWN, user_id=U_UNKNOWN). 2. Compute HMAC-SHA256 signature and POST to https://13.212.162.85.nip.io/slack/events. 3. Wait 3 seconds. 4. Check relay logs for rejection: `grep -i 'unauthorized\|rejected\|not allowed\|forbidden' /var/log/claw/relay.log`. 5. Confirm no tenant created: `sqlite3 /data/claw-orchestrator/db.sqlite "SELECT COUNT(*) FROM tenants WHERE slack_team_id='T_UNKNOWN' AND slack_user_id='U_UNKNOWN';"`. | Relay logs show rejection response; DB count = 0 for T_UNKNOWN/U_UNKNOWN | curl response body, relay log grep showing rejection, sqlite3 count = 0 | P1 |
| TC-013 | OBJ-ACCEPT | e2e | AGENTS.md pre-seeded in /workspace with Task Execution section | 1. Trigger provisioning for a fresh tenant. 2. Check file exists: `docker exec <id> ls -la /workspace/AGENTS.md`. 3. Verify Task Execution section present: `docker exec <id> grep -n "Task Execution" /workspace/AGENTS.md`. | /workspace/AGENTS.md exists; grep returns at least one matching line with "Task Execution" | ls -la output, grep output with line number and match | P1 |
| TC-014 | OBJ-ACCEPT | e2e | Bot sends "working on it" interim message after 15 seconds | 1. Record send timestamp: `START_TS=$(date +%s)`. 2. Build signed event_callback payload for allowlisted user (team_id=T0ABHS0G3, user_id=U08M34UT0FL) with a slow-response prompt text. 3. Compute HMAC-SHA256 signature and POST to https://13.212.162.85.nip.io/slack/events. 4. Wait 20 seconds. 5. Check relay log: `grep -i "working on it" /var/log/claw/relay.log \| tail -3`. 6. Calculate delay from extracted timestamp. | Relay log contains "working on it" entry; delay is 15–30 seconds from send | grep output with timestamp, delay calculation in seconds (must be 15–30) | P1 |
| TC-015 | OBJ-ACCEPT | e2e | Tenant state persists across control plane restart | 1. Confirm tenant active in DB (from TC-008). 2. Restart control-plane only: `pm2 restart control-plane` (or equivalent). 3. Wait 10 seconds. 4. Query tenant state: `sqlite3 /data/claw.db "SELECT id, status FROM tenants WHERE slack_user_id='<user>';"`. 5. Send another message and confirm routing still works. | Tenant row still exists post-restart; status unchanged; message routing functional | sqlite3 query post-restart, curl message delivery success | P1 |
| TC-016 | OBJ-ACCEPT | e2e | Services survive server reboot | 1. Reboot host: `sudo reboot` (or simulate via `sudo systemctl reboot`). 2. Wait for system to come back (poll SSH availability). 3. Check all 3 services running: `pm2 list` or `systemctl status claw-*`. 4. Confirm ports bound: `ss -tlnp \| grep -E '3200\|3101'`. | All 3 services auto-start after reboot; ports re-bound; no manual intervention required | pm2/systemctl status output post-reboot, port binding confirmation | P2 |
| TC-017 | OBJ-ACCEPT | e2e | Container OOM detected and tenant marked UNHEALTHY | 1. Lower container memory limit or trigger memory pressure inside container. 2. Wait for OOM kill: `docker inspect <id> --format '{{.State.OOMKilled}}'`. 3. After OOM confirmed, poll tenant DB: `sqlite3 /data/claw.db "SELECT status FROM tenants WHERE id='<tenant-id>';"`. | OOMKilled = true in docker inspect; tenant status = UNHEALTHY in DB | docker inspect OOMKilled=true, sqlite3 status=UNHEALTHY | P2 |
| TC-018 | OBJ-ACCEPT | e2e | Stopped tenant wakes on next message | 1. Confirm a tenant exists in STOPPED state: `sqlite3 /data/claw.db "SELECT id, status FROM tenants LIMIT 1;"` (or manually stop: `docker stop <id>` + DB update). 2. Send DM for that tenant's user. 3. Poll container status: `docker inspect <tenant-id> --format '{{.State.Status}}'`. 4. Confirm message delivered after wake. | Container transitions from stopped to running; tenant status = ACTIVE; message delivered | docker inspect status=running, DB status=ACTIVE, message delivery log | P2 |

---

## Execution Strategy

**Execution order:** TC-001 → TC-002 → TC-003 → TC-004 → TC-005 → TC-006 → TC-007 → TC-008 → TC-009 → TC-010 → TC-011 → TC-012 → TC-013 → TC-014 → TC-015 → TC-016 → TC-017 → TC-018

**Dependencies:**
- TC-002 depends on TC-001 (services must be up before restart test)
- TC-004 depends on TC-008 or standalone provisioning trigger
- TC-005 depends on TC-004 (directory must exist before docker run)
- TC-006, TC-007, TC-009, TC-010 depend on TC-005 (container must be running)
- TC-011, TC-012, TC-013, TC-014, TC-015 depend on TC-008
- TC-017 requires a running container from TC-005
- TC-018 requires an existing tenant from TC-008 in STOPPED state

**Fixtures required:** None — Slack DM tests use Option A (signed HTTP POST). Payloads are built inline via bash using:
- Relay URL: `https://13.212.162.85.nip.io/slack/events`
- Signing secret: `785bea69b0df0ec4ad8b4bc5d35b409f`
- Allowlisted user: `team_id=T0ABHS0G3`, `user_id=U08M34UT0FL`
- Unauthorized user: `team_id=T_UNKNOWN`, `user_id=U_UNKNOWN`

**Tools required:** `curl`, `sqlite3`, `docker`, `ss`, `pgrep`, `pm2` (or systemd), `grep`, `bash`

**Environment required:** Host with Docker daemon, SQLite DB at `/data/claw.db`, services running via process manager, test fixtures present

---

## Entry/Exit Criteria

### Entry Criteria
- All 3 service processes are defined in process manager config
- `.env` file present and populated at service root
- Docker image for agent container is built and available locally
- `/data/` directory exists and is writable by the service user
- Slack relay is reachable at https://13.212.162.85.nip.io/slack/events
- `curl` and `openssl` available for signed HTTP POST (Option A — no fixture files needed)

### Exit Criteria (Acceptance Gate)
- **P0:** All 10 P0 test cases pass with documented evidence → system is deployable
- **P1:** All 5 P1 test cases pass → system is production-ready
- **P2:** All 3 P2 test cases pass → system is operationally resilient

**Blocking failures:** Any P0 failure blocks acceptance. P1 failures block production promotion. P2 failures are documented risks but do not block deployment.

---

## Evidence Requirements

Each test case must produce and retain:

1. **Command output** — exact stdout/stderr from verification commands
2. **Log excerpts** — relevant log lines with timestamps from service logs
3. **DB query results** — sqlite3 query output for state verification
4. **Docker inspect output** — container state JSON for container lifecycle tests
5. **HTTP response codes** — curl status codes for all endpoint tests

Evidence must be stored in `tasks/qa-evidence/TC-<id>/` with filename `evidence.txt` per test case.

---

## Traceability

| TC ID | Objective Requirement | Acceptance Strategy Section |
|-------|-----------------------|-----------------------------|
| TC-001 | Services up | Happy path — process lifecycle |
| TC-002 | Restart resilience | Happy path — process lifecycle |
| TC-003 | Config validation | Happy path — config load |
| TC-004 | Provisioning correctness | Happy path — provisioning |
| TC-005 | Docker runtime | Happy path — container lifecycle |
| TC-006 | Gateway init | Happy path — container lifecycle |
| TC-007 | Health endpoint | Happy path — health/observability |
| TC-008 | E2E DM trigger | Happy path — message roundtrip |
| TC-009 | Message delivery | Happy path — message roundtrip |
| TC-010 | Credential access | Happy path — container config |
| TC-011 | Tenant reuse | Happy path — idempotency |
| TC-012 | Auth rejection | Validation failure — auth path |
| TC-013 | Workspace seeding | Happy path — provisioning |
| TC-014 | Interim message | Happy path — timing/UX |
| TC-015 | State persistence | Happy path — restart resilience |
| TC-016 | Reboot survival | Permission/error path — infra resilience |
| TC-017 | OOM detection | Permission/error path — error detection |
| TC-018 | Tenant wake | Permission/error path — state recovery |
