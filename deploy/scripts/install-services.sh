#!/bin/bash
# install-services.sh — Install Claw Orchestrator systemd unit files
# Run as root or with sudo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SYSTEMD_DIR="${SCRIPT_DIR}/../systemd"
SYSTEMD_DEST="/etc/systemd/system"

# shellcheck source=deploy/scripts/runtime-env.sh
source "${SCRIPT_DIR}/runtime-env.sh"

install_unit() {
  local unit_name="$1"
  render_systemd_unit_file "${SYSTEMD_DIR}/${unit_name}" "${SYSTEMD_DEST}/${unit_name}" "${REPO_DIR}"
}

echo "Installing Claw Orchestrator systemd unit files..."

install_unit "claw-control-plane.service"
install_unit "claw-slack-relay.service"
install_unit "claw-scheduler.service"
install_unit "claw-backup.service"
cp "${SYSTEMD_DIR}/claw-backup.timer" "${SYSTEMD_DEST}/claw-backup.timer"

echo "Running systemctl daemon-reload..."
systemctl daemon-reload

echo "Enabling services and backup timer..."
systemctl enable claw-control-plane claw-slack-relay claw-scheduler
systemctl enable --now claw-backup.timer

echo "Done. Start services with:"
echo "  systemctl start claw-control-plane claw-slack-relay claw-scheduler"
