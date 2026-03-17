import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attemptAutoRecovery } from './recovery.js';
import { TenantStatus } from '@claw/shared-types';

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makePrisma(tenantOverride: Record<string, unknown> = {}) {
  const tenant = {
    id: 'tenant-1',
    status: TenantStatus.UNHEALTHY,
    recovery_attempted_at: null,
    ...tenantOverride,
  };
  return {
    tenant: {
      findUnique: vi.fn().mockResolvedValue(tenant),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    messageQueue: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as import('@prisma/client').PrismaClient;
}

// Mock docker-client dynamic import
vi.mock('@claw/docker-client', () => ({
  DockerClient: {
    start: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('attemptAutoRecovery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets ACTIVE and writes TENANT_RECOVERED when health check succeeds', async () => {
    const prisma = makePrisma();

    // Mock fetch to return ok=true after the cooldown
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    }));

    // Use fake timers to skip cooldown
    vi.useFakeTimers();
    const recoveryPromise = attemptAutoRecovery(prisma, 'tenant-1', 'claw-tenant-abc', silentLog);
    await vi.runAllTimersAsync();
    await recoveryPromise;
    vi.useRealTimers();

    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: TenantStatus.ACTIVE }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event_type: 'TENANT_RECOVERED' }),
      })
    );
  });

  it('leaves tenant UNHEALTHY when health poll times out', async () => {
    const prisma = makePrisma();

    // Always fail
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

    vi.useFakeTimers();
    const recoveryPromise = attemptAutoRecovery(prisma, 'tenant-1', 'claw-tenant-abc', silentLog);
    await vi.runAllTimersAsync();
    await recoveryPromise;
    vi.useRealTimers();

    // Should have updated recovery_attempted_at but NOT set ACTIVE
    const updateCalls = (prisma.tenant.update as ReturnType<typeof vi.fn>).mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1];
    expect(finalUpdate[0].data).not.toHaveProperty('status', TenantStatus.ACTIVE);

    // No TENANT_RECOVERED event
    const auditCalls = (prisma.auditLog.create as ReturnType<typeof vi.fn>).mock.calls;
    const hasRecoveredEvent = auditCalls.some(
      (call: unknown[]) => (call[0] as { data: { event_type: string } }).data.event_type === 'TENANT_RECOVERED'
    );
    expect(hasRecoveredEvent).toBe(false);
  });

  it('skips recovery when recovery_attempted_at is already set', async () => {
    const prisma = makePrisma({ recovery_attempted_at: Date.now() - 10000 });

    vi.useFakeTimers();
    const recoveryPromise = attemptAutoRecovery(prisma, 'tenant-1', 'claw-tenant-abc', silentLog);
    await vi.runAllTimersAsync();
    await recoveryPromise;
    vi.useRealTimers();

    // Should not have attempted docker start (no update for recovery_attempted_at)
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});
