import { describe, it, expect, vi, beforeEach } from 'vitest';
import { acquireStartupLock, releaseStartupLock } from './startup-lock.js';

// Mock PrismaClient
function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    startupLock: {
      create: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    ...overrides,
  } as unknown as import('@prisma/client').PrismaClient;
}

describe('acquireStartupLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('successfully acquires lock when no row exists', async () => {
    const prisma = makePrisma();
    (prisma.startupLock.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const result = await acquireStartupLock(prisma, 'tenant-1', 'req-1');

    expect(result.acquired).toBe(true);
    expect(prisma.startupLock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenant_id: 'tenant-1',
          locked_by: 'req-1',
        }),
      })
    );
  });

  it('returns acquired=false when lock row exists with future expires_at', async () => {
    const prisma = makePrisma();
    // INSERT fails (row exists)
    (prisma.startupLock.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Unique constraint failed'));
    // Existing lock is not stale
    (prisma.startupLock.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      tenant_id: 'tenant-1',
      locked_by: 'req-other',
      acquired_at: Date.now() - 1000,
      expires_at: Date.now() + 60000, // future
    });

    const result = await acquireStartupLock(prisma, 'tenant-1', 'req-1');

    expect(result.acquired).toBe(false);
  });

  it('takes over stale lock and returns acquired=true', async () => {
    const prisma = makePrisma();
    // First INSERT fails (row exists)
    (prisma.startupLock.create as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Unique constraint failed'))
      .mockResolvedValueOnce({});
    // Existing lock is stale
    (prisma.startupLock.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      tenant_id: 'tenant-1',
      locked_by: 'req-old',
      acquired_at: Date.now() - 600000,
      expires_at: Date.now() - 1000, // expired
    });
    (prisma.startupLock.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const result = await acquireStartupLock(prisma, 'tenant-1', 'req-new');

    expect(result.acquired).toBe(true);
    expect(prisma.startupLock.delete).toHaveBeenCalledWith({
      where: { tenant_id: 'tenant-1' },
    });
  });
});

describe('releaseStartupLock', () => {
  it('deletes lock row for the correct tenant and requestId', async () => {
    const prisma = makePrisma();
    (prisma.startupLock.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    await releaseStartupLock(prisma, 'tenant-1', 'req-1');

    expect(prisma.startupLock.deleteMany).toHaveBeenCalledWith({
      where: { tenant_id: 'tenant-1', locked_by: 'req-1' },
    });
  });
});
