# QA Test — Implement and Run

Test ID: TC-029
Title: Provision endpoint idempotency → same tenant on duplicate call
Level: integration
Priority: P1

## Codebase Context (from qa-progress.txt)

## Codebase Patterns

### Parallel test cleanup race condition
All e2e test files share the same `DATA_DIR=/tmp/claw-test-tenants` (set by vitest-setup.ts). Tests run in parallel workers (one per file). afterAll hooks that do `rm(TEST_DATA_DIR, recursive)` wipe dirs created by other workers mid-test.
**Fix:** Each test file's afterAll must only delete specific tenant subdirs it created, not the entire base dir.

### vi.mock with vi.hoisted for @claw/shared-config/control-plane does NOT intercept the module
Attempting to override `controlPlaneConfig.DATA_DIR` via `vi.mock('@claw/shared-config/control-plane', ...)` + `vi.hoisted()` does not work — the module resolves to the dist file which is already cached/evaluated. The mock factory runs but the control-plane continues using the real `process.env.DATA_DIR`.
**Workaround:** Fix the cleanup race instead; use `process.env.DATA_DIR` directly in TEST_DATA_DIR.

### Provision fails silently → tenant becomes ACTIVE via FAILED→start path
If provisioning fails (e.g. seedWorkspace throws), rollback deletes dirs and marks tenant FAILED (attempts=1). The relay's polling loop gets FAILED status (200 OK), calls `/start` (no FAILED guard in start endpoint), mock docker resolves, health poll sets ACTIVE. Audit: TENANT_PROVISIONED is only written on success, so its absence signals failure.

### controlPlaneConfig is a module-level singleton
`controlPlaneConfig` in `@claw/shared-config/control-plane` is parsed from `process.env` at module load time (not per-request). vitest-setup.ts sets `DATA_DIR=/tmp/claw-test-tenants` before any test file is loaded.

---

Use the patterns above to avoid known pitfalls and apply known working approaches.

You are executing one deterministic QA test case from a JSON test plan.
Your job has two phases:

## Phase 1 — Implement the test (if it does not yet exist)

Expected test file: `tests/integration/tc-029.test.ts`

1. Check whether `tests/integration/tc-029.test.ts` exists.
2. If it does NOT exist (or lacks a test for TC-029), write the full test
   implementation to `tests/integration/tc-029.test.ts` following the steps and pass criteria below.
3. Use the project's existing test framework (Vitest) and import helpers from
   `tests/utils/` or `packages/test-utils/` if they exist.
4. The test MUST be identifiable by the grep pattern `TC-029` (include it in
   the describe/it block name).
5. After writing or modifying any test file, stage and commit it:
   `git add tests/integration/tc-029.test.ts && git commit -m 'test: implement TC-029'`

## Phase 2 — Run the test and evaluate pass criteria

### Steps
- POST /v1/tenants/provision for (T1, U1) → assert tenant created
- POST /v1/tenants/provision for (T1, U1) again
- Assert same tenantId returned
- Assert only 1 tenant row in DB for this principal
- Assert no new audit events written on idempotent call

### Commands
- ``pnpm test -- --grep "TC-029" --reporter=verbose

### Pass Criteria
- Idempotent provisioning returns same tenant

### Evidence Required
- Idempotent provisioning returns same tenant
- Agent output captured in agent-output.txt

## Response Format

After completing both phases, respond with exact tags:
<status>PASS</status> or <status>FAIL</status>
<evidence>...concise evidence from test output...</evidence>
<reason>...concise failure reason when FAIL...</reason>
<learnings>...reusable patterns, gotchas, or insights discovered during this test that would help future tests...</learnings>

Also append your findings to `qa-progress.txt` in the project root using the following format:

```
### TC-029 [PASS|FAIL] Provision endpoint idempotency → same tenant on duplicate call
- What worked / what failed
- **Learnings:**
  - Pattern discovered
  - Gotcha encountered
---
```
