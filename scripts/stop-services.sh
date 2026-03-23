#!/bin/bash
# stop-services.sh — Stop all claw-orchestrator systemd user services
# Usage: bash scripts/stop-services.sh

set -euo pipefail

echo "=== Stopping claw-orchestrator services ==="
systemctl --user stop claw-control-plane claw-slack-relay claw-scheduler

echo "  All services stopped."
