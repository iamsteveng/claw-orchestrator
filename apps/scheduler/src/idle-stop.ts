import type { PrismaClient } from '@prisma/client';
import { TenantStatus } from '@claw/shared-types';

export type IdleStopLog = {
  info: (ctx: object, msg: string) => void;
  warn: (ctx: object, msg: string) => void;
  error: (ctx: object, msg: string) => void;
};

/**
 * Stops all ACTIVE tenants whose last_activity_at is older than idleStopMs.
 * Skips tenants in STARTING or PROVISIONING status (covered by status filter).
 * Calls POST /v1/tenants/:id/stop on the control plane for each idle tenant.
 */
export async function stopIdleTenants(
  prisma: PrismaClient,
  controlPlaneUrl: string,
  idleStopMs: number,
  log: IdleStopLog,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const threshold = Date.now() - idleStopMs;

  const idleTenants = await prisma.tenant.findMany({
    where: {
      status: TenantStatus.ACTIVE,
      deleted_at: null,
      last_activity_at: { lt: threshold },
    },
    select: { id: true, last_activity_at: true },
  });

  for (const tenant of idleTenants) {
    const idleDurationMs = Date.now() - (tenant.last_activity_at ?? 0);

    try {
      const res = await fetchFn(`${controlPlaneUrl}/v1/tenants/${tenant.id}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });

      if (res.ok) {
        log.info({ tenantId: tenant.id, idleDurationMs }, 'Idle tenant stopped by scheduler');
      } else {
        log.warn({ tenantId: tenant.id, status: res.status }, 'Failed to stop idle tenant');
      }
    } catch (err) {
      log.error({ tenantId: tenant.id, err }, 'Error stopping idle tenant');
    }
  }
}
