import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retryQueuedTenants, getActiveCount } from './capacity-retry.js';
import { TenantStatus } from '@claw/shared-types';

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    tenant: {
      count: vi.fn(),
      findMany: vi.fn(),
      ...((overrides.tenant as object) ?? {}),
    },
    ...overrides,
  } as unknown as import('@prisma/client').PrismaClient;
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('retryQueuedTenants', () => {
  it('starts queued tenant when capacity is available', async () => {
    const prisma = makePrisma({
      tenant: {
        findMany: vi.fn().mockResolvedValue([{ id: 'tenant-abc', queued_for_start_at: 1000 }]),
        count: vi.fn().mockResolvedValue(2), // 2 active, max is 5
      },
    });

    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('') } as unknown as Response);

    await retryQueuedTenants(prisma, 'http://cp:3200', 5, 'queue', log, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      'http://cp:3200/v1/tenants/tenant-abc/start',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-abc' }),
      'Queued tenant started by scheduler',
    );
  });

  it('does not start tenant when at capacity', async () => {
    const prisma = makePrisma({
      tenant: {
        findMany: vi.fn().mockResolvedValue([{ id: 'tenant-abc', queued_for_start_at: 1000 }]),
        count: vi.fn().mockResolvedValue(5), // 5 active = max
      },
    });

    const fetchFn = vi.fn();

    await retryQueuedTenants(prisma, 'http://cp:3200', 5, 'queue', log, fetchFn);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ activeCount: 5, maxActiveTenants: 5 }),
      'Capacity full, skipping queued tenant retry',
    );
  });

  it('only starts one tenant per call (earliest queued_for_start_at)', async () => {
    // findMany with take: 1 ensures only one is returned; verify only one start is called
    const prisma = makePrisma({
      tenant: {
        findMany: vi.fn().mockResolvedValue([{ id: 'tenant-first', queued_for_start_at: 500 }]),
        count: vi.fn().mockResolvedValue(0),
      },
    });

    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('') } as unknown as Response);

    await retryQueuedTenants(prisma, 'http://cp:3200', 10, 'queue', log, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://cp:3200/v1/tenants/tenant-first/start',
      expect.anything(),
    );
  });

  it('does nothing when overflow policy is reject', async () => {
    const prisma = makePrisma({
      tenant: {
        findMany: vi.fn().mockResolvedValue([{ id: 'tenant-abc', queued_for_start_at: 1000 }]),
        count: vi.fn().mockResolvedValue(0),
      },
    });

    const fetchFn = vi.fn();

    await retryQueuedTenants(prisma, 'http://cp:3200', 5, 'reject', log, fetchFn);

    expect(fetchFn).not.toHaveBeenCalled();
    expect((prisma.tenant as unknown as { findMany: ReturnType<typeof vi.fn> }).findMany).not.toHaveBeenCalled();
  });

  it('does nothing when no queued tenants exist', async () => {
    const prisma = makePrisma({
      tenant: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn(),
      },
    });

    const fetchFn = vi.fn();

    await retryQueuedTenants(prisma, 'http://cp:3200', 5, 'queue', log, fetchFn);

    expect(fetchFn).not.toHaveBeenCalled();
    expect((prisma.tenant as unknown as { count: ReturnType<typeof vi.fn> }).count).not.toHaveBeenCalled();
  });
});

describe('getActiveCount', () => {
  it('returns count of ACTIVE tenants', async () => {
    const prisma = makePrisma({
      tenant: {
        count: vi.fn().mockResolvedValue(3),
      },
    });

    const result = await getActiveCount(prisma);
    expect(result).toBe(3);
    expect((prisma.tenant as unknown as { count: ReturnType<typeof vi.fn> }).count).toHaveBeenCalledWith({
      where: { status: TenantStatus.ACTIVE, deleted_at: null },
    });
  });
});
