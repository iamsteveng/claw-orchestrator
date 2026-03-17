#!/bin/bash
# Syncs Ralph skills from the ralph repo into the tenant Docker image build context.
# Run this when ralph skills are updated: bash scripts/update-ralph-skills.sh /path/to/ralph
set -euo pipefail

RALPH_REPO="${1:-../ralph}"
SKILLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docker/tenant-image/skills"
SKILLS=("prd" "ralph" "ralph-codex-loop" "qa-plan-generator" "qa-plan-json" "qa-codex-loop")

if [ ! -d "$RALPH_REPO/skills" ]; then
  echo "Error: ralph skills directory not found at $RALPH_REPO/skills"
  exit 1
fi

mkdir -p "$SKILLS_DIR"
for skill in "${SKILLS[@]}"; do
  echo "Syncing $skill..."
  rm -rf "$SKILLS_DIR/$skill"
  cp -r "$RALPH_REPO/skills/$skill" "$SKILLS_DIR/$skill"
done
echo "Done. ${#SKILLS[@]} skills synced to $SKILLS_DIR"
