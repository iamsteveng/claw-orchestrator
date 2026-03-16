import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { markUnhealthy, attemptRecovery } from './auto-recovery.js';

// Default: DockerClient.start succeeds; individual tests override as needed
vi.mock('@claw/docker-client', () => ({
  DockerClient: {
    start: vi.fn().mockResolvedValue(undefined),
  },
}));

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    tenant: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    ...overrides,
  } as unknown as import('@prisma/client').PrismaClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('markUnhealthy', () => {
  it('sets tenant status to UNHEALTHY and writes audit event', async () => {
    const prisma = makePrisma();

    await markUnhealthy(prisma, 'tenant-1', 'claw-tenant-abc', log);

    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-1' },
        data: expect.objectContaining({ status: 'UNHEALTHY' }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event_type: 'TENANT_UNHEALTHY' }),
      })
    );
  });
});

describe('attemptRecovery', () => {
  it('returns "recovered" and writes TENANT_RECOVERED when health check succeeds', async () => {
    const prisma = makePrisma();

    // Mock fetch for health check success
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    }));

    vi.useFakeTimers();

    const promise = attemptRecovery(prisma, 'tenant-1', 'claw-tenant-abc', log);

    // Fast-forward past the 30s cooldown and 90s health poll
    await vi.runAllTimersAsync();

    const result = await promise;

    expect(result).toBe('recovered');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ event_type: 'TENANT_RECOVERED' }),
      })
    );

    vi.useRealTimers();
  });

  it('returns "failed" when dockerStart fails', async () => {
    const prisma = makePrisma();

    // Override DockerClient.start to throw for this test
    const { DockerClient } = await import('@claw/docker-client');
    vi.mocked(DockerClient.start).mockRejectedValueOnce(new Error('Container not found'));

    vi.useFakeTimers();

    const promise = attemptRecovery(prisma, 'tenant-2', 'claw-tenant-xyz', log);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('failed');

    vi.useRealTimers();
  });

  it('returns "failed" when health poll times out after recovery attempt', async () => {
    const prisma = makePrisma();

    // Mock fetch to always fail
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

    vi.useFakeTimers();

    const promise = attemptRecovery(prisma, 'tenant-3', 'claw-tenant-def', log);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('failed');

    vi.useRealTimers();
  });
});
