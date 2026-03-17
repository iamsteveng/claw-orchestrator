import { describe, it, expect, vi } from 'vitest';
import { getDiskUsageBytes, checkDiskQuotas } from '../../src/disk-quota.js';
import { mockPrismaClient } from '@claw/test-utils';
import { TenantStatus } from '@claw/shared-types';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const QUOTA_BYTES = 12 * 1024 * 1024 * 1024; // 12 GB

describe('getDiskUsageBytes', () => {
  it('returns bytes from du -sb output', async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: '1073741824\t/data/tenants/abc\n' });

    const result = await getDiskUsageBytes('/data/tenants/abc', execFn);

    expect(result).toBe(1073741824);
    expect(execFn).toHaveBeenCalledWith('du', ['-sb', '/data/tenants/abc']);
  });

  it('returns null on error', async () => {
    const execFn = vi.fn().mockRejectedValue(new Error('no such file'));

    const result = await getDiskUsageBytes('/missing', execFn);

    expect(result).toBeNull();
  });
});

describe('Disk quota threshold actions', () => {
  it('sets disk_quota_exceeded when usage is at 100%+ of quota', async () => {
    const prisma = mockPrismaClient();
    const tenantId = 'tenant-1';
    prisma.tenant.findMany = vi.fn().mockResolvedValue([
      { id: tenantId, data_dir: '/data/tenants/t1', disk_quota_exceeded: 0, slack_user_id: 'U1' },
    ]);
    prisma.tenant.update = vi.fn().mockResolvedValue({});
    prisma.auditLog.create = vi.fn().mockResolvedValue({});
    const getDiskFn = vi.fn().mockResolvedValue(QUOTA_BYTES); // 100% usage
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });

    await checkDiskQuotas(prisma, 'xoxb-token', log, getDiskFn, fetchFn);

    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: tenantId },
        data: expect.objectContaining({ disk_quota_exceeded: 1 }),
      }),
    );
  });

  it('clears disk_quota_exceeded when usage drops below 95%', async () => {
    const prisma = mockPrismaClient();
    const tenantId = 'tenant-1';
    const under95 = Math.floor(QUOTA_BYTES * 0.80); // 80% — below both WARN (90%) and CLEAR (95%) thresholds
    prisma.tenant.findMany = vi.fn().mockResolvedValue([
      { id: tenantId, data_dir: '/data/tenants/t1', disk_quota_exceeded: 1, slack_user_id: 'U1' },
    ]);
    prisma.tenant.update = vi.fn().mockResolvedValue({});
    prisma.auditLog.create = vi.fn().mockResolvedValue({});
    const getDiskFn = vi.fn().mockResolvedValue(under95);
    const fetchFn = vi.fn();

    await checkDiskQuotas(prisma, 'xoxb-token', log, getDiskFn, fetchFn);

    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: tenantId },
        data: expect.objectContaining({ disk_quota_exceeded: 0 }),
      }),
    );
  });

  it('skips tenants where du returns null', async () => {
    const prisma = mockPrismaClient();
    prisma.tenant.findMany = vi.fn().mockResolvedValue([
      { id: 'tenant-1', data_dir: '/data/tenants/t1', disk_quota_exceeded: 0, slack_user_id: 'U1' },
    ]);
    prisma.tenant.update = vi.fn();
    const getDiskFn = vi.fn().mockResolvedValue(null);

    await checkDiskQuotas(prisma, 'xoxb-token', log, getDiskFn);

    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});
