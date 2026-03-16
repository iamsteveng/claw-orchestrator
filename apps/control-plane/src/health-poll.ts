import { PrismaClient } from '@prisma/client';
import { AuditEventType, TenantStatus } from '@claw/shared-types';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 90 * 1000; // 90 seconds
const REQUEST_TIMEOUT_MS = 3000;   // 3 seconds per request

export type PollResult = 'healthy' | 'timeout';

/**
 * Polls GET http://<containerName>:3101/health every 2 seconds for up to 90 seconds.
 *
 * On healthy (HTTP 200 + { ok: true }):
 *   - Sets tenant status → ACTIVE
 *   - Sets last_started_at to now
 *   - Writes TENANT_STARTED audit event
 *
 * On timeout:
 *   - If previousStatus was ACTIVE (i.e. a wake-up or re-start attempt for a running tenant):
 *     sets status → UNHEALTHY, writes TENANT_UNHEALTHY audit event
 *   - Otherwise (provisioning or fresh start): leaves status for the caller to handle rollback
 *
 * Designed to be called with `void pollUntilHealthy(...)` so it runs in the background.
 */
export async function pollUntilHealthy(
  prisma: PrismaClient,
  tenantId: string,
  containerName: string,
  previousStatus: string,
  log: { info: (ctx: object, msg: string) => void; warn: (ctx: object, msg: string) => void; error: (ctx: object, msg: string) => void },
): Promise<PollResult> {
  const url = `http://${containerName}:3101/health`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const healthy = await checkHealth(url, log, tenantId);

    if (healthy) {
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

    // Wait before next poll (only if there's still time)
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  // Timed out
  log.warn({ tenantId, previousStatus }, 'Health poll timed out after 90s');

  if (previousStatus === TenantStatus.ACTIVE) {
    // Tenant was previously healthy — mark UNHEALTHY
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
        metadata: JSON.stringify({ reason: 'health_poll_timeout', containerName }),
        created_at: now,
      },
    });

    log.warn({ tenantId }, 'Tenant status set to UNHEALTHY after poll timeout');
  }

  return 'timeout';
}

async function checkHealth(
  url: string,
  log: { error: (ctx: object, msg: string) => void },
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
