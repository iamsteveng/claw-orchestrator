#!/bin/bash
# install-services.sh — Install Claw Orchestrator systemd unit files
# Run as root or with sudo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DIR="${SCRIPT_DIR}/../systemd"
SYSTEMD_DEST="/etc/systemd/system"

echo "Installing Claw Orchestrator systemd unit files..."

cp "${SYSTEMD_DIR}/claw-control-plane.service" "${SYSTEMD_DEST}/"
cp "${SYSTEMD_DIR}/claw-slack-relay.service" "${SYSTEMD_DEST}/"
cp "${SYSTEMD_DIR}/claw-scheduler.service" "${SYSTEMD_DEST}/"

echo "Running systemctl daemon-reload..."
systemctl daemon-reload

echo "Enabling all three services..."
systemctl enable claw-control-plane claw-slack-relay claw-scheduler

echo "Done. Start services with:"
echo "  systemctl start claw-control-plane claw-slack-relay claw-scheduler"
