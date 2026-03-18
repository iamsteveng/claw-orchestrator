---
name: qa-plan-generator
description: "Generate a deterministic QA test plan markdown from a PRD markdown file. Use when you have a PRD and need structured test coverage planning output."
user-invocable: true
---

# QA Plan Generator

Generate a complete, deterministic QA test plan from either a PRD markdown file or a free-text testing objective.

---

## Pattern Mirror (from skills/prd/SKILL.md)

This skill intentionally mirrors the `skills/prd` structure pattern:

1. Clear job definition with explicit inputs/outputs
2. Step-based flow with deterministic section ordering
3. Strict markdown output conventions and file path rules
4. Validation checklist before final output

---

## The Job

1. Accept either a PRD markdown file path or a free-text testing objective
2. Determine generation mode (PRD-based or objective-based)
3. Build scenario coverage using deterministic mapping rules
4. Emit a deterministic `test-plan-*.md` artifact
5. Validate missing/ambiguous requirements and record assumptions explicitly

---

## Step 1: Input Contract

Supported inputs (exactly one):

- PRD file path ending in `.md` (example: `tasks/prd-qa-testing-skill-suite.md`)
- Free-text testing objective (example: `Investigate flaky checkout e2e around retries`)

If both input types are provided, stop and request one mode only.

If PRD mode is selected and file path is missing, unreadable, or not markdown, stop and report:

- what is invalid
- what input is expected
- one valid example path

If objective mode is selected:

- infer objective type from text or ask for explicit type when ambiguous
- allowed objective types:
  - `acceptance`
  - `bug`
  - `test-gap`
  - `flaky`
  - `refactor-for-testability`
  - `performance`

---

## Step 2A: Parse PRD Content (PRD Mode)

Extract at minimum:

- PRD title
- goals
- user stories (`US-###`, title, description, acceptance criteria)
- functional requirements (`FR-*` style when present)
- non-goals/out-of-scope
- open questions

If a section is absent, continue and track it in assumptions/risks.

---

## Step 2B: Parse Objective Content (Objective Mode)

Extract at minimum:

- objective statement
- inferred or explicit objective type
- system or feature area under test
- known failure signal or success signal
- constraints (time, environments, tooling)
- unknowns requiring assumptions

Normalize objective text into:

- `Objective Type`
- `Target`
- `Primary Risk`
- `Expected Outcome`

---

## Step 3: Map Input to Test Scenarios

### PRD Mode

For each user story and requirement:

- create positive-path scenarios
- create negative-path/error scenarios
- create edge-case scenarios
- identify required test level (unit, integration, e2e, manual/exploratory)
- define evidence and pass/fail criteria

Coverage rules:

- every user story must map to at least one scenario
- every explicit acceptance criterion must map to at least one scenario
- non-goals must be listed as exclusions (not test targets)

### Objective Mode

For the parsed objective:

- build a baseline scenario set (repro, isolate, verify, regressions)
- map scenario depth to objective type strategy template (Step 4)
- include at least one negative-path or failure-confirmation scenario
- include explicit evidence requirements for diagnosis and confirmation

---

## Step 4: Objective Strategy Templates

When in objective mode, include a template section named `## Objective Strategy` and apply the matching strategy:

- `acceptance`
  - focus: contract coverage against expected behavior
  - required scenarios: happy path, validation failure, permission/error path
- `bug`
  - focus: reproduce -> isolate -> verify fix -> guard regression
  - required scenarios: deterministic repro, root-cause hypothesis check, post-fix regression
- `test-gap`
  - focus: identify untested risk and add minimum sufficient coverage
  - required scenarios: missing path coverage, boundary case, ongoing guard test
- `flaky`
  - focus: trigger instability, quantify flake rate, verify stabilization
  - required scenarios: repeated runs, variance capture, anti-flake validation
- `refactor-for-testability`
  - focus: increase observability/control seams without behavior drift
  - required scenarios: behavior parity, seam-level tests, maintainability checks
- `performance`
  - focus: baseline vs candidate performance under controlled conditions
  - required scenarios: baseline capture, workload replay, threshold assertion

---

## Step 5: Deterministic Output Structure

Output section order must always be:

1. `# Test Plan: <PRD Title>`
2. `## Source`
3. `## Scope`
4. `## Out of Scope`
5. `## Assumptions and Ambiguities`
6. `## Risk Areas`
7. `## Scenario Matrix`
8. `## Execution Strategy`
9. `## Entry/Exit Criteria`
10. `## Evidence Requirements`
11. `## Traceability`

Objective mode appends section 12:

12. `## Objective Strategy`

Scenario IDs must be deterministic:

- `TC-001`, `TC-002`, ... in stable order by source story ID, then criterion order

For objective mode stable order is:

- objective template required scenarios first
- then supporting edge scenarios
- then optional stretch scenarios

Required Scenario Matrix columns:

- `ID`
- `Source` (US/FR reference)
- `Level` (unit/integration/e2e/manual)
- `Scenario`
- `Steps`
- `Expected Result`
- `Evidence`
- `Priority` (P0/P1/P2)

---

## Step 6: Validate Ambiguity and Record Assumptions

Before finalizing output:

- flag ambiguous language (`fast`, `user-friendly`, `robust`, etc.)
- flag missing acceptance criteria or missing expected outcomes
- flag missing environment/setup details needed for execution

Record each issue under `## Assumptions and Ambiguities` using:

- `A-001`, `A-002`, ...
- issue description
- assumed interpretation used for planning
- impact if assumption is wrong

---

## Output

- **Format:** Markdown (`.md`)
- **Location:** same directory as input PRD by default
- **Filename:**
  - PRD mode: `test-plan-<prd-file-basename>.md`
  - Objective mode: `test-plan-objective-<objective-type>-<slug>.md`

Example:

- input: `tasks/prd-qa-testing-skill-suite.md`
- output: `tasks/test-plan-prd-qa-testing-skill-suite.md`
- input objective: `Investigate flaky checkout e2e around retries` (type: `flaky`)
- output: `./test-plan-objective-flaky-investigate-flaky-checkout-e2e-around-retries.md`

---

## Handoff (Skill 1 of 3)

Pipeline order for QA suite alignment:

1. `qa-plan-generator` (this skill) writes deterministic `test-plan-*.md`
2. `qa-plan-json` converts markdown to strict `test-plan-*.json`
3. `qa-codex-loop` executes JSON gate with `--tool codex|claude-code`

When this skill finishes, return the generated markdown path explicitly for step 2.

---

## Checklist

Before returning the plan:

- [ ] Exactly one input mode selected (PRD or objective)
- [ ] PRD mode: input path is a readable PRD markdown file
- [ ] Objective mode: objective type is one of allowed values
- [ ] PRD mode: all user stories mapped to scenarios
- [ ] PRD mode: acceptance criteria mapped to scenarios
- [ ] Objective mode: matching strategy template applied
- [ ] Deterministic section order is followed
- [ ] Deterministic scenario IDs are used
- [ ] Ambiguities and assumptions are explicitly documented
