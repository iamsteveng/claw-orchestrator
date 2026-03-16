import type { PrismaClient } from '@prisma/client';
import { AuditEventType, TenantStatus } from '@claw/shared-types';

const RECOVERY_COOLDOWN_MS = 30 * 1000; // 30 seconds
const HEALTH_POLL_INTERVAL_MS = 2000;
const HEALTH_POLL_TIMEOUT_MS = 90 * 1000;
const HEALTH_REQUEST_TIMEOUT_MS = 3000;

export type Log = {
  info: (ctx: object, msg: string) => void;
  warn: (ctx: object, msg: string) => void;
  error: (ctx: object, msg: string) => void;
};

/**
 * Attempts auto-recovery of an UNHEALTHY tenant.
 * - Waits 30-second cooldown
 * - Checks recovery_attempted_at (at most once per UNHEALTHY episode)
 * - Docker start + health poll (90s)
 * - On success: sets ACTIVE, replays queued messages, writes TENANT_RECOVERED
 * - On failure: leaves UNHEALTHY
 */
export async function attemptAutoRecovery(
  prisma: PrismaClient,
  tenantId: string,
  containerName: string,
  log: Log,
): Promise<void> {
  // Cooldown
  await sleep(RECOVERY_COOLDOWN_MS);

  // Re-fetch tenant (might have changed)
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant || tenant.status !== TenantStatus.UNHEALTHY) {
    log.info({ tenantId }, 'Recovery aborted: tenant no longer UNHEALTHY');
    return;
  }

  // At most once: check if recovery was already attempted
  if (tenant.recovery_attempted_at !== null) {
    log.warn({ tenantId }, 'Recovery already attempted; skipping auto-recovery');
    return;
  }

  const now = Date.now();
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { recovery_attempted_at: now, updated_at: now },
  });

  log.info({ tenantId }, 'Attempting auto-recovery after UNHEALTHY');

  // Try to start the container
  try {
    const { DockerClient } = await import('@claw/docker-client');
    await DockerClient.start(containerName);
  } catch (err) {
    log.error({ tenantId, err }, 'Auto-recovery: dockerStart failed');
    return;
  }

  // Poll health
  const healthy = await pollForRecovery(containerName, log, tenantId);

  if (healthy) {
    const recovered = Date.now();
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        status: TenantStatus.ACTIVE,
        last_started_at: recovered,
        updated_at: recovered,
      },
    });

    await prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        event_type: AuditEventType.TENANT_RECOVERED,
        actor: 'system',
        metadata: JSON.stringify({ containerName }),
        created_at: recovered,
      },
    });

    log.info({ tenantId }, 'Tenant recovered successfully');

    // Replay any queued messages (best-effort: mark them PENDING so the next request picks them up)
    await prisma.messageQueue.updateMany({
      where: { tenant_id: tenantId, status: 'PENDING' },
      data: { updated_at: recovered },
    });
  } else {
    log.warn({ tenantId }, 'Auto-recovery failed after 90s health poll');
  }
}

async function pollForRecovery(
  containerName: string,
  log: Log,
  tenantId: string,
): Promise<boolean> {
  const url = `http://${containerName}:3101/health`;
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) {
        const body = await res.json() as { ok?: boolean };
        if (body.ok === true) return true;
      }
    } catch {
      // not yet healthy
    } finally {
      clearTimeout(timer);
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(HEALTH_POLL_INTERVAL_MS, remaining));
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
