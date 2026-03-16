import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rollbackProvisioning } from './rollback-provisioning.js';

vi.mock('@claw/docker-client', () => ({
  DockerClient: {
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

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

const log = {
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rollbackProvisioning', () => {
  it('sets tenant status to FAILED and increments provision_attempts', async () => {
    const prisma = makePrisma();

    await rollbackProvisioning(prisma, 'tenant-1', '/data/tenants/tenant-1', new Error('Directory creation failed'), log);

    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-1' },
        data: expect.objectContaining({
          status: 'FAILED',
          error_message: 'Directory creation failed',
          provision_attempts: { increment: 1 },
        }),
      })
    );
  });

  it('removes the data directory', async () => {
    const prisma = makePrisma();
    const { rm } = await import('node:fs/promises');

    await rollbackProvisioning(prisma, 'tenant-1', '/data/tenants/tenant-1', new Error('fail'), log);

    expect(rm).toHaveBeenCalledWith('/data/tenants/tenant-1', { recursive: true, force: true });
  });

  it('calls dockerRm for the tenant container', async () => {
    const prisma = makePrisma();
    const { DockerClient } = await import('@claw/docker-client');

    await rollbackProvisioning(prisma, 'tenant-1', '/data/tenants/tenant-1', new Error('fail'), log);

    expect(DockerClient.rm).toHaveBeenCalledWith('claw-tenant-tenant-1');
  });

  it('writes TENANT_PROVISION_FAILED audit event', async () => {
    const prisma = makePrisma();

    await rollbackProvisioning(prisma, 'tenant-1', '/data/tenants/tenant-1', new Error('docker run failed'), log);

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event_type: 'TENANT_PROVISION_FAILED',
          tenant_id: 'tenant-1',
        }),
      })
    );
  });

  it('does not throw even when dockerRm fails', async () => {
    const prisma = makePrisma();
    const { DockerClient } = await import('@claw/docker-client');
    (DockerClient.rm as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('not found'));

    await expect(
      rollbackProvisioning(prisma, 'tenant-2', '/data/tenants/tenant-2', new Error('fail'), log)
    ).resolves.not.toThrow();
  });
});
