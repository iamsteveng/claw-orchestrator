import { describe, it, expect, vi } from 'vitest';
import { acquireStartupLock, releaseStartupLock } from '../../src/startup-lock.js';
import { mockPrismaClient } from '@claw/test-utils';

describe('Startup lock — acquire/release/expire', () => {
  it('acquires lock when no existing row', async () => {
    const prisma = mockPrismaClient();
    prisma.startupLock.create = vi.fn().mockResolvedValue({});

    const result = await acquireStartupLock(prisma, 'tenant-1', 'req-1');

    expect(result.acquired).toBe(true);
    expect(prisma.startupLock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenant_id: 'tenant-1', locked_by: 'req-1' }),
      }),
    );
  });

  it('returns acquired=false when another process holds a valid lock', async () => {
    const prisma = mockPrismaClient();
    const future = Date.now() + 60_000;
    prisma.startupLock.create = vi.fn().mockRejectedValue(new Error('UNIQUE constraint failed'));
    prisma.startupLock.findUnique = vi.fn().mockResolvedValue({
      tenant_id: 'tenant-1',
      locked_by: 'req-other',
      expires_at: future,
    });

    const result = await acquireStartupLock(prisma, 'tenant-1', 'req-1');

    expect(result.acquired).toBe(false);
  });

  it('takes over a stale lock (expired)', async () => {
    const prisma = mockPrismaClient();
    const past = Date.now() - 60_000;
    prisma.startupLock.create = vi
      .fn()
      .mockRejectedValueOnce(new Error('UNIQUE constraint failed'))
      .mockResolvedValueOnce({});
    prisma.startupLock.findUnique = vi.fn().mockResolvedValue({
      tenant_id: 'tenant-1',
      locked_by: 'req-old',
      expires_at: past,
    });
    prisma.startupLock.delete = vi.fn().mockResolvedValue({});

    const result = await acquireStartupLock(prisma, 'tenant-1', 'req-1');

    expect(result.acquired).toBe(true);
    expect(prisma.startupLock.delete).toHaveBeenCalled();
  });

  it('releases lock successfully', async () => {
    const prisma = mockPrismaClient();
    prisma.startupLock.deleteMany = vi.fn().mockResolvedValue({ count: 1 });

    await releaseStartupLock(prisma, 'tenant-1', 'req-1');

    expect(prisma.startupLock.deleteMany).toHaveBeenCalledWith({
      where: { tenant_id: 'tenant-1', locked_by: 'req-1' },
    });
  });
});
