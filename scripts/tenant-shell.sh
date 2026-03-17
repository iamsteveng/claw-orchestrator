#!/bin/bash
# tenant-shell.sh — Open an interactive bash shell in a tenant container
# Usage: scripts/tenant-shell.sh <tenant_id>

set -euo pipefail

TENANT_ID="${1:-}"

if [ -z "${TENANT_ID}" ]; then
  echo "Usage: $0 <tenant_id>" >&2
  echo "Example: $0 a1b2c3d4e5f6a7b8" >&2
  exit 1
fi

CONTAINER="claw-tenant-${TENANT_ID}"

# Validate that the container is running
STATUS="$(docker inspect --format='{{.State.Status}}' "${CONTAINER}" 2>/dev/null || echo "not_found")"

if [ "${STATUS}" = "not_found" ]; then
  echo "Error: Container '${CONTAINER}' not found." >&2
  echo "Is tenant '${TENANT_ID}' provisioned?" >&2
  exit 1
fi

if [ "${STATUS}" != "running" ]; then
  echo "Error: Container '${CONTAINER}' is not running (status: ${STATUS})." >&2
  echo "Start the tenant first via: POST /v1/tenants/${TENANT_ID}/start" >&2
  exit 1
fi

echo "Opening shell in ${CONTAINER}..."
exec docker exec -it --user agent "${CONTAINER}" /bin/bash
