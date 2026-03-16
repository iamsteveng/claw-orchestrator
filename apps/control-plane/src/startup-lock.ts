import { PrismaClient } from '@prisma/client';

const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 3 * 60 * 1000; // 3 minutes

export interface AcquireResult {
  acquired: boolean;
}

/**
 * Attempts to acquire a startup lock for the given tenant.
 * Uses SQLite UNIQUE constraint on startup_locks.tenant_id as a distributed mutex.
 */
export async function acquireStartupLock(
  prisma: PrismaClient,
  tenantId: string,
  requestId: string,
): Promise<AcquireResult> {
  const now = Date.now();
  const expiresAt = now + LOCK_TTL_MS;

  // Attempt INSERT
  try {
    await prisma.startupLock.create({
      data: {
        tenant_id: tenantId,
        locked_by: requestId,
        acquired_at: now,
        expires_at: expiresAt,
      },
    });
    return { acquired: true };
  } catch (_insertErr) {
    // Row exists — check if it's stale
    const existing = await prisma.startupLock.findUnique({
      where: { tenant_id: tenantId },
    });

    if (!existing) {
      // Row disappeared between INSERT and SELECT (race) — try once more
      try {
        await prisma.startupLock.create({
          data: {
            tenant_id: tenantId,
            locked_by: requestId,
            acquired_at: now,
            expires_at: expiresAt,
          },
        });
        return { acquired: true };
      } catch {
        return { acquired: false };
      }
    }

    if (existing.expires_at < now) {
      // Stale lock — delete and retry INSERT once
      try {
        await prisma.startupLock.delete({
          where: { tenant_id: tenantId },
        });
        await prisma.startupLock.create({
          data: {
            tenant_id: tenantId,
            locked_by: requestId,
            acquired_at: now,
            expires_at: expiresAt,
          },
        });
        return { acquired: true };
      } catch {
        return { acquired: false };
      }
    }

    // Another process holds a valid lock
    return { acquired: false };
  }
}

/**
 * Releases the startup lock. Only deletes the row if it belongs to this requestId.
 * Always call in a finally block.
 */
export async function releaseStartupLock(
  prisma: PrismaClient,
  tenantId: string,
  requestId: string,
): Promise<void> {
  await prisma.startupLock.deleteMany({
    where: { tenant_id: tenantId, locked_by: requestId },
  });
}

/**
 * Non-holder behavior: polls tenant status every 2s for up to 3 minutes.
 * Returns {queued: true, ...} if tenant becomes ACTIVE, or a wait message if it times out.
 */
export async function waitForTenantActive(
  prisma: PrismaClient,
  tenantId: string,
): Promise<{ queued: true; status: string } | { queued: false; message: string }> {
  const deadline = Date.now() + POLL_MAX_MS;

  while (Date.now() < deadline) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });

    if (tenant?.status === 'ACTIVE') {
      return { queued: true, status: 'ACTIVE' };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return { queued: false, message: 'tenant is starting, please wait' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
