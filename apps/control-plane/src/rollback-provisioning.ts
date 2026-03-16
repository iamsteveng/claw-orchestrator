import type { PrismaClient } from '@prisma/client';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { rm } from 'node:fs/promises';

/**
 * Rolls back a failed provisioning attempt.
 * - Sets tenant status to FAILED with error_message
 * - Increments provision_attempts
 * - Removes the tenant data directory (best-effort)
 * - Removes the Docker container (best-effort, ignores not-found errors)
 * - Writes TENANT_PROVISION_FAILED audit event
 */
export async function rollbackProvisioning(
  prisma: PrismaClient,
  tenantId: string,
  dataDir: string,
  error: Error | unknown,
  rmContainer?: (name: string) => Promise<void>,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const containerName = `claw-tenant-${tenantId}`;
  const now = Date.now();

  // Update tenant to FAILED
  try {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        status: TenantStatus.FAILED,
        error_message: errorMessage,
        provision_attempts: { increment: 1 },
        updated_at: now,
      },
    });
  } catch {
    // best-effort
  }

  // Remove data directory
  try {
    await rm(dataDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }

  // Remove container (ignore not-found errors)
  try {
    if (rmContainer) {
      await rmContainer(containerName);
    } else {
      const { DockerClient } = await import('@claw/docker-client');
      await DockerClient.rm(containerName);
    }
  } catch {
    // Container may not exist — ignore
  }

  // Write audit event
  try {
    await prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        event_type: AuditEventType.TENANT_PROVISION_FAILED,
        actor: 'system',
        metadata: JSON.stringify({ error: errorMessage }),
        created_at: now,
      },
    });
  } catch {
    // best-effort
  }
}
