import type { PrismaClient } from '@prisma/client';
import { AuditEventType, TenantStatus } from '@claw/shared-types';

export type PollResult = 'healthy' | 'timeout';

export interface PollConfig {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 90 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3000;

/**
 * Polls GET http://<containerName>:3101/health every pollIntervalMs until
 * ok=true is returned or the deadline is reached.
 *
 * On healthy: sets tenant ACTIVE, writes TENANT_STARTED audit event.
 * On timeout (provisioning): sets tenant FAILED.
 * On timeout (previously ACTIVE): sets tenant UNHEALTHY, writes TENANT_UNHEALTHY.
 *
 * Intended to be called without await so it runs in the background.
 */
export async function pollUntilHealthy(
  prisma: PrismaClient,
  tenantId: string,
  containerName: string,
  previousStatus: string,
  config?: PollConfig,
): Promise<PollResult> {
  const pollIntervalMs = config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = config?.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const requestTimeoutMs = config?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const url = `http://${containerName}:3101/health`;
  const deadline = Date.now() + pollTimeoutMs;

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response: Response | undefined;
      try {
        response = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 200) {
        const data = (await response.json()) as { ok?: boolean };
        if (data.ok === true) {
          const now = Date.now();
          await prisma.tenant.update({
            where: { id: tenantId },
            data: { status: TenantStatus.ACTIVE, last_started_at: now, updated_at: now },
          });
          await prisma.auditLog.create({
            data: {
              id: crypto.randomUUID(),
              tenant_id: tenantId,
              event_type: AuditEventType.TENANT_STARTED,
              actor: 'control-plane',
              metadata: JSON.stringify({ containerName }),
              created_at: now,
            },
          });
          return 'healthy';
        }
      }
    } catch {
      // Container not yet reachable — continue polling
    }

    await sleep(pollIntervalMs);
  }

  // Timed out
  const now = Date.now();
  if (previousStatus === TenantStatus.ACTIVE) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { status: TenantStatus.UNHEALTHY, updated_at: now },
    });
    await prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        event_type: AuditEventType.TENANT_UNHEALTHY,
        actor: 'control-plane',
        metadata: JSON.stringify({ containerName, reason: 'health check timeout' }),
        created_at: now,
      },
    });
  } else {
    // Provisioning failure — rollback handled by US-019; set FAILED for now
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        status: TenantStatus.FAILED,
        error_message: 'Health check timed out after 90 seconds',
        updated_at: now,
      },
    });
  }

  return 'timeout';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
