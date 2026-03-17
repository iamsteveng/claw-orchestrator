import { describe, it, expect, vi } from 'vitest';
import { getActiveTenantCount, isAtCapacity } from '../../src/capacity.js';
import { mockPrismaClient } from '@claw/test-utils';

describe('Capacity cap enforcement', () => {
  it('getActiveTenantCount returns the number of ACTIVE tenants', async () => {
    const prisma = mockPrismaClient();
    prisma.tenant.count = vi.fn().mockResolvedValue(3);

    const count = await getActiveTenantCount(prisma);

    expect(count).toBe(3);
    expect(prisma.tenant.count).toHaveBeenCalledWith({
      where: { status: 'ACTIVE', deleted_at: null },
    });
  });

  it('isAtCapacity returns false when below the cap', async () => {
    const prisma = mockPrismaClient();
    prisma.tenant.count = vi.fn().mockResolvedValue(5);

    const result = await isAtCapacity(prisma, 10);

    expect(result).toBe(false);
  });

  it('isAtCapacity returns true when at the cap', async () => {
    const prisma = mockPrismaClient();
    prisma.tenant.count = vi.fn().mockResolvedValue(10);

    const result = await isAtCapacity(prisma, 10);

    expect(result).toBe(true);
  });

  it('isAtCapacity returns true when above the cap', async () => {
    const prisma = mockPrismaClient();
    prisma.tenant.count = vi.fn().mockResolvedValue(12);

    const result = await isAtCapacity(prisma, 10);

    expect(result).toBe(true);
  });

  it('isAtCapacity returns false when cap is 0 and there are no active tenants', async () => {
    const prisma = mockPrismaClient();
    prisma.tenant.count = vi.fn().mockResolvedValue(0);

    const result = await isAtCapacity(prisma, 1);

    expect(result).toBe(false);
  });
});
