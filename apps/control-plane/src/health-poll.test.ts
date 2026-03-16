import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollUntilHealthy } from './health-poll.js';

// Mock recovery module to avoid docker/network calls in tests
vi.mock('./recovery.js', () => ({
  attemptAutoRecovery: vi.fn().mockResolvedValue(undefined),
}));

// Minimal mock Prisma
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

// Silent logger for tests
const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pollUntilHealthy', () => {
  it('returns healthy and sets tenant ACTIVE when health endpoint responds ok=true', async () => {
    const prisma = makePrisma();

    // Mock fetch to return { ok: true } immediately
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    }));

    const result = await pollUntilHealthy(prisma, 'tenant-1', 'claw-tenant-abc', 'STARTING', log);

    expect(result).toBe('healthy');
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-1' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event_type: 'TENANT_STARTED' }),
      })
    );
  });

  it('sets UNHEALTHY after 3 consecutive failures when previousStatus=ACTIVE', async () => {
    const prisma = makePrisma();

    // Always fail
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));
    vi.useFakeTimers();

    const promise = pollUntilHealthy(prisma, 'tenant-2', 'claw-tenant-xyz', 'ACTIVE', log);
    await vi.runAllTimersAsync();
    const result = await promise;

    vi.useRealTimers();

    expect(result).toBe('timeout');
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-2' },
        data: expect.objectContaining({ status: 'UNHEALTHY' }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event_type: 'TENANT_UNHEALTHY' }),
      })
    );
  });

  it('returns timeout and sets UNHEALTHY when previousStatus=ACTIVE and polling times out', async () => {
    const prisma = makePrisma();

    // Always fail
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

    vi.useFakeTimers();
    const promise = pollUntilHealthy(prisma, 'tenant-3', 'claw-tenant-xyz', 'ACTIVE', log);

    // Fast-forward past 90 seconds
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('timeout');
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-3' },
        data: expect.objectContaining({ status: 'UNHEALTHY' }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event_type: 'TENANT_UNHEALTHY' }),
      })
    );

    vi.useRealTimers();
  });

  it('returns timeout without setting UNHEALTHY when previousStatus is not ACTIVE', async () => {
    const prisma = makePrisma();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));
    vi.useFakeTimers();

    const promise = pollUntilHealthy(prisma, 'tenant-4', 'claw-tenant-def', 'PROVISIONING', log);

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('timeout');
    // No DB update or audit log for non-ACTIVE previous status
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
