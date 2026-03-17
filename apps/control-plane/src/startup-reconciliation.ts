import type { PrismaClient } from '@prisma/client';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { seedDefaultImage } from './container-image.js';

export type ReconcileLog = {
  info: (msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
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

  // Mark in-flight tenant starts as FAILED
  await prisma.tenant.updateMany({
    where: {
      status: { in: [TenantStatus.STARTING, TenantStatus.PROVISIONING] },
    },
    data: {
      status: TenantStatus.FAILED,
      error_message: 'Process crashed during startup',
      updated_at: now,
    },
  });

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
