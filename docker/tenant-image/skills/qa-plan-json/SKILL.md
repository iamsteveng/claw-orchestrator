---
name: qa-plan-json
description: "Convert deterministic QA test plan markdown into strict, versioned executable JSON for downstream QA executors. Use when you need machine-readable test plan artifacts from test-plan-*.md files."
user-invocable: true
---

# QA Plan JSON Converter

Convert `test-plan-*.md` artifacts into strict `test-plan-*.json` artifacts with deterministic IDs, execution metadata, and validation errors that point to source lines.

---

## Pattern Mirror (from skills/ralph/SKILL.md)

This skill mirrors the converter discipline from `skills/ralph`:

1. Clear input contract and one output target file
2. Deterministic conversion rules and ordering discipline
3. Strict validation before final output
4. Fail-fast errors with actionable fixes

---

## The Job

1. Accept one QA test plan markdown file path (`test-plan-*.md`)
2. Parse deterministic sections and scenario matrix rows
3. Emit strict, versioned JSON schema for execution
4. Validate structure, required fields, and deterministic IDs
5. Report conversion/validation errors with source line references

---

## Input Contract

Accepted input:

- One readable markdown file path ending in `.md`
- Expected source format from `skills/qa-plan-generator/SKILL.md`

If input is invalid, stop and report:

- what failed
- expected format
- one valid example

Example valid input:

- `tasks/test-plan-prd-qa-testing-skill-suite.md`

---

## Conversion Rules

1. Parse section headers in deterministic order and reject missing required sections.
2. Parse `## Scenario Matrix` table rows into test cases in listed order.
3. Preserve deterministic IDs from source (`TC-001`, `TC-002`, ...).
4. Normalize test case records into strict executor fields.
5. Derive output path from input basename: `test-plan-<name>.json` in same directory.
6. Emit stable ordering:
   - top-level metadata
   - `tests` sorted by numeric test ID
   - within each test: `steps`, `commands`, `passFail`, `evidence.required`
7. Reject duplicate IDs, missing columns, unknown priorities, or malformed level/source values.

---

## JSON Schema (Versioned)

Output must conform to this schema contract:

```json
{
  "qaPlanSchemaVersion": "1.0.0",
  "planId": "test-plan-<slug>",
  "source": {
    "path": "tasks/test-plan-foo.md",
    "generatedAt": "2026-02-27T00:00:00Z"
  },
  "execution": {
    "defaultRetryRule": {
      "maxRetries": 0,
      "retryOn": ["flake", "timeout"]
    }
  },
  "tests": [
    {
      "id": "TC-001",
      "source": "US-001",
      "level": "unit",
      "priority": "P0",
      "title": "Scenario summary",
      "steps": [
        "Step 1",
        "Step 2"
      ],
      "commands": [
        "npm test -- --runInBand"
      ],
      "passFail": [
        "Expected result statement"
      ],
      "retryRules": [
        {
          "maxRetries": 0,
          "retryOn": ["flake", "timeout"]
        }
      ],
      "evidence": {
        "required": [
          "test output log"
        ],
        "artifacts": []
      }
    }
  ]
}
```

Field requirements:

- `qaPlanSchemaVersion`: required, fixed string `1.0.0`
- `tests[*].id`: required, `TC-###` format, unique
- `tests[*].steps`: required non-empty array
- `tests[*].commands`: required array (may be empty if marked manual in steps)
- `tests[*].passFail`: required non-empty array
- `tests[*].retryRules`: required non-empty array of retry rule objects
- `tests[*].evidence.required`: required non-empty array

Allowed enums:

- `level`: `unit` | `integration` | `e2e` | `manual`
- `priority`: `P0` | `P1` | `P2`
- `retryOn`: `flake` | `timeout` | `infra`

---

## Source Mapping Rules

Map Scenario Matrix columns to JSON:

- `ID` -> `tests[*].id`
- `Source` -> `tests[*].source`
- `Level` -> `tests[*].level`
- `Scenario` -> `tests[*].title`
- `Steps` -> `tests[*].steps` (split into ordered list)
- `Expected Result` -> `tests[*].passFail`
- `Evidence` -> `tests[*].evidence.required`
- `Priority` -> `tests[*].priority`

Command extraction rules:

- If a step contains inline command text (shell snippet/fenced code), extract into `commands`
- If no command is explicit and level is `manual`, set `commands: []`
- If no command is explicit and level is automated (`unit`/`integration`/`e2e`), emit validation error

Retry rule defaults:

- `P0` -> `{ "maxRetries": 0, "retryOn": ["flake", "timeout"] }`
- `P1` -> `{ "maxRetries": 1, "retryOn": ["flake", "timeout"] }`
- `P2` -> `{ "maxRetries": 1, "retryOn": ["flake", "timeout", "infra"] }`

---

## Validation Expectations

Fail conversion if any required condition is unmet. Error format:

- `E-<code> [line <n>] <message> :: <fix guidance>`

Required validations:

- required sections present
- scenario matrix header and required columns present
- test IDs unique, ordered, and parseable
- per-row required cells non-empty
- enum values valid (`level`, `priority`)
- automated tests include at least one command
- pass criteria and evidence fields are non-empty

Example errors:

- `E-MISSING-SECTION [line 1] Missing section '## Scenario Matrix' :: add the required section heading`
- `E-BAD-ID [line 74] Invalid ID 'TC-1' :: use zero-padded format 'TC-001'`
- `E-MISSING-COMMAND [line 88] Automated test without command :: add shell command in Steps or fenced code`

---

## Output

- **Format:** JSON (`.json`)
- **Location:** same directory as source markdown
- **Filename:** `test-plan-<source-basename>.json`

Examples:

- input: `tasks/test-plan-prd-qa-testing-skill-suite.md`
- output: `tasks/test-plan-prd-qa-testing-skill-suite.json`

---

## Handoff

Skill 2 of 3 in QA suite architecture. After generating JSON:

1. Validate JSON against this schema contract
2. Report any errors with source line numbers
3. If valid, pass output path to `qa-codex-loop` execution skill (`--plan <json> --tool codex|claude-code`)

---

## Checklist

Before finalizing output:

- [ ] Input is one readable `test-plan-*.md` file
- [ ] Converter pattern mirror from `skills/ralph` is documented
- [ ] Required sections parsed and validated
- [ ] JSON includes schema version and deterministic ordering
- [ ] Every test includes IDs, steps, commands, pass criteria, retry rules, and evidence
- [ ] Validation errors include actionable guidance and source line references
