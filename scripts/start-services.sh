#!/bin/bash
# start-services.sh — Start all claw-orchestrator systemd user services
# Usage: bash scripts/start-services.sh
#
# Requires services to be installed first via scripts/install-systemd.sh

set -euo pipefail

echo "=== Starting claw-orchestrator services ==="
systemctl --user start claw-control-plane claw-slack-relay claw-scheduler

echo "=== Verifying services ==="
sleep 3
for svc in claw-control-plane claw-slack-relay claw-scheduler; do
  STATUS=$(systemctl --user is-active "$svc" 2>/dev/null || echo "unknown")
  echo "  $svc: $STATUS"
done

echo ""
echo "=== Health checks ==="
sleep 2
if curl -sf "http://localhost:3200/health" | grep -q ok; then
  echo "  ✅ Control plane http://localhost:3200/health → ok"
else
  echo "  ⚠️  Control plane not responding yet (check: systemctl --user status claw-control-plane)"
fi
if curl -sf "http://localhost:3101/health" | grep -q ok; then
  echo "  ✅ Slack relay http://localhost:3101/health → ok"
else
  echo "  ⚠️  Slack relay not responding yet (check: systemctl --user status claw-slack-relay)"
fi
