import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rollbackProvisioning } from './rollback-provisioning.js';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises', () => ({
  rm: vi.fn().mockResolvedValue(undefined),
}));

function makePrisma() {
  return {
    tenant: {
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  } as unknown as import('@prisma/client').PrismaClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rollbackProvisioning', () => {
  it('sets tenant status to FAILED, increments attempts, removes dataDir, and writes audit event', async () => {
    const prisma = makePrisma();
    const rmContainer = vi.fn().mockResolvedValue(undefined);

    await rollbackProvisioning(
      prisma,
      'tenant-1',
      '/data/tenants/tenant-1',
      new Error('directory creation failed'),
      rmContainer,
    );

    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-1' },
        data: expect.objectContaining({
          status: 'FAILED',
          error_message: 'directory creation failed',
          provision_attempts: { increment: 1 },
        }),
      })
    );

    expect(fs.rm).toHaveBeenCalledWith('/data/tenants/tenant-1', { recursive: true, force: true });

    expect(rmContainer).toHaveBeenCalledWith('claw-tenant-tenant-1');

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event_type: 'TENANT_PROVISION_FAILED' }),
      })
    );
  });

  it('ignores container not-found errors (best-effort)', async () => {
    const prisma = makePrisma();
    const rmContainer = vi.fn().mockRejectedValue(new Error('No such container'));

    // Should not throw
    await expect(
      rollbackProvisioning(prisma, 'tenant-2', '/data/tenants/tenant-2', new Error('test'), rmContainer)
    ).resolves.toBeUndefined();
  });

  it('ignores directory removal errors (best-effort)', async () => {
    const prisma = makePrisma();
    const rmContainer = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fs.rm).mockRejectedValueOnce(new Error('Permission denied'));

    await expect(
      rollbackProvisioning(prisma, 'tenant-3', '/data/tenants/tenant-3', new Error('test'), rmContainer)
    ).resolves.toBeUndefined();
  });
});
