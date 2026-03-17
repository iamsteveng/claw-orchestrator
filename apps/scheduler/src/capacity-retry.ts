import type { PrismaClient } from '@prisma/client';
import { TenantStatus } from '@claw/shared-types';

export type CapacityRetryLog = {
  info: (ctx: object, msg: string) => void;
  warn: (ctx: object, msg: string) => void;
  error: (ctx: object, msg: string) => void;
};

/**
 * Returns the count of currently ACTIVE tenants.
 */
export async function getActiveCount(prisma: PrismaClient): Promise<number> {
  return prisma.tenant.count({
    where: {
      status: TenantStatus.ACTIVE,
      deleted_at: null,
    },
  });
}

/**
 * Checks for queued tenants (STOPPED with queued_for_start_at set) and starts
 * the one with the earliest queued_for_start_at if capacity allows.
 *
 * Only starts ONE tenant per call to avoid overshooting the capacity cap.
 * No-op if ACTIVE_TENANTS_OVERFLOW_POLICY is 'reject'.
 */
export async function retryQueuedTenants(
  prisma: PrismaClient,
  controlPlaneUrl: string,
  maxActiveTenants: number,
  overflowPolicy: 'queue' | 'reject',
  log: CapacityRetryLog,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (overflowPolicy === 'reject') {
    return;
  }

  const queued = await prisma.tenant.findMany({
    where: {
      status: TenantStatus.STOPPED,
      queued_for_start_at: { not: null },
      deleted_at: null,
    },
    orderBy: { queued_for_start_at: 'asc' },
    take: 1,
    select: { id: true, queued_for_start_at: true },
  });

  if (queued.length === 0) {
    return;
  }

  const activeCount = await getActiveCount(prisma);
  if (activeCount >= maxActiveTenants) {
    log.info(
      { activeCount, maxActiveTenants },
      'Capacity full, skipping queued tenant retry',
    );
    return;
  }

  const tenant = queued[0];
  try {
    const res = await fetchFn(`${controlPlaneUrl}/v1/tenants/${tenant.id}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (res.ok) {
      log.info({ tenantId: tenant.id, activeCount }, 'Queued tenant started by scheduler');
    } else {
      const text = await res.text().catch(() => '');
      log.warn({ tenantId: tenant.id, status: res.status, body: text }, 'Failed to start queued tenant');
    }
  } catch (err) {
    log.error({ tenantId: tenant.id, err }, 'Error starting queued tenant');
  }
}
