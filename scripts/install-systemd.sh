#!/bin/bash
# install-systemd.sh — Install claw-orchestrator as systemd user services
# Usage: bash scripts/install-systemd.sh
#
# This script:
#   1. Kills any existing zombie/orphan node processes
#   2. Copies service files to ~/.config/systemd/user/
#   3. Copies the env file
#   4. Enables linger for the ubuntu user
#   5. Reloads systemd daemon
#   6. Enables and starts all 3 services

set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SERVICE_SRC="$BASE/deploy/systemd"

echo "=== Killing any existing zombie/orphan node processes ==="
pkill -9 -f "apps/control-plane/dist" 2>/dev/null && echo "  Killed control-plane processes" || true
pkill -9 -f "apps/slack-relay/dist" 2>/dev/null && echo "  Killed slack-relay processes" || true
pkill -9 -f "apps/scheduler/dist" 2>/dev/null && echo "  Killed scheduler processes" || true
for port in 3200 3101; do
  PID=$(ss -tlnp "sport = $port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1)
  if [ -n "$PID" ]; then
    kill -9 "$PID" 2>/dev/null && echo "  Killed PID $PID on port $port" || true
  fi
done
sleep 1

echo "=== Installing systemd user service files ==="
mkdir -p "$SYSTEMD_USER_DIR"

for svc in claw-control-plane claw-slack-relay claw-scheduler; do
  cp "$SERVICE_SRC/${svc}.service" "$SYSTEMD_USER_DIR/${svc}.service"
  echo "  Installed ${svc}.service"
done

echo "=== Installing environment file ==="
# Copy env template and merge real secrets from .env if present
cp "$SERVICE_SRC/claw-orchestrator.env" "$SYSTEMD_USER_DIR/claw-orchestrator.env"
if [ -f "$BASE/.env" ]; then
  # Patch in real SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN from .env
  SLACK_SECRET=$(grep -E '^SLACK_SIGNING_SECRET=' "$BASE/.env" | cut -d= -f2- | head -1)
  SLACK_TOKEN=$(grep -E '^SLACK_BOT_TOKEN=' "$BASE/.env" | cut -d= -f2- | head -1)
  if [ -n "$SLACK_SECRET" ]; then
    sed -i "s|^SLACK_SIGNING_SECRET=.*|SLACK_SIGNING_SECRET=$SLACK_SECRET|" "$SYSTEMD_USER_DIR/claw-orchestrator.env"
    echo "  Patched SLACK_SIGNING_SECRET from .env"
  fi
  if [ -n "$SLACK_TOKEN" ]; then
    sed -i "s|^SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=$SLACK_TOKEN|" "$SYSTEMD_USER_DIR/claw-orchestrator.env"
    echo "  Patched SLACK_BOT_TOKEN from .env"
  fi
fi

# Update service files to point to the user-dir env file
for svc in claw-control-plane claw-slack-relay claw-scheduler; do
  sed -i "s|EnvironmentFile=.*|EnvironmentFile=$SYSTEMD_USER_DIR/claw-orchestrator.env|" \
    "$SYSTEMD_USER_DIR/${svc}.service"
done

echo "=== Enabling linger for $USER ==="
loginctl enable-linger "$USER"

echo "=== Reloading systemd user daemon ==="
systemctl --user daemon-reload

echo "=== Enabling and starting services ==="
for svc in claw-control-plane claw-slack-relay claw-scheduler; do
  systemctl --user enable "$svc"
  systemctl --user start "$svc"
  echo "  Started $svc"
done

echo ""
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

echo ""
echo "Installation complete. Use 'systemctl --user status claw-*' to check service status."
