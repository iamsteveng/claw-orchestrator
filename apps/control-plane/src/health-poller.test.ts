import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollUntilHealthy } from './health-poller.js';
import { AuditEventType, TenantStatus } from '@claw/shared-types';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makePrisma() {
  return {
    tenant: { update: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  } as unknown as import('@prisma/client').PrismaClient;
}

// Speed up tests with very short timeouts
const fastConfig = { pollIntervalMs: 5, pollTimeoutMs: 50, requestTimeoutMs: 20 };

describe('pollUntilHealthy', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('returns "healthy" and sets tenant ACTIVE when ok=true received', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => ({ ok: true }),
    });

    const prisma = makePrisma();
    const result = await pollUntilHealthy(prisma, 'tenant-1', 'claw-tenant-abc', 'STARTING', fastConfig);

    expect(result).toBe('healthy');
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-1' },
        data: expect.objectContaining({ status: TenantStatus.ACTIVE }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event_type: AuditEventType.TENANT_STARTED }),
      }),
    );
  });

  it('returns "timeout" and sets UNHEALTHY for previously-ACTIVE tenant', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const prisma = makePrisma();
    const result = await pollUntilHealthy(prisma, 'tenant-1', 'claw-tenant-abc', TenantStatus.ACTIVE, fastConfig);

    expect(result).toBe('timeout');
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: TenantStatus.UNHEALTHY }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event_type: AuditEventType.TENANT_UNHEALTHY }),
      }),
    );
  });

  it('returns "timeout" and sets FAILED for provisioning timeout', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const prisma = makePrisma();
    const result = await pollUntilHealthy(prisma, 'tenant-1', 'claw-tenant-abc', 'STARTING', fastConfig);

    expect(result).toBe('timeout');
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: TenantStatus.FAILED }),
      }),
    );
  });

  it('polls until ok=true after initial failures', async () => {
    // First two calls fail, third succeeds
    mockFetch
      .mockRejectedValueOnce(new Error('not ready'))
      .mockRejectedValueOnce(new Error('not ready'))
      .mockResolvedValue({ status: 200, json: async () => ({ ok: true }) });

    const prisma = makePrisma();
    const result = await pollUntilHealthy(prisma, 'tenant-1', 'claw-tenant-abc', 'STARTING', {
      pollIntervalMs: 5,
      pollTimeoutMs: 1000,
      requestTimeoutMs: 20,
    });

    expect(result).toBe('healthy');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
