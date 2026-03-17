#!/bin/bash
# backup.sh — Daily backup procedure for Claw Orchestrator
# Implements the backup procedure from §29 of SPEC.md.
# Run as root or the claw user (needs read access to /data/).
# Optional: set S3_BUCKET env var to enable S3 sync (e.g. S3_BUCKET=my-bucket).

set -euo pipefail

DB_PATH="/data/claw-orchestrator/db.sqlite"
BACKUP_DIR="/data/backups/$(date +%Y-%m-%d)"

echo "[backup] Starting backup at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# 1. Checkpoint SQLite WAL to ensure all data is flushed
echo "[backup] Checkpointing SQLite WAL..."
sqlite3 "${DB_PATH}" ".checkpoint FULL"

# 2. Create dated snapshot directory
echo "[backup] Creating snapshot directory: ${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"

# 3. Copy the SQLite database
echo "[backup] Copying database..."
cp "${DB_PATH}" "${BACKUP_DIR}/db.sqlite"

# 4. Tar+gzip tenant data, excluding large cache directories
echo "[backup] Archiving tenant data..."
tar -czf "${BACKUP_DIR}/tenants.tar.gz" \
  --exclude='*/cache/*' \
  --exclude='*/.cache/*' \
  /data/tenants/

# 5. Upload to S3 if configured
if [ -n "${S3_BUCKET:-}" ]; then
  echo "[backup] Syncing to S3: s3://${S3_BUCKET}/claw-backups/$(date +%Y-%m-%d)/"
  aws s3 sync "${BACKUP_DIR}" "s3://${S3_BUCKET}/claw-backups/$(date +%Y-%m-%d)/"
else
  echo "[backup] S3_BUCKET not set — skipping S3 sync."
fi

echo "[backup] Backup complete: ${BACKUP_DIR}"
