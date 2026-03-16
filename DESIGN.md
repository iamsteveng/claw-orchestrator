# Claw Orchestrator — MVP Technical Design Spec

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

## 3. Key Requirements From Discussion

### Functional requirements
- One shared Slack app is preferred.
- Multiple Slack apps should only be considered if there is a strong reason.
- Tenants may be stopped after 48 hours of inactivity.
- The system must wake a stopped tenant when a new Slack message arrives.
- Interactive shell access is optional but preferred.
- Required tool support includes:
  - `gh`
  - `convex`
  - `vercel`
  - `Claude Code`
  - `OpenAI Codex`

### Infrastructure constraints
- Host is **Linux**
- Initial deployment target is **AWS EC2**
- System should be cost-conscious
- Node.js is preferred over Python for implementation

---

## 4. High-Level Design Decision

## Decision: Use one isolated container per Slack user

Each Slack user gets:
- one tenant ID
- one Docker container
- one isolated filesystem
- one isolated workspace
- one isolated home directory
- one isolated `.ssh`
- one isolated set of CLI auth/config/cache files
- one isolated OpenClaw runtime

This is the most important design decision in the MVP.

### Why this works
This approach gives strong isolation with simple, understandable boundaries:

- filesystem namespace separation
- process namespace separation
- per-container environment variables
- per-container mounts
- independent restart/stop lifecycle
- simple auditing and debugging
- easier testability

### Why a shared OpenClaw process is not acceptable
A shared runtime with logical tenant separation is not enough for this use case because it risks cross-user leakage of:

- SSH keys
- auth tokens
- CLI config
- writable workspace contents
- process environment variables
- cached secrets

A single bug in path handling, auth lookup, or process state could leak real credentials.

### Conclusion
For MVP, **container-per-user** is the correct design.

---

## 5. Architecture Summary

The system has four main parts:

### 5.1 Shared Slack App
One shared Slack app receives:
- DMs
- possibly app mentions later

It identifies the sender using:
- `team_id`
- `user_id`

### 5.2 Slack Relay
A Node.js service that:
- receives Slack events
- verifies Slack signatures
- resolves the Slack user to a tenant
- queues messages if the tenant is stopped or starting
- forwards messages to the correct tenant runtime
- returns responses to Slack

### 5.3 Control Plane
A Node.js service that:
- provisions tenant containers
- starts/stops/resets containers
- tracks tenant lifecycle state
- manages tenant metadata
- runs health checks
- keeps audit logs
- exposes internal APIs

### 5.4 Per-Tenant Runtime
One Docker container per tenant containing:
- OpenClaw
- required CLIs
- git
- openssh-client
- shell
- per-tenant home/workspace/config/state

### 5.5 Scheduler
A small Node.js worker that:
- periodically checks tenant activity
- stops containers idle for over 48 hours

---

## 6. Tenant Isolation Model

Each tenant must have completely separate runtime state.

### 6.1 Per-tenant filesystem
Each tenant has separate:
- `/home/agent`
- `/workspace`
- `~/.ssh`
- `~/.config`
- `~/.cache`
- `~/.local/state`
- OpenClaw config/state directories
- logs

### 6.2 Per-tenant environment variables
Each tenant container should explicitly set:

```bash
HOME=/home/agent
XDG_CONFIG_HOME=/home/agent/.config
XDG_CACHE_HOME=/home/agent/.cache
XDG_STATE_HOME=/home/agent/.local/state
```

This ensures `gh`, `vercel`, `convex`, Claude Code, Codex, git, and SSH state stay inside the tenant.

### 6.3 Per-tenant mounts
Only tenant-specific volumes/directories should be mounted into a tenant container.

Never mount:
- host home directories
- shared `.ssh`
- shared credential stores
- Docker socket
- broad writable host directories

### 6.4 Process isolation
Each tenant runs in its own container with:
- isolated process namespace
- isolated runtime user
- separate memory and filesystem context

### 6.5 Secrets isolation
Tenant secrets must be stored and injected per tenant. Shared control plane services should only hold the minimum metadata required.

---

## 7. Slack Routing Design

### Identity mapping
Map Slack sender to tenant using:

- `tenant_principal = team_id + ":" + user_id`
- derive `tenant_id` from this principal

Example:
- `tenant_id = sha256(team_id + ":" + user_id).slice(0, 16)`

### Message flow
1. Slack event arrives at shared Slack app endpoint.
2. Slack relay verifies the signature.
3. Relay resolves tenant by `team_id + user_id`.
4. If tenant does not exist:
   - create tenant record
   - provision tenant runtime
5. If tenant exists but is stopped:
   - enqueue message
   - start tenant
   - wait until healthy
   - replay queued message
6. Route message to tenant runtime.
7. Send tenant response back to Slack.

### Slack scope strategy
For MVP:
- prefer DMs only
- add channel mention support later if needed

DM-only mode reduces ambiguity and routing risk.

---

## 8. Tenant Lifecycle

### States
Suggested tenant states:
- `NEW`
- `PROVISIONING`
- `STARTING`
- `ACTIVE`
- `STOPPED`
- `UNHEALTHY`
- `FAILED`
- `DELETING`

### Provisioning flow
On first user message:
1. Create tenant DB row
2. Create tenant directories/volumes
3. Generate config from templates
4. Optionally generate tenant SSH keypair
5. Start tenant container
6. Run health checks
7. Mark tenant active
8. Process message

### Idle stop flow
If no incoming messages for 48 hours:
1. Scheduler marks tenant eligible for stop
2. Stop tenant container
3. Keep volumes and metadata
4. Mark tenant `STOPPED`

### Wake-up flow
When a message arrives for a stopped tenant:
1. Resolve tenant
2. Acquire per-tenant startup lock
3. Start the tenant container
4. Wait for readiness:
   - gateway alive
   - config mounted
   - workspace mounted
   - secrets available
5. Replay queued message
6. Mark tenant `ACTIVE`

### Race handling
If multiple messages arrive while waking:
- only one start should happen
- all messages should be queued and processed in order
- wake-up path must be idempotent

---

## 9. Interactive Access Design

Interactive access is optional but desirable.

## Recommended MVP approach
Do **not** expose public SSH daemons for each tenant.

Instead:
- use AWS SSM Session Manager to access the host
- provide a host-side helper command such as:

```bash
tenant-shell <tenant_id>
```

That command can run:

```bash
docker exec -it --user agent <container_name> /bin/bash
```

This provides:
- interactive shell access
- zero extra inbound ports
- simpler security model
- lower operational cost

### Why not run sshd in each container now
Per-tenant sshd adds:
- more processes
- more hardening needs
- more key management
- more network exposure
- more test complexity

For MVP, `docker exec` through SSM is better.

---

## 10. Node.js Implementation Direction

Python is not required. The project can be implemented fully in Node.js.

## Recommended stack
- **Node.js 20 or 22**
- **TypeScript**
- **Fastify** for APIs/webhooks
- **Prisma + SQLite** for metadata persistence
- **Vitest** for tests
- **Pino** for logs
- **Zod** for config validation
- **execa** to call Docker CLI
- optional `dockerode` later if needed

## Why Node.js works well here
The project mainly involves:
- HTTP/webhook handling
- container orchestration
- queueing and wake-up logic
- state transitions
- automated tests
- shell/CLI invocation

This is a strong fit for Node.js.

### Recommendation
Use **Node.js only**, not Python.

---

## 11. Repository Structure Suggestion

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
    tenant-image/
    compose/
  templates/
  scripts/
  tests/
    unit/
    integration/
    e2e/
  prisma/
  docs/
```

---

## 12. Container Image Design

The tenant image should include:
- OpenClaw
- git
- openssh-client
- shell tools
- `gh`
- `convex`
- `vercel`
- Claude Code
- OpenAI Codex
- a non-root `agent` user

### Entrypoint behavior
On container start:
1. Create required directories
2. Restore or mount tenant secrets
3. Render tenant config
4. Validate `.ssh` permissions
5. Start OpenClaw
6. Expose private health endpoint or readiness signal

### Required permissions
- `~/.ssh` should be `700`
- private keys should be `600`

---

## 13. Host-Side Directory Layout

Suggested production layout:

```text
/opt/claw-orchestrator/
  apps/
  templates/
  scripts/

/data/tenants/
  t_xxxxxxxx/
    home/
    workspace/
    config/
    logs/
    secrets/
  t_yyyyyyyy/
    home/
    workspace/
    config/
    logs/
    secrets/
```

This layout makes backup, inspection, restore, and deletion easier.

---

## 14. Control Plane Responsibilities

The control plane should handle:
- idempotent tenant provisioning
- container lifecycle management
- tenant status transitions
- health checks
- message routing integration
- activity timestamps
- audit logs
- concurrency/locking during startup
- stop/reset/delete operations

### Suggested internal API
Examples:

```text
POST   /tenants/provision
POST   /tenants/:tenantId/start
POST   /tenants/:tenantId/stop
POST   /tenants/:tenantId/reset
GET    /tenants/:tenantId/health
POST   /tenants/:tenantId/message
POST   /slack/events
```

These do not need to be public beyond the internal system.

---

## 15. What Works vs What Doesn't

## What works
### One shared Slack app
This is the preferred design because:
- lower operational complexity
- one webhook endpoint
- simpler identity model
- easier provisioning
- less OAuth/token sprawl

### One container per user
Works because:
- strongest practical isolation for MVP
- easy to reason about
- easy to test
- safe for SSH keys and auth sessions

### Stop-after-48h with wake-on-message
Works because:
- lowers cost
- preserves tenant state on disk
- keeps user experience acceptable
- simple to implement in the control plane

### Interactive shell via SSM + docker exec
Works because:
- no exposed SSH ports
- simpler than running sshd in every tenant
- operationally cheap and secure enough

### Node.js-only implementation
Works because:
- your team is more familiar with Node.js
- project is orchestration-heavy
- one language keeps the system simpler

## What does not work well
### Shared OpenClaw runtime for all users
Does not work because:
- too risky for auth/token/SSH leakage
- weaker security boundary
- harder to prove correctness

### Multiple Slack apps per user by default
Does not work well for MVP because:
- too much OAuth and operational overhead
- not necessary given your preference for one shared app

### Public SSH per tenant in MVP
Does not work well because:
- adds attack surface
- extra hardening needed
- unnecessary if SSM + docker exec is acceptable

### Relying only on logical app-layer checks for isolation
Does not work because:
- one bug could leak real secrets
- no strong OS boundary

---

## 16. EC2 Recommendation and Cost

### Recommended instance
For 10 active users, recommended minimum:
- **t4g.2xlarge**

Reason:
- better safety margin for 10 active isolated containers
- more realistic than t4g.xlarge if users run coding tasks or CLIs heavily

### Lean but riskier option
- **t4g.xlarge**
- only reasonable for lighter usage

### Monthly estimate previously discussed
Approximate on-demand:
- `t4g.2xlarge`: about **$196/month compute**
- plus storage, e.g. `150 GB gp3`: about **$12/month**
- total around **$208/month**

This was considered the practical minimum recommendation for 10 active users.

### Important note
Actual sizing depends heavily on:
- concurrency
- repo size
- install/build frequency
- OpenClaw workload intensity
- how much Claude Code / Codex / Vercel / Convex activity occurs

---

## 17. Development Environment Requirements

Recommended dev environment:

### Host OS
Prefer Linux:
- Ubuntu 22.04 or 24.04

### Local machine
Practical minimum:
- 8 vCPU
- 16 GB RAM
- 40+ GB free disk

More comfortable:
- 8–12 vCPU
- 32 GB RAM
- 80+ GB SSD

### Required tools
- Docker Engine
- Docker Compose v2
- Node.js 20 or 22
- pnpm or npm
- git
- jq
- curl
- make optional

### Important principle
The important runtime compatibility checks should happen **inside the tenant container image**, not only on the developer machine.

### Multi-arch support
Since production may use AWS Graviton:
- build/test `linux/arm64`
- also keep `linux/amd64` support in CI

---

## 18. Local Development Workflow

The local environment should support:

1. Start control plane
2. Start Slack relay
3. Start scheduler
4. Provision 2+ tenants locally
5. Send fake Slack events
6. Route messages correctly
7. Stop tenants after idle timeout
8. Wake tenants on new messages
9. Run isolation assertions repeatedly

### Slack development strategy
Prefer a **fake Slack event generator** for most development and tests.

Use a real Slack app + tunnel only for manual E2E verification.

---

## 19. Testing Strategy

The system is not complete unless automated tests prove isolation and lifecycle correctness.

## Test layers

### Unit tests
For:
- tenant state transitions
- Slack signature verification
- config validation
- tenant mapping
- idle stop eligibility
- lock logic

### Integration tests
For:
- control plane API + DB
- Docker CLI integration
- tenant startup and health checks

### End-to-end tests
For:
- provisioning
- routing
- stop/wake lifecycle
- isolation of SSH/config/workspace
- auth persistence
- concurrency behavior

---

## 20. Detailed End-to-End Test Cases

## A. Provisioning tests

### A1. First-message auto-provision
- Send Slack DM from new user U1
- Assert tenant record created
- Assert container started
- Assert tenant directories created
- Assert response returned

### A2. Idempotent first-use provisioning
- Send concurrent first messages for same user
- Assert only one tenant created
- Assert only one container exists

### A3. Multiple users, multiple runtimes
- Send first messages from U1 and U2
- Assert different tenant IDs
- Assert different containers
- Assert different mounted volumes

---

## B. Filesystem isolation tests

### B1. SSH key separation
- In U1 runtime, create `~/.ssh/id_ed25519`
- Verify file is not visible in U2 runtime
- Verify U2 cannot access U1 home or mounted paths

### B2. Workspace separation
- U1 writes `/workspace/test.txt`
- U2 attempts to read it
- Assert failure

### B3. Config separation
- U1 writes tool config to `~/.config/tool/config.json`
- U2 cannot read or see it

---

## C. Tool auth isolation tests

These are especially important because this project exists to isolate CLI auth state.

### C1. GitHub CLI isolation
- Authenticate or simulate auth for `gh` in U1
- Verify U2 cannot see U1 auth files

### C2. Vercel auth isolation
- Store a token/session in U1
- Assert U2 does not inherit it

### C3. Convex auth isolation
- Login/configure U1
- Assert U2 has no access to that state

### C4. Claude Code isolation
- Configure Claude Code state for U1
- Assert U2 is independent

### C5. Codex isolation
- Configure Codex state for U1
- Assert U2 cannot access it

### C6. Auth persistence after stop/wake
- Login U1 to one or more tools
- Stop U1 after idle
- Wake U1 on next message
- Assert auth state still exists for U1 only

---

## D. Process and environment isolation tests

### D1. HOME correctness
- Exec `echo $HOME` in each runtime
- Assert it equals `/home/agent`

### D2. XDG path correctness
- Check `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`
- Assert they point to tenant-local paths

### D3. No shared env leaks
- Inject a test variable into U1 only
- Assert it is absent in U2

### D4. No sibling visibility
- Attempt to inspect peer runtime info from within U1
- Assert denied or unavailable

---

## E. Slack routing tests

### E1. Correct tenant routing
- Send U1 message that writes a marker to its workspace
- Send U2 message that writes a different marker
- Assert each marker lands in the correct workspace

### E2. Session continuity
- Send multiple messages from same user
- Assert same tenant runtime is reused
- Assert no mixing with another user’s state

### E3. Multi-user concurrency
- Send burst traffic across several users
- Assert replies map to the correct user
- Assert no cross-route contamination

---

## F. Wake-up and idle-stop tests

### F1. Idle stop after 48 hours
- Simulate inactivity older than 48h
- Run scheduler
- Assert tenant container is stopped
- Assert tenant data persists

### F2. Wake on message
- Send a message to a stopped tenant
- Assert container starts
- Assert readiness succeeds
- Assert queued message is processed after startup

### F3. Concurrent wake race
- Send two messages simultaneously to a stopped tenant
- Assert only one startup occurs
- Assert both messages are processed correctly

### F4. Wake preserves state
- Put files and tool auth in tenant
- Stop tenant
- Wake tenant
- Assert state is preserved

---

## G. Recovery tests

### G1. Container crash recovery
- Kill tenant container during usage
- Send next message
- Assert tenant restarts or recovers
- Assert tenant identity remains stable

### G2. Corrupt config handling
- Corrupt one tenant config
- Assert tenant becomes unhealthy
- Assert other tenants continue normally

### G3. Disk pressure
- Fill one tenant workspace close to quota/limit
- Assert graceful error handling
- Assert other tenants are unaffected

---

## H. Security regression tests

### H1. Prompt-level cross-tenant access attempt
- Ask U2 runtime to read other users’ SSH keys
- Assert refusal or failure
- Assert audit log entry exists

### H2. Path traversal attempt
- Attempt access like `../../...`
- Assert tenant cannot escape its allowed paths

### H3. Dangerous command gating
- Attempt risky operations such as destructive git or system modification
- Assert policy/approval path triggers if such controls are implemented

---

## 21. Acceptance Criteria

The MVP is ready only if all of these are true:

- one Slack message can provision a new isolated tenant
- repeated messages from same Slack user reuse the same tenant
- different users never share:
  - SSH keys
  - CLI login state
  - workspace
  - config/state
- stopped tenants wake automatically on next message
- tenant state persists across stop/wake
- startup is idempotent and race-safe
- one tenant crash does not break other tenants
- automated E2E tests prove the above

---

## 22. Suggested Coding Agent Implementation Order

A coding agent should implement in this sequence:

### Phase 1 — skeleton
- repo structure
- Node monorepo
- shared types/config
- SQLite schema
- basic Fastify services

### Phase 2 — tenant control plane
- tenant table
- provision/start/stop APIs
- Docker wrapper
- health polling
- tenant directory creation

### Phase 3 — Slack relay
- Slack signature verification
- user-to-tenant resolution
- message forwarding
- queued wake-up behavior

### Phase 4 — tenant image
- non-root user
- OpenClaw installation
- required CLIs
- health endpoint/readiness

### Phase 5 — scheduler
- idle-stop logic
- 48h inactivity checks

### Phase 6 — tests
- unit tests
- integration tests
- isolation E2E tests
- wake-up and race tests

### Phase 7 — operator access
- host-side `tenant-shell` helper
- admin/debug scripts

---

## 23. Non-goals for MVP

Do not implement these initially unless required:

- Kubernetes
- multi-host scheduling
- public SSH into each tenant
- one shared OpenClaw runtime for all users
- per-user Slack apps
- rich UI/admin dashboard
- advanced RBAC
- cross-tenant collaboration

---

## 24. Final Recommendation

Claw Orchestrator should be built as:

- **one shared Slack app**
- **one Node.js control plane**
- **one Node.js Slack relay**
- **one Node.js scheduler**
- **one Docker container per Slack user**
- **persistent tenant-local state**
- **idle stop after 48h**
- **automatic wake on next message**
- **interactive access via SSM + docker exec**
- **strong automated E2E isolation tests**

This is the simplest MVP that actually satisfies the core safety requirement:  
**no user should ever accidentally use another user’s SSH keys, CLI logins, workspace, or agent state.**
