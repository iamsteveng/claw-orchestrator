import type { PrismaClient } from '@prisma/client';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

export type RollbackLog = {
  warn: (ctx: object, msg: string) => void;
  error: (ctx: object, msg: string) => void;
};

/**
 * Rolls back a failed tenant provisioning attempt:
 * 1. Sets tenant status=FAILED, error_message, increments provision_attempts
 * 2. Removes /data/tenants/<id>/ directory tree (best-effort)
 * 3. Calls dockerRm('claw-tenant-<id>') to remove Docker container (best-effort, ignores not-found)
 * 4. Writes TENANT_PROVISION_FAILED audit event
 *
 * Safe to call multiple times (idempotent on directory removal).
 */
export async function rollbackProvisioning(
  prisma: PrismaClient,
  tenantId: string,
  dataDir: string,
  error: Error,
  log: RollbackLog,
): Promise<void> {
  const containerName = `claw-tenant-${tenantId}`;
  const now = Date.now();

  // 1. Update DB: FAILED + increment provision_attempts
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      status: TenantStatus.FAILED,
      error_message: error.message,
      provision_attempts: { increment: 1 },
      updated_at: now,
    },
  });

  // 2. Remove tenant data directory (best-effort)
  try {
    await rm(dataDir, { recursive: true, force: true });
  } catch (rmErr) {
    log.warn({ tenantId, rmErr }, 'rollbackProvisioning: failed to remove data directory');
  }

  // 3. Remove Docker container (best-effort; ignore not-found)
  try {
    const { DockerClient } = await import('@claw/docker-client');
    await DockerClient.rm(containerName);
  } catch (dockerErr) {
    log.warn({ tenantId, dockerErr }, 'rollbackProvisioning: dockerRm failed (may not exist)');
  }

  // 4. Write TENANT_PROVISION_FAILED audit event
  await prisma.auditLog.create({
    data: {
      id: randomUUID(),
      tenant_id: tenantId,
      event_type: AuditEventType.TENANT_PROVISION_FAILED,
      actor: 'system',
      metadata: JSON.stringify({ error: error.message, containerName }),
      created_at: now,
    },
  });
}
