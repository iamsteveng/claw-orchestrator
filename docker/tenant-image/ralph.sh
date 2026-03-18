#!/bin/bash
# Ralph Wiggum - Long-running AI agent loop
# Usage: ./ralph.sh [--tool amp|claude|codex] [max_iterations]

set -e

# Parse arguments
TOOL="amp"  # Default to amp for backwards compatibility
MAX_ITERATIONS=10
CODEX_MODEL="${CODEX_MODEL:-gpt-5.3-codex}"
OPENCLAW_SESSION_KEY="${OPENCLAW_SESSION_KEY:-agent:main:main}"
OPENCLAW_SESSION_ID="${OPENCLAW_SESSION_ID:-}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --tool)
      TOOL="$2"
      shift 2
      ;;
    --tool=*)
      TOOL="${1#*=}"
      shift
      ;;
    *)
      # Assume it's max_iterations if it's a number
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        MAX_ITERATIONS="$1"
      fi
      shift
      ;;
  esac
done

# Validate tool choice
if [[ "$TOOL" != "amp" && "$TOOL" != "claude" && "$TOOL" != "codex" ]]; then
  echo "Error: Invalid tool '$TOOL'. Must be 'amp', 'claude', or 'codex'."
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(pwd)"
LOGS_DIR="$WORKSPACE_DIR/logs"
PRD_FILE="$SCRIPT_DIR/prd.json"
PROGRESS_FILE="$SCRIPT_DIR/progress.txt"
ARCHIVE_DIR="$SCRIPT_DIR/archive"
LAST_BRANCH_FILE="$SCRIPT_DIR/.last-branch"

# Archive previous run if branch changed
if [ -f "$PRD_FILE" ] && [ -f "$LAST_BRANCH_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  LAST_BRANCH=$(cat "$LAST_BRANCH_FILE" 2>/dev/null || echo "")
  
  if [ -n "$CURRENT_BRANCH" ] && [ -n "$LAST_BRANCH" ] && [ "$CURRENT_BRANCH" != "$LAST_BRANCH" ]; then
    # Archive the previous run
    DATE=$(date +%Y-%m-%d)
    # Strip "ralph/" prefix from branch name for folder
    FOLDER_NAME=$(echo "$LAST_BRANCH" | sed 's|^ralph/||')
    ARCHIVE_FOLDER="$ARCHIVE_DIR/$DATE-$FOLDER_NAME"
    
    echo "Archiving previous run: $LAST_BRANCH"
    mkdir -p "$ARCHIVE_FOLDER"
    [ -f "$PRD_FILE" ] && cp "$PRD_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$PROGRESS_FILE" ] && cp "$PROGRESS_FILE" "$ARCHIVE_FOLDER/"
    echo "   Archived to: $ARCHIVE_FOLDER"
    
    # Reset progress file for new run
    echo "# Ralph Progress Log" > "$PROGRESS_FILE"
    echo "Started: $(date)" >> "$PROGRESS_FILE"
    echo "---" >> "$PROGRESS_FILE"
  fi
fi

# Track current branch
if [ -f "$PRD_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  if [ -n "$CURRENT_BRANCH" ]; then
    echo "$CURRENT_BRANCH" > "$LAST_BRANCH_FILE"
  fi
fi

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
  echo "# Ralph Progress Log" > "$PROGRESS_FILE"
  echo "Started: $(date)" >> "$PROGRESS_FILE"
  echo "---" >> "$PROGRESS_FILE"
fi

mkdir -p "$LOGS_DIR"

echo "Starting Ralph - Tool: $TOOL - Max iterations: $MAX_ITERATIONS"
echo "Workspace logs: $LOGS_DIR"

extract_story_id_from_text() {
  local text="$1"
  echo "$text" | grep -Eo 'US-[0-9]+' | head -n 1 || true
}

extract_story_title_from_prd() {
  local story_id="$1"
  jq -r --arg story_id "$story_id" '.userStories[] | select(.id == $story_id) | .title' "$PRD_FILE" 2>/dev/null | head -n 1 || true
}

extract_story_id_from_progress() {
  if [ -f "$PROGRESS_FILE" ]; then
    grep -Eo 'US-[0-9]+' "$PROGRESS_FILE" | tail -n 1 || true
  fi
}

extract_summary_text() {
  local text="$1"
  local one_line
  one_line=$(echo "$text" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')
  if [ -z "$one_line" ]; then
    echo "No summary provided."
  else
    echo "$one_line" | cut -c1-220
  fi
}

infer_iteration_result() {
  local text="$1"
  local tool_exit_status="$2"
  local commit_hash="$3"

  # A real commit means the iteration made forward progress.
  if [ "$commit_hash" != "none" ]; then
    echo "completed"
    return
  fi

  if [ "$tool_exit_status" -ne 0 ] || echo "$text" | grep -qiE '\b(failed|failure|exception|traceback|fatal error)\b'; then
    echo "failed"
    return
  fi

  # Avoid false positives from domain text like "user blocked" in app behavior descriptions.
  if echo "$text" | grep -qiE '\b(cannot proceed|needs? user input|waiting on|requires decision|blocked by)\b'; then
    echo "blocked"
    return
  fi

  echo "no-op"
}

resolve_main_session_id() {
  if [ -n "$OPENCLAW_SESSION_ID" ]; then
    echo "$OPENCLAW_SESSION_ID"
    return
  fi

  if ! command -v openclaw >/dev/null 2>&1; then
    return
  fi

  OPENCLAW_SESSION_ID="$(openclaw sessions --json 2>/dev/null | jq -r --arg key "$OPENCLAW_SESSION_KEY" '
    .sessions
    | ((map(select(.key == $key))[0]) // (sort_by(.updatedAt) | reverse | .[0]))
    | .sessionId // empty
  ')"
  echo "$OPENCLAW_SESSION_ID"
}

format_iteration_update_message() {
  local iteration="$1"
  local max_iterations="$2"
  local story_id="$3"
  local story_title="$4"
  local result="$5"
  local commit="$6"
  local summary="$7"

  printf 'Iteration %s/%s\nStory: %s - %s\nResult: %s\nCommit: %s\nSummary: %s' \
    "$iteration" "$max_iterations" "$story_id" "$story_title" "$result" "$commit" "$summary"
}

send_iteration_update() {
  local message="$1"
  local session_id

  session_id="$(resolve_main_session_id)"
  if [ -z "$session_id" ]; then
    return
  fi

  # Fire-and-forget to avoid deadlocking when Ralph is invoked from an active agent turn.
  (openclaw agent --session-id "$session_id" --message "$message" --timeout 90 >/dev/null 2>&1 &) || true
}

for i in $(seq 1 $MAX_ITERATIONS); do
  echo ""
  echo "==============================================================="
  echo "  Ralph Iteration $i of $MAX_ITERATIONS ($TOOL)"
  echo "==============================================================="

  ITERATION_START_HEAD="$(git rev-parse HEAD 2>/dev/null || true)"
  TARGET_STORY_ID="$(jq -r '.userStories | map(select(.passes == false)) | sort_by(.priority) | .[0].id // "unknown"' "$PRD_FILE" 2>/dev/null || echo "unknown")"
  TARGET_STORY_TITLE="$(jq -r '.userStories | map(select(.passes == false)) | sort_by(.priority) | .[0].title // "unknown"' "$PRD_FILE" 2>/dev/null || echo "unknown")"
  TOOL_EXIT_STATUS=0
  ATTEMPT_NUMBER=1
  ATTEMPT_RESULT="failed"
  ITERATION_MSG=""
  OUTPUT=""

  while true; do
    # Run the selected tool with the ralph prompt
    if [[ "$TOOL" == "amp" ]]; then
      set +e
      OUTPUT=$(cat "$SCRIPT_DIR/prompt.md" | amp --dangerously-allow-all 2>&1 | tee /dev/stderr)
      TOOL_EXIT_STATUS=$?
      set -e
    elif [[ "$TOOL" == "claude" ]]; then
      # Claude Code: use --dangerously-skip-permissions for autonomous operation, --print for output
      set +e
      OUTPUT=$(claude --dangerously-skip-permissions --print < "$SCRIPT_DIR/CLAUDE.md" 2>&1)
      TOOL_EXIT_STATUS=$?
      set -e
    else
      # Codex CLI: run non-interactive with full permissions and emit JSONL logs per iteration
      ITER_JSONL="$LOGS_DIR/codex-iteration-$i.jsonl"
      ITER_LAST_MSG="$LOGS_DIR/codex-iteration-$i-last-message.txt"
      ITER_STDERR="$LOGS_DIR/codex-iteration-$i-stderr.log"

      set +e
      codex exec \
        --model "$CODEX_MODEL" \
        --dangerously-bypass-approvals-and-sandbox \
        --json \
        --output-last-message "$ITER_LAST_MSG" \
        "$(cat "$SCRIPT_DIR/prompt.md")" \
        > "$ITER_JSONL" \
        2> >(tee /dev/stderr "$ITER_STDERR")
      TOOL_EXIT_STATUS=$?
      set -e

      OUTPUT="$(cat "$ITER_LAST_MSG" 2>/dev/null || true)"
      echo "Codex logs written: $ITER_JSONL"
      echo "Codex last message: $ITER_LAST_MSG"
      echo "Codex stderr log: $ITER_STDERR"
    fi

    ITERATION_MSG="$OUTPUT"
    if [ -f "$LOGS_DIR/codex-iteration-$i-last-message.txt" ]; then
      ITERATION_MSG="$(cat "$LOGS_DIR/codex-iteration-$i-last-message.txt")"
    fi
    ATTEMPT_RESULT="$(infer_iteration_result "$ITERATION_MSG" "$TOOL_EXIT_STATUS" "none")"

    if [ "$ATTEMPT_RESULT" = "failed" ] && [ "$ATTEMPT_NUMBER" -eq 1 ]; then
      echo "Iteration $i failed on attempt 1. Retrying once..."
      ATTEMPT_NUMBER=2
      continue
    fi
    break
  done

  ITERATION_END_HEAD="$(git rev-parse HEAD 2>/dev/null || true)"
  ITERATION_COMMIT="none"
  if [ -n "$ITERATION_START_HEAD" ] && [ -n "$ITERATION_END_HEAD" ] && [ "$ITERATION_START_HEAD" != "$ITERATION_END_HEAD" ]; then
    ITERATION_COMMIT="$(git rev-parse --short "$ITERATION_END_HEAD")"
  fi

  STORY_ID="$TARGET_STORY_ID"
  STORY_TITLE="$TARGET_STORY_TITLE"
  if [ "$ITERATION_COMMIT" != "none" ]; then
    LAST_COMMIT_SUBJECT="$(git log -1 --format=%s "$ITERATION_END_HEAD" 2>/dev/null || true)"
    if echo "$LAST_COMMIT_SUBJECT" | grep -qE '^feat: \[US-[0-9]+\] - .+'; then
      STORY_ID="$(echo "$LAST_COMMIT_SUBJECT" | sed -nE 's/^feat: \[(US-[0-9]+)\] - .+/\1/p')"
      STORY_TITLE="$(echo "$LAST_COMMIT_SUBJECT" | sed -nE 's/^feat: \[US-[0-9]+\] - (.+)$/\1/p')"
    fi
  fi

  if [ -z "$STORY_ID" ] || [ "$STORY_ID" = "unknown" ]; then
    STORY_ID="$(extract_story_id_from_text "$ITERATION_MSG")"
  fi
  if [ -z "$STORY_ID" ]; then
    STORY_ID="$(extract_story_id_from_progress)"
  fi
  if [ -z "$STORY_ID" ]; then
    STORY_ID="unknown"
  fi
  if [ -z "$STORY_TITLE" ] || [ "$STORY_TITLE" = "unknown" ]; then
    STORY_TITLE="$(extract_story_title_from_prd "$STORY_ID")"
  fi
  if [ -z "$STORY_TITLE" ] || [ "$STORY_TITLE" = "null" ]; then
    STORY_TITLE="unknown"
  fi

  ITERATION_RESULT="$(infer_iteration_result "$ITERATION_MSG" "$TOOL_EXIT_STATUS" "$ITERATION_COMMIT")"
  if [ "$ATTEMPT_NUMBER" -eq 2 ]; then
    if [ "$ITERATION_RESULT" = "failed" ]; then
      ITERATION_RESULT="failed (terminal after retry)"
    else
      ITERATION_RESULT="$ITERATION_RESULT (after retry)"
    fi
  fi
  ITERATION_SUMMARY="$(extract_summary_text "$ITERATION_MSG")"
  ITERATION_SUMMARY_FILE="$LOGS_DIR/codex-iteration-$i-summary.txt"
  {
    echo "Iteration: $i/$MAX_ITERATIONS"
    echo "Story: $STORY_ID - $STORY_TITLE"
    echo "Result: $ITERATION_RESULT"
    echo "Commit: $ITERATION_COMMIT"
    echo "Summary: $ITERATION_SUMMARY"
  } > "$ITERATION_SUMMARY_FILE"
  echo "Iteration summary written: $ITERATION_SUMMARY_FILE"

  ITERATION_UPDATE_MESSAGE="$(format_iteration_update_message "$i" "$MAX_ITERATIONS" "$STORY_ID" "$STORY_TITLE" "$ITERATION_RESULT" "$ITERATION_COMMIT" "$ITERATION_SUMMARY")"
  send_iteration_update "$ITERATION_UPDATE_MESSAGE"

  if [ "$ITERATION_RESULT" = "blocked" ] || [ "$ITERATION_RESULT" = "blocked (after retry)" ]; then
    echo ""
    echo "Iteration $i is blocked. Stopping and waiting for user decision."
    exit 1
  fi

  if [ "$ITERATION_RESULT" = "failed (terminal after retry)" ]; then
    echo ""
    echo "Iteration $i failed twice. Stopping with terminal failure."
    exit 1
  fi
  
  # Check for completion signal
  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo ""
    echo "Ralph completed all tasks!"
    echo "Completed at iteration $i of $MAX_ITERATIONS"
    exit 0
  fi
  
  echo "Iteration $i complete. Continuing..."
  sleep 2
done

echo ""
echo "Ralph reached max iterations ($MAX_ITERATIONS) without completing all tasks."
echo "Check $PROGRESS_FILE for status."
exit 1
