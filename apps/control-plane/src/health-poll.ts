import { PrismaClient } from '@prisma/client';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { attemptAutoRecovery } from './recovery.js';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 90 * 1000; // 90 seconds
const REQUEST_TIMEOUT_MS = 3000;   // 3 seconds per request
const CONSECUTIVE_UNHEALTHY_THRESHOLD = 3; // 3 failures = ~6 seconds for ACTIVE tenants

export type PollResult = 'healthy' | 'timeout';

export type Log = {
  info: (ctx: object, msg: string) => void;
  warn: (ctx: object, msg: string) => void;
  error: (ctx: object, msg: string) => void;
};

/** Minimal docker inspect function signature needed by health-poll */
export type DockerInspectFn = (containerName: string) => Promise<{
  State?: { Running?: boolean };
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
} | null>;

/**
 * Polls GET http://<containerName>:3101/health every 2 seconds for up to 90 seconds.
 *
 * For previously-ACTIVE tenants:
 *   - Detects UNHEALTHY after 3 consecutive poll failures (6 seconds)
 *   - Sets status → UNHEALTHY, writes TENANT_UNHEALTHY audit event
 *   - Triggers auto-recovery in background
 *
 * For other previousStatus (STARTING, PROVISIONING etc.):
 *   - Times out after 90 seconds; leaves status for caller to handle
 *
 * On success (any previousStatus):
 *   - Sets tenant status → ACTIVE, last_started_at, writes TENANT_STARTED audit event
 *
 * Designed to be called with `void pollUntilHealthy(...)` so it runs in the background.
 */
export async function pollUntilHealthy(
  prisma: PrismaClient,
  tenantId: string,
  containerName: string,
  previousStatus: string,
  log: Log,
  dockerInspect?: DockerInspectFn,
): Promise<PollResult> {
  // Resolve container IP via docker inspect (host cannot resolve container names)
  let containerHost = containerName;
  if (dockerInspect) {
    try {
      const inspectResult = await dockerInspect(containerName);
      const networks = inspectResult?.NetworkSettings?.Networks;
      const ip = networks ? Object.values(networks)[0]?.IPAddress : undefined;
      if (ip) containerHost = ip;
    } catch {
      log.warn({ tenantId, containerName }, 'docker inspect failed; falling back to container name for health URL');
    }
  }
  const url = `http://${containerHost}:3101/health`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (Date.now() < deadline) {
    const healthy = await checkHealth(url, log, tenantId);

    if (healthy) {
      consecutiveFailures = 0;
      const now = Date.now();

      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          status: TenantStatus.ACTIVE,
          last_started_at: now,
          updated_at: now,
        },
      });

      await prisma.auditLog.create({
        data: {
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          event_type: AuditEventType.TENANT_STARTED,
          actor: 'system',
          metadata: JSON.stringify({ containerName }),
          created_at: now,
        },
      });

      log.info({ tenantId }, 'Tenant health check passed — status set to ACTIVE');
      return 'healthy';
    }

    consecutiveFailures++;

    // For previously-ACTIVE tenants: detect UNHEALTHY after 3 consecutive failures (6 seconds)
    if (previousStatus === TenantStatus.ACTIVE && consecutiveFailures >= CONSECUTIVE_UNHEALTHY_THRESHOLD) {
      await markUnhealthy(prisma, tenantId, containerName, log);
      // Trigger auto-recovery in background
      void attemptAutoRecovery(prisma, tenantId, containerName, log);
      return 'timeout';
    }

    // Wait before next poll (only if there's still time)
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  // Timed out (for non-ACTIVE previousStatus)
  log.warn({ tenantId, previousStatus }, 'Health poll timed out after 90s');

  if (previousStatus === TenantStatus.ACTIVE) {
    // Fallback: should have been caught above, but mark UNHEALTHY just in case
    await markUnhealthy(prisma, tenantId, containerName, log);
    void attemptAutoRecovery(prisma, tenantId, containerName, log);
  }

  return 'timeout';
}

async function markUnhealthy(
  prisma: PrismaClient,
  tenantId: string,
  containerName: string,
  log: Log,
): Promise<void> {
  const now = Date.now();
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { status: TenantStatus.UNHEALTHY, updated_at: now },
  });
  await prisma.auditLog.create({
    data: {
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      event_type: AuditEventType.TENANT_UNHEALTHY,
      actor: 'system',
      metadata: JSON.stringify({ reason: 'consecutive_failures', containerName }),
      created_at: now,
    },
  });
  log.warn({ tenantId }, 'Tenant status set to UNHEALTHY after consecutive health poll failures');
}

async function checkHealth(
  url: string,
  log: Log,
  tenantId: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return false;
    const body = await res.json() as { ok?: boolean };
    return body.ok === true;
  } catch {
    log.error({ tenantId, url }, 'Health check request failed');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
