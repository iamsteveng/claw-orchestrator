#!/bin/bash
# QA Codex Loop - deterministic JSON plan executor with optional remediation loops
# Usage: ./qa-codex-loop.sh --plan path/to/test-plan.json --tool codex|claude-code

set -euo pipefail

TOOL="codex"
PLAN_PATH=""
LOGS_ROOT="logs/qa-loop"
CODEX_MODEL="${CODEX_MODEL:-gpt-5.3-codex}"
MAX_LOOPS="${QA_MAX_LOOPS:-3}"
MAX_DURATION="${QA_MAX_DURATION_SECONDS:-0}"
MAX_PATCH_COUNT="${QA_MAX_PATCH_COUNT:-0}"
WORKSPACE_DIR="${QA_WORKSPACE_DIR:-$(pwd)}"
PROGRESS_FILE="$WORKSPACE_DIR/qa-progress.txt"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)
      PLAN_PATH="$2"
      shift 2
      ;;
    --tool)
      TOOL="$2"
      shift 2
      ;;
    --logs-dir)
      LOGS_ROOT="$2"
      shift 2
      ;;
    --max-loops)
      MAX_LOOPS="$2"
      shift 2
      ;;
    --max-duration)
      MAX_DURATION="$2"
      shift 2
      ;;
    --max-patch-count)
      MAX_PATCH_COUNT="$2"
      shift 2
      ;;
    --workspace-dir)
      WORKSPACE_DIR="$2"
      PROGRESS_FILE="$WORKSPACE_DIR/qa-progress.txt"
      shift 2
      ;;
    --help|-h)
      cat <<'USAGE'
Usage: ./qa-codex-loop.sh --plan <test-plan.json> --tool codex|claude-code [options]

Options:
  --logs-dir <path>         Logs directory root (default: logs/qa-loop)
  --max-loops <n>           Maximum remediation loops after initial full run (default: 3)
  --max-duration <seconds>  Optional max wall-clock duration, 0 disables limit (default: 0)
  --max-patch-count <n>     Optional max remediation patch attempts, 0 disables limit (default: 0)
  --workspace-dir <path>    Project workspace root for qa-progress.txt (default: cwd)
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$PLAN_PATH" ]]; then
  echo "Error: --plan is required"
  exit 1
fi

if [[ "$TOOL" != "codex" && "$TOOL" != "claude-code" ]]; then
  echo "Error: --tool must be 'codex' or 'claude-code'"
  exit 1
fi

if [[ ! -f "$PLAN_PATH" ]]; then
  echo "Error: plan file not found: $PLAN_PATH"
  exit 1
fi

if ! [[ "$MAX_LOOPS" =~ ^[0-9]+$ ]]; then
  echo "Error: --max-loops must be a non-negative integer"
  exit 1
fi

if ! [[ "$MAX_DURATION" =~ ^[0-9]+$ ]]; then
  echo "Error: --max-duration must be a non-negative integer (seconds)"
  exit 1
fi

if ! [[ "$MAX_PATCH_COUNT" =~ ^[0-9]+$ ]]; then
  echo "Error: --max-patch-count must be a non-negative integer"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required"
  exit 1
fi

if [[ "$TOOL" == "codex" ]] && ! command -v codex >/dev/null 2>&1; then
  echo "Error: codex CLI not found"
  exit 1
fi

if [[ "$TOOL" == "claude-code" ]] && ! command -v claude >/dev/null 2>&1; then
  echo "Error: claude CLI not found"
  exit 1
fi

SCHEMA_VERSION="$(jq -r '.qaPlanSchemaVersion // empty' "$PLAN_PATH")"
if [[ "$SCHEMA_VERSION" != "1.0.0" ]]; then
  echo "Error: unsupported qaPlanSchemaVersion '$SCHEMA_VERSION' (expected 1.0.0)"
  exit 1
fi

TEST_COUNT="$(jq '.tests | length' "$PLAN_PATH")"
if [[ "$TEST_COUNT" -eq 0 ]]; then
  echo "Error: plan contains no tests"
  exit 1
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$LOGS_ROOT/$RUN_ID"
RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_STARTED_EPOCH="$(date -u +%s)"
mkdir -p "$RUN_DIR/tests" "$RUN_DIR/attempts" "$RUN_DIR/remediation"

cp "$PLAN_PATH" "$RUN_DIR/plan.json"

echo "runId=$RUN_ID" > "$RUN_DIR/run.env"
echo "tool=$TOOL" >> "$RUN_DIR/run.env"
echo "plan=$PLAN_PATH" >> "$RUN_DIR/run.env"
echo "startedAt=$RUN_STARTED_AT" >> "$RUN_DIR/run.env"
echo "maxLoops=$MAX_LOOPS" >> "$RUN_DIR/run.env"
echo "maxDurationSeconds=$MAX_DURATION" >> "$RUN_DIR/run.env"
echo "maxPatchCount=$MAX_PATCH_COUNT" >> "$RUN_DIR/run.env"

# ─── qa-progress.txt helpers ──────────────────────────────────────────────────

# Initialize qa-progress.txt for this run (creates if missing, appends run header if exists)
init_progress_file() {
  local run_date
  run_date="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"

  if [[ ! -f "$PROGRESS_FILE" ]]; then
    cat > "$PROGRESS_FILE" <<EOF
# QA Progress Log
Started: $run_date
---

## Codebase Patterns
(no patterns captured yet — will be populated after successful runs)

---
EOF
  fi

  # Append new run header
  cat >> "$PROGRESS_FILE" <<EOF

## Run: $RUN_ID [$run_date]
EOF
}

# Extract the ## Codebase Patterns section from qa-progress.txt
get_codebase_patterns() {
  python3 - "$PROGRESS_FILE" <<'PY'
import sys
import re

file_path = sys.argv[1]
try:
    with open(file_path, encoding="utf-8", errors="ignore") as f:
        text = f.read()

    # Extract ## Codebase Patterns section (up to next ## heading or end of file)
    match = re.search(r"(## Codebase Patterns.*?)(?=\n## |\Z)", text, re.S)
    if match:
        print(match.group(1).strip())
    else:
        print("## Codebase Patterns\n(none yet)")
except FileNotFoundError:
    print("## Codebase Patterns\n(none yet)")
PY
}

# Returns 0 (true) if test_id already recorded as [PASS] in this run's section
check_already_passed() {
  local run_id="$1"
  local test_id="$2"

  if [[ ! -f "$PROGRESS_FILE" ]]; then
    return 1
  fi

  python3 - "$PROGRESS_FILE" "$run_id" "$test_id" <<'PY'
import sys
import re

file_path = sys.argv[1]
run_id = sys.argv[2]
test_id = sys.argv[3]

try:
    with open(file_path, encoding="utf-8", errors="ignore") as f:
        text = f.read()

    # Find the section for this run_id
    run_section = re.search(
        rf"## Run: {re.escape(run_id)}.*?(?=\n## Run:|\Z)",
        text, re.S
    )
    if run_section:
        section_text = run_section.group(0)
        if re.search(rf"### {re.escape(test_id)} \[PASS\]", section_text):
            sys.exit(0)  # Found — already passed
except FileNotFoundError:
    pass
sys.exit(1)  # Not found
PY
}

# Append a test result entry to qa-progress.txt
append_test_progress() {
  local test_id="$1"
  local title="$2"
  local status="$3"
  local evidence="$4"
  local reason="$5"
  local learnings="$6"

  {
    echo ""
    echo "### $test_id [$status] $title"
    if [[ "$status" == "FAIL" && -n "$reason" ]]; then
      echo "- **Failed:** $reason"
    fi
    if [[ -n "$evidence" ]]; then
      echo "- **Evidence:** $evidence"
    fi
    if [[ -n "$learnings" ]]; then
      echo "- **Learnings:**"
      while IFS= read -r line; do
        [[ -n "$line" ]] && echo "  - $line"
      done <<< "$learnings"
    fi
    echo "---"
  } >> "$PROGRESS_FILE"
}

# Append a remediation loop summary to qa-progress.txt
append_remediation_progress() {
  local loop_label="$1"
  local failed_ids="$2"
  local root_causes="$3"
  local fixes_summary="$4"
  local result="$5"

  {
    echo ""
    echo "## Remediation: $RUN_ID $loop_label"
    echo "- Failed tests: $failed_ids"
    echo "- Root causes identified: $root_causes"
    echo "- Fixes applied: $fixes_summary"
    echo "- Result: $result"
    echo "---"
  } >> "$PROGRESS_FILE"
}

# Distill learnings from this run into ## Codebase Patterns at top of qa-progress.txt
update_codebase_patterns() {
  local run_learnings
  run_learnings="$(python3 - "$PROGRESS_FILE" "$RUN_ID" <<'PY'
import sys
import re

file_path = sys.argv[1]
run_id = sys.argv[2]

try:
    with open(file_path, encoding="utf-8", errors="ignore") as f:
        text = f.read()

    # Find this run's section
    run_section = re.search(
        rf"## Run: {re.escape(run_id)}.*?(?=\n## Run:|\n## Remediation:|\Z)",
        text, re.S
    )
    if run_section:
        # Extract all Learnings bullet lines
        learnings_blocks = re.findall(
            r"\*\*Learnings:\*\*\n((?:\s+- .+\n?)+)",
            run_section.group(0)
        )
        all_items = []
        for block in learnings_blocks:
            items = re.findall(r"- (.+)", block)
            all_items.extend(items)
        print("\n".join(all_items))
except FileNotFoundError:
    pass
PY
)"

  if [[ -z "$run_learnings" ]]; then
    return 0
  fi

  python3 - "$PROGRESS_FILE" "$run_learnings" <<'PY'
import sys
import re

file_path = sys.argv[1]
new_learnings = sys.argv[2]

try:
    with open(file_path, encoding="utf-8", errors="ignore") as f:
        text = f.read()

    # Find the Codebase Patterns section (between heading and first ---)
    match = re.search(r"(## Codebase Patterns\n)(.*?)(\n---)", text, re.S)
    if match:
        existing = match.group(2).strip()
        # Remove placeholder text
        if "(no patterns captured yet" in existing or "(none yet)" in existing:
            existing = ""

        new_items = [line.strip() for line in new_learnings.strip().split("\n") if line.strip()]
        new_bullets = []
        for item in new_items:
            bullet = item if item.startswith("-") else f"- {item}"
            # Deduplicate against existing
            if bullet not in existing:
                new_bullets.append(bullet)

        if existing and new_bullets:
            combined = existing + "\n" + "\n".join(new_bullets)
        elif new_bullets:
            combined = "\n".join(new_bullets)
        else:
            combined = existing

        new_section = f"{match.group(1)}{combined}{match.group(3)}"
        text = text[:match.start()] + new_section + text[match.end():]

        with open(file_path, "w", encoding="utf-8") as f:
            f.write(text)
except FileNotFoundError:
    pass
PY
}

# Seed (or update) ## QA Patterns in CLAUDE.md with distilled codebase patterns
seed_claude_md() {
  local claude_md="$WORKSPACE_DIR/CLAUDE.md"
  local patterns
  patterns="$(get_codebase_patterns)"

  # Skip if nothing useful to write
  if [[ -z "$patterns" ]] || \
     echo "$patterns" | grep -q "(no patterns captured yet" || \
     echo "$patterns" | grep -q "(none yet)"; then
    return 0
  fi

  local qa_section
  qa_section="$(printf "## QA Patterns\n\n_Auto-generated by qa-codex-loop on %s (run: %s)_\n\n%s\n" \
    "$(date -u '+%Y-%m-%d %H:%M UTC')" "$RUN_ID" "$patterns")"

  if [[ -f "$claude_md" ]]; then
    if grep -q "## QA Patterns" "$claude_md"; then
      # Replace existing QA Patterns section
      python3 - "$claude_md" "$qa_section" <<'PY'
import sys
import re

file_path = sys.argv[1]
new_section = sys.argv[2]

with open(file_path, encoding="utf-8", errors="ignore") as f:
    text = f.read()

updated = re.sub(r"## QA Patterns.*?(?=\n## |\Z)", new_section.rstrip(), text, flags=re.S)
with open(file_path, "w", encoding="utf-8") as f:
    f.write(updated)
PY
    else
      # Append section
      {
        echo ""
        echo "$qa_section"
      } >> "$claude_md"
    fi
  else
    # Create CLAUDE.md
    printf "# CLAUDE.md\n\n%s\n" "$qa_section" > "$claude_md"
  fi
}

# ─── End qa-progress.txt helpers ──────────────────────────────────────────────

# Initialize progress file now that RUN_ID is set
init_progress_file

extract_tag_text() {
  local file_path="$1"
  local tag="$2"

  python3 - "$file_path" "$tag" <<'PY'
import re
import sys

file_path = sys.argv[1]
tag = re.escape(sys.argv[2])

with open(file_path, encoding="utf-8", errors="ignore") as f:
    text = f.read()

match = re.search(fr"<{tag}>\s*(.*?)\s*</{tag}>", text, re.S | re.I)
if match:
    print(" ".join(match.group(1).split()))
PY
}

run_test() {
  local test_json="$1"
  local suite_tests_dir="$2"
  local suite_outcomes_file="$3"
  local test_id
  local title
  local level
  local priority
  local test_dir
  local prompt_file
  local output_file
  local stderr_file
  local status_file
  local result_json
  local tool_exit=0
  local status="FAIL"
  local reason=""
  local evidence=""
  local learnings=""

  test_id="$(jq -r '.id' <<< "$test_json")"
  title="$(jq -r '.title' <<< "$test_json")"
  level="$(jq -r '.level' <<< "$test_json")"
  priority="$(jq -r '.priority' <<< "$test_json")"

  test_dir="$suite_tests_dir/$test_id"
  mkdir -p "$test_dir"

  prompt_file="$test_dir/prompt.md"
  output_file="$test_dir/agent-output.txt"
  stderr_file="$test_dir/stderr.log"
  status_file="$test_dir/status.txt"
  result_json="$test_dir/result.json"

  # --- Resume check: skip if already PASS in this run ---
  if check_already_passed "$RUN_ID" "$test_id"; then
    echo "  [SKIP] $test_id already PASS in run $RUN_ID (resume)" >&2
    status="PASS"
    reason="Skipped — already passed in this run (resume)"
    evidence="(skipped)"

    echo "PASS" > "$status_file"
    printf "" > "$output_file"
    printf "" > "$stderr_file"

    jq -n \
      --arg id "$test_id" \
      --arg title "$title" \
      --arg level "$level" \
      --arg priority "$priority" \
      --arg status "$status" \
      --arg reason "$reason" \
      --arg evidence "$evidence" \
      --arg tool "$TOOL" \
      --arg outputFile "$output_file" \
      --arg stderrFile "$stderr_file" \
      --arg executedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --argjson toolExit 0 \
      '{
        id: $id,
        title: $title,
        level: $level,
        priority: $priority,
        tool: $tool,
        status: $status,
        reason: $reason,
        evidence: $evidence,
        toolExitCode: $toolExit,
        outputFile: $outputFile,
        stderrFile: $stderrFile,
        executedAt: $executedAt
      }' > "$result_json"

    mkdir -p "$RUN_DIR/tests/$test_id"
    cp "$prompt_file" "$RUN_DIR/tests/$test_id/prompt.md" 2>/dev/null || touch "$RUN_DIR/tests/$test_id/prompt.md"
    cp "$output_file" "$RUN_DIR/tests/$test_id/agent-output.txt"
    cp "$stderr_file" "$RUN_DIR/tests/$test_id/stderr.log"
    cp "$status_file" "$RUN_DIR/tests/$test_id/status.txt"
    cp "$result_json" "$RUN_DIR/tests/$test_id/result.json"

    cat "$result_json" >> "$suite_outcomes_file"
    echo >> "$suite_outcomes_file"
    return 0
  fi

  # --- Read codebase patterns for context injection ---
  local codebase_patterns
  codebase_patterns="$(get_codebase_patterns)"

  # Derive expected test file path from level and test ID
  local test_file_hint=""
  local test_file_lower
  test_file_lower="$(echo "$test_id" | tr '[:upper:]' '[:lower:]')"
  case "$level" in
    e2e)         test_file_hint="tests/e2e/${test_file_lower}.test.ts" ;;
    integration) test_file_hint="tests/integration/${test_file_lower}.test.ts" ;;
    unit)        test_file_hint="tests/unit/${test_file_lower}.test.ts" ;;
    *)           test_file_hint="" ;;
  esac

  {
    echo "# QA Test — Implement and Run"
    echo ""
    echo "Test ID: $test_id"
    echo "Title: $title"
    echo "Level: $level"
    echo "Priority: $priority"
    echo ""
    echo "## Codebase Context (from qa-progress.txt)"
    echo ""
    echo "$codebase_patterns"
    echo ""
    echo "Use the patterns above to avoid known pitfalls and apply known working approaches."
    echo ""
    echo "You are executing one deterministic QA test case from a JSON test plan."
    echo "Your job has two phases:"
    echo ""
    echo "## Phase 1 — Implement the test (if it does not yet exist)"
    echo ""
    if [[ -n "$test_file_hint" ]]; then
      echo "Expected test file: \`$test_file_hint\`"
      echo ""
      echo "1. Check whether \`$test_file_hint\` exists."
      echo "2. If it does NOT exist (or lacks a test for $test_id), write the full test"
      echo "   implementation to \`$test_file_hint\` following the steps and pass criteria below."
      echo "3. Use the project's existing test framework (Vitest) and import helpers from"
      echo "   \`tests/utils/\` or \`packages/test-utils/\` if they exist."
      echo "4. The test MUST be identifiable by the grep pattern \`$test_id\` (include it in"
      echo "   the describe/it block name)."
      echo "5. After writing or modifying any test file, stage and commit it:"
      echo "   \`git add $test_file_hint && git commit -m 'test: implement $test_id'\`"
    else
      echo "This is a manual verification test — no test file to implement."
      echo "Proceed directly to Phase 2."
    fi
    echo ""
    echo "## Phase 2 — Run the test and evaluate pass criteria"
    echo ""
    echo "### Steps"
    jq -r '.steps[] | "- " + .' <<< "$test_json"
    echo ""
    echo "### Commands"
    if jq -e '.commands | length > 0' <<< "$test_json" >/dev/null; then
      jq -r '.commands[]' <<< "$test_json" | sed 's/^/- `&`/'
    else
      echo "- No commands provided (manual verification path)."
    fi
    echo ""
    echo "### Pass Criteria"
    jq -r '(.passFail // .passCriteria // [])[] | "- " + .' <<< "$test_json"
    echo ""
    echo "### Evidence Required"
    jq -r '.evidence.required[] | "- " + .' <<< "$test_json"
    echo ""
    echo "## Response Format"
    echo ""
    echo "After completing both phases, respond with exact tags:"
    echo "<status>PASS</status> or <status>FAIL</status>"
    echo "<evidence>...concise evidence from test output...</evidence>"
    echo "<reason>...concise failure reason when FAIL...</reason>"
    echo "<learnings>...reusable patterns, gotchas, or insights discovered during this test that would help future tests...</learnings>"
    echo ""
    echo "Also append your findings to \`qa-progress.txt\` in the project root using the following format:"
    echo ""
    echo "\`\`\`"
    echo "### $test_id [PASS|FAIL] $title"
    echo "- What worked / what failed"
    echo "- **Learnings:**"
    echo "  - Pattern discovered"
    echo "  - Gotcha encountered"
    echo "---"
    echo "\`\`\`"
  } > "$prompt_file"

  if [[ "$TOOL" == "codex" ]]; then
    set +e
    codex exec \
      --model "$CODEX_MODEL" \
      --dangerously-bypass-approvals-and-sandbox \
      "$(cat "$prompt_file")" \
      > "$output_file" \
      2> "$stderr_file"
    tool_exit=$?
    set -e
  else
    set +e
    claude --dangerously-skip-permissions --print < "$prompt_file" > "$output_file" 2> "$stderr_file"
    tool_exit=$?
    set -e
  fi

  if [[ "$tool_exit" -eq 0 ]] && grep -q "<status>PASS</status>" "$output_file"; then
    status="PASS"
  fi

  reason="$(extract_tag_text "$output_file" "reason" || true)"
  evidence="$(extract_tag_text "$output_file" "evidence" || true)"
  learnings="$(extract_tag_text "$output_file" "learnings" || true)"

  echo "$status" > "$status_file"

  # Append test result to qa-progress.txt
  append_test_progress "$test_id" "$title" "$status" "$evidence" "$reason" "$learnings"

  jq -n \
    --arg id "$test_id" \
    --arg title "$title" \
    --arg level "$level" \
    --arg priority "$priority" \
    --arg status "$status" \
    --arg reason "$reason" \
    --arg evidence "$evidence" \
    --arg tool "$TOOL" \
    --arg outputFile "$output_file" \
    --arg stderrFile "$stderr_file" \
    --arg executedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson toolExit "$tool_exit" \
    '{
      id: $id,
      title: $title,
      level: $level,
      priority: $priority,
      tool: $tool,
      status: $status,
      reason: $reason,
      evidence: $evidence,
      toolExitCode: $toolExit,
      outputFile: $outputFile,
      stderrFile: $stderrFile,
      executedAt: $executedAt
    }' > "$result_json"

  mkdir -p "$RUN_DIR/tests/$test_id"
  cp "$prompt_file" "$RUN_DIR/tests/$test_id/prompt.md"
  cp "$output_file" "$RUN_DIR/tests/$test_id/agent-output.txt"
  cp "$stderr_file" "$RUN_DIR/tests/$test_id/stderr.log"
  cp "$status_file" "$RUN_DIR/tests/$test_id/status.txt"
  cp "$result_json" "$RUN_DIR/tests/$test_id/result.json"

  cat "$result_json" >> "$suite_outcomes_file"
  echo >> "$suite_outcomes_file"
}

run_suite() {
  local suite_label="$1"
  local ids_json="$2"
  local suite_dir="$RUN_DIR/attempts/$suite_label"
  local suite_tests_dir="$suite_dir/tests"
  local suite_outcomes_file="$suite_dir/outcomes.jsonl"
  local suite_summary_file="$suite_dir/summary.json"
  local pass_count
  local fail_count
  local total_count
  local suite_status="PASS"

  mkdir -p "$suite_tests_dir"
  : > "$suite_outcomes_file"

  if [[ "$ids_json" == "[]" ]]; then
    while IFS= read -r test_json; do
      run_test "$test_json" "$suite_tests_dir" "$suite_outcomes_file"
    done < <(
      jq -c '.tests | sort_by((.id | ltrimstr("TC-") | tonumber))[]' "$PLAN_PATH"
    )
  else
    while IFS= read -r test_json; do
      run_test "$test_json" "$suite_tests_dir" "$suite_outcomes_file"
    done < <(
      jq -c --argjson ids "$ids_json" '
        .tests
        | map(select(.id as $id | $ids | index($id)))
        | sort_by((.id | ltrimstr("TC-") | tonumber))[]
      ' "$PLAN_PATH"
    )
  fi

  pass_count="$(jq -s '[.[] | select(.status == "PASS")] | length' "$suite_outcomes_file")"
  fail_count="$(jq -s '[.[] | select(.status == "FAIL")] | length' "$suite_outcomes_file")"
  total_count="$(jq -s 'length' "$suite_outcomes_file")"

  if [[ "$fail_count" -gt 0 ]]; then
    suite_status="FAIL"
  fi

  jq -n \
    --arg label "$suite_label" \
    --arg status "$suite_status" \
    --arg startedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson total "$total_count" \
    --argjson passed "$pass_count" \
    --argjson failed "$fail_count" \
    '{
      label: $label,
      status: $status,
      totals: {
        total: $total,
        passed: $passed,
        failed: $failed
      },
      completedAt: $startedAt
    }' > "$suite_summary_file"

  echo "$suite_status"
}

build_failed_ids_json() {
  local outcomes_file="$1"
  jq -s -c '[.[] | select(.status == "FAIL") | .id]' "$outcomes_file"
}

extract_root_causes_json() {
  local remediation_output="$1"

  python3 - "$remediation_output" <<'PY'
import json
import re
import sys

file_path = sys.argv[1]
with open(file_path, encoding="utf-8", errors="ignore") as f:
    text = f.read()

items = []
root = re.search(r"<root_causes>\s*(.*?)\s*</root_causes>", text, re.S | re.I)
if root:
    items = [
        " ".join(item.split())
        for item in re.findall(r"<item>\s*(.*?)\s*</item>", root.group(1), re.S | re.I)
        if item.strip()
    ]

print(json.dumps(items))
PY
}

run_remediation() {
  local loop_index="$1"
  local failed_ids_json="$2"
  local loop_label="loop-$(printf '%02d' "$loop_index")"
  local remediation_dir="$RUN_DIR/remediation/$loop_label"
  local prompt_file="$remediation_dir/prompt.md"
  local output_file="$remediation_dir/agent-output.txt"
  local stderr_file="$remediation_dir/stderr.log"
  local status_file="$remediation_dir/status.txt"
  local root_causes_file="$remediation_dir/root-causes.json"
  local test_context_file="$remediation_dir/failed-tests.json"
  local tool_exit=0

  mkdir -p "$remediation_dir"

  jq -s --argjson ids "$failed_ids_json" '
    map(select(.id as $id | $ids | index($id)))
    | map({id, title, reason, outputFile, stderrFile})
  ' "$LATEST_FULL_OUTCOMES_FILE" > "$test_context_file"

  # --- Read codebase patterns for context injection ---
  local codebase_patterns
  codebase_patterns="$(get_codebase_patterns)"

  {
    echo "# QA Remediation Loop"
    echo ""
    echo "Run ID: $RUN_ID"
    echo "Loop: $loop_index"
    echo ""
    echo "## Codebase Context (from qa-progress.txt)"
    echo ""
    echo "$codebase_patterns"
    echo ""
    echo "Use the patterns above to avoid known pitfalls and apply known working approaches."
    echo ""
    echo "You are fixing failing QA tests in this repository."
    echo ""
    echo "## Failing Tests (Latest Full Gate)"
    jq '.' "$test_context_file"
    echo ""
    echo "## Required Actions"
    echo "1. Diagnose likely root causes from failing test output."
    echo "2. Apply minimal code changes to fix failures."
    echo "3. Do not edit generated logs under logs/qa-loop unless required by tooling."
    echo ""
    echo "Return exact tags in your final answer:"
    echo "<status>PATCHED</status> or <status>BLOCKED</status>"
    echo "<root_causes><item>cause 1</item><item>cause 2</item></root_causes>"
    echo "<summary>short description of code changes</summary>"
  } > "$prompt_file"

  if [[ "$TOOL" == "codex" ]]; then
    set +e
    codex exec \
      --model "$CODEX_MODEL" \
      --dangerously-bypass-approvals-and-sandbox \
      "$(cat "$prompt_file")" \
      > "$output_file" \
      2> "$stderr_file"
    tool_exit=$?
    set -e
  else
    set +e
    claude --dangerously-skip-permissions --print < "$prompt_file" > "$output_file" 2> "$stderr_file"
    tool_exit=$?
    set -e
  fi

  local remediation_result="BLOCKED"
  if [[ "$tool_exit" -eq 0 ]] && grep -q "<status>PATCHED</status>" "$output_file"; then
    remediation_result="PATCHED"
    echo "PATCHED" > "$status_file"
  else
    echo "BLOCKED" > "$status_file"
  fi

  extract_root_causes_json "$output_file" > "$root_causes_file"

  LAST_ROOT_CAUSES_JSON="$(cat "$root_causes_file")"

  # Extract failed IDs as a readable list
  local failed_ids_list
  failed_ids_list="$(jq -r '.[]' <<< "$failed_ids_json" | tr '\n' ' ' | sed 's/ $//')"

  # Extract root causes as readable text
  local root_causes_text
  root_causes_text="$(jq -r '.[]' "$root_causes_file" | head -5 | tr '\n' '; ' | sed 's/; $//')"

  # Extract summary from agent output
  local fixes_summary
  fixes_summary="$(extract_tag_text "$output_file" "summary" || true)"

  # Append remediation entry to qa-progress.txt
  append_remediation_progress "$loop_label" "$failed_ids_list" "${root_causes_text:-none identified}" "${fixes_summary:-none}" "$remediation_result"
}

LOOPS_PERFORMED=0
PATCH_ATTEMPTS=0
STOP_REASON="all_tests_passed"
LATEST_FULL_OUTCOMES_FILE=""
LAST_ROOT_CAUSES_JSON="[]"

INITIAL_STATUS="$(run_suite "loop-00-full" "[]")"
LATEST_FULL_OUTCOMES_FILE="$RUN_DIR/attempts/loop-00-full/outcomes.jsonl"

while [[ "$INITIAL_STATUS" == "FAIL" ]]; do
  now_epoch="$(date -u +%s)"
  elapsed_seconds="$((now_epoch - RUN_STARTED_EPOCH))"

  if [[ "$LOOPS_PERFORMED" -ge "$MAX_LOOPS" ]]; then
    STOP_REASON="max_loops_reached"
    break
  fi

  if [[ "$MAX_DURATION" -gt 0 && "$elapsed_seconds" -ge "$MAX_DURATION" ]]; then
    STOP_REASON="max_duration_reached"
    break
  fi

  if [[ "$MAX_PATCH_COUNT" -gt 0 && "$PATCH_ATTEMPTS" -ge "$MAX_PATCH_COUNT" ]]; then
    STOP_REASON="max_patch_count_reached"
    break
  fi

  LOOPS_PERFORMED="$((LOOPS_PERFORMED + 1))"

  FAILED_IDS_JSON="$(build_failed_ids_json "$LATEST_FULL_OUTCOMES_FILE")"

  run_remediation "$LOOPS_PERFORMED" "$FAILED_IDS_JSON"
  PATCH_ATTEMPTS="$((PATCH_ATTEMPTS + 1))"

  run_suite "loop-$(printf '%02d' "$LOOPS_PERFORMED")-affected" "$FAILED_IDS_JSON" >/dev/null
  INITIAL_STATUS="$(run_suite "loop-$(printf '%02d' "$LOOPS_PERFORMED")-full" "[]")"
  LATEST_FULL_OUTCOMES_FILE="$RUN_DIR/attempts/loop-$(printf '%02d' "$LOOPS_PERFORMED")-full/outcomes.jsonl"

done

FINAL_STATUS="PASS"
if [[ "$INITIAL_STATUS" == "FAIL" ]]; then
  FINAL_STATUS="FAIL"
fi

if [[ "$FINAL_STATUS" == "PASS" ]]; then
  STOP_REASON="all_tests_passed"
fi

cp "$LATEST_FULL_OUTCOMES_FILE" "$RUN_DIR/outcomes.jsonl"

PASS_COUNT="$(jq -s '[.[] | select(.status == "PASS")] | length' "$RUN_DIR/outcomes.jsonl")"
FAIL_COUNT="$(jq -s '[.[] | select(.status == "FAIL")] | length' "$RUN_DIR/outcomes.jsonl")"
TOTAL_COUNT="$(jq -s 'length' "$RUN_DIR/outcomes.jsonl")"
FAILED_IDS_JSON="$(build_failed_ids_json "$RUN_DIR/outcomes.jsonl")"

now_epoch="$(date -u +%s)"
ELAPSED_SECONDS="$((now_epoch - RUN_STARTED_EPOCH))"

jq -s --argjson ids "$FAILED_IDS_JSON" '
  map(select(.id as $id | $ids | index($id)))
  | map({id, title, reason})
' "$RUN_DIR/outcomes.jsonl" > "$RUN_DIR/unresolved.json"

jq -n \
  --arg runId "$RUN_ID" \
  --arg tool "$TOOL" \
  --arg status "$FINAL_STATUS" \
  --arg stopReason "$STOP_REASON" \
  --arg startedAt "$RUN_STARTED_AT" \
  --arg finishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg planPath "$PLAN_PATH" \
  --argjson total "$TOTAL_COUNT" \
  --argjson passed "$PASS_COUNT" \
  --argjson failed "$FAIL_COUNT" \
  --argjson maxLoops "$MAX_LOOPS" \
  --argjson loopsPerformed "$LOOPS_PERFORMED" \
  --argjson maxDurationSeconds "$MAX_DURATION" \
  --argjson elapsedSeconds "$ELAPSED_SECONDS" \
  --argjson maxPatchCount "$MAX_PATCH_COUNT" \
  --argjson patchAttempts "$PATCH_ATTEMPTS" \
  --argjson unresolved "$(cat "$RUN_DIR/unresolved.json")" \
  --argjson lastRootCauses "$LAST_ROOT_CAUSES_JSON" \
  '{
    runId: $runId,
    tool: $tool,
    status: $status,
    stopReason: $stopReason,
    planPath: $planPath,
    startedAt: $startedAt,
    finishedAt: $finishedAt,
    totals: {
      total: $total,
      passed: $passed,
      failed: $failed
    },
    remediation: {
      maxLoops: $maxLoops,
      loopsPerformed: $loopsPerformed,
      maxDurationSeconds: $maxDurationSeconds,
      elapsedSeconds: $elapsedSeconds,
      maxPatchCount: $maxPatchCount,
      patchAttempts: $patchAttempts,
      unresolved: $unresolved,
      lastRootCauses: $lastRootCauses
    }
  }' > "$RUN_DIR/summary.json"

echo "$FINAL_STATUS" > "$RUN_DIR/status.txt"

# --- Post-run: distill learnings and seed CLAUDE.md on successful run ---
if [[ "$FINAL_STATUS" == "PASS" ]]; then
  update_codebase_patterns
  seed_claude_md
fi

echo "QA loop run directory: $RUN_DIR"
echo "QA progress log: $PROGRESS_FILE"
echo "Machine-readable status: $FINAL_STATUS"

if [[ "$FINAL_STATUS" == "PASS" ]]; then
  exit 0
fi

exit 1
