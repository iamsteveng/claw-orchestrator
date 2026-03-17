import { PrismaClient } from '@prisma/client';
import { AuditEventType, TenantStatus } from '@claw/shared-types';
import { pollUntilHealthy } from './health-poll.js';

const POLL_INTERVAL_MS = 2000;
const CONSECUTIVE_FAILURES_THRESHOLD = 3;
const COOLDOWN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 3000;

export type Notifier = (slackUserId: string, message: string) => Promise<void>;
export type MessageReplayer = (tenantId: string) => Promise<void>;

type Logger = {
  info: (ctx: object, msg: string) => void;
  warn: (ctx: object, msg: string) => void;
  error: (ctx: object, msg: string) => void;
};

/**
 * Monitors the health of an ACTIVE tenant in the background.
 *
 * Polls GET http://<containerName>:3101/health every 2 seconds.
 * After 3 consecutive failures (6 seconds), transitions to UNHEALTHY,
 * notifies the user via Slack DM, waits 30 seconds, then attempts
 * auto-recovery once (dockerStart + pollUntilHealthy).
 *
 * Auto-recovery is only attempted once — tracked via recovery_attempted_at
 * so that admin restart can reset it.
 */
export async function monitorTenantHealth(
  prisma: PrismaClient,
  tenantId: string,
  containerName: string,
  slackUserId: string,
  notifyUser: Notifier,
  replayMessages: MessageReplayer,
  log: Logger,
): Promise<void> {
  const url = `http://${containerName}:3101/health`;
  let consecutiveFailures = 0;

  // Poll until 3 consecutive failures
  while (true) {
    const healthy = await checkHealth(url, tenantId, log);

    if (healthy) {
      consecutiveFailures = 0;
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    consecutiveFailures++;
    log.warn({ tenantId, consecutiveFailures }, 'Health check failed');

    if (consecutiveFailures >= CONSECUTIVE_FAILURES_THRESHOLD) {
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // --- UNHEALTHY transition ---
  const now = Date.now();

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      status: TenantStatus.UNHEALTHY,
      error_message: '3 consecutive health check failures',
      updated_at: now,
    },
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

  log.warn({ tenantId }, 'Tenant set to UNHEALTHY — notifying user');
  await notifyUser(
    slackUserId,
    "Your workspace is experiencing issues. We're attempting to recover it automatically.",
  );

  // Check whether auto-recovery was already attempted for this tenant
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (tenant?.recovery_attempted_at) {
    log.warn({ tenantId }, 'Auto-recovery already attempted; skipping');
    return;
  }

  // 30-second cooldown before recovery
  await sleep(COOLDOWN_MS);

  // Mark recovery as attempted (prevents duplicate auto-recovery)
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { recovery_attempted_at: Date.now(), updated_at: Date.now() },
  });

  // Attempt recovery: docker start
  try {
    const { DockerClient } = await import('@claw/docker-client');
    await DockerClient.start(containerName);
  } catch (err) {
    log.error({ tenantId, err }, 'Docker start failed during auto-recovery');
    await notifyUser(
      slackUserId,
      'We were unable to recover your workspace automatically. Please try again in a few minutes.',
    );
    return;
  }

  // Poll until healthy (90-second timeout)
  const result = await pollUntilHealthy(
    prisma,
    tenantId,
    containerName,
    TenantStatus.UNHEALTHY,
    log,
  );

  if (result === 'healthy') {
    // Write TENANT_RECOVERED in addition to TENANT_STARTED (written by pollUntilHealthy)
    await prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        event_type: AuditEventType.TENANT_RECOVERED,
        actor: 'system',
        metadata: JSON.stringify({ containerName }),
        created_at: Date.now(),
      },
    });

    log.info({ tenantId }, 'Tenant recovered — replaying queued messages');
    await replayMessages(tenantId);
  } else {
    log.warn({ tenantId }, 'Auto-recovery failed');
    await notifyUser(
      slackUserId,
      'We were unable to recover your workspace automatically. Please try again in a few minutes.',
    );
  }
}

async function checkHealth(
  url: string,
  tenantId: string,
  log: Logger,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return false;
    const body = await res.json() as { ok?: boolean };
    return body.ok === true;
  } catch {
    log.error({ tenantId, url }, 'Health monitor request failed');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
