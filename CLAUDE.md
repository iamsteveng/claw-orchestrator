# Claw Orchestrator — Agent Instructions

## Before You Do Anything

Read `SPEC.md` in this directory. It is the single source of truth for this project — architecture, data models, API contracts, service design, infrastructure, and acceptance criteria. Do not start implementing without reading it first.

## Project Summary

Claw Orchestrator is a multi-tenant control plane that gives each Slack user their own isolated OpenClaw agent runtime in a Docker container on a single Linux host.

Three services: `slack-relay`, `control-plane`, `scheduler`.
Stack: Node.js 22 + TypeScript, Fastify, Prisma + SQLite, Docker (via execa).

## Key Conventions

- Monorepo: `apps/` for services, `packages/` for shared libs
- All DB access via Prisma — no raw SQL except for advisory locks
- Docker CLI calls go through `packages/docker-client` (execa wrapper)
- Config validation via Zod at startup — fail fast if env vars missing
- Pino for structured logging — always include `tenantId` in log context
- API versioned under `/v1/`

## Working on a Story

1. Read `SPEC.md` for full context on the story you're implementing
2. Review the Codebase Patterns below for relevant gotchas
3. Implement the story
4. Run typechecks: `npm run typecheck` (or per-package equivalent)
5. Commit with: `feat: [Story ID] - [Story Title]`

---

## Codebase Patterns

### Test Infrastructure

**DATA_DIR isolation (e2e tests)**
- Use `vi.stubEnv('DATA_DIR', '/tmp/claw-tc00X-isolated')` + `vi.resetModules()` + dynamic import in `beforeAll` to give each e2e test file its own isolated DATA_DIR.
- `vi.mock('@claw/shared-config/control-plane')` + `vi.hoisted()` does NOT work — the module resolves to pre-compiled dist files already evaluated before the mock fires. Use `stubEnv + resetModules` instead.
- `afterAll` hooks must only delete specific tenant subdirs the test created, never the entire base `TEST_DATA_DIR` — parallel workers share it.

**SQLite INT overflow**
- Prisma enforces 32-bit signed range on `Int` columns (max ~2.1B). Real `Date.now()` (~1.77 trillion) overflows. Always mock `Date.now()` in integration tests that write timestamps directly via Prisma.
- Safe baseline values per test file: TC-001: 3M, TC-002: 4M, TC-003: 5M, TC-004: 6M, TC-005: 7M, TC-006: 8M, TC-007: 9M, TC-008: 10M, TC-009: 11M, TC-016–TC-029: 16M–29M.
- For 48h idle-stop tests (TC-010): use `mockNow = 200_000_000` — the 172.8M ms offset requires a larger baseline.
- For reaper/retention tests: use `MOCK_NOW = 1_800_000_000` so 31-day offsets (`-878M`) still fit in INT32.

**Fake timers + real Prisma**
- `vi.useFakeTimers()` + `vi.runAllTimersAsync()` / `advanceTimersByTimeAsync()` hangs (60s+) with real Prisma — Prisma's multi-level async promise chains require more event loop iterations than the fake timer loop provides.
- Fake timers work fine with mock Prisma (`vi.fn().mockResolvedValue({})`). For integration tests with real Prisma, bypass fake timers: manipulate DB state directly and call mocked functions sequentially.

**pnpm package resolution from root-level test files**
- `@claw/shared-types` is not hoisted — import enums via relative source paths (`../../packages/shared-types/src/tenant.js`, `../../packages/shared-types/src/message.js`).
- `@claw/test-utils` resolves correctly via relative path: `../../packages/test-utils/src/index.js`.
- `vi.mock('execa')` doesn't intercept execa used by `@claw/docker-client` (pnpm sub-package has its own `node_modules/execa`). Use concrete path: `vi.mock('../../packages/docker-client/node_modules/execa/index.js', factory)`.
- `zod` is not a workspace-root dependency — don't `import { ZodError } from 'zod'` in `tests/unit/`. Check `err.name === 'ZodError'` and `err.issues` shape instead.
- Linter may auto-rewrite relative imports to package aliases, breaking resolution. Use explicit relative paths for cross-package imports from `tests/unit/`.

**Async flush pattern**
- After `/start` triggers `void pollUntilHealthy(...)`, flush with two `await new Promise(resolve => setImmediate(resolve))` calls before asserting TENANT_STARTED audit events.
- 403 denial, disk quota DMs, and other fire-and-forget side effects need `pollUntil` to wait for async completion — the HTTP 200 returns before the async work finishes.

---

### Tenant Provisioning

- `/provision` is **fully synchronous** — when it returns 200, all tenant dirs (`home/`, `workspace/`, `config/`, `logs/`, `secrets/`) are already on disk.
- Response body is slim: `{ tenantId, status, relayToken }` only. `data_dir` and `container_name` must be fetched from DB via `prisma.tenant.findUnique()`.
- `container_name` is always `claw-tenant-${tenantId}`.
- `principal` field is required on `prisma.tenant.create()` — format `T_XXX:U_XXX`, `@unique`. Missing it causes a Prisma validation error.
- `TENANT_PROVISIONED` audit event is the reliable provisioning success signal — only written after dirs + relay-token + seedWorkspace all succeed.
- Provision **does not re-provision** FAILED tenants with `provision_attempts < 3` — returns 200 with existing FAILED status. Cap check: `provision_attempts >= 3` → 409.
- Provision failure: mock `seedWorkspace` to throw (not `docker.run` — that's only called in `/start`).
- Idempotency: `provisionTenant()` checks `findUnique({ where: { principal } })` first. On match, returns immediately with no DB writes (no audit log, no status update).
- `computeTenantId`: `sha256(teamId + ':' + userId).digest('hex').slice(0, 16)` — exported from `apps/slack-relay/src/index.ts`.

---

### Start / Stop Lifecycle

- **NEW tenant** → `dc.run()` (create container). **STOPPED tenant** → `dc.start(containerName)` (restart existing).
- Pass `dockerClient` explicitly to `buildApp(prisma, { dockerClient: mockDc })` — the `/start` endpoint uses dynamic `import('@claw/docker-client')` otherwise, which may not pick up `vi.mock` in some Vitest configs.
- `/start` idempotency: ACTIVE tenant returns HTTP **200** `{status: 'active'}` (not 202) — before acquiring the startup lock.
- `/stop` is **fully synchronous** — awaits `dc.stop()` and DB update before returning. No setImmediate flushing needed.
- `/stop` idempotency: STOPPED → `{status: 'already_stopped'}`, no docker call.
- `dc.stop(containerName, 10)` — hardcoded 10-second timeout; assert both positional args.
- Image tag update on `/start` is synchronous — `getDefaultImage(prisma)` comparison and DB update happen before the 202 is returned.
- Delete endpoint uses soft delete: tenant row preserved with `deleted_at` set. Second DELETE → 409. `archiveDir` is stored in `TENANT_DELETED` audit log metadata `{ containerName, archiveDir }` — parse it rather than reconstructing.

---

### Startup Lock

- Uses SQLite UNIQUE constraint on `startup_locks.tenant_id`. First `/start` INSERT succeeds; second fails → 202 "already_starting", no docker call.
- Potential flakiness with strict `=1` assertion: instant health mock can release the lock before the second request arrives. Use `≤ 2` in lifecycle tests for safety.
- When testing lock contention: add a `healthCheckDelayMs` flag (~300ms) to the mock health check response. This holds the lock long enough for both concurrent requests to collide at the UNIQUE constraint. Reset to 0 after the test.
- Monitor pattern: `setInterval(() => prisma.startupLock.count().then(c => { if (c > max) max = c }), 50)` — assert max ≤ 1.

---

### Health Polling

- `pollUntilHealthy` mock: write `status=ACTIVE` + `TENANT_STARTED` audit log directly via the injected `prisma`. Two `setImmediate` flushes after POST `/start` are sufficient to wait for the background void call.
- `pollUntilHealthy` returns `'timeout'` when max consecutive failures are reached; UNHEALTHY is written to DB before that return.
- `TENANT_UNHEALTHY` audit log metadata: `{ reason: 'consecutive_failures', containerName }`.
- Always mock `attemptAutoRecovery` in health-poll integration tests: `vi.mock('../../apps/control-plane/src/recovery.js', () => ({ attemptAutoRecovery: vi.fn().mockResolvedValue(undefined) }))`.
- `vi.useFakeTimers()` + `vi.runAllTimersAsync()` works for health polling tests **only when using mock Prisma** — hangs with real Prisma (see fake timers note above).

---

### Messages & Relay

- `message_queue` has no text/content field — message text is not persisted. Identify messages by `slack_event_id` (unique column).
- The relay does **not** queue messages while STOPPED — it calls `/start`, polls until ACTIVE, then enqueues. FIFO = monotonically increasing `created_at` (mockNow++ is monotonic).
- Test deduplication at event-handler level (`enqueueMessage` + `deliverPendingMessages`), not relay level. `processSlackEventWithConfig` re-delivers even on duplicates — testing via the full relay endpoint would see 2 runtime calls.
- `last_activity_at` assertions use `>=` (not `>`) — mocked timestamps can be equal within the same tick.
- To intercept relay `/start` calls: check fetch URLs for `/v1/tenants/${tenantId}/start` in the mock handler before the passthrough branch.

---

### Access Control

- `isAllowed()` checks `revoked_at IS NULL` on **every** message delivery — no caching. Revocation takes effect immediately.
- Message endpoint checks allowlist **before** tenant status — even ACTIVE tenants get 403 immediately after revocation.
- `ACCESS_DENIED` and `ACCESS_REVOKED` audit events have `tenant_id: null` and carry `{ slackTeamId, slackUserId }` in metadata.
- Revocation is soft delete on the allowlist row — does NOT touch the tenant row, container, or data directory.
- Relay token validation fires **before** allowlist check — wrong/missing `x-relay-token` → 401.
- `disk_quota_exceeded` check fires after auth (401) and allowlist (403), but **before** ACTIVE status check (503) → 507.

---

### Scheduler

- For scheduler integration tests, seed ACTIVE tenants directly via `prisma.tenant.create()` with explicit `last_activity_at` — simpler than the full provision flow.
- `makeAppFetch` pattern: a custom `fetchFn` that intercepts `/v1/tenants/:id/stop` URLs and routes through `app.inject()` — avoids needing a real HTTP server.
- The CP stop endpoint defaults `actor` to `'system'`. The scheduler must explicitly send `body: JSON.stringify({ actor: 'scheduler' })`.
- `checkDiskQuotas` is fully injectable: `getDiskFn` (4th arg) and `fetchFn` (5th arg) — no real `du` or Slack API calls needed.
- `Math.ceil(QUOTA_BYTES * 0.9)` not `Math.floor` — floor produces `0.8999...` which is strictly below the `>= 0.9` threshold.

---

### Misc

- `seedWorkspace` is a pure function (no HTTP/DB/Docker) — testable in isolation with a real tmpdir.
- `reconcile()` was extracted to `startup-reconciliation.ts` for testability. Accepts `(prisma, log)` where `log` is duck-typed `{ info, warn }`.
- In JavaScript regex, `[^]]*` is a trap: `[^]]` means "any char" (empty negated class), so `[^]]*` does not mean "not `]`". Use `toContain()` for bash script assertions.
- Always check for pre-existing test files before implementing — many TC test files were committed by prior agent runs.
