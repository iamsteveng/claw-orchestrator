# Claw Orchestrator — Design Gaps Addendum (PRD)

> This document is a PRD-level addendum to `DESIGN.md`. It fills specification gaps not covered there. Do not repeat what DESIGN.md already defines — read both together. References to section numbers are to DESIGN.md.

---

## Table of Contents

1. [Message Queue Design](#1-message-queue-design)
2. [Tenant-to-Runtime Message Protocol](#2-tenant-to-runtime-message-protocol)
3. [Database Schema](#3-database-schema)
4. [Startup Lock Mechanism](#4-startup-lock-mechanism)
5. [Provisioning Failure Rollback](#5-provisioning-failure-rollback)
6. [Tenant Container Health Endpoint](#6-tenant-container-health-endpoint)
7. [Resource Limits Per Container](#7-resource-limits-per-container)
8. [Tenant Deletion / Offboarding Flow](#8-tenant-deletion--offboarding-flow)
9. [Slack 3-Second Timeout Handling](#9-slack-3-second-timeout-handling)
10. [Tenant Allowlist / Registration Gating](#10-tenant-allowlist--registration-gating)
11. [Audit Log Format and Storage](#11-audit-log-format-and-storage)
12. [Container Image Update / Rollout Strategy](#12-container-image-update--rollout-strategy)
13. [API Versioning Strategy](#13-api-versioning-strategy)
14. [Observability / Metrics Strategy](#14-observability--metrics-strategy)
15. [Backup and Disaster Recovery](#15-backup-and-disaster-recovery)
16. [Deployment / Startup Procedure](#16-deployment--startup-procedure)
17. [UNHEALTHY State Behavior](#17-unhealthy-state-behavior)
18. [Disk Pressure / Quota Enforcement](#18-disk-pressure--quota-enforcement)

---

## 1. Message Queue Design

### Purpose

When a tenant is STOPPED or STARTING, incoming Slack messages must not be dropped. They are enqueued, then replayed in order after the tenant becomes ACTIVE. (See DESIGN.md §8 — Wake-up flow and Race handling.)

### Storage

The queue lives in the **same SQLite database** used for all control-plane state (see §3 below). There is no external queue dependency (no Redis, no SQS) for MVP. SQLite WAL mode provides sufficient durability and concurrency for the expected message rate.

### Message Payload Structure

| Field | Type | Description |
|---|---|---|
| `id` | `TEXT` (UUID v4) | Primary key |
| `tenant_id` | `TEXT` | Foreign key → `tenants.id` |
| `slack_event_id` | `TEXT` | Slack `event_id` for idempotency |
| `payload` | `TEXT` (JSON) | Full raw Slack event envelope, stringified |
| `status` | `TEXT` | `PENDING` \| `PROCESSING` \| `DELIVERED` \| `FAILED` |
| `attempts` | `INTEGER` | Delivery attempt count, default 0 |
| `created_at` | `INTEGER` | Unix epoch ms |
| `updated_at` | `INTEGER` | Unix epoch ms |
| `deliver_after` | `INTEGER` | Unix epoch ms; allow delayed retry (null = immediate) |
| `error` | `TEXT` | Last error message if status is FAILED |

### Queue Lifecycle

```
PENDING → PROCESSING → DELIVERED (happy path)
                     → FAILED (after max attempts)
```

1. Slack relay inserts a row with `status = PENDING` before attempting delivery.
2. Before forwarding to the tenant, relay sets `status = PROCESSING`.
3. On successful HTTP 200 from tenant runtime, relay sets `status = DELIVERED`.
4. On failure or timeout, relay increments `attempts`. After 3 attempts it sets `status = FAILED`.
5. Scheduler job reaps DELIVERED rows older than 7 days and FAILED rows older than 30 days.

### Crash Safety

- All queue mutations use SQLite transactions. Partial writes roll back atomically.
- On relay process restart, any row stuck in `PROCESSING` (updated_at older than 2 minutes) is reset to `PENDING` by a startup sweep.
- `slack_event_id` is a UNIQUE constraint — duplicate Slack retries are silently ignored (upsert: if exists and `status = DELIVERED`, skip).

### Ordering

Delivery is ordered by `created_at ASC` within a tenant. The relay processes one message per tenant at a time to preserve order. Parallelism is only across different tenants.

---

## 2. Tenant-to-Runtime Message Protocol

### Purpose

The Slack relay must forward messages to a running tenant container and receive a response to send back to Slack. (See DESIGN.md §5.2 — Slack Relay.)

### Transport

| Property | Value |
|---|---|
| Protocol | HTTP/1.1 |
| Port | `3100` (fixed, not exposed on host network; container-internal) |
| Host access | Via Docker bridge network: `http://<container_name>:3100` |
| Path | `POST /message` |
| Auth | Shared secret header `X-Relay-Token: <per-tenant-token>` (stored in `tenants.relay_token`) |

### Request Schema

```json
{
  "messageId": "uuid-v4",
  "slackEventId": "Ev0123456",
  "userId": "U012345",
  "teamId": "T012345",
  "text": "the user's message text",
  "slackPayload": { /* full Slack event object */ },
  "timestamp": 1710000000000
}
```

### Response Schema

**Success (HTTP 200):**

```json
{
  "ok": true,
  "response": "The agent's reply text",
  "blocks": null
}
```

`blocks` is optional Slack Block Kit JSON array. If present, relay sends it instead of plain text.

**Error (HTTP 4xx/5xx or timeout):**

```json
{
  "ok": false,
  "error": "human-readable error string"
}
```

### Sync vs Async

- **The protocol is synchronous** from the relay's perspective: the relay sends the request and waits for a response.
- **Timeout:** relay waits up to **4 minutes** for a response. This covers long-running agent tasks.
- If the request times out, the relay posts a "still working…" fallback to Slack (see §9) and continues polling.
- Long-running tasks: the tenant runtime may stream partial progress by sending intermediate Slack messages directly via the Slack API using its own bot token before the HTTP response completes. The final HTTP response closes the loop.

### Container Name Convention

Container name: `claw-tenant-<tenant_id>` (e.g. `claw-tenant-a1b2c3d4`).

The relay derives the container hostname from `tenant_id`. No DNS lookup needed — Docker bridge network resolves container names.

---

## 3. Database Schema

### Engine and Location

- **SQLite** with WAL mode enabled.
- File location: `/data/claw-orchestrator/db.sqlite`
- Managed by **Prisma** (see DESIGN.md §10).
- Single writer (control plane). Relay reads tenant rows; control plane owns writes.

---

### Table: `tenants`

Tracks every provisioned tenant and their lifecycle state.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PK | Short hash tenant ID (e.g. `sha256(principal).slice(0,16)`) |
| `principal` | TEXT | UNIQUE NOT NULL | `team_id:user_id` |
| `slack_team_id` | TEXT | NOT NULL | Slack workspace ID |
| `slack_user_id` | TEXT | NOT NULL | Slack user ID |
| `status` | TEXT | NOT NULL | Enum: `NEW` \| `PROVISIONING` \| `STARTING` \| `ACTIVE` \| `STOPPED` \| `UNHEALTHY` \| `FAILED` \| `DELETING` |
| `relay_token` | TEXT | NOT NULL | Per-tenant shared secret for relay→runtime auth |
| `container_name` | TEXT | | Docker container name (`claw-tenant-<id>`) |
| `image_tag` | TEXT | | Docker image tag currently running |
| `data_dir` | TEXT | NOT NULL | Absolute path to `/data/tenants/<id>` |
| `last_activity_at` | INTEGER | | Unix epoch ms of last Slack message received |
| `last_started_at` | INTEGER | | Unix epoch ms of last container start |
| `last_stopped_at` | INTEGER | | Unix epoch ms of last container stop |
| `provisioned_at` | INTEGER | | Unix epoch ms when provisioning completed |
| `created_at` | INTEGER | NOT NULL | Unix epoch ms |
| `updated_at` | INTEGER | NOT NULL | Unix epoch ms |
| `deletion_requested_at` | INTEGER | | Unix epoch ms when deletion was requested |
| `error_message` | TEXT | | Last error detail when status is FAILED or UNHEALTHY |
| `allowlist_entry_id` | TEXT | FK → `allowlist.id` | Which allowlist entry granted access |

Index: `(slack_team_id, slack_user_id)` — used by relay for fast tenant lookup.

---

### Table: `message_queue`

See §1 for full schema. Reproduced here for completeness.

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PK (UUID v4) |
| `tenant_id` | TEXT | FK → `tenants.id` NOT NULL |
| `slack_event_id` | TEXT | UNIQUE NOT NULL |
| `payload` | TEXT | NOT NULL (JSON) |
| `status` | TEXT | NOT NULL default `PENDING` |
| `attempts` | INTEGER | NOT NULL default 0 |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |
| `deliver_after` | INTEGER | |
| `error` | TEXT | |

Index: `(tenant_id, status, created_at)` — used by relay to fetch pending messages per tenant in order.

---

### Table: `startup_locks`

Prevents concurrent startup races per tenant. See §4.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `tenant_id` | TEXT | PK, FK → `tenants.id` | One lock slot per tenant |
| `locked_by` | TEXT | NOT NULL | Process/request identifier (UUID) |
| `acquired_at` | INTEGER | NOT NULL | Unix epoch ms |
| `expires_at` | INTEGER | NOT NULL | Unix epoch ms (acquired_at + 5 min TTL) |

---

### Table: `audit_log`

Append-only audit trail. See §11 for full format.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PK (UUID v4) | |
| `tenant_id` | TEXT | FK → `tenants.id` nullable | Null for system-level events |
| `event_type` | TEXT | NOT NULL | e.g. `TENANT_PROVISIONED`, `TENANT_STARTED` |
| `actor` | TEXT | NOT NULL | `system` \| `scheduler` \| `relay` \| `admin:<user>` |
| `metadata` | TEXT | | JSON object with event-specific fields |
| `created_at` | INTEGER | NOT NULL | Unix epoch ms |

No updates or deletes on this table.

---

### Table: `allowlist`

Controls who may use the system. See §10.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PK (UUID v4) | |
| `slack_team_id` | TEXT | NOT NULL | |
| `slack_user_id` | TEXT | nullable | If null, entire team is allowed |
| `added_by` | TEXT | NOT NULL | Who granted access |
| `note` | TEXT | | Optional human-readable note |
| `created_at` | INTEGER | NOT NULL | Unix epoch ms |
| `revoked_at` | INTEGER | | Unix epoch ms; null = active |

Index: `(slack_team_id, slack_user_id, revoked_at)`.

---

### Table: `container_images`

Tracks available tenant image versions. See §12.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PK (UUID v4) | |
| `tag` | TEXT | UNIQUE NOT NULL | Docker image tag, e.g. `sha-abc1234` |
| `digest` | TEXT | | Docker image digest |
| `is_default` | INTEGER | NOT NULL default 0 | Boolean; only one row should be 1 |
| `release_notes` | TEXT | | |
| `created_at` | INTEGER | NOT NULL | Unix epoch ms |
| `deprecated_at` | INTEGER | | Unix epoch ms |

---

## 4. Startup Lock Mechanism

### Problem

Multiple Slack messages may arrive simultaneously for a STOPPED tenant (see DESIGN.md §8 — Race handling). Without a lock, multiple processes could each try to start the same container, causing Docker errors or duplicate state transitions.

### Mechanism

The `startup_locks` table (§3) is used as a distributed mutex within the single SQLite database.

**Acquire lock:**

```sql
INSERT INTO startup_locks (tenant_id, locked_by, acquired_at, expires_at)
VALUES (?, ?, ?, ?)
-- On conflict (tenant_id already exists), check expiry first
```

The INSERT is wrapped in a SQLite transaction:

1. Attempt INSERT with `locked_by = <request-uuid>` and `expires_at = now + 5 minutes`.
2. If INSERT succeeds → this request owns the lock, proceed with container start.
3. If INSERT fails (row exists) → check `expires_at`:
   - If `expires_at < now` → the prior lock is stale; DELETE old row, retry INSERT (once).
   - If `expires_at >= now` → another process holds the lock; do not start container.

**Release lock:**

```sql
DELETE FROM startup_locks WHERE tenant_id = ? AND locked_by = ?
```

Release happens in a `finally` block after the startup sequence completes (success or error).

**Non-holder behavior:**

A request that cannot acquire the lock must not fail. It should:
1. Enqueue its message (if not already enqueued).
2. Poll tenant `status` every 2 seconds for up to 3 minutes.
3. When status becomes `ACTIVE`, proceed to deliver its queued message.
4. If status never reaches `ACTIVE` within 3 minutes, return a friendly "tenant is starting, please wait" message to Slack.

### Lock TTL

5 minutes. If a process crashes mid-startup and never releases, the TTL prevents permanent deadlock. The next request will detect the expired lock and take over.

### Invariant

At most one startup sequence per tenant may run at a time. The container start command (`docker start` or `docker run`) is only ever called by the lock holder.

---

## 5. Provisioning Failure Rollback

### Problem

If provisioning a new tenant fails partway through (e.g. container start fails, health check times out), the system may be left with partial state: directories created, DB row in `PROVISIONING`, no running container.

### Rollback Steps

Rollback is triggered whenever provisioning fails at any step after step 1. Steps are ordered; rollback undoes completed steps in reverse.

| Step | Action | Rollback Action |
|---|---|---|
| 1 | Insert tenant row (`status = PROVISIONING`) | Set `status = FAILED`, set `error_message` |
| 2 | Create `/data/tenants/<id>/` directories | Remove directory tree: `rm -rf /data/tenants/<id>` |
| 3 | Generate relay token and per-tenant config | Covered by directory removal |
| 4 | `docker run` or `docker create` tenant container | `docker rm -f claw-tenant-<id>` if container exists |
| 5 | Wait for health check | N/A — container already removed in step 4 rollback |
| 6 | Mark `status = ACTIVE` | Mark `status = FAILED` (no container) |

**Rollback is not a retry.** After rollback, status is `FAILED`. A subsequent user message triggers a fresh provisioning attempt (treat `FAILED` the same as `NEW` in the relay's provisioning gate).

### Max Provisioning Attempts

Track `provision_attempts` in the tenant row (add to schema: `provision_attempts INTEGER NOT NULL DEFAULT 0`). After 3 failed attempts, set status to `FAILED` permanently and post a human-readable error to Slack. An admin must manually reset the tenant to `NEW` to retry.

### Notification on Failure

On provisioning failure, the relay posts to the user's Slack DM:
> "Sorry, I wasn't able to set up your workspace. Our team has been notified. Please try again in a few minutes."

---

## 6. Tenant Container Health Endpoint

### Purpose

The control plane polls a health endpoint inside each tenant container to determine readiness after start (see DESIGN.md §8 — Wake-up flow, step 4).

### Endpoint Definition

| Property | Value |
|---|---|
| Port | `3101` (separate from message port `3100`) |
| Path | `GET /health` |
| Auth | None (internal Docker bridge only, not exposed to host) |
| Response content-type | `application/json` |

### Response Format

**Healthy (HTTP 200):**

```json
{
  "ok": true,
  "status": "healthy",
  "checks": {
    "openclaw": true,
    "workspace_mounted": true,
    "home_mounted": true
  },
  "uptime_ms": 4321
}
```

**Not yet ready (HTTP 503):**

```json
{
  "ok": false,
  "status": "starting",
  "checks": {
    "openclaw": false,
    "workspace_mounted": true,
    "home_mounted": true
  }
}
```

### Polling Behavior (Control Plane)

| Parameter | Value |
|---|---|
| Poll interval | 2 seconds |
| Max wait | 90 seconds total |
| Timeout per request | 3 seconds |
| Success condition | HTTP 200 with `ok: true` |
| Failure condition | 90 seconds elapsed without success |

On timeout → trigger provisioning failure rollback if NEW, or set status = UNHEALTHY if previously ACTIVE.

### What the Health Endpoint Checks

The tenant container's health server (small Node.js or bash/socat process started before OpenClaw) checks:

1. **`openclaw`** — Is the OpenClaw process running? (check PID file or process list)
2. **`workspace_mounted`** — Is `/workspace` writable? (stat check)
3. **`home_mounted`** — Is `/home/agent` writable? (stat check)

All three must be true for `ok: true`.

---

## 7. Resource Limits Per Container

### Default Quotas

These limits are applied via `docker run` flags when provisioning a tenant container.

| Resource | Default Limit | Notes |
|---|---|---|
| CPU | 1.0 CPU (1000m) | `--cpus=1.0` |
| Memory | 1.5 GB | `--memory=1536m` |
| Memory swap | 1.5 GB (no swap) | `--memory-swap=1536m` |
| Disk (workspace) | 10 GB | Docker volume with size limit (via `--storage-opt size=10G` on supported drivers, else enforced by quota — see §18) |
| Disk (home) | 2 GB | Same mechanism |
| PIDs | 256 | `--pids-limit=256` |
| Open files | 1024 | `--ulimit nofile=1024:1024` |

### Override Mechanism

Limits may be overridden per tenant by adding a `resource_overrides` TEXT (JSON) column to the `tenants` table. If null, defaults apply. Format:

```json
{
  "cpus": 2.0,
  "memory_mb": 3072
}
```

This allows operators to grant more resources to power users without code changes.

### Rationale

On a `t4g.2xlarge` (8 vCPU, 32 GB RAM) with 10 active tenants: 10 × 1.5 GB = 15 GB reserved, leaving ~17 GB for host OS, control plane, and burst. CPU is burstable under Docker's default fair scheduling.

---

## 8. Tenant Deletion / Offboarding Flow

### Trigger

Deletion is initiated by:
- An admin API call: `DELETE /tenants/:tenantId`
- A Slack user requesting account deletion (future feature; not MVP)

### Status Transition

`ANY_STATUS → DELETING` (immediately on request)

While in `DELETING`, no new messages are accepted. Any queued messages are discarded.

### Deletion Steps (ordered)

1. Set `status = DELETING`, set `deletion_requested_at = now` in DB.
2. Reject any in-flight message delivery with "This workspace is being deleted."
3. Stop the container if running: `docker stop claw-tenant-<id> --time 10`
4. Remove the container: `docker rm claw-tenant-<id>`
5. Remove Docker volumes if any were created separately.
6. **Data retention window:** Archive `/data/tenants/<id>/` to `/data/tenants-archive/<id>/` (do NOT delete immediately). See retention policy below.
7. Purge `message_queue` rows for this tenant.
8. Purge `startup_locks` row for this tenant.
9. Mark `allowlist` entry as revoked (if deletion means access revoked).
10. Write audit log entry: `TENANT_DELETED`.
11. Delete tenant row from DB (or soft-delete: set `deleted_at` timestamp).

> **Note:** Audit log rows are never deleted.

### Data Retention Policy

| Data | Retention |
|---|---|
| Tenant filesystem archive (`/data/tenants-archive/<id>/`) | 30 days, then `rm -rf` by a scheduled cleanup job |
| DB tenant row | Soft-deleted (add `deleted_at` column), retained indefinitely |
| Audit log rows | Retained indefinitely |
| Message queue rows | Purged immediately on deletion |

### Accidental Deletion Recovery

Within the 30-day retention window, an admin can restore a tenant by:
1. Moving `/data/tenants-archive/<id>/` back to `/data/tenants/<id>/`.
2. Re-inserting or clearing `deleted_at` on the tenant row.
3. Triggering a fresh container start.

---

## 9. Slack 3-Second Timeout Handling

### Problem

Slack requires an HTTP 200 response within 3 seconds of delivering an event, or it will retry (up to 3 times). Most agent tasks take far longer than 3 seconds.

### Pattern: Immediate Acknowledge + Async Reply

```
Slack Event → Relay → [Ack 200 immediately] → Queue/Forward to tenant
                                               ↓
                                    Tenant processes message
                                               ↓
                                    Relay calls Slack API (chat.postMessage)
                                    to deliver the response
```

**Step-by-step:**

1. Slack event arrives at relay.
2. Relay verifies signature (< 50ms).
3. Relay resolves tenant (DB lookup, < 10ms).
4. Relay enqueues message in `message_queue`.
5. **Relay immediately returns HTTP 200 `{"ok": true}` to Slack.** (This must happen within 3 seconds.)
6. Relay asynchronously starts or checks tenant, then delivers the message to the tenant runtime.
7. Tenant processes the message and returns a response to the relay.
8. Relay calls Slack's `chat.postMessage` API to send the response to the user's DM channel.

### Deduplication

Slack may retry delivery if it doesn't receive a 200 within 3 seconds. The relay uses `slack_event_id` as a UNIQUE key in `message_queue`. A retry insert is a no-op if the event was already enqueued.

### "Working on it" Message

If the tenant takes longer than **15 seconds** to respond, the relay posts an interim message to Slack:
> "⏳ Working on it..."

This prevents the user from thinking the message was lost. The final response replaces or follows this message.

### Slack API Credentials

The relay must have access to the Slack bot token (`SLACK_BOT_TOKEN`) to call `chat.postMessage`. This is a shared credential for the whole system — not per-tenant.

---

## 10. Tenant Allowlist / Registration Gating

### Purpose

Not every Slack user who messages the bot should get a tenant. Access must be controlled to prevent abuse and runaway resource consumption.

### Allowlist Model

The `allowlist` table (§3) controls access. A request is allowed if:

```
SELECT 1 FROM allowlist
WHERE revoked_at IS NULL
  AND slack_team_id = ?
  AND (slack_user_id = ? OR slack_user_id IS NULL)
LIMIT 1
```

A null `slack_user_id` row means the entire team is allowed.

### Resolution Flow (Relay)

When a Slack event arrives from a user not yet in `tenants`:

1. Check `allowlist`. 
2. **If allowed:** proceed with tenant provisioning (DESIGN.md §8 — Provisioning flow).
3. **If not allowed:** 
   - Do NOT create a tenant row.
   - Post to Slack DM: "Thanks for your interest! This system is currently invite-only. Contact [admin contact] to request access."
   - Log to audit log: `ACCESS_DENIED` with `slack_team_id`, `slack_user_id`.
   - Return HTTP 200 to Slack (already acknowledged).

For users who already have a tenant row (previously allowed, now revoked): check allowlist on every message. If revoked, block message delivery and notify: "Your access has been revoked. Contact [admin contact] for assistance."

### Granting Access

Access is granted by an admin via the control plane API:

```
POST /admin/allowlist
Body: { "slack_team_id": "T...", "slack_user_id": "U..." }
```

Or to allow a whole team:

```
POST /admin/allowlist
Body: { "slack_team_id": "T..." }
```

### Revoking Access

```
DELETE /admin/allowlist/:id
```

Sets `revoked_at = now`. Does not delete the tenant or their data (use the deletion flow in §8 for that).

### Bootstrap

For MVP, the allowlist is seeded manually via a migration or admin script before launch. There is no self-service registration UI.

---

## 11. Audit Log Format and Storage

### Purpose

An append-only record of significant system events for debugging, compliance, and incident response.

### Storage

Stored in the `audit_log` table in SQLite (§3). No external log shipper required for MVP.

### Event Types

| Event Type | Description |
|---|---|
| `TENANT_PROVISIONED` | New tenant successfully provisioned |
| `TENANT_PROVISION_FAILED` | Provisioning failed (with error) |
| `TENANT_STARTED` | Container started |
| `TENANT_STOPPED` | Container stopped (idle or manual) |
| `TENANT_DELETED` | Tenant deletion completed |
| `TENANT_UNHEALTHY` | Tenant entered UNHEALTHY state |
| `TENANT_RECOVERED` | Tenant recovered from UNHEALTHY |
| `MESSAGE_QUEUED` | Slack message enqueued |
| `MESSAGE_DELIVERED` | Message delivered to tenant runtime |
| `MESSAGE_FAILED` | Message delivery failed after max retries |
| `ACCESS_DENIED` | Allowlist check failed for a user |
| `ACCESS_GRANTED` | User added to allowlist |
| `ACCESS_REVOKED` | User removed from allowlist |
| `IMAGE_UPDATED` | Tenant container image updated |
| `DISK_QUOTA_WARNING` | Tenant nearing disk quota |
| `DISK_QUOTA_EXCEEDED` | Tenant exceeded disk quota |
| `ADMIN_ACTION` | Generic admin API call |

### Row Format

```json
{
  "id": "uuid",
  "tenant_id": "a1b2c3d4 or null",
  "event_type": "TENANT_STARTED",
  "actor": "control-plane",
  "metadata": {
    "container_name": "claw-tenant-a1b2c3d4",
    "image_tag": "sha-abc1234",
    "duration_ms": 4200
  },
  "created_at": 1710000000000
}
```

### Querying

Expose a read-only admin API endpoint:

```
GET /admin/audit?tenant_id=<id>&event_type=<type>&limit=100&before=<ts>
```

### Retention

Audit log rows are never deleted. If the SQLite file grows large (>500 MB), archive older rows to a compressed NDJSON file: `/data/audit-archive/audit-YYYY-MM.ndjson.gz`, then delete from DB.

---

## 12. Container Image Update / Rollout Strategy

### Image Naming

Tenant images are tagged by git commit SHA: `claw-tenant:sha-<7char>` (e.g. `claw-tenant:sha-abc1234`).

The `container_images` table (§3) tracks all available tags. Exactly one row has `is_default = 1`.

### When a New Image is Available

1. Build new image and push to local Docker daemon (or private registry).
2. Insert new row into `container_images` with `is_default = 0`.
3. Run admin command to promote: `POST /admin/images/:id/promote` — sets new row as default, demotes old one.

### Rollout Policy

Images are updated **lazily** — a tenant picks up the new image the next time its container is started (wake-up after idle stop or restart). There is no forced live migration.

This means tenants may run different image versions concurrently. This is acceptable for MVP.

**To force an update** on a specific tenant:

```
POST /tenants/:tenantId/stop
POST /tenants/:tenantId/start   ← will use current default image
```

Or for all stopped tenants: a batch admin script.

### Rollback

Revert `is_default` to the previous image tag via `POST /admin/images/:id/promote`. Containers already running the bad image must be stopped and restarted manually.

### Image Build Requirements

- Multi-arch build: `linux/arm64` and `linux/amd64` (see DESIGN.md §17).
- Image tag recorded in `tenants.image_tag` when container starts.
- Audit log entry `IMAGE_UPDATED` written when a tenant's image changes.

### Validation Before Promotion

Before promoting a new image to default:
1. Run a canary tenant with the new image.
2. Confirm health endpoint returns `ok: true` within 90 seconds.
3. Run a smoke test message through the canary tenant.
4. Only then promote.

---

## 13. API Versioning Strategy

### Approach: URL Path Versioning

All control plane APIs are prefixed with `/v1/`. Example: `POST /v1/tenants/provision`.

The Slack relay's Slack-facing webhook endpoint is NOT versioned (Slack controls the URL).

### Version Lifecycle

| Phase | Rule |
|---|---|
| Current | `/v1/` — all current endpoints |
| Deprecated | Announce in docs; keep running for 60 days |
| Removed | Delete endpoint after deprecation window |

For MVP there is only v1. No breaking changes to v1 without bumping to v2.

### Breaking vs Non-Breaking Changes

**Non-breaking (no version bump needed):**
- Adding new optional fields to responses
- Adding new endpoints
- Adding optional request fields

**Breaking (requires v2):**
- Removing fields from responses
- Changing field types
- Changing behavior of existing endpoints
- Removing endpoints

### Internal vs External

The control plane API is **internal only** (not publicly exposed). For MVP, strict versioning is a discipline concern more than a public contract concern. Versioning prevents pain when a coding agent updates the relay and control plane independently.

---

## 14. Observability / Metrics Strategy

### Structured Logging

All services log JSON via **Pino** (see DESIGN.md §10). Every log line includes:

| Field | Description |
|---|---|
| `level` | `debug` \| `info` \| `warn` \| `error` |
| `time` | ISO 8601 timestamp |
| `service` | `slack-relay` \| `control-plane` \| `scheduler` |
| `tenant_id` | Present when log relates to a tenant |
| `request_id` | UUID per inbound HTTP request |
| `slack_event_id` | When processing a Slack event |
| `msg` | Human-readable message |
| `err` | Error object (Pino serialized) when applicable |
| `duration_ms` | For timed operations |

### Key Metrics to Track

For MVP, emit metrics as structured log lines with `metric: true` field. A future Prometheus scraper or CloudWatch agent can parse them.

| Metric | Type | Description |
|---|---|---|
| `tenant.provisioned` | counter | New tenants provisioned |
| `tenant.provision_failed` | counter | Provisioning failures |
| `tenant.started` | counter | Container starts (wake-ups) |
| `tenant.stopped` | counter | Container stops |
| `tenant.unhealthy` | counter | Transitions to UNHEALTHY |
| `message.queued` | counter | Messages enqueued |
| `message.delivered` | counter | Messages delivered to runtime |
| `message.failed` | counter | Messages failed after max retries |
| `message.queue_depth` | gauge | Per-tenant pending message count |
| `message.delivery_latency_ms` | histogram | Time from queue to delivered |
| `tenant.wake_latency_ms` | histogram | Time from start to healthy |
| `tenant.active_count` | gauge | Currently running containers |
| `access.denied` | counter | Allowlist rejections |
| `disk.usage_bytes` | gauge | Per-tenant disk usage (sampled every 5 min) |

### Log Destinations

- **stdout** from each service (captured by systemd journal or Docker log driver).
- **File sink** (optional): Pino transport to `/var/log/claw-orchestrator/<service>.log`, rotated daily, kept 14 days.

### Alerting (MVP)

No automated alerting in MVP. Operator reviews logs. Post-MVP: CloudWatch Alarms or similar on error rate.

---

## 15. Backup and Disaster Recovery

### What to Back Up

| Data | Location | Backup Method |
|---|---|---|
| SQLite database | `/data/claw-orchestrator/db.sqlite` | Daily snapshot |
| Tenant filesystems | `/data/tenants/` | Daily snapshot |
| Control plane config/env | `/opt/claw-orchestrator/.env` | Manual, version-controlled template |

### Backup Procedure

A cron job (or systemd timer) runs daily at **03:00 UTC**:

```bash
# 1. Checkpoint SQLite WAL
sqlite3 /data/claw-orchestrator/db.sqlite ".checkpoint FULL"

# 2. Create dated snapshot
BACKUP_DIR=/data/backups/$(date +%Y-%m-%d)
mkdir -p $BACKUP_DIR

cp /data/claw-orchestrator/db.sqlite $BACKUP_DIR/db.sqlite

# 3. Tar+gzip tenant data (exclude large cache dirs)
tar -czf $BACKUP_DIR/tenants.tar.gz \
  --exclude='*/cache/*' \
  --exclude='*/.cache/*' \
  /data/tenants/

# 4. Upload to S3 (if configured)
aws s3 sync $BACKUP_DIR s3://your-bucket/claw-backups/$(date +%Y-%m-%d)/
```

Retention: keep 7 daily backups locally, 30 daily backups in S3.

### Recovery Procedure

1. Stop all services.
2. Restore SQLite: `cp $BACKUP_DIR/db.sqlite /data/claw-orchestrator/db.sqlite`
3. Restore tenant data: `tar -xzf $BACKUP_DIR/tenants.tar.gz -C /`
4. Restart services.
5. Re-run health checks on all tenants.

### RPO / RTO Targets (MVP)

| Target | Value |
|---|---|
| RPO (data loss tolerance) | 24 hours (daily backup cadence) |
| RTO (recovery time) | ~1 hour (manual restore + service restart) |

### Instance Loss

If the EC2 instance is lost:
- Launch new instance of same type.
- Attach or restore EBS volume from snapshot (or restore from S3 backup).
- Re-install services (see §16).
- Tenant containers must be re-provisioned (containers are ephemeral; data is on EBS).
- Running containers **do not** survive instance replacement. Tenant state on disk survives.

---

## 16. Deployment / Startup Procedure

### Service Management

All three Node.js services are managed by **systemd** on the Linux host.

Unit files live in `/etc/systemd/system/`:

- `claw-control-plane.service`
- `claw-slack-relay.service`
- `claw-scheduler.service`

### Unit File Template (example: control plane)

```ini
[Unit]
Description=Claw Orchestrator Control Plane
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=claw
WorkingDirectory=/opt/claw-orchestrator/apps/control-plane
EnvironmentFile=/opt/claw-orchestrator/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=claw-control-plane

[Install]
WantedBy=multi-user.target
```

### Startup Order

1. `docker.service` (managed by OS)
2. `claw-control-plane.service` — must be healthy before relay starts
3. `claw-slack-relay.service` — depends on control plane
4. `claw-scheduler.service` — independent, can start in any order

### Control Plane Startup Sequence

On startup, the control plane:

1. Opens SQLite connection, runs Prisma migrations (`prisma migrate deploy`).
2. Sweeps `startup_locks` — reset any expired locks (acquired_at + 5m < now).
3. Sweeps `message_queue` — reset any `PROCESSING` rows older than 2 minutes to `PENDING`.
4. Reconciles tenant states — any tenant with status `STARTING` or `PROVISIONING` at boot has likely crashed mid-operation; set to `FAILED`.
5. Starts Fastify HTTP server on configured port (default `3200`).
6. Logs `SYSTEM_STARTUP` to audit log.

### Environment Variables

Defined in `/opt/claw-orchestrator/.env` (not committed to git):

```
# Control Plane
CONTROL_PLANE_PORT=3200
DATABASE_URL=file:/data/claw-orchestrator/db.sqlite
DATA_DIR=/data/tenants
TENANT_IMAGE=claw-tenant:sha-latest
LOG_LEVEL=info

# Slack Relay
SLACK_RELAY_PORT=3000
SLACK_SIGNING_SECRET=...
SLACK_BOT_TOKEN=xoxb-...
CONTROL_PLANE_URL=http://localhost:3200

# Scheduler
SCHEDULER_INTERVAL_MS=60000
IDLE_STOP_HOURS=48
```

### Deployment Steps (first time)

```bash
# 1. Install Docker Engine
# 2. Install Node.js 22 + pnpm
# 3. Clone repo to /opt/claw-orchestrator
# 4. pnpm install && pnpm build
# 5. Create /data/claw-orchestrator/ and /data/tenants/ (owned by 'claw' user)
# 6. Copy .env.example to .env and fill in secrets
# 7. Run database migrations: cd prisma && npx prisma migrate deploy
# 8. Copy systemd unit files: cp deploy/systemd/*.service /etc/systemd/system/
# 9. systemctl daemon-reload
# 10. systemctl enable --now claw-control-plane claw-slack-relay claw-scheduler
# 11. Configure Slack app webhook URL to point to relay
```

### Deployment Steps (updates)

```bash
cd /opt/claw-orchestrator
git pull
pnpm install && pnpm build
npx prisma migrate deploy
systemctl restart claw-control-plane claw-slack-relay claw-scheduler
```

---

## 17. UNHEALTHY State Behavior

### Definition

A tenant enters `UNHEALTHY` when it has been started but fails to sustain health. This is distinct from a startup failure (`FAILED`).

### Triggers for UNHEALTHY

| Trigger | Condition |
|---|---|
| Health poll failure | Tenant was `ACTIVE`, health endpoint returns non-200 for 3 consecutive polls (6 seconds) |
| Container exit | Docker container exits unexpectedly while tenant is `ACTIVE` |
| Message delivery failure | Message delivery fails 3 times in a row with connection errors (not application errors) |

### UNHEALTHY Behavior

1. Set `status = UNHEALTHY` in DB.
2. Log `TENANT_UNHEALTHY` to audit log with reason.
3. **Do not immediately restart.** Allow a 30-second cooldown.
4. Attempt auto-recovery: run the wake-up flow (start container, wait for health).
5. If recovery succeeds within 90 seconds → set `status = ACTIVE`, log `TENANT_RECOVERED`, replay any queued messages.
6. If recovery fails → leave status as `UNHEALTHY`. Do not retry automatically more than once.

### User Experience During UNHEALTHY

While a tenant is UNHEALTHY:
- New messages are queued (not dropped).
- Slack relay posts to the user: "Your workspace is experiencing issues. We're attempting to recover it automatically."
- If auto-recovery succeeds, queued messages are processed transparently.
- If auto-recovery fails, relay posts: "We were unable to recover your workspace automatically. Please try again in a few minutes. If the issue persists, contact [admin]."

### Manual Recovery

Admin calls `POST /v1/tenants/:tenantId/start` to force another recovery attempt.

### Effect on Other Tenants

An UNHEALTHY tenant has zero effect on other tenants. Health polling and message delivery are per-tenant. Container crashes are isolated by Docker.

---

## 18. Disk Pressure / Quota Enforcement

### Goal

Prevent one tenant from filling the host disk and degrading or crashing other tenants or the host itself.

### Per-Tenant Disk Quotas

Default quotas (see §7):
- `/workspace` volume: **10 GB**
- `/home/agent` volume: **2 GB**

### Enforcement Mechanism

**Preferred (if using ext4 with project quotas or XFS on `/data/tenants`):**

Use filesystem-level project quotas. Each tenant's data directory gets a project ID with a hard limit. The OS enforces this at the VFS layer — writes beyond quota return `ENOSPC`.

**Fallback (simpler MVP approach):**

Scheduler measures disk usage per tenant every **5 minutes** using `du -sb`:

```bash
du -sb /data/tenants/<id>/
```

If usage exceeds **90% of quota (warning threshold)**:
- Log `DISK_QUOTA_WARNING` to audit log.
- Post to Slack: "⚠️ Your workspace is using XX GB of XX GB. Consider freeing up space."

If usage exceeds **100% of quota (hard limit)**:
- Log `DISK_QUOTA_EXCEEDED` to audit log.
- Post to Slack: "🚨 Your workspace has reached its disk limit (XX GB). New writes may fail. Please free up space or contact an admin."
- Set a `disk_quota_exceeded` boolean on the tenant row (add to schema).
- Block new message delivery until usage drops below 95%.

### Host-Level Disk Monitoring

A separate check runs every minute monitoring total disk usage on `/data`:

- If `/data` is above **80% full**: log warning, alert admin channel.
- If `/data` is above **95% full**: set all tenants to `UNHEALTHY` (to prevent writes), alert admin immediately.

### Cleanup Suggestions to Users

When a tenant hits quota, the relay suggests:
> "You can free space by clearing build caches: `rm -rf ~/.cache/` and `/workspace/node_modules/` in large projects."

### No Enforcement During MVP If Quotas Are Complex

If filesystem project quotas are not set up, the scheduler-based measurement approach is the MVP fallback. Hard enforcement is best-effort (block new messages) — it does not forcibly delete user data.

---

*End of Design Gaps Addendum. Refer to DESIGN.md for all architectural decisions, isolation model, Slack routing, lifecycle states, tech stack, test cases, and repository structure.*
