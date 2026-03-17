# QA Test — Implement and Run

Test ID: TC-001
Title: First Slack message → tenant provisioned → container started → message delivered
Level: e2e
Priority: P0

## Codebase Context (from qa-progress.txt)

## Codebase Patterns
(no patterns captured yet — will be populated after successful runs)

---

Use the patterns above to avoid known pitfalls and apply known working approaches.

You are executing one deterministic QA test case from a JSON test plan.
Your job has two phases:

## Phase 1 — Implement the test (if it does not yet exist)

Expected test file: `tests/e2e/tc-001.test.ts`

1. Check whether `tests/e2e/tc-001.test.ts` exists.
2. If it does NOT exist (or lacks a test for TC-001), write the full test
   implementation to `tests/e2e/tc-001.test.ts` following the steps and pass criteria below.
3. Use the project's existing test framework (Vitest) and import helpers from
   `tests/utils/` or `packages/test-utils/` if they exist.
4. The test MUST be identifiable by the grep pattern `TC-001` (include it in
   the describe/it block name).
5. After writing or modifying any test file, stage and commit it:
   `git add tests/e2e/tc-001.test.ts && git commit -m 'test: implement TC-001'`

## Phase 2 — Run the test and evaluate pass criteria

### Steps
- Pre-seed allowlist entry for test user (team T_TC001, user U_TC001)
- POST fake Slack event to relay /slack/events with valid HMAC signature
- Verify relay returns HTTP 200 immediately (before provisioning completes)
- Poll DB until tenant row exists with status=ACTIVE (max 30s)
- Assert tenant directories created: home/, workspace/, config/, logs/, secrets/
- Assert AGENTS.md seeded in workspace with '## Task Execution' section
- Assert message_queue row transitions to DELIVERED
- Assert Slack chat.postMessage called with agent response
- Assert audit log contains TENANT_PROVISIONED, TENANT_STARTED, MESSAGE_DELIVERED in order

### Commands
- ``pnpm test:e2e -- --grep "TC-001" --reporter=verbose

### Pass Criteria
- Full provisioning flow completes; message delivered; audit trail present

### Evidence Required
- Full provisioning flow completes; message delivered; audit trail present
- Agent output captured in agent-output.txt

## Response Format

After completing both phases, respond with exact tags:
<status>PASS</status> or <status>FAIL</status>
<evidence>...concise evidence from test output...</evidence>
<reason>...concise failure reason when FAIL...</reason>
<learnings>...reusable patterns, gotchas, or insights discovered during this test that would help future tests...</learnings>

Also append your findings to `qa-progress.txt` in the project root using the following format:

```
### TC-001 [PASS|FAIL] First Slack message → tenant provisioned → container started → message delivered
- What worked / what failed
- **Learnings:**
  - Pattern discovered
  - Gotcha encountered
---
```
