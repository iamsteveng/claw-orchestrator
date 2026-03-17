import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkDiskQuotas, getDiskUsageBytes } from './disk-quota.js';
import type { PrismaClient } from '@prisma/client';

const QUOTA_BYTES = 12 * 1024 * 1024 * 1024; // 12 GB

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const fetchFn = vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ ok: true, channel: { id: 'D001' } }), { status: 200 }),
) as unknown as typeof fetch;

function makePrisma(tenants: { id: string; data_dir: string; disk_quota_exceeded: number; slack_user_id: string }[]) {
  return {
    tenant: {
      findMany: vi.fn().mockResolvedValue(tenants),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaClient;
}

const tenant = {
  id: 'tenant-1',
  data_dir: '/data/tenants/tenant-1',
  disk_quota_exceeded: 0,
  slack_user_id: 'U123',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset fetchFn mock to return conversations.open then chat.postMessage
  (fetchFn as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (String(url).includes('conversations.open')) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, channel: { id: 'D001' } }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });
});

describe('checkDiskQuotas', () => {
  it('writes DISK_QUOTA_EXCEEDED and sets flag when usage >= 100%', async () => {
    const prisma = makePrisma([tenant]);
    const getDiskFn = vi.fn().mockResolvedValue(QUOTA_BYTES); // exactly 100%

    await checkDiskQuotas(prisma, 'xoxb-token', log, getDiskFn, fetchFn);

    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-1' },
        data: expect.objectContaining({ disk_quota_exceeded: 1 }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event_type: 'DISK_QUOTA_EXCEEDED' }),
      }),
    );
  });

  it('writes DISK_QUOTA_WARNING when usage is between 90% and 100%', async () => {
    const prisma = makePrisma([tenant]);
    const usedBytes = Math.floor(QUOTA_BYTES * 0.92); // 92%
    const getDiskFn = vi.fn().mockResolvedValue(usedBytes);

    await checkDiskQuotas(prisma, 'xoxb-token', log, getDiskFn, fetchFn);

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event_type: 'DISK_QUOTA_WARNING' }),
      }),
    );
    // Should NOT set disk_quota_exceeded
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('clears disk_quota_exceeded when usage drops below 95%', async () => {
    const prisma = makePrisma([{ ...tenant, disk_quota_exceeded: 1 }]);
    const usedBytes = Math.floor(QUOTA_BYTES * 0.80); // 80% — below 95%
    const getDiskFn = vi.fn().mockResolvedValue(usedBytes);

    await checkDiskQuotas(prisma, 'xoxb-token', log, getDiskFn, fetchFn);

    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-1' },
        data: expect.objectContaining({ disk_quota_exceeded: 0 }),
      }),
    );
  });

  it('does nothing for tenants under 90% quota with no exceeded flag', async () => {
    const prisma = makePrisma([tenant]);
    const usedBytes = Math.floor(QUOTA_BYTES * 0.50); // 50%
    const getDiskFn = vi.fn().mockResolvedValue(usedBytes);

    await checkDiskQuotas(prisma, 'xoxb-token', log, getDiskFn, fetchFn);

    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('skips tenant if du returns null', async () => {
    const prisma = makePrisma([tenant]);
    const getDiskFn = vi.fn().mockResolvedValue(null);

    await checkDiskQuotas(prisma, 'xoxb-token', log, getDiskFn, fetchFn);

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
