import type { PrismaClient } from '@prisma/client';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { seedDefaultImage } from './container-image.js';

export type ReconcileLog = {
  info: (msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
};

/** Minimal docker client interface needed for reconciliation */
type ReconcileDockerClient = {
  inspect: (containerName: string) => Promise<{
    State?: { Running?: boolean };
  } | null>;
};

/**
 * Startup reconciliation — runs once at control-plane boot.
 *
 * Restores consistent DB state after a crash or unclean shutdown:
 * 1. Deletes expired startup_locks
 * 2. Resets PROCESSING messages stuck > 2 minutes → PENDING
 * 3. Marks PROVISIONING/STARTING tenants → FAILED
 * 4. Writes SYSTEM_STARTUP audit event
 * 5. Seeds default container image if absent
 */
export async function reconcile(
  prisma: PrismaClient,
  log: ReconcileLog,
  dockerClient?: ReconcileDockerClient,
): Promise<void> {
  const now = Date.now();
  const twoMinutesAgo = now - 2 * 60 * 1000;

  // Delete expired startup locks
  await prisma.startupLock.deleteMany({
    where: { expires_at: { lt: now } },
  });

  // Reset PROCESSING messages stuck for > 2 minutes
  await prisma.messageQueue.updateMany({
    where: {
      status: 'PROCESSING',
      updated_at: { lt: twoMinutesAgo },
    },
    data: { status: 'PENDING', updated_at: now },
  });

  // Always fail PROVISIONING tenants (no container was started for them)
  await prisma.tenant.updateMany({
    where: { status: TenantStatus.PROVISIONING },
    data: {
      status: TenantStatus.FAILED,
      error_message: 'Process crashed during startup',
      updated_at: now,
    },
  });

  // For STARTING tenants: check if their container is still running.
  // If running, leave them as STARTING so the caller can resume health polling.
  // If not running (or no docker client provided), mark them FAILED.
  const startingTenants = await prisma.tenant.findMany({
    where: { status: TenantStatus.STARTING },
    select: { id: true, container_name: true },
  });

  const tenantsToFail: string[] = [];
  for (const tenant of startingTenants) {
    let isRunning = false;
    if (dockerClient && tenant.container_name) {
      try {
        const result = await dockerClient.inspect(tenant.container_name);
        isRunning = result?.State?.Running === true;
      } catch {
        // Inspect failed — treat as not running
      }
    }
    if (!isRunning) {
      tenantsToFail.push(tenant.id);
    }
  }

  if (tenantsToFail.length > 0) {
    await prisma.tenant.updateMany({
      where: { id: { in: tenantsToFail } },
      data: {
        status: TenantStatus.FAILED,
        error_message: 'Process crashed during startup',
        updated_at: now,
      },
    });
  }

  // For ACTIVE tenants: check if their container is still running.
  // If not running (or no docker client provided), reset to STOPPED so the relay
  // will call /start on the next message, restarting the existing container.
  const activeTenants = await prisma.tenant.findMany({
    where: { status: TenantStatus.ACTIVE },
    select: { id: true, container_name: true },
  });

  const tenantsToStop: string[] = [];
  for (const tenant of activeTenants) {
    let isRunning = false;
    if (dockerClient && tenant.container_name) {
      try {
        const result = await dockerClient.inspect(tenant.container_name);
        isRunning = result?.State?.Running === true;
      } catch {
        // Inspect failed — treat as not running
      }
    }
    if (!isRunning) {
      tenantsToStop.push(tenant.id);
      log.warn(
        { tenantId: tenant.id, containerName: tenant.container_name },
        'Tenant container not running on startup — reset to STOPPED',
      );
    }
  }

  if (tenantsToStop.length > 0) {
    await prisma.tenant.updateMany({
      where: { id: { in: tenantsToStop } },
      data: { status: TenantStatus.STOPPED, updated_at: now },
    });
  }

  // Write SYSTEM_STARTUP audit event
  await prisma.auditLog.create({
    data: {
      id: crypto.randomUUID(),
      tenant_id: null,
      event_type: AuditEventType.SYSTEM_STARTUP,
      actor: 'system',
      metadata: JSON.stringify({ uptime_ms: 0 }),
      created_at: now,
    },
  });

  // Seed default container image if not already set
  await seedDefaultImage(prisma);

  log.info('Startup reconciliation complete');
}
