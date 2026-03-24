#!/bin/bash
# audit.sh — Check for stale code, data, containers, or images on the EC2 host
# Run from /opt/claw-orchestrator

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.test.yml"
HEAD_SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
ISSUES=0

echo "=== Claw Orchestrator Audit ==="
echo "Git HEAD: $HEAD_SHA ($(git -C "$REPO_ROOT" log --oneline -1))"
echo ""

echo "--- Stack containers ---"
docker compose -f "$COMPOSE_FILE" ps 2>/dev/null || echo "Stack not running"
echo ""

echo "--- Image freshness (vs git HEAD: $HEAD_SHA) ---"
for img in claw-control-plane:test claw-slack-relay:test claw-scheduler:test; do
  label=$(docker inspect "$img" --format "{{index .Config.Labels \"org.opencontainers.image.version\"}}" 2>/dev/null || echo "missing")
  created=$(docker inspect "$img" --format "{{.Created}}" 2>/dev/null | cut -c1-19 || echo "not found")
  echo "  $img | label=$label | built=$created"
done
tenant_sha=$(docker inspect claw-tenant:latest --format "{{index .Config.Labels \"org.opencontainers.image.version\"}}" 2>/dev/null || echo "missing")
echo "  claw-tenant:latest | label=$tenant_sha"
if [[ "$tenant_sha" != "sha-$HEAD_SHA" ]]; then
  echo "  ⚠️  STALE: claw-tenant:latest label=$tenant_sha, HEAD=sha-$HEAD_SHA — rebuild needed"
  ISSUES=$((ISSUES+1))
fi
echo ""

echo "--- Stale tenant containers ---"
stale=$(docker ps -a --filter "name=claw-tenant" --format "{{.Names}}\t{{.Status}}" 2>/dev/null)
if [ -n "$stale" ]; then
  echo "$stale"
  echo "  ⚠️  STALE containers found"
  ISSUES=$((ISSUES+1))
else
  echo "  ✓ None"
fi
echo ""

echo "--- Orphan volumes ---"
vols=$(docker volume ls -q 2>/dev/null)
if [ -n "$vols" ]; then
  echo "$vols"
  echo "  ⚠️  Volumes found (may be stale named volumes)"
  ISSUES=$((ISSUES+1))
else
  echo "  ✓ None"
fi
echo ""

echo "--- /data/tenants ---"
ls -la /data/tenants/ 2>/dev/null || echo "  /data/tenants not found"
echo ""

echo "--- DB state ---"
docker exec claw-cp-test node -e "
const { PrismaClient } = require('/app/node_modules/@prisma/client');
const p = new PrismaClient({ datasourceUrl: 'file:/data/tenants/orchestrator.db' });
Promise.all([p.tenant.count(), p.allowlist.count(), p.tenant.findMany({where:{status:{in:['STARTING','FAILED','PROVISIONING']}}})]).then(([tc, ac, stuck]) => {
  console.log('  Tenants:', tc, '| Allowlist:', ac);
  stuck.forEach(t => console.log('  ⚠️  STUCK tenant:', t.id, t.status));
  if (stuck.length > 0) process.exitCode = 1;
  return p.\$disconnect();
});
" 2>/dev/null
echo ""

echo "--- CONTAINER_NETWORK in running CP ---"
docker exec claw-cp-test env 2>/dev/null | grep -E "CONTAINER_NETWORK|HOST_DATA_DIR|DATA_DIR" | sed 's/^/  /'
echo ""

echo "--- Git status on host ---"
git -C "$REPO_ROOT" status --short | sed 's/^/  /' || true
echo ""

if [ "$ISSUES" -eq 0 ]; then
  echo "✅ All clear — no stale items found"
else
  echo "⚠️  Found $ISSUES issue(s) — review above"
fi
