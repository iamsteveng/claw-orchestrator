#!/bin/bash
# setup-dirs.sh — Create required host directories and system user for Claw Orchestrator
# Run as root.

set -euo pipefail

# Create the 'claw' system user if it does not exist
if ! id -u claw &>/dev/null; then
  echo "Creating 'claw' system user..."
  useradd --system --no-create-home --shell /usr/sbin/nologin claw
else
  echo "'claw' user already exists."
fi

# Add ubuntu to the claw group so it can read claw-owned files (e.g. the SQLite DB).
# Writes still require sudo -u claw since the DB is 640.
if id -u ubuntu &>/dev/null; then
  usermod -aG claw ubuntu
fi

# Create required directories with correct ownership
echo "Creating required directories..."

install -d -o claw -g claw -m 0755 /data/claw-orchestrator
# /data/tenants is written by the control-plane service (runs as ubuntu) and
# by the ubuntu shell user during validation — own by ubuntu, not claw.
install -d -o ubuntu -g ubuntu -m 0755 /data/tenants
# Repair any prior ownership set to claw or root
chown ubuntu:ubuntu /data/tenants
install -d -o claw -g claw -m 0755 /data/tenants-archive
install -d -o claw -g claw -m 0755 /data/backups
install -d -o claw -g claw -m 0755 /data/audit-archive
install -d -o claw -g claw -m 0755 /opt/claw-orchestrator

echo "Done. Directory layout:"
ls -la /data/ /opt/ | grep -E "claw|tenants|backups|audit"
