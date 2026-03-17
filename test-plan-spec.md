# QA Test Plan — Claw Orchestrator E2E

**Plan ID:** claw-orchestrator-e2e  
**Source:** SPEC.md + prd.json  
**Generated:** 2026-03-17  
**Author:** qa-plan-generator pipeline  

---

## Scope

End-to-end and integration tests verifying the full Claw Orchestrator lifecycle: Slack message ingestion → tenant provisioning → container management → message delivery → lifecycle events → security boundaries.

All 39 user stories (US-001 through US-040) are covered. Tests run with **Vitest** using real SQLite (in-memory / temp file) and mocked Docker CLI.

---

## Test Environment

- **Runtime:** Node.js 22, Vitest
- **Database:** Real SQLite temp files (not mocked)
- **Docker:** Mocked via `@claw/docker-client` injection / `vi.mock`
- **Slack API:** Mocked via `globalThis.fetch` interceptor
- **Test data dir:** `/tmp/claw-test-tenants`
- **Command:** `pnpm test:e2e`

---

## Scenario Map

| ID | User Stories | Level | Priority | Flow |
|---|---|---|---|---|
| TC-001 | US-040, US-007, US-008 | e2e | P0 | First Slack message → provision → start → deliver |
| TC-002 | US-040, US-024 | e2e | P0 | Same user second message → reuse same tenant |
| TC-003 | US-025, US-011 | e2e | P0 | Stopped tenant → wake on message → queued messages replayed |
| TC-004 | US-007, US-009 | e2e | P0 | Concurrent messages to stopped tenant → single start (startup lock) |
| TC-005 | US-003, US-007 | integration | P0 | Different users → completely isolated tenants |
| TC-006 | US-015, US-023 | e2e | P0 | Allowlist enforcement → unauthorized user rejected |
| TC-007 | US-014, US-029 | integration | P0 | Tenant deletion → data cleaned up |
| TC-008 | US-017, US-010 | integration | P0 | Health polling → UNHEALTHY detection |
| TC-009 | US-028 | integration | P1 | Disk quota → warning at 90%, block at 100% |
| TC-010 | US-027 | integration | P1 | Idle stop → container stopped after 48h inactivity |
| TC-011 | US-021, US-032 | integration | P1 | auth-profiles.json bind-mount → included in docker run options |
| TC-012 | US-008, US-035 | integration | P1 | AGENTS.md pre-seeded correctly in tenant workspace |
| TC-013 | US-009 | unit | P0 | Startup lock → no duplicate containers on concurrent messages |
| TC-014 | US-019 | integration | P1 | Provisioning rollback → cleanup on failure |
| TC-015 | US-018 | integration | P0 | Audit log → events recorded for all system actions |
| TC-016 | US-006 | integration | P1 | Control plane startup reconciliation → crashed state reset |
| TC-017 | US-005 | unit | P2 | Config validation → missing env var causes fast failure |
| TC-018 | US-002, US-001 | unit | P2 | Tenant ID computation → sha256(team:user).slice(0,16) |
| TC-019 | US-023 | unit | P0 | Slack signature verification → valid/invalid/expired |
| TC-020 | US-026 | integration | P1 | Interim message sent at 15s when agent takes too long |
| TC-021 | US-039, US-011 | integration | P0 | Start endpoint → STOPPED → STARTING → ACTIVE transition |
| TC-022 | US-013 | integration | P1 | Stop endpoint → ACTIVE → STOPPED transition |
| TC-023 | US-030 | integration | P1 | Capacity queue → ACTIVE_TENANTS_OVERFLOW queues tenant |
| TC-024 | US-020 | integration | P2 | Container image promote → new default image used on next start |
| TC-025 | US-024, US-025 | e2e | P1 | Message queue deduplication → Slack retry is no-op |
| TC-026 | US-039 | integration | P0 | MAX_ACTIVE_TENANTS enforcement → second tenant queued |
| TC-027 | US-015 | integration | P1 | Allowlist revocation → existing tenant blocked |
| TC-028 | US-017 | integration | P1 | UNHEALTHY auto-recovery → tenant recovers and queued messages processed |
| TC-029 | US-007 | integration | P1 | Provision endpoint idempotency → same tenant on duplicate call |
| TC-030 | US-029 | integration | P2 | Queue reaping → DELIVERED rows older than 7 days deleted |
| TC-031 | US-012 | integration | P0 | Message forwarding → relay token mismatch → 401 |
| TC-032 | US-012 | integration | P0 | Message forwarding → disk quota exceeded → 507 |
| TC-033 | US-036 | unit | P2 | systemd unit files exist for all three services |
| TC-034 | US-037 | unit | P2 | tenant-shell script validates container is running |
| TC-035 | US-031 | unit | P2 | Tenant Dockerfile does not embed ANTHROPIC_API_KEY |
| TC-036 | US-004 | unit | P1 | Docker client wrapper → correct CLI flags constructed |
| TC-037 | US-038 | unit | P1 | Workspace template fixtures → test-utils package |
| TC-038 | US-033 | integration | P1 | Health endpoint in tenant container returns correct JSON shape |
| TC-039 | US-034 | integration | P1 | Message endpoint in tenant container validates relay token |

---

## Detailed Scenarios

### TC-001 — First Slack message → tenant provisioned → container started → message delivered

**Source:** US-040, US-007, US-008  
**Level:** e2e  
**Priority:** P0  

**Steps:**
1. Pre-seed allowlist entry for test user (team T_TC001, user U_TC001)
2. POST fake Slack event to relay `/slack/events` with valid HMAC signature
3. Verify relay returns HTTP 200 immediately (before provisioning completes)
4. Poll DB until tenant row exists with status=ACTIVE (max 30s)
5. Assert tenant directories created: home/, workspace/, config/, logs/, secrets/
6. Assert AGENTS.md seeded in workspace with `## Task Execution` section
7. Assert message_queue row transitions to DELIVERED
8. Assert Slack chat.postMessage called with agent response
9. Assert audit log contains TENANT_PROVISIONED, TENANT_STARTED, MESSAGE_DELIVERED in order

**Expected Result:** Full provisioning flow completes; message delivered; audit trail present  
**Evidence:** DB state + filesystem + mock fetch call log  

---

### TC-002 — Repeated messages from same user → same tenant reused

**Source:** US-040, US-024  
**Level:** e2e  
**Priority:** P0  

**Steps:**
1. Ensure TC-001 tenant is ACTIVE
2. Send second Slack event with same team+user, different event_id
3. Assert relay returns HTTP 200 immediately
4. Assert no new tenant row created (count = 1 for this principal)
5. Assert same tenant_id used for both messages
6. Assert second message_queue row added and delivered
7. Assert tenant last_activity_at updated

**Expected Result:** Same tenant reused; message count incremented; no duplicate provisioning  
**Evidence:** DB tenant count, message_queue rows  

---

### TC-003 — Stopped tenant → wakes on next message → queued messages replayed

**Source:** US-025, US-011  
**Level:** e2e  
**Priority:** P0  

**Steps:**
1. Provision a tenant and bring to ACTIVE
2. Stop the tenant via POST /v1/tenants/:id/stop
3. Assert tenant status = STOPPED
4. Send a Slack event to the relay for this tenant
5. Assert relay calls /v1/tenants/:id/start
6. Mock health endpoint returns healthy after start
7. Poll until tenant status = ACTIVE
8. Assert queued message_queue rows are delivered in order

**Expected Result:** Tenant wakes; queued messages replayed in FIFO order  
**Evidence:** message_queue rows status=DELIVERED, ordered by created_at  

---

### TC-004 — Concurrent messages to stopped tenant → single start (startup lock)

**Source:** US-007, US-009  
**Level:** e2e  
**Priority:** P0  

**Steps:**
1. Provision a tenant and set status=STOPPED
2. Send two Slack events simultaneously (Promise.all)
3. Assert only ONE call to dockerStart / dockerRun (mock call count)
4. Assert both messages are eventually delivered
5. Assert startup_locks table has at most 1 row at any time
6. Assert no duplicate containers (docker run called exactly once)

**Expected Result:** Startup lock prevents duplicate container starts  
**Evidence:** mockDockerClient.start/run call count = 1  

---

### TC-005 — Different users → completely isolated (no shared workspace/state)

**Source:** US-007, US-003  
**Level:** integration  
**Priority:** P0  

**Steps:**
1. Provision tenant A (team T1, user U1) via POST /v1/tenants/provision
2. Provision tenant B (team T1, user U2) via POST /v1/tenants/provision
3. Assert different tenant IDs (sha256 of different principals)
4. Assert different data_dir paths
5. Assert different container_name values
6. Assert different relay_token values
7. Write a marker file to tenant A workspace
8. Assert marker file NOT present in tenant B workspace path

**Expected Result:** Complete filesystem and identity isolation between tenants  
**Evidence:** Different tenantId, data_dir, relay_token; filesystem check  

---

### TC-006 — Allowlist enforcement → unauthorized user rejected

**Source:** US-015, US-023  
**Level:** e2e  
**Priority:** P0  

**Steps:**
1. Ensure no allowlist entry exists for team T_BLOCKED, user U_BLOCKED
2. POST Slack event from T_BLOCKED/U_BLOCKED to relay
3. Assert relay returns HTTP 200 (Slack ack)
4. Assert control plane returns 403 on /v1/tenants/provision
5. Assert NO tenant row created for this user
6. Assert Slack chat.postMessage called with invite-only rejection message
7. Assert ACCESS_DENIED audit log entry exists

**Expected Result:** Access denied; rejection DM sent; no tenant created  
**Evidence:** 403 from CP, no tenant row, audit log  

---

### TC-007 — Tenant deletion → data cleaned up

**Source:** US-014, US-029  
**Level:** integration  
**Priority:** P0  

**Steps:**
1. Provision tenant and create workspace files
2. Call DELETE /v1/tenants/:id
3. Assert response {deleted: true}
4. Assert tenant row has deleted_at set (soft delete)
5. Assert message_queue rows for tenant purged
6. Assert startup_locks row purged
7. Assert TENANT_DELETED audit log entry
8. Assert tenant data_dir moved to tenants-archive/
9. Assert second DELETE returns HTTP 409

**Expected Result:** All tenant resources cleaned up; audit trail preserved  
**Evidence:** DB state, filesystem archive  

---

### TC-008 — Health polling → UNHEALTHY detection

**Source:** US-017, US-010  
**Level:** integration  
**Priority:** P0  

**Steps:**
1. Provision tenant and set status=ACTIVE
2. Start health monitor polling
3. Mock health endpoint to return 503 for 3 consecutive polls
4. Assert tenant status transitions to UNHEALTHY
5. Assert TENANT_UNHEALTHY audit log entry written with reason
6. Assert UNHEALTHY state does not affect other tenants

**Expected Result:** Health polling detects failure; UNHEALTHY state set  
**Evidence:** DB status=UNHEALTHY, audit log entry  

---

### TC-009 — Disk quota → warning at 90%, block at 100%

**Source:** US-028  
**Level:** integration  
**Priority:** P1  

**Steps:**
1. Mock `du -sb` to return 10.8 GB (90% of 12 GB quota)
2. Run disk check scheduler tick
3. Assert DISK_QUOTA_WARNING audit event written
4. Assert Slack DM sent with cleanup suggestion
5. Mock `du -sb` to return 12 GB (100% of quota)
6. Run disk check scheduler tick
7. Assert DISK_QUOTA_EXCEEDED audit event written
8. Assert tenant.disk_quota_exceeded = 1
9. Assert POST /v1/tenants/:id/message returns 507 while quota exceeded
10. Mock `du -sb` to return < 11.4 GB (< 95%)
11. Run disk check; assert disk_quota_exceeded reset to 0

**Expected Result:** Warning at 90%, block at 100%, auto-clear below 95%  
**Evidence:** Audit log, DB disk_quota_exceeded flag, 507 response  

---

### TC-010 — Idle stop → container stopped after 48h inactivity

**Source:** US-027  
**Level:** integration  
**Priority:** P1  

**Steps:**
1. Create tenant with status=ACTIVE and last_activity_at = now - 49 hours
2. Run scheduler idle stop job
3. Assert POST /v1/tenants/:id/stop was called
4. Assert tenant status = STOPPED
5. Assert TENANT_STOPPED audit event with actor=scheduler
6. Create another tenant with last_activity_at = now - 47 hours
7. Run scheduler idle stop job
8. Assert second tenant is NOT stopped

**Expected Result:** Idle tenants stopped after 48h; recent tenants unaffected  
**Evidence:** DB status, audit log actor  

---

### TC-011 — auth-profiles.json bind-mount → included in docker run options

**Source:** US-021, US-032  
**Level:** integration  
**Priority:** P1  

**Steps:**
1. Call buildDockerRunOptions with tenantId, image, dataDir
2. Assert returned options include readOnlyBindMounts
3. Assert bind mount contains path ending in auth-profiles.json
4. Assert bind mount is marked read-only (:ro)
5. Assert container env includes HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_STATE_HOME
6. Assert resource flags: --cpus=1.0, --memory=1536m, --pids-limit=256

**Expected Result:** docker run options include auth-profiles.json:ro and correct env vars  
**Evidence:** Options object assertion  

---

### TC-012 — AGENTS.md pre-seeded correctly in tenant workspace

**Source:** US-008, US-035  
**Level:** integration  
**Priority:** P1  

**Steps:**
1. Create a temp workspace directory (empty)
2. Call seedWorkspace(workspacePath, templatesDir)
3. Assert AGENTS.md created with `## Task Execution` section
4. Call seedWorkspace again (AGENTS.md already present with section)
5. Assert AGENTS.md untouched
6. Remove `## Task Execution` section from AGENTS.md
7. Call seedWorkspace again
8. Assert `## Task Execution` section appended to existing file

**Expected Result:** Three merge scenarios handled correctly  
**Evidence:** File content assertions  

---

### TC-013 — Startup lock → no duplicate containers on concurrent messages

**Source:** US-009  
**Level:** unit  
**Priority:** P0  

**Steps:**
1. Call acquireStartupLock(tenantId, requestId1) → assert {acquired: true}
2. Call acquireStartupLock(tenantId, requestId2) → assert {acquired: false}
3. Call releaseStartupLock(tenantId, requestId1)
4. Call acquireStartupLock(tenantId, requestId3) → assert {acquired: true}
5. Insert stale lock (expires_at = 1 ms ago)
6. Call acquireStartupLock → assert stale lock overridden, {acquired: true}

**Expected Result:** At most one lock holder; stale locks expire and can be taken over  
**Evidence:** acquireStartupLock return values  

---

### TC-014 — Provisioning rollback → cleanup on failure

**Source:** US-019  
**Level:** integration  
**Priority:** P1  

**Steps:**
1. Mock docker.run to throw an error
2. Call POST /v1/tenants/provision for a new user
3. Assert tenant status = FAILED
4. Assert provision_attempts = 1
5. Assert data_dir directory does NOT exist (cleaned up)
6. Assert TENANT_PROVISION_FAILED audit log entry
7. Retry provision → assert attempts = 2
8. Retry twice more → assert status = FAILED permanently (attempts >= 3)

**Expected Result:** Rollback cleans up all resources; 3-attempt cap enforced  
**Evidence:** DB state, filesystem, audit log  

---

### TC-015 — Audit log → events recorded for all system actions

**Source:** US-018  
**Level:** integration  
**Priority:** P0  

**Steps:**
1. Provision a tenant → assert TENANT_PROVISIONED event
2. Start the tenant → assert TENANT_STARTED event
3. Deliver a message → assert MESSAGE_DELIVERED event
4. Stop the tenant → assert TENANT_STOPPED event
5. Delete the tenant → assert TENANT_DELETED event
6. Attempt access by blocked user → assert ACCESS_DENIED event
7. Add allowlist entry → assert ACCESS_GRANTED event
8. Revoke allowlist entry → assert ACCESS_REVOKED event
9. GET /v1/admin/audit?tenant_id=X → assert all events returned in desc order
10. Assert audit log rows cannot be deleted or updated (no DELETE/UPDATE endpoint)

**Expected Result:** All 8 event types recorded; audit API returns them correctly  
**Evidence:** Audit log rows  

---

### TC-016 — Control plane startup reconciliation → crashed state reset

**Source:** US-006  
**Level:** integration  
**Priority:** P1  

**Steps:**
1. Insert a tenant row with status=PROVISIONING into DB
2. Insert a tenant row with status=STARTING
3. Insert an expired startup_lock (expires_at in the past)
4. Insert a message_queue row with status=PROCESSING and updated_at = 3 minutes ago
5. Start/build the control plane app (calls reconciliation)
6. Assert PROVISIONING tenant → status=FAILED
7. Assert STARTING tenant → status=FAILED
8. Assert expired startup_lock deleted
9. Assert stale PROCESSING message → status=PENDING
10. Assert SYSTEM_STARTUP audit log entry written

**Expected Result:** Startup reconciliation restores consistent state  
**Evidence:** DB state after buildApp()  

---

### TC-017 — Config validation → missing env var causes fast failure

**Source:** US-005  
**Level:** unit  
**Priority:** P2  

**Steps:**
1. Remove SLACK_SIGNING_SECRET from process.env
2. Import slack-relay config module
3. Assert ZodError thrown with message identifying missing field
4. Remove DATABASE_URL from process.env
5. Import control-plane config module
6. Assert ZodError thrown

**Expected Result:** Fast failure with descriptive error on startup  
**Evidence:** ZodError thrown  

---

### TC-018 — Tenant ID computation → sha256(team:user).slice(0,16)

**Source:** US-002, US-001  
**Level:** unit  
**Priority:** P2  

**Steps:**
1. Compute tenantId for (T12345, U67890)
2. Assert result equals sha256("T12345:U67890").hex.slice(0,16)
3. Assert result is exactly 16 hex chars
4. Assert same inputs always produce same output (deterministic)
5. Assert different users produce different IDs

**Expected Result:** Deterministic, collision-resistant 16-char hex ID  
**Evidence:** Hash assertion  

---

### TC-019 — Slack signature verification → valid/invalid/expired

**Source:** US-023  
**Level:** unit  
**Priority:** P0  

**Steps:**
1. POST /slack/events with valid HMAC signature → assert HTTP 200
2. POST /slack/events with invalid signature → assert HTTP 403
3. POST /slack/events with timestamp 6 minutes old → assert HTTP 403 (replay protection)
4. POST /slack/events with missing X-Slack-Signature → assert HTTP 403
5. POST /slack/events with type=url_verification → assert {challenge: ...} returned synchronously

**Expected Result:** Signature enforcement prevents unauthorized event injection  
**Evidence:** HTTP status codes  

---

### TC-020 — Interim message sent at 15s when agent takes too long

**Source:** US-026  
**Level:** integration  
**Priority:** P1  

**Steps:**
1. Mock tenant runtime to delay response by 20 seconds
2. Send Slack event to relay
3. Assert chat.postMessage called with "⏳ Working on it..." after ~15s
4. Assert interim message sent only once
5. After mock response arrives at 20s, assert final response also posted to Slack

**Expected Result:** Interim "working on it" message sent on 15s timer  
**Evidence:** mock fetch call log for chat.postMessage  

---

### TC-021 — Start endpoint → STOPPED → STARTING → ACTIVE transition

**Source:** US-039, US-011  
**Level:** integration  
**Priority:** P0  

**Steps:**
1. Create tenant with status=STOPPED via DB
2. POST /v1/tenants/:id/start
3. Assert response status=202 with {status: 'starting'}
4. Assert tenant DB status=STARTING
5. Mock health endpoint returns 200 ok:true
6. Poll until tenant status=ACTIVE (max 10s)
7. Assert TENANT_STARTED audit event written
8. POST /v1/tenants/:id/start again → assert {status: 'active'} (idempotent)

**Expected Result:** Full STOPPED → STARTING → ACTIVE state machine  
**Evidence:** DB status transitions, audit log  

---

### TC-022 — Stop endpoint → ACTIVE → STOPPED transition

**Source:** US-013  
**Level:** integration  
**Priority:** P1  

**Steps:**
1. Create tenant with status=ACTIVE
2. POST /v1/tenants/:id/stop
3. Assert response {status: 'stopped'}
4. Assert tenant DB status=STOPPED
5. Assert last_stopped_at set
6. Assert TENANT_STOPPED audit event written
7. POST /v1/tenants/:id/stop again → assert {status: 'already_stopped'}
8. Assert dockerStop called only once (not on second call)

**Expected Result:** Idempotent stop; correct DB transitions  
**Evidence:** DB state, mock docker call count  

---

### TC-023 — Capacity queue → ACTIVE_TENANTS_OVERFLOW queues tenant

**Source:** US-030  
**Level:** integration  
**Priority:** P1  

**Steps:**
1. Fill DB with 10 ACTIVE tenant rows directly
2. Provision new tenant (tenant A)
3. POST /v1/tenants/tenantA/start
4. Assert response {status: 'queued'} (202)
5. Assert tenant.queued_for_start_at set
6. Assert dockerStart NOT called
7. Remove 1 ACTIVE tenant (simulate stop)
8. Run scheduler capacity queue retry
9. Assert tenant A starts and becomes ACTIVE

**Expected Result:** Overflow queued correctly; starts when capacity opens  
**Evidence:** DB state, mock docker call  

---

### TC-024 — Container image promote → new default used on next start

**Source:** US-020  
**Level:** integration  
**Priority:** P2  

**Steps:**
1. Seed default image (tag: v1.0)
2. Insert new image row (tag: v2.0, is_default=0)
3. POST /v1/admin/images/:id/promote for v2.0
4. Assert v2.0 is_default=1
5. Assert v1.0 is_default=0 and deprecated_at set
6. Start a tenant → assert image_tag = v2.0 on tenant row
7. Assert IMAGE_UPDATED audit event

**Expected Result:** Image promotion works; tenants use new default on restart  
**Evidence:** DB state  

---

### TC-025 — Message queue deduplication → Slack retry is no-op

**Source:** US-024, US-025  
**Level:** e2e  
**Priority:** P1  

**Steps:**
1. Send Slack event with event_id=Ev_DUP_001
2. Assert message_queue row created
3. Send identical Slack event again with same event_id (simulated Slack retry)
4. Assert message_queue row count = 1 (no duplicate)
5. Assert only one delivery attempt made to tenant runtime

**Expected Result:** Duplicate Slack events idempotently ignored  
**Evidence:** message_queue row count  

---

### TC-026 — MAX_ACTIVE_TENANTS enforcement → second tenant queued

**Source:** US-039  
**Level:** integration  
**Priority:** P0  

**Steps:**
1. Fill DB with MAX_ACTIVE_TENANTS (10) ACTIVE rows
2. Provision a new tenant
3. POST /v1/tenants/:id/start
4. Assert response {status: 'queued'}
5. Assert queued_for_start_at set on tenant

**Expected Result:** Hard cap enforced; overflow is queued not rejected  
**Evidence:** 202 response, DB state  

---

### TC-027 — Allowlist revocation → existing tenant blocked

**Source:** US-015  
**Level:** integration  
**Priority:** P1  

**Steps:**
1. Provision and activate tenant for user U_REVOKE
2. DELETE /v1/admin/allowlist/:id to revoke access
3. Assert response {revoked: true}
4. POST /v1/tenants/:id/message for revoked tenant
5. Assert response 403 {ok: false, error: 'Access revoked'}
6. Assert ACCESS_REVOKED audit event

**Expected Result:** Revoked users cannot deliver messages to their tenant  
**Evidence:** 403 response, audit log  

---

### TC-028 — UNHEALTHY auto-recovery → tenant recovers and queued messages processed

**Source:** US-017  
**Level:** integration  
**Priority:** P1  

**Steps:**
1. Provision and activate tenant
2. Queue 2 messages while tenant is UNHEALTHY
3. Trigger UNHEALTHY detection (3 consecutive health poll failures)
4. Assert TENANT_UNHEALTHY audit event
5. Assert Slack DM sent about recovery attempt
6. Mock health endpoint to return healthy after 30s cooldown
7. Assert tenant returns to ACTIVE within 90s
8. Assert TENANT_RECOVERED audit event
9. Assert queued messages processed after recovery

**Expected Result:** Auto-recovery completes; queued messages not dropped  
**Evidence:** DB state, audit log, message delivery  

---

### TC-029 — Provision endpoint idempotency → same tenant on duplicate call

**Source:** US-007  
**Level:** integration  
**Priority:** P1  

**Steps:**
1. POST /v1/tenants/provision for (T1, U1) → assert tenant created
2. POST /v1/tenants/provision for (T1, U1) again
3. Assert same tenantId returned
4. Assert only 1 tenant row in DB for this principal
5. Assert no new audit events written on idempotent call

**Expected Result:** Idempotent provisioning returns same tenant  
**Evidence:** DB count = 1, same tenantId  

---

### TC-030 — Queue reaping → DELIVERED rows older than 7 days deleted

**Source:** US-029  
**Level:** integration  
**Priority:** P2  

**Steps:**
1. Insert DELIVERED message_queue row with created_at = 8 days ago
2. Insert DELIVERED message_queue row with created_at = 3 days ago
3. Insert FAILED message_queue row with created_at = 31 days ago
4. Insert FAILED message_queue row with created_at = 15 days ago
5. Run queue reaping job
6. Assert 8-day-old DELIVERED row deleted
7. Assert 3-day-old DELIVERED row NOT deleted
8. Assert 31-day-old FAILED row deleted
9. Assert 15-day-old FAILED row NOT deleted

**Expected Result:** Correct retention policy applied  
**Evidence:** DB row counts  

---

### TC-031 — Message forwarding → relay token mismatch → 401

**Source:** US-012  
**Level:** integration  
**Priority:** P0  

**Steps:**
1. Provision and activate tenant with known relay_token
2. POST /v1/tenants/:id/message with wrong X-Relay-Token header
3. Assert HTTP 401 response {ok: false, error: 'Unauthorized'}
4. POST /v1/tenants/:id/message with correct relay token
5. Assert HTTP 200 (message forwarded)

**Expected Result:** Relay token validates message delivery authorization  
**Evidence:** 401 vs 200 response codes  

---

### TC-032 — Message forwarding → disk quota exceeded → 507

**Source:** US-012  
**Level:** integration  
**Priority:** P0  

**Steps:**
1. Provision and activate tenant
2. Set tenant.disk_quota_exceeded = 1 directly in DB
3. POST /v1/tenants/:id/message with correct relay token
4. Assert HTTP 507 {ok: false, error: 'Disk quota exceeded'}
5. Set disk_quota_exceeded = 0
6. POST /v1/tenants/:id/message again
7. Assert HTTP 200 (message forwarded successfully)

**Expected Result:** Disk quota flag blocks message delivery  
**Evidence:** 507 vs 200 response codes  

---

### TC-033 — systemd unit files exist for all three services

**Source:** US-036  
**Level:** unit  
**Priority:** P2  

**Steps:**
1. Assert deploy/systemd/claw-control-plane.service file exists
2. Assert deploy/systemd/claw-slack-relay.service file exists
3. Assert deploy/systemd/claw-scheduler.service file exists
4. Assert each file contains WantedBy=multi-user.target
5. Assert control-plane service has Requires=docker.service

**Expected Result:** All unit files present and correctly structured  
**Evidence:** File existence and content  

---

### TC-034 — tenant-shell script validates container is running

**Source:** US-037  
**Level:** unit  
**Priority:** P2  

**Steps:**
1. Assert scripts/tenant-shell.sh file exists
2. Assert file contains `docker exec -it --user agent`
3. Assert file validates containerName argument
4. Assert shebang #!/bin/bash present

**Expected Result:** Operator tool exists and is properly structured  
**Evidence:** File content assertions  

---

### TC-035 — Tenant Dockerfile does not embed ANTHROPIC_API_KEY

**Source:** US-031  
**Level:** unit  
**Priority:** P2  

**Steps:**
1. Read docker/tenant-image/Dockerfile
2. Assert no line contains ANTHROPIC_API_KEY
3. Assert no ENV instruction sets any API key
4. Assert auth-profiles.json is NOT COPY'd into the image
5. Assert image build ARG only has IMAGE_TAG (no auth args)

**Expected Result:** No credentials embedded in image  
**Evidence:** Dockerfile content scan  

---

### TC-036 — Docker client wrapper → correct CLI flags constructed

**Source:** US-004  
**Level:** unit  
**Priority:** P1  

**Steps:**
1. Mock execa
2. Call dockerRun with sample options
3. Assert --cpus, --memory, --memory-swap, --pids-limit, --ulimit nofile present
4. Assert --name=claw-tenant-<id> present
5. Assert -d flag present (detached)
6. Assert :ro suffix on auth-profiles.json bind mount
7. Call dockerStop → assert --time=10 flag
8. Call dockerRm → assert -f flag

**Expected Result:** CLI arguments constructed correctly for all operations  
**Evidence:** execa mock call args  

---

### TC-037 — Workspace template fixtures → test-utils package

**Source:** US-038  
**Level:** unit  
**Priority:** P1  

**Steps:**
1. Import makeTenant() from test-utils
2. Assert all required Tenant fields populated
3. Import makeMessageQueueRow()
4. Assert all required MessageQueueRow fields populated
5. Import mockPrismaClient()
6. Assert all DB methods are vi.fn() mocks
7. Import mockDockerClient()
8. Assert run, start, stop, rm are vi.fn() mocks

**Expected Result:** Test utilities produce valid typed fixtures  
**Evidence:** Type checking + runtime assertions  

---

### TC-038 — Health endpoint in tenant container returns correct JSON shape

**Source:** US-033  
**Level:** integration  
**Priority:** P1  

**Steps:**
1. Assert docker/tenant-image/health-server.js exists
2. Verify file exports GET /health handler
3. Verify healthy response shape: {ok: true, status: 'healthy', checks: {openclaw, workspace_mounted, home_mounted}, uptime_ms}
4. Verify unhealthy response shape: {ok: false, status: 'starting', checks: {...}}
5. Assert Content-Type application/json set

**Expected Result:** Health server returns correct JSON shapes  
**Evidence:** File content / unit test  

---

### TC-039 — Message endpoint in tenant container validates relay token

**Source:** US-034  
**Level:** integration  
**Priority:** P1  

**Steps:**
1. Assert docker/tenant-image/message-server.js exists
2. Verify file validates X-Relay-Token against RELAY_TOKEN env var
3. Assert 401 returned on token mismatch
4. Assert response shape: {ok: true, response: '...', blocks: null} on success
5. Assert error response shape: {ok: false, error: '...'} on failure

**Expected Result:** Message server enforces relay token authentication  
**Evidence:** File content assertions  

---

## Coverage Matrix

| US ID | TC | Priority |
|---|---|---|
| US-001 | TC-018 | P2 |
| US-002 | TC-018 | P2 |
| US-003 | TC-005 | P0 |
| US-004 | TC-036 | P1 |
| US-005 | TC-017 | P2 |
| US-006 | TC-016 | P1 |
| US-007 | TC-001, TC-005, TC-014, TC-029 | P0/P1 |
| US-008 | TC-012 | P1 |
| US-009 | TC-004, TC-013 | P0 |
| US-010 | TC-008 | P0 |
| US-011 | TC-003, TC-021 | P0 |
| US-012 | TC-031, TC-032 | P0 |
| US-013 | TC-022 | P1 |
| US-014 | TC-007 | P0 |
| US-015 | TC-006, TC-027 | P0/P1 |
| US-017 | TC-008, TC-028 | P0/P1 |
| US-018 | TC-015 | P0 |
| US-019 | TC-014 | P1 |
| US-020 | TC-024 | P2 |
| US-021 | TC-011 | P1 |
| US-022 | TC-016 | P1 |
| US-023 | TC-019 | P0 |
| US-024 | TC-002, TC-025 | P0/P1 |
| US-025 | TC-003, TC-025 | P0/P1 |
| US-026 | TC-020 | P1 |
| US-027 | TC-010 | P1 |
| US-028 | TC-009 | P1 |
| US-029 | TC-030 | P2 |
| US-030 | TC-023 | P1 |
| US-031 | TC-035 | P2 |
| US-032 | TC-011 | P1 |
| US-033 | TC-038 | P1 |
| US-034 | TC-039 | P1 |
| US-035 | TC-012 | P1 |
| US-036 | TC-033 | P2 |
| US-037 | TC-034 | P2 |
| US-038 | TC-037 | P1 |
| US-039 | TC-021, TC-026 | P0 |
| US-040 | TC-001, TC-002 | P0 |
