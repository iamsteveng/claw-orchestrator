import { describe, it, expect, vi } from 'vitest';
import { stopIdleTenants } from '../../src/idle-stop.js';
import { mockPrismaClient, makeTenant } from '@claw/test-utils';
import { TenantStatus } from '@claw/shared-types';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const IDLE_48H = 48 * 60 * 60 * 1000;

describe('Idle stop eligibility (last_activity_at threshold)', () => {
  it('stops tenants whose last_activity_at is older than the threshold', async () => {
    const prisma = mockPrismaClient();
    const oldActivity = Date.now() - IDLE_48H - 1000; // 48h + 1s ago
    const tenant = makeTenant({ status: TenantStatus.ACTIVE, last_activity_at: oldActivity });
    prisma.tenant.findMany = vi.fn().mockResolvedValue([{ id: tenant.id, last_activity_at: oldActivity }]);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });

    await stopIdleTenants(prisma, 'http://cp', IDLE_48H, log, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      `http://cp/v1/tenants/${tenant.id}/stop`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not stop tenants with recent activity', async () => {
    const prisma = mockPrismaClient();
    prisma.tenant.findMany = vi.fn().mockResolvedValue([]); // no idle tenants found
    const fetchFn = vi.fn();

    await stopIdleTenants(prisma, 'http://cp', IDLE_48H, log, fetchFn);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('queries only ACTIVE tenants with last_activity_at below threshold', async () => {
    const prisma = mockPrismaClient();
    prisma.tenant.findMany = vi.fn().mockResolvedValue([]);

    await stopIdleTenants(prisma, 'http://cp', IDLE_48H, log);

    expect(prisma.tenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: TenantStatus.ACTIVE,
          deleted_at: null,
          last_activity_at: expect.objectContaining({ lt: expect.any(Number) }),
        }),
      }),
    );
  });

  it('handles fetch errors gracefully', async () => {
    const prisma = mockPrismaClient();
    const oldActivity = Date.now() - IDLE_48H - 1000;
    prisma.tenant.findMany = vi.fn().mockResolvedValue([{ id: 'tenant-1', last_activity_at: oldActivity }]);
    const fetchFn = vi.fn().mockRejectedValue(new Error('network error'));

    // Should not throw
    await expect(
      stopIdleTenants(prisma, 'http://cp', IDLE_48H, log, fetchFn),
    ).resolves.not.toThrow();
    expect(log.error).toHaveBeenCalled();
  });
});
