#!/bin/bash
# stop-services.sh — Stop all claw-orchestrator systemd services
# Usage: bash scripts/stop-services.sh

set -euo pipefail

echo "=== Stopping claw-orchestrator services ==="
systemctl stop claw-scheduler claw-slack-relay claw-control-plane

echo "  All services stopped."
