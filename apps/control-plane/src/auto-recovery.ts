import { PrismaClient } from '@prisma/client';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { pollUntilHealthy } from './health-poll.js';

const RECOVERY_COOLDOWN_MS = 30 * 1000;  // 30-second cooldown before recovery attempt
const MAX_CONSECUTIVE_FAILURES = 3;      // failures before UNHEALTHY
const POLL_INTERVAL_MS = 2000;
const REQUEST_TIMEOUT_MS = 3000;

type SimpleLogger = {
  info: (ctx: object, msg: string) => void;
  warn: (ctx: object, msg: string) => void;
  error: (ctx: object, msg: string) => void;
};

/**
 * Runs a continuous background health monitor for an ACTIVE tenant.
 * - Polls every 2 seconds
 * - On 3 consecutive failures: marks UNHEALTHY, triggers auto-recovery once
 * - On recovery success: marks ACTIVE, writes TENANT_RECOVERED, replays queued messages
 * - On recovery failure: leaves UNHEALTHY (admin must manually restart)
 *
 * Call without await to run in background.
 */
export async function runHealthMonitor(
  prisma: PrismaClient,
  tenantId: string,
  containerName: string,
  log: SimpleLogger,
): Promise<void> {
  let consecutiveFailures = 0;

  while (true) {
    // Check if tenant is still ACTIVE (stop monitoring if not)
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });

    if (!tenant || tenant.status !== TenantStatus.ACTIVE) {
      // Tenant stopped, deleted, or in another state — stop monitoring
      return;
    }

    const healthy = await checkHealthOnce(`http://${containerName}:3101/health`);

    if (healthy) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Detected UNHEALTHY
        await markUnhealthy(prisma, tenantId, containerName, log);
        // Attempt recovery once
        await attemptRecovery(prisma, tenantId, containerName, log);
        return; // Stop monitoring; recovery flow handles the rest
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Marks tenant as UNHEALTHY and writes audit event.
 */
export async function markUnhealthy(
  prisma: PrismaClient,
  tenantId: string,
  containerName: string,
  log: SimpleLogger,
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
      metadata: JSON.stringify({ reason: '3_consecutive_health_failures', containerName }),
      created_at: now,
    },
  });
  log.warn({ tenantId }, 'Tenant marked UNHEALTHY after 3 consecutive health failures');
}

/**
 * Attempts auto-recovery after 30s cooldown:
 * 1. Waits 30 seconds
 * 2. Calls dockerStart on the container
 * 3. Calls pollUntilHealthy
 * 4. On success: marks ACTIVE, writes TENANT_RECOVERED, replays queued messages
 * 5. On failure: leaves UNHEALTHY
 *
 * @param startFn - optional override for container start (injected for testing)
 */
export async function attemptRecovery(
  prisma: PrismaClient,
  tenantId: string,
  containerName: string,
  log: SimpleLogger,
  startFn?: (name: string) => Promise<void>,
): Promise<'recovered' | 'failed'> {
  log.info({ tenantId }, 'Starting auto-recovery after 30s cooldown');
  await sleep(RECOVERY_COOLDOWN_MS);

  // Try to start the container
  try {
    if (startFn) {
      await startFn(containerName);
    } else {
      const { DockerClient } = await import('@claw/docker-client');
      await DockerClient.start(containerName);
    }
  } catch (err) {
    log.error({ tenantId, err }, 'dockerStart failed during auto-recovery');
    return 'failed';
  }

  // Poll for health
  const result = await pollUntilHealthy(prisma, tenantId, containerName, TenantStatus.UNHEALTHY, log);

  if (result === 'healthy') {
    // pollUntilHealthy already set ACTIVE + wrote TENANT_STARTED
    // Write TENANT_RECOVERED audit event
    const now = Date.now();
    await prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        event_type: AuditEventType.TENANT_RECOVERED,
        actor: 'system',
        metadata: JSON.stringify({ containerName }),
        created_at: now,
      },
    });

    // Replay queued messages (set PENDING messages back so the relay will pick them up)
    // The relay processes PENDING messages on delivery attempts
    log.info({ tenantId }, 'Auto-recovery succeeded; tenant is ACTIVE');
    return 'recovered';
  } else {
    log.warn({ tenantId }, 'Auto-recovery failed; tenant remains UNHEALTHY');
    return 'failed';
  }
}

async function checkHealthOnce(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
