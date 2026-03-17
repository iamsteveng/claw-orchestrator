/**
 * US-025: Message queuing and ordered replay when tenant is stopped or starting.
 *
 * This module handles the core event processing logic with direct DB access
 * for reliable queue management. The relay shares the same SQLite DB as the
 * control plane (single-host deployment; SQLite WAL mode for concurrent access).
 */
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const POLL_INTERVAL_MS = 2000;
const ACTIVE_WAIT_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const MAX_ATTEMPTS = 3;

export type Logger = {
  info: (ctx: object, msg: string) => void;
  warn: (ctx: object, msg: string) => void;
  error: (ctx: object, msg: string) => void;
};

export interface HandleEventOptions {
  prisma: PrismaClient;
  tenantId: string;
  tenantStarted: boolean;  // true if the tenant was already ACTIVE at event receipt
  slackEventId: string;
  payload: string;  // raw Slack event JSON
  controlPlaneUrl: string;
  slackBotToken: string;
  slackUserId: string;
  slackChannel: string;
  log: Logger;
  fetchFn?: typeof fetch;
}

/**
 * Inserts a PENDING message queue row. Returns false if duplicate (idempotent).
 */
export async function enqueueMessage(
  prisma: PrismaClient,
  tenantId: string,
  slackEventId: string,
  payload: string,
): Promise<boolean> {
  const now = Date.now();
  try {
    await prisma.messageQueue.create({
      data: {
        id: randomUUID(),
        tenant_id: tenantId,
        slack_event_id: slackEventId,
        payload,
        status: 'PENDING',
        attempts: 0,
        created_at: now,
        updated_at: now,
      },
    });
    return true;
  } catch {
    // Unique constraint violation = duplicate Slack retry; silently ignore
    return false;
  }
}

/**
 * Polls tenant status every 2 seconds until ACTIVE or timeout.
 * Returns true if tenant became ACTIVE within the deadline.
 */
export async function waitForTenantActive(
  prisma: PrismaClient,
  tenantId: string,
  timeoutMs: number = ACTIVE_WAIT_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });

    if (tenant?.status === 'ACTIVE') {
      return true;
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  return false;
}

/**
 * Delivers all PENDING messages for a tenant sequentially (in created_at order).
 * Sets status=PROCESSING before delivery; DELIVERED on success; FAILED after 3 attempts.
 */
export async function deliverPendingMessages(
  prisma: PrismaClient,
  tenantId: string,
  relayToken: string,
  log: Logger,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const containerName = `claw-tenant-${tenantId}`;
  const runtimeUrl = `http://${containerName}:3100/message`;

  const pendingMessages = await prisma.messageQueue.findMany({
    where: { tenant_id: tenantId, status: 'PENDING' },
    orderBy: { created_at: 'asc' },
  });

  for (const msg of pendingMessages) {
    const now = Date.now();

    // Mark as PROCESSING (only one PROCESSING per tenant at a time)
    await prisma.messageQueue.update({
      where: { id: msg.id },
      data: { status: 'PROCESSING', updated_at: now },
    });

    let success = false;
    try {
      const res = await fetchFn(runtimeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-relay-token': relayToken,
        },
        body: msg.payload,
      });

      if (res.ok) {
        const body = await res.json() as { ok?: boolean };
        success = body.ok === true;
      }
    } catch (err) {
      log.error({ tenantId, msgId: msg.id, err }, 'Message delivery error');
    }

    const updatedNow = Date.now();

    if (success) {
      await prisma.messageQueue.update({
        where: { id: msg.id },
        data: { status: 'DELIVERED', updated_at: updatedNow },
      });
      log.info({ tenantId, msgId: msg.id }, 'Message delivered');
    } else {
      const newAttempts = msg.attempts + 1;
      const finalStatus = newAttempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING';
      await prisma.messageQueue.update({
        where: { id: msg.id },
        data: {
          status: finalStatus,
          attempts: newAttempts,
          error: finalStatus === 'FAILED' ? 'Max delivery attempts reached' : null,
          updated_at: updatedNow,
        },
      });
      log.warn({ tenantId, msgId: msg.id, attempts: newAttempts, finalStatus }, 'Message delivery failed');
    }
  }
}

/**
 * Startup sweep: reset PROCESSING rows older than 2 minutes back to PENDING.
 * Call on relay process startup.
 */
export async function resetStuckProcessingRows(prisma: PrismaClient): Promise<void> {
  const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
  await prisma.messageQueue.updateMany({
    where: {
      status: 'PROCESSING',
      updated_at: { lt: twoMinutesAgo },
    },
    data: { status: 'PENDING', updated_at: Date.now() },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
