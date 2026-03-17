---
name: ralph-codex-loop
description: Run the Ralph agentic development loop with OpenAI Codex CLI. Use when the user asks to run iterative PRD-driven autonomous development via ralph.sh, monitor loop iterations, inspect logs in logs/, or troubleshoot Codex loop execution. Requires explicit RALPH_PATH configuration before execution.
---

# Ralph Codex Loop

Require an explicit script path before running.

## Required config

Set `RALPH_PATH` to the absolute path of `ralph.sh`.

Current configured path on this machine:

```bash
export RALPH_PATH="/home/ec2-user/.openclaw/workspace/ralph/ralph.sh"
```

Validate:

```bash
test -x "$RALPH_PATH"
```

If validation fails, stop and report the missing path.

## Run loop

From the target project workspace:

```bash
CODEX_MODEL="gpt-5.3-codex" "$RALPH_PATH" --tool codex <max_iterations>
```

## Logs and outputs

Ralph writes Codex artifacts under `logs/` in the current working directory:

- `logs/codex-iteration-<n>.jsonl`
- `logs/codex-iteration-<n>-last-message.txt`
- `logs/codex-iteration-<n>-stderr.log`

## Monitoring checklist

1. Confirm `prd.json` exists in Ralph script directory.
2. Run loop with a bounded iteration count.
3. After run, summarize:
   - iteration reached
   - whether `<promise>COMPLETE</promise>` was emitted
   - latest changed files / commit status
   - any stderr errors from latest iteration log

## Safety

Codex is executed with `--dangerously-bypass-approvals-and-sandbox` by Ralph. Call this out before long runs or unfamiliar repos.
