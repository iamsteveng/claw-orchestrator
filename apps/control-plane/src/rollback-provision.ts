import type { PrismaClient } from '@prisma/client';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

/**
 * Rolls back a failed tenant provisioning attempt:
 * 1. Removes /data/tenants/<id>/ directory tree (best-effort)
 * 2. Calls dockerRm('claw-tenant-<id>') if container exists (ignores not-found errors)
 * 3. Increments provision_attempts; sets status=FAILED with error_message
 * 4. Writes TENANT_PROVISION_FAILED audit event
 *
 * Safe to call multiple times (idempotent on the directory removal).
 */
export async function rollbackProvisioning(
  prisma: PrismaClient,
  tenantId: string,
  dataDir: string,
  error: Error,
): Promise<void> {
  const containerName = `claw-tenant-${tenantId}`;

  // Remove tenant data directory
  try {
    await rm(dataDir, { recursive: true, force: true });
  } catch {
    // best-effort; if directory doesn't exist, that's fine
  }

  // Remove container if it exists (ignore not-found)
  try {
    const { DockerClient } = await import('@claw/docker-client');
    await DockerClient.rm(containerName);
  } catch {
    // Container might not exist yet; ignore
  }

  const now = Date.now();

  // Update tenant status
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      status: TenantStatus.FAILED,
      error_message: error.message,
      provision_attempts: { increment: 1 },
      updated_at: now,
    },
  });

  // Write audit event
  await prisma.auditLog.create({
    data: {
      id: randomUUID(),
      tenant_id: tenantId,
      event_type: AuditEventType.TENANT_PROVISION_FAILED,
      actor: 'control-plane',
      metadata: JSON.stringify({ error: error.message, containerName }),
      created_at: now,
    },
  });
}
