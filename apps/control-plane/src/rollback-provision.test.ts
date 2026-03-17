import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rollbackProvisioning } from './rollback-provision.js';
import { TenantStatus, AuditEventType } from '@claw/shared-types';

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

describe('rollbackProvisioning', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets status=FAILED and increments provision_attempts', async () => {
    const prisma = makePrisma();
    const err = new Error('Directory creation failed');
    await rollbackProvisioning(prisma, 'tenant-1', '/data/tenants/tenant-1', err);

    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-1' },
        data: expect.objectContaining({
          status: TenantStatus.FAILED,
          error_message: 'Directory creation failed',
          provision_attempts: { increment: 1 },
        }),
      }),
    );
  });

  it('writes TENANT_PROVISION_FAILED audit event', async () => {
    const prisma = makePrisma();
    const err = new Error('docker run failed');
    await rollbackProvisioning(prisma, 'tenant-1', '/data/tenants/tenant-1', err);

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event_type: AuditEventType.TENANT_PROVISION_FAILED,
          tenant_id: 'tenant-1',
        }),
      }),
    );
  });

  it('calls dockerRm with the correct container name', async () => {
    const prisma = makePrisma();
    const { DockerClient } = await import('@claw/docker-client');
    const err = new Error('health timeout');
    await rollbackProvisioning(prisma, 'tenant-1', '/data/tenants/tenant-1', err);

    expect(DockerClient.rm).toHaveBeenCalledWith('claw-tenant-tenant-1');
  });

  it('does not throw if dockerRm fails (container not found)', async () => {
    const prisma = makePrisma();
    const { DockerClient } = await import('@claw/docker-client');
    vi.mocked(DockerClient.rm).mockRejectedValueOnce(new Error('No such container'));

    const err = new Error('some error');
    await expect(
      rollbackProvisioning(prisma, 'tenant-1', '/data/tenants/tenant-1', err),
    ).resolves.not.toThrow();
  });
});
