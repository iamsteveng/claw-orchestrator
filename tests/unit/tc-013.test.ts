/**
 * TC-013: Startup lock → no duplicate containers on concurrent messages
 *
 * Verifies that acquireStartupLock enforces mutual exclusion:
 *  1. First caller acquires the lock
 *  2. Second concurrent caller is rejected (acquired: false)
 *  3. After release, a third caller can acquire
 *  4. Stale locks (expires_at in the past) are overridden
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { acquireStartupLock, releaseStartupLock } from '../../apps/control-plane/src/startup-lock.js';

function makePrisma() {
  return {
    startupLock: {
      create: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
  } as unknown as import('@prisma/client').PrismaClient;
}

describe('TC-013: Startup lock → no duplicate containers on concurrent messages', () => {
  const tenantId = 'tenant-tc013';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('TC-013: step 1 — acquireStartupLock(requestId1) returns {acquired: true}', async () => {
    const prisma = makePrisma();
    (prisma.startupLock.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const result = await acquireStartupLock(prisma, tenantId, 'req-1');

    expect(result.acquired).toBe(true);
  });

  it('TC-013: step 2 — concurrent acquireStartupLock(requestId2) returns {acquired: false}', async () => {
    const prisma = makePrisma();
    // INSERT fails because req-1 holds the lock
    (prisma.startupLock.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Unique constraint failed on the fields: (`tenant_id`)')
    );
    // Existing lock held by req-1 is still valid (not stale)
    (prisma.startupLock.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      tenant_id: tenantId,
      locked_by: 'req-1',
      acquired_at: Date.now() - 1000,
      expires_at: Date.now() + 300000, // valid, not expired
    });

    const result = await acquireStartupLock(prisma, tenantId, 'req-2');

    expect(result.acquired).toBe(false);
  });

  it('TC-013: step 3 — after releaseStartupLock(requestId1), acquireStartupLock(requestId3) returns {acquired: true}', async () => {
    const prisma = makePrisma();

    // Release req-1's lock
    (prisma.startupLock.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    await releaseStartupLock(prisma, tenantId, 'req-1');
    expect(prisma.startupLock.deleteMany).toHaveBeenCalledWith({
      where: { tenant_id: tenantId, locked_by: 'req-1' },
    });

    // req-3 can now acquire
    (prisma.startupLock.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const result = await acquireStartupLock(prisma, tenantId, 'req-3');
    expect(result.acquired).toBe(true);
  });

  it('TC-013: step 4 — stale lock (expires_at 1ms ago) is overridden, {acquired: true}', async () => {
    const prisma = makePrisma();

    // First INSERT fails (stale row exists)
    (prisma.startupLock.create as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Unique constraint failed on the fields: (`tenant_id`)'))
      .mockResolvedValueOnce({}); // second INSERT succeeds after delete

    // Existing lock is stale (expired 1ms ago)
    (prisma.startupLock.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      tenant_id: tenantId,
      locked_by: 'req-old',
      acquired_at: Date.now() - 600000,
      expires_at: Date.now() - 1, // expired 1ms ago
    });

    (prisma.startupLock.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const result = await acquireStartupLock(prisma, tenantId, 'req-new');

    expect(result.acquired).toBe(true);
    expect(prisma.startupLock.delete).toHaveBeenCalledWith({
      where: { tenant_id: tenantId },
    });
  });

  it('TC-013: full sequence — mutual exclusion and stale takeover', async () => {
    const prisma = makePrisma();

    // Step 1: req-1 acquires
    (prisma.startupLock.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});
    const r1 = await acquireStartupLock(prisma, tenantId, 'req-1');
    expect(r1).toEqual({ acquired: true });

    // Step 2: req-2 fails (lock held by req-1)
    (prisma.startupLock.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Unique constraint failed')
    );
    (prisma.startupLock.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      tenant_id: tenantId,
      locked_by: 'req-1',
      acquired_at: Date.now() - 1000,
      expires_at: Date.now() + 300000,
    });
    const r2 = await acquireStartupLock(prisma, tenantId, 'req-2');
    expect(r2).toEqual({ acquired: false });

    // Step 3: req-1 releases, req-3 acquires
    (prisma.startupLock.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 1 });
    await releaseStartupLock(prisma, tenantId, 'req-1');

    (prisma.startupLock.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});
    const r3 = await acquireStartupLock(prisma, tenantId, 'req-3');
    expect(r3).toEqual({ acquired: true });

    // Step 4: stale lock (expires_at = 1ms ago) is overridden
    (prisma.startupLock.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Unique constraint failed')
    );
    (prisma.startupLock.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      tenant_id: tenantId,
      locked_by: 'req-stale',
      acquired_at: Date.now() - 600000,
      expires_at: Date.now() - 1,
    });
    (prisma.startupLock.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});
    (prisma.startupLock.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    const r4 = await acquireStartupLock(prisma, tenantId, 'req-after-stale');
    expect(r4).toEqual({ acquired: true });
  });
});
