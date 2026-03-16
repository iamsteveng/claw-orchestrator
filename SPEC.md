# Claw Orchestrator — Full Technical Specification

> **About this document**
>
> This is the canonical technical specification for Claw Orchestrator. It merges the original architecture design (`DESIGN.md`) and its detailed design gaps addendum (`DESIGN-GAPS.md`) into a single authoritative reference. It covers goals, architecture decisions, data models, protocols, lifecycle behaviors, infrastructure, and testing strategy in enough detail for a developer or coding agent to implement from. Nothing is out-of-scope here — if a detail was defined in either source document, it is in this spec.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Core Objective](#2-core-objective)
3. [Key Requirements](#3-key-requirements)
4. [Design Decision: Container-Per-User](#4-design-decision-container-per-user)
5. [Architecture Summary](#5-architecture-summary)
6. [Tenant Isolation Model](#6-tenant-isolation-model)
7. [Slack Routing Design](#7-slack-routing-design)
8. [Tenant Lifecycle](#8-tenant-lifecycle)
9. [Startup Lock Mechanism](#9-startup-lock-mechanism)
10. [Provisioning Failure Rollback](#10-provisioning-failure-rollback)
11. [UNHEALTHY State Behavior](#11-unhealthy-state-behavior)
12. [Tenant Deletion / Offboarding Flow](#12-tenant-deletion--offboarding-flow)
13. [Message Queue Design](#13-message-queue-design)
14. [Tenant-to-Runtime Message Protocol](#14-tenant-to-runtime-message-protocol)
15. [Database Schema](#15-database-schema)
16. [Container Image Design](#16-container-image-design)
17. [Container Image Update / Rollout Strategy](#17-container-image-update--rollout-strategy)
18. [Tenant Container Health Endpoint](#18-tenant-container-health-endpoint)
19. [Resource Limits Per Container](#19-resource-limits-per-container)
20. [Disk Pressure / Quota Enforcement](#20-disk-pressure--quota-enforcement)
21. [Control Plane Responsibilities & API](#21-control-plane-responsibilities--api)
22. [API Versioning Strategy](#22-api-versioning-strategy)
23. [Tenant Allowlist / Registration Gating](#23-tenant-allowlist--registration-gating)
24. [Audit Log Format and Storage](#24-audit-log-format-and-storage)
25. [Observability / Metrics Strategy](#25-observability--metrics-strategy)
26. [Interactive Access Design](#26-interactive-access-design)
27. [Host-Side Directory Layout](#27-host-side-directory-layout)
28. [EC2 Recommendation and Cost](#28-ec2-recommendation-and-cost)
29. [Backup and Disaster Recovery](#29-backup-and-disaster-recovery)
30. [Deployment / Startup Procedure](#30-deployment--startup-procedure)
31. [Technology Stack](#31-technology-stack)
32. [Repository Structure](#32-repository-structure)
33. [Development Environment Requirements](#33-development-environment-requirements)
34. [Local Development Workflow](#34-local-development-workflow)
35. [Testing Strategy](#35-testing-strategy)
36. [Detailed End-to-End Test Cases](#36-detailed-end-to-end-test-cases)
37. [Acceptance Criteria](#37-acceptance-criteria)
38. [Implementation Order](#38-implementation-order)
39. [Non-Goals for MVP](#39-non-goals-for-mvp)

---

## 1. Project Overview

**Project name:** Claw Orchestrator

**Goal:**
Build an MVP platform that lets **multiple Slack users** connect to and use **their own isolated OpenClaw agent runtime** on a **single Linux machine**, with strong separation between users so that secrets and state such as:

- SSH keys
- CLI login sessions
- Git config
- tool caches
- workspace files
- OpenClaw runtime state

are **never shared across users by mistake**.

The system should be inexpensive, practical to operate, and easy for a coding agent to implement iteratively.

---

## 2. Core Objective

The MVP must support:

- one **shared Slack app**
- multiple Slack users
- one **dedicated isolated runtime per Slack user**
- a single Linux host
- automatic provisioning on first use
- automatic idle stop after **48 hours of inactivity**
- automatic wake-up when a new Slack message arrives
- persistent per-user state across restarts
- automated end-to-end tests proving user isolation

This is a **multi-tenant control plane** for isolated OpenClaw environments, not just a chat bot.

---

## 3. Key Requirements

### Functional Requirements

- One shared Slack app is preferred. Multiple Slack apps should only be considered if there is a strong reason.
- Tenants may be stopped after 48 hours of inactivity.
- The system must wake a stopped tenant when a new Slack message arrives.
- Interactive shell access is optional but preferred.
- Required tool support includes: `gh`, `convex`, `vercel`, Claude Code, OpenAI Codex.
- Access must be gated by an allowlist — not every Slack user who messages the bot gets a tenant.

### Infrastructure Constraints

- Host is **Linux** (initial deployment target: AWS EC2).
- System should be cost-conscious.
- Node.js is preferred over Python for implementation.

---

## 4. Design Decision: Container-Per-User

Each Slack user gets:

- one tenant ID
- one Docker container
- one isolated filesystem, home directory, workspace
- one isolated `.ssh` and CLI auth/config/cache
- one isolated OpenClaw runtime

### Why This Works

Container-per-user gives strong isolation with simple, understandable boundaries:

- filesystem and process namespace separation
- per-container environment variables and mounts
- independent restart/stop lifecycle
- simple auditing, debugging, and testability

### Why a Shared OpenClaw Process Is Not Acceptable

A shared runtime with logical tenant separation risks cross-user leakage of SSH keys, auth tokens, CLI config, workspace contents, process environment variables, and cached secrets. A single bug in path handling, auth lookup, or process state could leak real credentials. No app-layer check provides a strong OS-level boundary.

### Conclusion

For MVP, **container-per-user** is the correct design. A per-user Slack app, public SSH per tenant, or a shared OpenClaw runtime are all explicitly ruled out for MVP.

---

## 5. Architecture Summary

The system has four main services plus a scheduler:

### 5.1 Shared Slack App

One shared Slack app receives DMs (and possibly app mentions later). It identifies the sender using `team_id` and `user_id`. DM-only mode is preferred for MVP to reduce ambiguity and routing risk.

### 5.2 Slack Relay

A Node.js service that:

- receives Slack events
- verifies Slack signatures
- resolves the Slack user to a tenant
- immediately acknowledges Slack with HTTP 200 (within 3 seconds — see §7.3)
- enqueues messages if the tenant is stopped or starting
- forwards messages to the correct tenant runtime using the message protocol defined in §15
- delivers tenant responses back to Slack via `chat.postMessage`

### 5.3 Control Plane

A Node.js service that:

- provisions tenant containers
- starts/stops/resets/deletes containers
- tracks tenant lifecycle state
- manages tenant metadata
- runs health checks
- keeps audit logs
- exposes the internal API (see §22)

### 5.4 Per-Tenant Runtime

One Docker container per tenant containing OpenClaw, required CLIs, git, openssh-client, shell tools, and per-tenant home/workspace/config/state. Exposes two internal ports:

- `3100` — message endpoint (relay forwards Slack messages here)
- `3101` — health/readiness endpoint (control plane polls this)

### 5.5 Scheduler

A small Node.js worker that:

- periodically checks tenant activity timestamps
- stops containers idle for over 48 hours
- samples per-tenant disk usage every 5 minutes (see §21)
- reaps stale message queue rows

---

## 6. Tenant Isolation Model

Each tenant must have completely separate runtime state. This section defines all isolation boundaries.

### 6.1 Per-Tenant Filesystem

Each tenant has separate:

- `/home/agent`
- `/workspace`
- `~/.ssh`
- `~/.config`
- `~/.cache`
- `~/.local/state`
- OpenClaw config/state directories
- logs

### 6.2 Per-Tenant Environment Variables

Each tenant container must explicitly set:

```bash
HOME=/home/agent
XDG_CONFIG_HOME=/home/agent/.config
XDG_CACHE_HOME=/home/agent/.cache
XDG_STATE_HOME=/home/agent/.local/state
```

This ensures `gh`, `vercel`, `convex`, Claude Code, Codex, git, and SSH state stay inside the tenant.

Model authentication (OpenClaw's Anthropic token) is **not** injected as an environment variable. It is provided via a read-only bind-mount of the host's `auth-profiles.json` file — see §6.5.

### 6.3 Per-Tenant Mounts

Only tenant-specific volumes/directories may be mounted into a tenant container.

**Never mount:**

- host home directories
- shared `.ssh`
- shared credential stores
- Docker socket
- broad writable host directories

### 6.4 Process Isolation

Each tenant runs in its own container with an isolated process namespace, isolated runtime user, and separate memory and filesystem context.

### 6.5 Secrets Isolation

Tenant secrets must be stored and injected per tenant. Shared control plane services should hold only the minimum metadata required (e.g., the relay token for routing auth — see §15).

**Shared Model Auth — Bind-Mount Strategy:**
OpenClaw's model authentication is stored in the host's auth profile file at:

```
~/.openclaw/agents/main/agent/auth-profiles.json
```

This file contains a `profiles` map (e.g. `anthropic:default`) with provider tokens used by OpenClaw to call AI models. Rather than copying or re-injecting this credential, the host file is **bind-mounted read-only** into every tenant container at the same path:

```
/root/.openclaw/agents/main/agent/auth-profiles.json:ro
```

(or the equivalent OpenClaw default user home path inside the container — `/root` assumes OpenClaw runs as root within the container).

This design has the following implications:

- **No per-tenant auth profile.** Tenants do not get their own `auth-profiles.json`. There is no `ANTHROPIC_API_KEY` or equivalent Anthropic token stored in the database, per-tenant secrets directory, or container environment.
- **Read-only mount.** Tenants cannot modify the shared auth profile (`:ro`). A write attempt from within a container will fail at the filesystem layer.
- **Immediate token rotation.** Because it is a bind-mount, if the host file is updated (token rotated), all currently-running containers immediately see the new token on their next read — no container restart needed. Containers that are stopped and restarted also pick up the latest file automatically.
- **Simultaneous revocation risk.** If the host token expires or is revoked, **all tenants simultaneously lose model access**. Operators must monitor for auth failures (e.g. `401 Unauthorized` responses from the Anthropic API) and treat host token health as a platform-wide concern, not a per-tenant one.
- **Cost and billing.** All tenant model usage is billed to the host account associated with the shared auth profile. Operators must account for aggregate usage across all tenants when estimating costs (§29).
- **Operators are responsible** for keeping the host `auth-profiles.json` current and valid. If the file is missing at container start time, the container will start but model calls will fail immediately.

---

## 7. Slack Routing Design

### 7.1 Identity Mapping

Map Slack sender to tenant using:

```
tenant_principal = team_id + ":" + user_id
tenant_id = sha256(tenant_principal).slice(0, 16)
```

### 7.2 Message Flow

1. Slack event arrives at shared Slack app endpoint.
2. Slack relay verifies the signature.
3. **Relay immediately returns HTTP 200 to Slack** (within 3 seconds — see §7.3).
4. Relay checks the allowlist (see §24). If denied, post a rejection DM and stop.
5. Relay resolves tenant by `team_id + user_id`.
6. If tenant does not exist: create tenant record and begin provisioning.
7. If tenant exists but is stopped: enqueue message, wake tenant, process after healthy.
8. If tenant is active: enqueue message, deliver to tenant runtime.
9. Relay calls Slack `chat.postMessage` with the tenant's response.

### 7.3 Slack 3-Second Timeout Handling

Slack requires an HTTP 200 response within 3 seconds of event delivery or it will retry (up to 3 times). Most agent tasks take far longer than 3 seconds. The relay must use an **immediate-acknowledge, async-reply** pattern:

```
Slack Event → Relay → [Ack HTTP 200 immediately]
                      → Enqueue message
                      → Async: forward to tenant runtime
                      → Async: call chat.postMessage with response
```

- **Deduplication:** Slack may retry delivery before receiving the 200. The relay uses `slack_event_id` as a UNIQUE key in `message_queue`. A retry insert is a no-op if the event was already enqueued.
- **"Working on it" message:** If the tenant takes longer than **15 seconds** to respond, the relay posts an interim message to Slack: `"⏳ Working on it..."`. The final response follows.
- **Max wait:** Relay waits up to **4 minutes** for a tenant response. This covers long-running agent tasks.
- **Long-running tasks:** The tenant runtime may stream partial progress by sending intermediate Slack messages directly via the Slack API using its own bot token before the HTTP response completes. The final HTTP response closes the relay loop.
- **Slack API Credentials:** The relay holds the shared `SLACK_BOT_TOKEN` for `chat.postMessage`. This is a system-level credential, not per-tenant.

### 7.4 Race Handling

If multiple messages arrive while a tenant is waking:

- only one container start is triggered (see §9 — Startup Lock)
- all messages are queued and processed in arrival order
- wake-up path is idempotent

---

## 8. Tenant Lifecycle

### 8.1 States

| State | Description |
|---|---|
| `NEW` | Tenant record created, not yet provisioned |
| `PROVISIONING` | Directories and container being set up |
| `STARTING` | Container started, waiting for health |
| `ACTIVE` | Container running and healthy |
| `STOPPED` | Container stopped, state persisted on disk |
| `UNHEALTHY` | Container started but failing health checks |
| `FAILED` | Provisioning or startup failed; manual intervention needed |
| `DELETING` | Deletion in progress |

### 8.2 Provisioning Flow

Triggered on first user message (after allowlist check passes):

1. Create tenant DB row (`status = PROVISIONING`)
2. Create tenant directories at `/data/tenants/<tenant_id>/`
3. Generate config from templates
4. Generate per-tenant relay token and optionally a tenant SSH keypair
5. Copy workspace template files into the tenant's workspace directory, including `AGENTS.md` (see §8.2.1 below)
6. Run `docker run` to create and start the tenant container, bind-mounting the host's `auth-profiles.json` read-only (see §6.5); no per-tenant Anthropic credential is injected
7. Poll health endpoint (see §19) until healthy or timeout
8. Mark tenant `ACTIVE`
9. Process message

On failure at any step → rollback (see §10).

`provision_attempts` is tracked in the tenant row. After 3 failed attempts, status is set to `FAILED` permanently. An admin must manually reset the tenant to `NEW` to retry.

#### 8.2.1 Workspace Template Seeding

During provisioning (step 5 above), the control plane copies the workspace template directory into the new tenant's `/workspace/`:

```
templates/workspace/  →  /data/tenants/<id>/workspace/
```

The template directory lives at `templates/workspace/` in the repository and is included in the deployed package at `/opt/claw-orchestrator/templates/workspace/`.

**Required template files:**

- `AGENTS.md` — pre-seeded with the following section at minimum:

```markdown
## Task Execution

For any task that is complex enough to take more than ~2 minutes:
- Spawn a sub-agent or background process to handle it
- Don't block the conversation
- When it's done, report back with a concise summary of what was done
```

**Merge behavior on re-provisioning:** If the tenant's workspace already contains an `AGENTS.md` (e.g. the tenant was previously active and the file has been modified), the provisioning script must not blindly overwrite it. Instead:

1. If `AGENTS.md` does not exist → copy the template file directly.
2. If `AGENTS.md` exists and already contains the `## Task Execution` section → leave it untouched.
3. If `AGENTS.md` exists but is missing the `## Task Execution` section → append the section verbatim to the end of the existing file.

This ensures the required operational behaviour is always present without destroying tenant customizations.

### 8.3 Idle Stop Flow

If no incoming messages for 48 hours:

1. Scheduler marks tenant eligible for stop
2. Stop tenant container (`docker stop`)
3. Keep volumes and metadata on disk
4. Mark tenant `STOPPED`

### 8.4 Wake-Up Flow

When a message arrives for a stopped tenant:

1. Resolve tenant
2. Acquire per-tenant startup lock (see §9)
3. Start the tenant container via `docker start`. The host's `auth-profiles.json` is already bind-mounted read-only from provisioning time (§6.5); token rotations on the host are picked up automatically on the next read — no env var re-injection is needed.
4. Wait for readiness — health endpoint returns `ok: true`:
   - gateway alive
   - config mounted
   - workspace mounted
   - secrets available
5. Replay queued messages in order
6. Mark tenant `ACTIVE`

---

## 9. Startup Lock Mechanism

### Problem

Multiple Slack messages may arrive simultaneously for a STOPPED tenant. Without a lock, multiple processes could each try to start the same container, causing Docker errors or duplicate state transitions.

### Mechanism

The `startup_locks` table (§16) acts as a distributed mutex within the single SQLite database.

**Acquire lock:**

```sql
INSERT INTO startup_locks (tenant_id, locked_by, acquired_at, expires_at)
VALUES (?, ?, ?, ?)
```

Wrapped in a SQLite transaction:

1. Attempt INSERT with `locked_by = <request-uuid>` and `expires_at = now + 5 minutes`.
2. If INSERT succeeds → this request owns the lock; proceed with container start.
3. If INSERT fails (row exists) → check `expires_at`:
   - If `expires_at < now` → stale lock; DELETE old row, retry INSERT once.
   - If `expires_at >= now` → another process holds the lock; do not start container.

**Release lock:**

```sql
DELETE FROM startup_locks WHERE tenant_id = ? AND locked_by = ?
```

Released in a `finally` block after the startup sequence completes (success or error).

**Non-holder behavior:**

A request that cannot acquire the lock must not fail. It should:

1. Enqueue its message (if not already enqueued).
2. Poll tenant `status` every 2 seconds for up to 3 minutes.
3. When status becomes `ACTIVE`, deliver its queued message.
4. If status never reaches `ACTIVE` within 3 minutes, post a friendly "tenant is starting, please wait" message to Slack.

### Lock TTL

5 minutes. If a process crashes mid-startup without releasing, the TTL prevents permanent deadlock. The next request detects the expired lock and takes over.

### Invariant

At most one startup sequence per tenant may run at a time. `docker start` or `docker run` is only ever called by the lock holder.

---

## 10. Provisioning Failure Rollback

### Problem

If provisioning fails partway through, the system may be left with partial state: directories created, DB row in `PROVISIONING`, no running container. Rollback ensures the system reaches a consistent `FAILED` state.

### Rollback Steps

Rollback undoes completed provisioning steps in reverse:

| Step | Action | Rollback Action |
|---|---|---|
| 1 | Insert tenant row (`status = PROVISIONING`) | Set `status = FAILED`, set `error_message` |
| 2 | Create `/data/tenants/<id>/` directories | `rm -rf /data/tenants/<id>` |
| 3 | Generate relay token and per-tenant config | Covered by directory removal |
| 4 | `docker run` / `docker create` tenant container | `docker rm -f claw-tenant-<id>` if container exists |
| 5 | Wait for health check | N/A — container already removed |
| 6 | Mark `status = ACTIVE` | Mark `status = FAILED` (no container) |

**Rollback is not a retry.** Status becomes `FAILED`. A subsequent user message triggers a fresh provisioning attempt (`FAILED` is treated the same as `NEW` in the relay's provisioning gate), subject to the 3-attempt cap.

### Notification on Failure

On provisioning failure, the relay posts to the user's Slack DM:
> "Sorry, I wasn't able to set up your workspace. Our team has been notified. Please try again in a few minutes."

---

## 11. UNHEALTHY State Behavior

### Definition

A tenant enters `UNHEALTHY` when it has been started and was previously `ACTIVE` but fails to sustain health. This is distinct from a startup failure (`FAILED`).

### Triggers for UNHEALTHY

| Trigger | Condition |
|---|---|
| Health poll failure | Tenant was `ACTIVE`; health endpoint returns non-200 for 3 consecutive polls (6 seconds) |
| Container exit | Docker container exits unexpectedly while tenant is `ACTIVE` |
| Message delivery failure | Delivery fails 3 times in a row with connection errors (not application errors) |

### UNHEALTHY Behavior

1. Set `status = UNHEALTHY` in DB.
2. Log `TENANT_UNHEALTHY` to audit log with reason.
3. **Do not immediately restart.** Allow a 30-second cooldown.
4. Attempt auto-recovery: run the wake-up flow (start container, wait for health).
5. If recovery succeeds within 90 seconds → set `status = ACTIVE`, log `TENANT_RECOVERED`, replay any queued messages.
6. If recovery fails → leave status as `UNHEALTHY`. Do not retry automatically more than once. Admin must call `POST /v1/tenants/:tenantId/start` to force another attempt.

### User Experience During UNHEALTHY

- New messages are queued (not dropped).
- Relay posts to user: "Your workspace is experiencing issues. We're attempting to recover it automatically."
- If auto-recovery succeeds, queued messages are processed transparently.
- If auto-recovery fails, relay posts: "We were unable to recover your workspace automatically. Please try again in a few minutes. If the issue persists, contact [admin]."

### Effect on Other Tenants

Zero. Health polling and message delivery are per-tenant. Container crashes are isolated by Docker.

---

## 12. Tenant Deletion / Offboarding Flow

### Trigger

Deletion is initiated by:

- An admin API call: `DELETE /v1/tenants/:tenantId`
- Future: a Slack user requesting account deletion (not MVP)

### Status Transition

`ANY_STATUS → DELETING` immediately on request. While in `DELETING`, no new messages are accepted; any queued messages are discarded.

### Deletion Steps (ordered)

1. Set `status = DELETING`, set `deletion_requested_at = now` in DB.
2. Reject any in-flight message delivery: "This workspace is being deleted."
3. Stop the container if running: `docker stop claw-tenant-<id> --time 10`
4. Remove the container: `docker rm claw-tenant-<id>`
5. Remove Docker volumes if any were created separately.
6. **Archive** `/data/tenants/<id>/` to `/data/tenants-archive/<id>/` — do NOT delete immediately.
7. Purge `message_queue` rows for this tenant.
8. Purge `startup_locks` row for this tenant.
9. Mark `allowlist` entry as revoked if deletion means access is revoked.
10. Write audit log entry: `TENANT_DELETED`.
11. Soft-delete tenant row: set `deleted_at` timestamp. Audit log rows are never deleted.

### Data Retention Policy

| Data | Retention |
|---|---|
| Tenant filesystem archive (`/data/tenants-archive/<id>/`) | 30 days, then `rm -rf` by a scheduled cleanup job |
| DB tenant row | Soft-deleted (`deleted_at`), retained indefinitely |
| Audit log rows | Retained indefinitely |
| Message queue rows | Purged immediately on deletion |

### Accidental Deletion Recovery

Within the 30-day retention window, an admin can restore a tenant by:

1. Moving `/data/tenants-archive/<id>/` back to `/data/tenants/<id>/`.
2. Clearing `deleted_at` on the tenant row.
3. Triggering a fresh container start.

---

## 13. Message Queue Design

### Purpose

When a tenant is `STOPPED` or `STARTING`, incoming Slack messages must not be dropped. They are enqueued, then replayed in order after the tenant becomes `ACTIVE`.

### Storage

The queue lives in the **same SQLite database** as all control-plane state (see §16). There is no external queue dependency (no Redis, no SQS) for MVP. SQLite WAL mode provides sufficient durability and concurrency for expected message rates.

### Message Payload Structure

| Field | Type | Description |
|---|---|---|
| `id` | `TEXT` (UUID v4) | Primary key |
| `tenant_id` | `TEXT` | Foreign key → `tenants.id` |
| `slack_event_id` | `TEXT` | Slack `event_id` for idempotency (UNIQUE) |
| `payload` | `TEXT` (JSON) | Full raw Slack event envelope, stringified |
| `status` | `TEXT` | `PENDING` \| `PROCESSING` \| `DELIVERED` \| `FAILED` |
| `attempts` | `INTEGER` | Delivery attempt count, default 0 |
| `created_at` | `INTEGER` | Unix epoch ms |
| `updated_at` | `INTEGER` | Unix epoch ms |
| `deliver_after` | `INTEGER` | Unix epoch ms; allows delayed retry (null = immediate) |
| `error` | `TEXT` | Last error message if status is FAILED |

### Queue Lifecycle

```
PENDING → PROCESSING → DELIVERED   (happy path)
                     → FAILED      (after max 3 attempts)
```

1. Slack relay inserts a row with `status = PENDING` before attempting delivery.
2. Before forwarding to the tenant, relay sets `status = PROCESSING`.
3. On successful HTTP 200 from tenant runtime, relay sets `status = DELIVERED`.
4. On failure or timeout, relay increments `attempts`. After 3 attempts it sets `status = FAILED`.
5. Scheduler reaps `DELIVERED` rows older than 7 days and `FAILED` rows older than 30 days.

### Crash Safety

- All queue mutations use SQLite transactions. Partial writes roll back atomically.
- On relay process restart, any row stuck in `PROCESSING` with `updated_at` older than 2 minutes is reset to `PENDING` by a startup sweep.
- `slack_event_id` is a UNIQUE constraint — duplicate Slack retries are silently ignored. If a row already exists with `status = DELIVERED`, the new insert is a no-op.

### Ordering

Delivery is ordered by `created_at ASC` within a tenant. The relay processes one message per tenant at a time to preserve order. Parallelism is only across different tenants.

---

## 14. Tenant-to-Runtime Message Protocol

### Purpose

The Slack relay forwards messages to a running tenant container and receives a response to send back to Slack.

### Transport

| Property | Value |
|---|---|
| Protocol | HTTP/1.1 |
| Port | `3100` (container-internal; not exposed on host network) |
| Host access | Via Docker bridge network: `http://<container_name>:3100` |
| Path | `POST /message` |
| Auth | `X-Relay-Token: <per-tenant-token>` (token stored in `tenants.relay_token`) |

Container name convention: `claw-tenant-<tenant_id>` (e.g. `claw-tenant-a1b2c3d4`). The relay derives the hostname from `tenant_id`; Docker bridge network resolves container names without DNS.

### Request Schema

```json
{
  "messageId": "uuid-v4",
  "slackEventId": "Ev0123456",
  "userId": "U012345",
  "teamId": "T012345",
  "text": "the user's message text",
  "slackPayload": { },
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

`blocks` is an optional Slack Block Kit JSON array. If present, relay sends it instead of plain text.

**Error (HTTP 4xx/5xx or timeout):**

```json
{
  "ok": false,
  "error": "human-readable error string"
}
```

### Timeout and Long-Running Tasks

- **Timeout:** relay waits up to **4 minutes** for a response.
- If the request times out, the relay posts a "still working…" fallback to Slack and continues polling.
- For long-running tasks, the tenant runtime may send intermediate Slack messages directly via the Slack API (using its own bot token) before the HTTP response completes. The final HTTP response closes the relay loop.

---

## 15. Database Schema

### Engine and Location

- **SQLite** with WAL mode enabled.
- File location: `/data/claw-orchestrator/db.sqlite`
- Managed by **Prisma**.
- Single writer: control plane. Relay reads tenant rows; control plane owns writes.

---

### Table: `tenants`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PK | `sha256(principal).slice(0,16)` |
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
| `provision_attempts` | INTEGER | NOT NULL DEFAULT 0 | Count of failed provisioning attempts |
| `resource_overrides` | TEXT | | JSON object; per-tenant resource limit overrides (see §20) |
| `disk_quota_exceeded` | INTEGER | NOT NULL DEFAULT 0 | Boolean flag; set by disk quota enforcement (see §21) |
| `allowlist_entry_id` | TEXT | FK → `allowlist.id` | Which allowlist entry granted access |
| `created_at` | INTEGER | NOT NULL | Unix epoch ms |
| `updated_at` | INTEGER | NOT NULL | Unix epoch ms |
| `deleted_at` | INTEGER | | Unix epoch ms; soft-delete timestamp |
| `deletion_requested_at` | INTEGER | | Unix epoch ms when deletion was requested |
| `error_message` | TEXT | | Last error detail when status is FAILED or UNHEALTHY |

**Index:** `(slack_team_id, slack_user_id)` — used by relay for fast tenant lookup.

---

### Table: `message_queue`

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

**Index:** `(tenant_id, status, created_at)` — for fetching pending messages per tenant in order.

---

### Table: `startup_locks`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `tenant_id` | TEXT | PK, FK → `tenants.id` | One lock slot per tenant |
| `locked_by` | TEXT | NOT NULL | Process/request identifier (UUID) |
| `acquired_at` | INTEGER | NOT NULL | Unix epoch ms |
| `expires_at` | INTEGER | NOT NULL | `acquired_at + 5 min TTL` |

---

### Table: `audit_log`

Append-only. No updates or deletes.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PK (UUID v4) | |
| `tenant_id` | TEXT | FK → `tenants.id` nullable | Null for system-level events |
| `event_type` | TEXT | NOT NULL | See §25 for event type enum |
| `actor` | TEXT | NOT NULL | `system` \| `scheduler` \| `relay` \| `admin:<user>` |
| `metadata` | TEXT | | JSON object with event-specific fields |
| `created_at` | INTEGER | NOT NULL | Unix epoch ms |

---

### Table: `allowlist`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PK (UUID v4) | |
| `slack_team_id` | TEXT | NOT NULL | |
| `slack_user_id` | TEXT | nullable | If null, entire team is allowed |
| `added_by` | TEXT | NOT NULL | Who granted access |
| `note` | TEXT | | Optional human-readable note |
| `created_at` | INTEGER | NOT NULL | Unix epoch ms |
| `revoked_at` | INTEGER | | Unix epoch ms; null = active |

**Index:** `(slack_team_id, slack_user_id, revoked_at)`.

---

### Table: `container_images`

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | TEXT | PK (UUID v4) | |
| `tag` | TEXT | UNIQUE NOT NULL | e.g. `sha-abc1234` |
| `digest` | TEXT | | Docker image digest |
| `is_default` | INTEGER | NOT NULL default 0 | Boolean; exactly one row should be 1 |
| `release_notes` | TEXT | | |
| `created_at` | INTEGER | NOT NULL | Unix epoch ms |
| `deprecated_at` | INTEGER | | Unix epoch ms |

---

## 16. Container Image Design

The tenant image must include:

- OpenClaw
- git
- openssh-client
- shell tools
- `gh`, `convex`, `vercel`, Claude Code, OpenAI Codex
- a non-root `agent` user

### Entrypoint Behavior

On container start:

1. Create required directories
2. Restore or mount tenant secrets
3. Render tenant config from templates
4. Validate `.ssh` permissions (`~/.ssh` → `700`, private keys → `600`)
5. Start the health server (small Node.js or bash/socat process) on port `3101`
6. Start the message server on port `3100`
7. Start OpenClaw

### Image Naming

Images are tagged by git commit SHA: `claw-tenant:sha-<7char>` (e.g. `claw-tenant:sha-abc1234`). The `container_images` table (§16) tracks all available tags; exactly one row has `is_default = 1`.

### Multi-Arch Support

Build for both `linux/arm64` and `linux/amd64` in CI. Production may run on AWS Graviton (`arm64`).

---

## 17. Container Image Update / Rollout Strategy

### When a New Image Is Available

1. Build new image and push to local Docker daemon (or private registry).
2. Insert a new row into `container_images` with `is_default = 0`.
3. **Validate before promoting:** Start a canary tenant with the new image, confirm health endpoint returns `ok: true` within 90 seconds, and run a smoke test message through it.
4. Promote: `POST /v1/admin/images/:id/promote` — sets new row as default, demotes old.

### Rollout Policy

Images are updated **lazily** — a tenant picks up the new image the next time its container is started (after idle stop or manual restart). Tenants may run different image versions concurrently. This is acceptable for MVP.

**To force an update on a specific tenant:**

```
POST /v1/tenants/:tenantId/stop
POST /v1/tenants/:tenantId/start   ← uses current default image
```

### Rollback

Revert `is_default` to the previous image tag via `POST /v1/admin/images/:id/promote`. Containers already running the bad image must be stopped and restarted manually.

### Image Tag Tracking

`tenants.image_tag` records which tag the container was started with. An `IMAGE_UPDATED` audit event is written when a tenant's image changes on restart.

---

## 18. Tenant Container Health Endpoint

### Endpoint Definition

| Property | Value |
|---|---|
| Port | `3101` (separate from message port `3100`) |
| Path | `GET /health` |
| Auth | None (internal Docker bridge only; not exposed to host) |
| Content-Type | `application/json` |

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

### Checks Performed

1. **`openclaw`** — Is the OpenClaw process running? (PID file or process list check)
2. **`workspace_mounted`** — Is `/workspace` writable? (stat check)
3. **`home_mounted`** — Is `/home/agent` writable? (stat check)

All three must be `true` for `ok: true`.

### Polling Behavior (Control Plane)

| Parameter | Value |
|---|---|
| Poll interval | 2 seconds |
| Max wait | 90 seconds |
| Timeout per request | 3 seconds |
| Success condition | HTTP 200 with `ok: true` |
| Failure condition | 90 seconds elapsed without success |

On timeout: trigger provisioning failure rollback if provisioning new tenant; set `status = UNHEALTHY` if previously `ACTIVE`.

---

## 19. Resource Limits Per Container

### Default Quotas

Applied via `docker run` flags when provisioning a tenant container:

| Resource | Default | Flag |
|---|---|---|
| CPU | 1.0 CPU | `--cpus=1.0` |
| Memory | 1.5 GB | `--memory=1536m` |
| Memory swap | 1.5 GB (no swap) | `--memory-swap=1536m` |
| Disk (workspace) | 10 GB | Volume size limit via `--storage-opt size=10G` or quota (see §21) |
| Disk (home) | 2 GB | Same mechanism |
| PIDs | 256 | `--pids-limit=256` |
| Open files | 1024 | `--ulimit nofile=1024:1024` |

**Rationale:** On a `t4g.2xlarge` (8 vCPU, 32 GB RAM) with 10 active tenants: 10 × 1.5 GB = 15 GB reserved, leaving ~17 GB for host OS, control plane, and burst. CPU is burstable under Docker's default fair scheduling.

### Override Mechanism

`tenants.resource_overrides` (TEXT / JSON) allows per-tenant overrides without code changes:

```json
{
  "cpus": 2.0,
  "memory_mb": 3072
}
```

If null, defaults apply.

---

## 20. Disk Pressure / Quota Enforcement

### Per-Tenant Disk Quotas

Defaults (from §20): `/workspace` = 10 GB, `/home/agent` = 2 GB.

### Enforcement Mechanism

**Preferred** (if using ext4 with project quotas or XFS on `/data/tenants`): Use filesystem-level project quotas. Each tenant data directory gets a project ID with a hard limit. The OS enforces this at the VFS layer — writes beyond quota return `ENOSPC`.

**MVP Fallback:** The scheduler measures disk usage per tenant every **5 minutes**:

```bash
du -sb /data/tenants/<id>/
```

| Threshold | Action |
|---|---|
| 90% of quota (warning) | Log `DISK_QUOTA_WARNING`; post Slack message to user; suggest cleanup |
| 100% of quota (exceeded) | Log `DISK_QUOTA_EXCEEDED`; post Slack error to user; set `disk_quota_exceeded = 1`; block new message delivery until usage drops below 95% |

Cleanup suggestion posted to user:
> "You can free space by clearing build caches: `rm -rf ~/.cache/` and `/workspace/node_modules/` in large projects."

### Host-Level Disk Monitoring

Runs every minute monitoring total disk usage on `/data`:

- Above **80% full**: log warning, alert admin channel.
- Above **95% full**: set all tenants to `UNHEALTHY` (to prevent writes), alert admin immediately.

---

## 21. Control Plane Responsibilities & API

The control plane handles: idempotent tenant provisioning, container lifecycle management, tenant status transitions, health checks, message routing integration, activity timestamps, audit logs, concurrency/locking during startup, stop/reset/delete operations, and capacity enforcement.

### Internal API

All endpoints are prefixed `/v1/` (see §23). These are not publicly exposed.

```
POST   /v1/tenants/provision
POST   /v1/tenants/:tenantId/start
POST   /v1/tenants/:tenantId/stop
POST   /v1/tenants/:tenantId/reset
DELETE /v1/tenants/:tenantId
GET    /v1/tenants/:tenantId/health
POST   /v1/tenants/:tenantId/message
POST   /v1/slack/events

POST   /v1/admin/allowlist
DELETE /v1/admin/allowlist/:id
GET    /v1/admin/audit
POST   /v1/admin/images/:id/promote
```

### Control Plane Startup Sequence

On startup, the control plane:

1. Opens SQLite connection, runs Prisma migrations (`prisma migrate deploy`).
2. Sweeps `startup_locks` — resets any expired locks (`acquired_at + 5m < now`).
3. Sweeps `message_queue` — resets any `PROCESSING` rows older than 2 minutes to `PENDING`.
4. Reconciles tenant states — any tenant with status `STARTING` or `PROVISIONING` at boot has likely crashed mid-operation; sets to `FAILED`.
5. Starts Fastify HTTP server on configured port (default `3200`).
6. Logs `SYSTEM_STARTUP` to audit log.

---

## 22. API Versioning Strategy

### Approach: URL Path Versioning

All control plane API endpoints are prefixed with `/v1/`. The Slack relay's Slack-facing webhook endpoint is NOT versioned (Slack controls the URL).

### Version Lifecycle

| Phase | Rule |
|---|---|
| Current | `/v1/` — all current endpoints |
| Deprecated | Announce in docs; keep running for 60 days |
| Removed | Delete endpoint after deprecation window |

For MVP there is only v1. No breaking changes to v1 without bumping to v2.

### Breaking vs Non-Breaking Changes

**Non-breaking (no version bump needed):** Adding new optional fields to responses, adding new endpoints, adding optional request fields.

**Breaking (requires v2):** Removing response fields, changing field types, changing behavior of existing endpoints, removing endpoints.

---

## 23. Tenant Allowlist / Registration Gating

### Purpose

Not every Slack user who messages the bot should get a tenant. Access is controlled to prevent abuse and runaway resource consumption.

### Allowlist Model

A request is allowed if:

```sql
SELECT 1 FROM allowlist
WHERE revoked_at IS NULL
  AND slack_team_id = ?
  AND (slack_user_id = ? OR slack_user_id IS NULL)
LIMIT 1
```

A null `slack_user_id` means the entire team is allowed.

### Resolution Flow (Relay)

When a Slack event arrives from a user not yet in `tenants`:

1. Check allowlist.
2. **If allowed:** proceed with tenant provisioning (§8.2).
3. **If not allowed:**
   - Do NOT create a tenant row.
   - Post to Slack DM: "Thanks for your interest! This system is currently invite-only. Contact [admin contact] to request access."
   - Log `ACCESS_DENIED` to audit log with `slack_team_id`, `slack_user_id`.
   - Return HTTP 200 to Slack (already acknowledged in §7.3).

For users who already have a tenant row but whose allowlist entry is revoked: check allowlist on every message. If revoked, block message delivery: "Your access has been revoked. Contact [admin contact] for assistance."

### Granting and Revoking Access

```
# Grant access to a specific user
POST /v1/admin/allowlist
Body: { "slack_team_id": "T...", "slack_user_id": "U..." }

# Grant access to an entire team
POST /v1/admin/allowlist
Body: { "slack_team_id": "T..." }

# Revoke access
DELETE /v1/admin/allowlist/:id
```

Revocation sets `revoked_at = now`. It does not delete the tenant or their data.

### Bootstrap

For MVP, the allowlist is seeded manually via a migration or admin script before launch. No self-service registration UI.

---

## 24. Audit Log Format and Storage

### Purpose

An append-only record of significant system events for debugging, compliance, and incident response.

### Storage

Stored in the `audit_log` table in SQLite (§16). Exposed via `GET /v1/admin/audit?tenant_id=<id>&event_type=<type>&limit=100&before=<ts>`.

### Event Types

| Event Type | Description |
|---|---|
| `SYSTEM_STARTUP` | Control plane started |
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

### Retention

Audit log rows are never deleted from the DB. If the SQLite file grows large (>500 MB), archive older rows to a compressed NDJSON file: `/data/audit-archive/audit-YYYY-MM.ndjson.gz`, then delete from DB.

---

## 25. Observability / Metrics Strategy

### Structured Logging

All services log JSON via **Pino**. Every log line includes:

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

### Key Metrics

For MVP, emit metrics as structured log lines with a `metric: true` field. A future Prometheus scraper or CloudWatch agent can parse them.

| Metric | Type | Description |
|---|---|---|
| `tenant.provisioned` | counter | New tenants provisioned |
| `tenant.provision_failed` | counter | Provisioning failures |
| `tenant.started` | counter | Container starts |
| `tenant.stopped` | counter | Container stops |
| `tenant.unhealthy` | counter | Transitions to UNHEALTHY |
| `tenant.active_count` | gauge | Currently running containers |
| `message.queued` | counter | Messages enqueued |
| `message.delivered` | counter | Messages delivered to runtime |
| `message.failed` | counter | Messages failed after max retries |
| `message.queue_depth` | gauge | Per-tenant pending message count |
| `message.delivery_latency_ms` | histogram | Time from queue to delivered |
| `tenant.wake_latency_ms` | histogram | Time from start to healthy |
| `access.denied` | counter | Allowlist rejections |
| `disk.usage_bytes` | gauge | Per-tenant disk usage (sampled every 5 min) |

### Log Destinations

- **stdout** from each service (captured by systemd journal or Docker log driver).
- **File sink** (optional): Pino transport to `/var/log/claw-orchestrator/<service>.log`, rotated daily, kept 14 days.

### Alerting

No automated alerting in MVP. Operator reviews logs manually. Post-MVP: CloudWatch Alarms or similar on error rate.

---

## 26. Interactive Access Design

### Recommended MVP Approach

Do **not** expose public SSH daemons for each tenant. Instead, use AWS SSM Session Manager to access the host and provide a host-side helper command:

```bash
tenant-shell <tenant_id>
```

Which runs:

```bash
docker exec -it --user agent claw-tenant-<tenant_id> /bin/bash
```

This provides interactive shell access with zero extra inbound ports, simpler security model, and lower operational cost.

### Why Not Run `sshd` in Each Container

Per-tenant sshd adds more processes, more hardening needs, more key management, more network exposure, and more test complexity. For MVP, `docker exec` through SSM is better.

---

## 27. Host-Side Directory Layout

```text
/opt/claw-orchestrator/
  apps/
  templates/
    workspace/
      AGENTS.md          ← pre-seeded with Task Execution section
  scripts/

~/.openclaw/
  agents/
    main/
      agent/
        auth-profiles.json   ← host OpenClaw model auth (bind-mounted :ro into every tenant container)

/data/
  claw-orchestrator/
    db.sqlite
  tenants/
    t_xxxxxxxx/
      home/
      workspace/
      config/
      logs/
      secrets/           ← per-tenant secrets only (relay token, SSH keypair); NO auth-profiles.json here
    t_yyyyyyyy/
      home/
      workspace/
      config/
      logs/
      secrets/
  tenants-archive/
    t_xxxxxxxx/      ← archived on deletion; removed after 30 days
  backups/
    YYYY-MM-DD/
      db.sqlite
      tenants.tar.gz
  audit-archive/
    audit-YYYY-MM.ndjson.gz
```

This layout makes backup, inspection, restore, and deletion straightforward.

**Note on model auth:** The host's `~/.openclaw/agents/main/agent/auth-profiles.json` is the single source of truth for OpenClaw model authentication. It is bind-mounted read-only into each tenant container (see §6.5). Tenant `secrets/` directories do **not** contain a copy of this file.

---

## 28. EC2 Recommendation and Cost

### Recommended Instance

For 10 active users, recommended minimum: **t4g.2xlarge** (8 vCPU, 32 GB RAM).

This provides a better safety margin if users run coding tasks or CLIs heavily. A **t4g.xlarge** is a leaner alternative only for lighter usage.

### Monthly Estimate

| Item | Cost |
|---|---|
| `t4g.2xlarge` on-demand compute | ~$196/month |
| 150 GB gp3 storage | ~$12/month |
| **Total** | **~$208/month** |

### Important Caveats

Actual sizing depends on concurrency, repo size, install/build frequency, OpenClaw workload intensity, and how much Claude Code / Codex / Vercel / Convex activity occurs.

---

## 29. Backup and Disaster Recovery

### What to Back Up

| Data | Location | Method |
|---|---|---|
| SQLite database | `/data/claw-orchestrator/db.sqlite` | Daily snapshot |
| Tenant filesystems | `/data/tenants/` | Daily snapshot |
| Control plane config/env | `/opt/claw-orchestrator/.env` | Manual; version-controlled template |

### Backup Procedure

A cron job / systemd timer runs daily at **03:00 UTC**:

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

Retention: 7 daily backups locally; 30 daily backups in S3.

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

If the EC2 instance is lost: launch a new instance, restore from EBS snapshot or S3 backup, re-install services, and re-provision tenant containers (containers are ephemeral; data on EBS/disk survives). Running containers do not survive instance replacement.

---

## 30. Deployment / Startup Procedure

### Service Management

All three Node.js services are managed by **systemd** on the Linux host. Unit files live in `/etc/systemd/system/`:

- `claw-control-plane.service`
- `claw-slack-relay.service`
- `claw-scheduler.service`

### Unit File Template (control plane example)

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

1. `docker.service` (OS-managed)
2. `claw-control-plane.service` — must be healthy before relay starts
3. `claw-slack-relay.service` — depends on control plane
4. `claw-scheduler.service` — independent, can start in any order

### Environment Variables (`/opt/claw-orchestrator/.env`)

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

# Model Auth — NO ANTHROPIC_API_KEY here.
# OpenClaw model auth is provided via a read-only bind-mount of the host's auth-profiles.json
# into every tenant container (see §6.5). The file path on the host is:
#   ~/.openclaw/agents/main/agent/auth-profiles.json
# Mounted into each container at:
#   /root/.openclaw/agents/main/agent/auth-profiles.json  (read-only)
# Token rotation on the host is picked up immediately by running containers on next read.
# If the file is missing or the token is revoked, ALL tenants lose model access simultaneously.
```

### First-Time Deployment

```bash
# 1. Install Docker Engine
# 2. Install Node.js 22 + pnpm
# 3. Clone repo to /opt/claw-orchestrator
# 4. pnpm install && pnpm build
# 5. Create /data/claw-orchestrator/ and /data/tenants/ (owned by 'claw' user)
# 6. cp .env.example .env && fill in secrets
# 7. npx prisma migrate deploy
# 8. cp deploy/systemd/*.service /etc/systemd/system/
# 9. systemctl daemon-reload
# 10. systemctl enable --now claw-control-plane claw-slack-relay claw-scheduler
# 11. Configure Slack app webhook URL to point to relay
```

### Updates

```bash
cd /opt/claw-orchestrator
git pull
pnpm install && pnpm build
npx prisma migrate deploy
systemctl restart claw-control-plane claw-slack-relay claw-scheduler
```

---

## 31. Technology Stack

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | **Node.js 20 or 22** | Orchestration-heavy workload; strong fit |
| Language | **TypeScript** | Type safety across services |
| HTTP framework | **Fastify** | APIs and webhooks |
| ORM | **Prisma + SQLite** | Metadata persistence; single-file DB; easy migrations |
| Testing | **Vitest** | Fast, TS-native |
| Logging | **Pino** | Structured JSON logs |
| Config validation | **Zod** | Runtime schema validation |
| Container calls | **execa** | Docker CLI invocations |
| (optional) | **dockerode** | Docker API client if CLI proves insufficient |

Python is explicitly not used. One language keeps the system simpler.

---

## 32. Repository Structure

```text
repo/
  apps/
    slack-relay/
    control-plane/
    scheduler/
  packages/
    shared-config/
    shared-types/
    test-utils/
    docker-client/
  docker/
    tenant-image/       ← Dockerfile; entrypoint expects auth-profiles.json bind-mounted at runtime
    compose/
  templates/
    workspace/
      AGENTS.md         ← base tenant workspace template (includes Task Execution section)
  scripts/
  tests/
    unit/
    integration/
    e2e/
  prisma/
  docs/
  deploy/
    systemd/
```

**Note on model auth in the repo:** The repo does not contain any Anthropic API key or `auth-profiles.json`. Model auth is sourced exclusively from the host operator's OpenClaw installation at runtime via bind-mount (see §6.5). The tenant image Dockerfile must not embed or reference any auth credential.

---

## 33. Development Environment Requirements

### Host OS

Prefer Linux (Ubuntu 22.04 or 24.04).

### Local Machine

| Spec | Practical minimum | Comfortable |
|---|---|---|
| vCPU | 8 | 8–12 |
| RAM | 16 GB | 32 GB |
| Free disk | 40+ GB | 80+ GB SSD |

### Required Tools

Docker Engine, Docker Compose v2, Node.js 20 or 22, pnpm or npm, git, jq, curl. `make` is optional.

### Important Principle

Runtime compatibility checks (tool versions, OpenClaw behavior) should happen **inside the tenant container image**, not only on the developer machine.

### Multi-Arch

Build and test `linux/arm64` for production Graviton compatibility. Also keep `linux/amd64` support in CI.

---

## 34. Local Development Workflow

The local environment must support:

1. Start control plane, Slack relay, and scheduler locally
2. Provision 2+ tenants locally
3. Send fake Slack events (no real Slack app required)
4. Route messages correctly to the right tenant
5. Stop tenants after idle timeout
6. Wake tenants on new messages
7. Run isolation assertions repeatedly

### Slack Development Strategy

Prefer a **fake Slack event generator** for most development and automated tests. Use a real Slack app + tunnel (e.g. ngrok) only for manual end-to-end verification.

---

## 35. Testing Strategy

The system is not complete unless automated tests prove isolation and lifecycle correctness.

### Unit Tests

Cover:

- tenant state transitions
- Slack signature verification
- config validation
- tenant mapping (`team_id + user_id → tenant_id`)
- idle stop eligibility
- lock logic

### Integration Tests

Cover:

- control plane API + DB
- Docker CLI integration
- tenant startup and health checks

### End-to-End Tests

Cover:

- provisioning
- routing
- stop/wake lifecycle
- isolation of SSH/config/workspace
- auth persistence
- concurrency behavior

---

## 36. Detailed End-to-End Test Cases

### A. Provisioning Tests

**A1. First-message auto-provision**
Send Slack DM from new user U1. Assert: tenant record created, container started, tenant directories created, response returned.

**A2. Idempotent first-use provisioning**
Send concurrent first messages for same user. Assert: only one tenant created, only one container exists.

**A3. Multiple users, multiple runtimes**
Send first messages from U1 and U2. Assert: different tenant IDs, different containers, different mounted volumes.

---

### B. Filesystem Isolation Tests

**B1. SSH key separation**
Create `~/.ssh/id_ed25519` in U1 runtime. Assert: not visible in U2 runtime; U2 cannot access U1 home or mounted paths.

**B2. Workspace separation**
U1 writes `/workspace/test.txt`. U2 attempts to read it. Assert: failure.

**B3. Config separation**
U1 writes `~/.config/tool/config.json`. Assert: U2 cannot read or see it.

---

### C. Tool Auth Isolation Tests

**C1. GitHub CLI isolation**
Authenticate `gh` in U1. Assert: U2 cannot see U1 auth files.

**C2. Vercel auth isolation**
Store a token/session in U1. Assert: U2 does not inherit it.

**C3. Convex auth isolation**
Login/configure U1. Assert: U2 has no access to that state.

**C4. Claude Code isolation**
Configure Claude Code state for U1. Assert: U2 is independent.

**C5. Codex isolation**
Configure Codex state for U1. Assert: U2 cannot access it.

**C6. Auth persistence after stop/wake**
Login U1 to one or more tools. Stop U1. Wake U1 on next message. Assert: auth state still exists for U1 only.

---

### D. Process and Environment Isolation Tests

**D1. HOME correctness**
Exec `echo $HOME` in each runtime. Assert: equals `/home/agent`.

**D2. XDG path correctness**
Check `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`. Assert: all point to tenant-local paths.

**D3. No shared env leaks**
Inject a test variable into U1 only. Assert: absent in U2.

**D4. No sibling visibility**
Attempt to inspect peer runtime info from within U1. Assert: denied or unavailable.

---

### E. Slack Routing Tests

**E1. Correct tenant routing**
U1 message writes a marker to its workspace. U2 message writes a different marker. Assert: each marker lands in the correct workspace.

**E2. Session continuity**
Send multiple messages from same user. Assert: same tenant runtime reused; no mixing with another user's state.

**E3. Multi-user concurrency**
Send burst traffic across several users. Assert: replies map to the correct user; no cross-route contamination.

---

### F. Wake-Up and Idle-Stop Tests

**F1. Idle stop after 48 hours**
Simulate inactivity older than 48h. Run scheduler. Assert: tenant container is stopped; tenant data persists.

**F2. Wake on message**
Send a message to a stopped tenant. Assert: container starts, readiness succeeds, queued message is processed.

**F3. Concurrent wake race**
Send two messages simultaneously to a stopped tenant. Assert: only one startup occurs; both messages are processed correctly.

**F4. Wake preserves state**
Put files and tool auth in tenant. Stop tenant. Wake tenant. Assert: state is preserved.

---

### G. Recovery Tests

**G1. Container crash recovery**
Kill tenant container during usage. Send next message. Assert: tenant restarts or recovers; tenant identity remains stable.

**G2. Corrupt config handling**
Corrupt one tenant config. Assert: tenant becomes unhealthy; other tenants continue normally.

**G3. Disk pressure**
Fill one tenant workspace close to quota/limit. Assert: graceful error handling; other tenants unaffected.

---

### H. Security Regression Tests

**H1. Prompt-level cross-tenant access attempt**
Ask U2 runtime to read other users' SSH keys. Assert: refusal or failure; audit log entry exists.

**H2. Path traversal attempt**
Attempt access like `../../...`. Assert: tenant cannot escape its allowed paths.

**H3. Dangerous command gating**
Attempt risky operations such as destructive git or system modification. Assert: policy/approval path triggers if such controls are implemented.

---

---

## 37. Acceptance Criteria

The MVP is ready only if all of the following are true:

- One Slack message can provision a new isolated tenant.
- Repeated messages from the same Slack user reuse the same tenant.
- Different users never share: SSH keys, CLI login state, workspace, config/state.
- Stopped tenants wake automatically on next message.
- Tenant state persists across stop/wake.
- Startup is idempotent and race-safe.
- One tenant crash does not break other tenants.
- Access is gated by allowlist; unauthorized users receive a rejection message.
- Automated E2E tests prove all of the above.

---

## 38. Implementation Order

A coding agent should implement in this sequence:

### Phase 1 — Skeleton
Repo structure, Node monorepo, shared types/config, SQLite schema (all tables), basic Fastify services.

### Phase 2 — Tenant Control Plane
Tenant table, provision/start/stop/delete APIs, Docker wrapper (`execa`), health polling, tenant directory creation, startup lock, provisioning rollback. Implement workspace template seeding (§8.2.1), including `AGENTS.md` copy/merge logic. Implement the read-only bind-mount of the host's `auth-profiles.json` into every tenant container on `docker run` (§6.5, §8.2).

### Phase 3 — Slack Relay
Slack signature verification, user-to-tenant resolution, allowlist check, immediate-ack pattern, message forwarding, queued wake-up behavior, `chat.postMessage` delivery.

### Phase 4 — Tenant Image
Non-root `agent` user, OpenClaw installation, required CLIs, health server on port `3101`, message server on port `3100`, entrypoint script. The image must **not** embed or expect `ANTHROPIC_API_KEY` in the environment. Instead, the entrypoint should verify that `/root/.openclaw/agents/main/agent/auth-profiles.json` is present (bind-mounted read-only by the control plane at start time — see §6.5) and surface a clear error in logs if it is missing.

### Phase 5 — Scheduler
Idle-stop logic (48h inactivity checks), disk usage sampling, message queue reaping, stale lock sweep.

### Phase 6 — Tests
Unit tests, integration tests, isolation E2E tests, wake-up and race tests.

### Phase 7 — Operator Access
Host-side `tenant-shell` helper, admin/debug scripts, backup cron job.

### Phase 8 — Image Rollout
Image tagging, `container_images` table, promote/rollback admin endpoints, canary validation flow.

---

## 40. Non-Goals for MVP

Do not implement these initially unless required:

- Kubernetes or multi-host scheduling
- Public SSH into each tenant
- One shared OpenClaw runtime for all users
- Per-user Slack apps
- Rich UI or admin dashboard
- Advanced RBAC
- Cross-tenant collaboration
- Automated alerting / external monitoring integration
- Self-service tenant registration (allowlist is manually seeded)
