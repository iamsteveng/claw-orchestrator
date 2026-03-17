#!/bin/bash
# update.sh — Update Claw Orchestrator to the latest version
# Run as the claw user (or with sudo -u claw) from /opt/claw-orchestrator.
# Requires root for systemctl restart (or configure sudo for the claw user).

set -euo pipefail

DEPLOY_DIR="/opt/claw-orchestrator"

echo "Pulling latest changes..."
cd "${DEPLOY_DIR}"
git pull

echo "Installing dependencies..."
pnpm install --frozen-lockfile

echo "Building all packages and apps..."
pnpm build

echo "Running database migrations..."
DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" \
  npx prisma migrate deploy

echo "Restarting services..."
systemctl restart claw-control-plane claw-slack-relay claw-scheduler

echo "Update complete."
